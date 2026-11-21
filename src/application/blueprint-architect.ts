import { randomUUID } from 'node:crypto';
import type {
  AutonomyMode,
  BlueprintDimension,
  BlueprintLintIssue,
  BlueprintPhase,
  BlueprintPresetId,
  BlueprintRequirement,
  DetectedRepoContext,
  InterviewMode,
  InterviewQuestion,
  InterviewSession,
  ProjectBlueprint
} from '../domain/blueprint.js';
import type { WorkDomain } from '../domain/models.js';
import type { BlueprintArtifactWriterPort, RepoScannerPort, StateRepository } from '../domain/ports.js';
import { NotFoundError, ValidationError } from '../domain/errors.js';
import { detectDomainsFromText } from './blueprint-parser.js';

const now = () => new Date().toISOString();

interface QuestionSpec extends InterviewQuestion {
  minMode: InterviewMode;
  condition?: (ctx: { session: InterviewSession; answerText: (id: string) => string }) => boolean;
}

const MODE_RANK: Record<InterviewMode, number> = { quick: 1, standard: 2, deep: 3 };
const COMPLETENESS_THRESHOLD: Record<InterviewMode, number> = { quick: 60, standard: 78, deep: 88 };

const PRESET_SIGNALS: Array<{ id: BlueprintPresetId; pattern: RegExp; defaultFeatures: string[]; defaultRoutes: string[] }> = [
  {
    id: 'ecommerce',
    pattern: /toko|e-?commerce|shop|store|produk|katalog|checkout|keranjang|cart|jual/i,
    defaultFeatures: ['Product Catalog & Filtering', 'Product Detail & Variants', 'Cart & Checkout Flow', 'Order & User Account'],
    defaultRoutes: ['/', '/products', '/products/[id]', '/cart', '/checkout']
  },
  {
    id: '3d-showroom',
    pattern: /3d|showroom|three\.?js|webgl|atelier|virtual try|configurator/i,
    defaultFeatures: ['Interactive 3D Showroom & Orbit Controls', 'Material / Color Variant Selector', 'Catalog & Specification Drawer'],
    defaultRoutes: ['/', '/showroom', '/catalog']
  },
  {
    id: 'saas-dashboard',
    pattern: /saas|dashboard|admin|crm|analytics|workspace|billing|team/i,
    defaultFeatures: ['Authentication & Workspace Switcher', 'Analytics Dashboard & KPIs', 'Core CRUD Management', 'Settings & Billing'],
    defaultRoutes: ['/', '/login', '/dashboard', '/settings']
  },
  {
    id: 'portfolio',
    pattern: /portfolio|portofolio|personal site|cv|resume|studio showcase/i,
    defaultFeatures: ['Hero & Identity Statement', 'Selected Works & Case Studies', 'About, Capabilities & Contact'],
    defaultRoutes: ['/', '/projects', '/about', '/contact']
  },
  {
    id: 'landing',
    pattern: /landing|company profile|profil perusahaan|launch page|waitlist/i,
    defaultFeatures: ['Hero Value Proposition', 'Features & Social Proof', 'Pricing / CTA & Lead Capture'],
    defaultRoutes: ['/']
  },
  {
    id: 'fullstack-app',
    pattern: /aplikasi|app|platform|portal|sistem|management/i,
    defaultFeatures: ['Authentication & User Roles', 'Core Domain Workflows', 'Data Persistence & API'],
    defaultRoutes: ['/', '/login', '/app']
  }
];

function detectPreset(idea: string, explicit?: BlueprintPresetId): BlueprintPresetId | null {
  if (explicit) return explicit;
  return PRESET_SIGNALS.find(p => p.pattern.test(idea))?.id ?? null;
}

function asString(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value.join(', ');
  return typeof value === 'string' ? value : '';
}

function hasYesSignal(text: string): boolean {
  return /\b(ya|yes|perlu|butuh|pakai|use|include|enable|ada|true|three|3d|api|database|auth|login|payment|motion|animasi)\b/i.test(text) &&
    !/\b(tidak|no|tanpa|skip|none|belum perlu|statis saja)\b/i.test(text);
}

const QUESTION_BANK: readonly QuestionSpec[] = [
  // 1. Goal & Audience
  {
    id: 'goal.audience',
    dimension: 'goal',
    minMode: 'quick',
    question: 'Siapa target pengguna utama dan hasil bisnis/produk terpenting yang ingin dicapai?',
    options: [
      '(Rekomendasi) End-user / konsumen umum dengan fokus konversi & UX cepat',
      'Klien B2B / profesional dengan fokus kredibilitas & detail data',
      'Tim internal / operasional dengan fokus produktivitas & kecepatan kerja'
    ],
    multiSelect: false,
    recommendedDefault: 'End-user / konsumen umum dengan fokus konversi & UX cepat',
    why: 'Menentukan hierarki informasi, tone copy, dan prioritas fitur antar-phase.',
    required: true,
    unlocks: ['scope.features']
  },
  // 2. Scope & Features (MoSCoW)
  {
    id: 'scope.features',
    dimension: 'scope',
    minMode: 'quick',
    question: 'Fitur inti (Must-Have) apa saja yang WAJIB selesai di semua phase (bukan hanya halaman depan)?',
    options: [
      '(Rekomendasi) Semua fitur inti sesuai jenis aplikasi (Fondasi -> Fitur Utama -> Alur Transaksi/Interaksi -> QA)',
      'MVP ramping: halaman utama + 1-2 alur fitur inti saja',
      'Full production: semua modul termasuk admin, manajemen data, dan polish lengkap'
    ],
    multiSelect: false,
    recommendedDefault: 'Semua fitur inti sesuai jenis aplikasi (Fondasi -> Fitur Utama -> Alur Transaksi/Interaksi -> QA)',
    why: 'Menjadi dasar penyusunan Multi-Phase DAG agar seluruh phase dikerjakan tuntas.',
    required: true,
    unlocks: ['pages.routes', 'scope.nongoals']
  },
  {
    id: 'scope.nongoals',
    dimension: 'scope',
    minMode: 'deep',
    question: 'Ada fitur yang secara eksplisit TIDAK termasuk (Non-Goals / Out of Scope) untuk versi ini?',
    options: [
      '(Rekomendasi) Tidak termasuk deployment otomatis produksi, native mobile app, dan multi-region infra',
      'Tidak termasuk CMS/Admin panel untuk versi pertama',
      'Tidak ada pengecualian khusus selain non-deployment otomatis'
    ],
    multiSelect: false,
    recommendedDefault: 'Tidak termasuk deployment otomatis produksi, native mobile app, dan multi-region infra',
    why: 'Mencegah scope creep dan membatasi pemanggilan skill yang tidak relevan.',
    required: false
  },
  // 3. Pages & User Journey
  {
    id: 'pages.routes',
    dimension: 'pages',
    minMode: 'quick',
    question: 'Halaman / route utama dan alur pengguna apa saja yang harus dibangun?',
    options: [
      '(Rekomendasi) Multi-halaman penuh sesuai preset aplikasi (Landing + Katalog/Fitur + Detail + Alur Utama)',
      'Single-page / landing terstruktur dengan section lengkap',
      'Dashboard multi-view dengan sidebar navigasi & halaman pengaturan'
    ],
    multiSelect: false,
    recommendedDefault: 'Multi-halaman penuh sesuai preset aplikasi (Landing + Katalog/Fitur + Detail + Alur Utama)',
    why: 'Menentukan daftar route untuk phase frontend dan matriks inspeksi Playwright.',
    required: true,
    unlocks: ['pages.edge_states']
  },
  {
    id: 'pages.edge_states',
    dimension: 'pages',
    minMode: 'deep',
    question: 'Bagaimana penanganan state kosong (empty state), loading, dan error di halaman utama?',
    options: [
      '(Rekomendasi) Skeleton loading + empty state informatif dengan CTA + error boundary/retry yang ramah',
      'Spinner loading sederhana + pesan teks error standar'
    ],
    multiSelect: false,
    recommendedDefault: 'Skeleton loading + empty state informatif dengan CTA + error boundary/retry yang ramah',
    why: 'Menghindari UI rusak saat data kosong atau request gagal.',
    required: false
  },
  // 4. Data, Backend & Auth
  {
    id: 'data_backend.architecture',
    dimension: 'data_backend',
    minMode: 'quick',
    question: 'Apakah proyek ini membutuhkan backend API, database, atau autentikasi pengguna?',
    options: [
      '(Rekomendasi) Frontend saja / data statis & mock terstruktur (tanpa backend/DB)',
      'Fullstack dengan REST/Route API + Database (Prisma/SQLite/PostgreSQL)',
      'Fullstack lengkap dengan API + Database + Autentikasi & Role (RBAC)'
    ],
    multiSelect: false,
    recommendedDefault: 'Frontend saja / data statis & mock terstruktur (tanpa backend/DB)',
    why: 'Mengontrol apakah skill backend-implementation, data, dan security-review diaktifkan atau dilewati (hemat token).',
    required: true,
    unlocks: ['data_backend.entities', 'integrations.external']
  },
  {
    id: 'data_backend.entities',
    dimension: 'data_backend',
    minMode: 'standard',
    condition: ({ answerText }) => hasYesSignal(answerText('data_backend.architecture')),
    question: 'Entitas data utama dan aturan autentikasi/izin apa yang dibutuhkan?',
    options: [
      '(Rekomendasi) User + entitas domain utama dengan validasi schema (Zod) dan session/JWT aman',
      'Multi-role (Admin & Customer/Member) dengan proteksi route dan audit log'
    ],
    multiSelect: false,
    recommendedDefault: 'User + entitas domain utama dengan validasi schema (Zod) dan session/JWT aman',
    why: 'Menentukan schema database, kontrak API, dan phase keamanan.',
    required: true
  },
  // 5. Design Direction & Theme
  {
    id: 'design.theme',
    dimension: 'design',
    minMode: 'quick',
    question: 'Mode tema (color scheme) apa yang diinginkan?',
    options: [
      '(Rekomendasi) Light + Dark fleksibel mengikuti sistem dengan toggle manual',
      'Light mode saja (clean editorial)',
      'Dark mode saja (cinematic / luxury showcase)'
    ],
    multiSelect: false,
    recommendedDefault: 'Light + Dark fleksibel mengikuti sistem dengan toggle manual',
    why: 'Menentukan token warna semantic (`light-dark()`) dan apakah audit kontras dijalankan di 1 atau 2 tema.',
    required: true,
    unlocks: ['design.direction']
  },
  {
    id: 'design.direction',
    dimension: 'design',
    minMode: 'standard',
    question: 'Pilih arah visual (design direction) yang paling cocok dengan brand kamu:',
    options: [
      '(Rekomendasi) Editorial Minimal — tipografi tajam, ruang napas lega, aksen hangat/netral',
      'Luxury Atelier / Cinematic — kontras kaya, material halus, fokus visual produk',
      'Modern SaaS / Swiss Grid — bento layout rapi, hirarki data jelas, high-craft'
    ],
    multiSelect: false,
    recommendedDefault: 'Editorial Minimal — tipografi tajam, ruang napas lega, aksen hangat/netral',
    why: 'Menghindari tampilan template AI generik dan mengunci kontrak desain sejak Phase 0.',
    required: true
  },
  // 6. 3D & Motion (Conditional / Token-Saving Gate!)
  {
    id: 'threejs_motion.need',
    dimension: 'threejs_motion',
    minMode: 'quick',
    question: 'Apakah membutuhkan visual 3D/Three.js atau animasi/motion khusus?',
    options: [
      '(Rekomendasi) Tidak perlu 3D; cukup micro-interaction CSS halus (hemat token & performa tinggi)',
      'Animasi / Motion kaya (scroll reveal, transisi interaktif), tanpa 3D',
      'Ya, butuh 3D WebGL / Three.js interaktif (showroom / objek 3D detail + PBR)'
    ],
    multiSelect: false,
    recommendedDefault: 'Tidak perlu 3D; cukup micro-interaction CSS halus (hemat token & performa tinggi)',
    why: 'Jika tidak butuh 3D/motion, skill threejs-shaders & motion-animation dilewati sepenuhnya.',
    required: true,
    unlocks: ['threejs_motion.detail']
  },
  {
    id: 'threejs_motion.detail',
    dimension: 'threejs_motion',
    minMode: 'standard',
    condition: ({ answerText }) => {
      const a = answerText('threejs_motion.need');
      return !/tidak perlu 3d|tanpa 3d|no 3d/i.test(a) && /3d|three|webgl|showroom/i.test(a);
    },
    question: 'Untuk bagian 3D Three.js, tingkat detail dan fallback perangkat seperti apa yang diharapkan?',
    options: [
      '(Rekomendasi) Multi-part sculpted PBR + RoomEnvironment IBL + seam detail + fallback 2D/low-tier GPU',
      'Model ringan interaktif (orbit + zoom) dengan prioritas FPS 60 di mobile'
    ],
    multiSelect: false,
    recommendedDefault: 'Multi-part sculpted PBR + RoomEnvironment IBL + seam detail + fallback 2D/low-tier GPU',
    why: 'Mengunci standar kualitas 3D dan kriteria audit WebGL sejak awal.',
    required: true
  },
  // 7. E-commerce specific adaptive branch
  {
    id: 'integrations.ecommerce',
    dimension: 'integrations',
    minMode: 'standard',
    condition: ({ session, answerText }) =>
      session.preset === 'ecommerce' || /toko|e-?commerce|checkout|payment|cart/i.test(`${session.initialIdea} ${answerText('scope.features')}`),
    question: 'Untuk alur belanja / e-commerce, cakupan pembayaran dan stok seperti apa?',
    options: [
      '(Rekomendasi) Cart + Checkout lengkap dengan simulasi/sandbox payment gateway & validasi stok lokal',
      'Integrasi payment gateway nyata (Stripe / Midtrans) dengan webhook terverifikasi',
      'Katalog & keranjang dengan checkout via WhatsApp / inquiry form'
    ],
    multiSelect: false,
    recommendedDefault: 'Cart + Checkout lengkap dengan simulasi/sandbox payment gateway & validasi stok lokal',
    why: 'Menentukan phase checkout, kontrak API pembayaran, dan level audit keamanan.',
    required: true
  },
  // 8. Responsive & Device Targets
  {
    id: 'responsive.targets',
    dimension: 'responsive',
    minMode: 'deep',
    question: 'Prioritas perangkat dan kebutuhan sentuh (touch) utama?',
    options: [
      '(Rekomendasi) Mobile-first penuh (320px–1920px+, target sentuh >= 44px, zero horizontal overflow)',
      'Desktop-first (dashboard/workspace) dengan dukungan tablet & mobile yang tetap rapi'
    ],
    multiSelect: false,
    recommendedDefault: 'Mobile-first penuh (320px–1920px+, target sentuh >= 44px, zero horizontal overflow)',
    why: 'Mengatur matriks viewport Playwright saat verifikasi otomatis.',
    required: false
  },
  // 9. Accessibility
  {
    id: 'accessibility.standard',
    dimension: 'accessibility',
    minMode: 'deep',
    question: 'Standar aksesibilitas dan kontras warna yang diterapkan?',
    options: [
      '(Rekomendasi) WCAG 2.2 AA (kontras >= 4.5:1 teks normal, navigasi keyboard, focus ring jelas, prefers-reduced-motion)',
      'WCAG 2.2 AAA (kontras tinggi >= 7:1 untuk teks utama)'
    ],
    multiSelect: false,
    recommendedDefault: 'WCAG 2.2 AA (kontras >= 4.5:1 teks normal, navigasi keyboard, focus ring jelas, prefers-reduced-motion)',
    why: 'Menjadi ambang gate otomatis pada `localhost.audit_visual_a11y`.',
    required: false
  },
  // 10. Performance
  {
    id: 'performance.budget',
    dimension: 'performance',
    minMode: 'deep',
    question: 'Target performa & Core Web Vitals yang dijadikan acuan?',
    options: [
      '(Rekomendasi) LCP <= 2.5s, CLS <= 0.1, zero console/network error, JS bundle efisien',
      'Ketat: LCP <= 1.8s, CLS <= 0.05, animasi stabil 60 FPS'
    ],
    multiSelect: false,
    recommendedDefault: 'LCP <= 2.5s, CLS <= 0.1, zero console/network error, JS bundle efisien',
    why: 'Mengubah target "cepat" menjadi metrik terukur untuk gate performa.',
    required: false
  },
  // 11. Content & Language
  {
    id: 'content.language',
    dimension: 'content',
    minMode: 'deep',
    question: 'Bahasa konten UI dan kebutuhan i18n?',
    options: [
      '(Rekomendasi) Bahasa Indonesia alami & profesional (1 bahasa)',
      'Bahasa Inggris profesional (1 bahasa)',
      'Bilingual (Indonesia + Inggris dengan language switcher)'
    ],
    multiSelect: false,
    recommendedDefault: 'Bahasa Indonesia alami & profesional (1 bahasa)',
    why: 'Menghindari teks placeholder campur aduk dan menentukan apakah perlu arsitektur i18n.',
    required: false
  },
  // 12. Integrations & Security Policy (conditional when backend/payments/auth)
  {
    id: 'integrations.external',
    dimension: 'integrations',
    minMode: 'deep',
    condition: ({ answerText }) => hasYesSignal(answerText('data_backend.architecture')) || /payment|stripe|midtrans/i.test(answerText('integrations.ecommerce')),
    question: 'Integrasi eksternal dan kebijakan keamanan data (env secrets, sanitasi input, rate limit)?',
    options: [
      '(Rekomendasi) Validasi Zod di semua boundary, secret hanya via .env (tidak di repo), proteksi XSS/CSRF/SQLi',
      'Standar keamanan + integrasi email/analytics pihak ketiga dengan consent'
    ],
    multiSelect: false,
    recommendedDefault: 'Validasi Zod di semua boundary, secret hanya via .env (tidak di repo), proteksi XSS/CSRF/SQLi',
    why: 'Mengunci acceptance criteria keamanan sebelum kode backend ditulis.',
    required: false
  },
  // 13. Acceptance Criteria / Definition of Done
  {
    id: 'acceptance.dod',
    dimension: 'acceptance',
    minMode: 'standard',
    question: 'Kriteria selesai (Definition of Done) apa yang wajib dipenuhi sebelum proyek dinyatakan tuntas?',
    options: [
      '(Rekomendasi) Semua phase lulus build/typecheck, zero error console, audit responsive & kontras light/dark PASS, semua REQ punya evidence',
      'Semua di atas + unit/integration test lulus untuk setiap fitur inti'
    ],
    multiSelect: false,
    recommendedDefault: 'Semua phase lulus build/typecheck, zero error console, audit responsive & kontras light/dark PASS, semua REQ punya evidence',
    why: 'Menjadi kontrak akhir quality gate Craftrig.',
    required: true
  },
  // 14. Autonomy Preference
  {
    id: 'autonomy.mode',
    dimension: 'autonomy',
    minMode: 'quick',
    question: 'Mode eksekusi autopilot setelah blueprint disetujui?',
    options: [
      '(Rekomendasi) Full-Auto — kerjakan semua phase sampai selesai & lulus QA tanpa berhenti (deploy tetap minta izin)',
      'Phase-Gate — berhenti sebentar di akhir setiap phase untuk review sebelum lanjut phase berikutnya'
    ],
    multiSelect: false,
    recommendedDefault: 'Full-Auto — kerjakan semua phase sampai selesai & lulus QA tanpa berhenti (deploy tetap minta izin)',
    why: 'Menentukan perilaku loop `craftrig.autopilot_next` antar-phase.',
    required: true
  }
];

function getApplicableQuestions(session: InterviewSession): QuestionSpec[] {
  const rank = MODE_RANK[session.mode];
  const answerText = (id: string) => asString(session.answers[id]);
  return QUESTION_BANK.filter(q => {
    if (MODE_RANK[q.minMode] > rank) return false;
    if (q.condition && !q.condition({ session, answerText })) return false;
    return true;
  });
}

function computeCompleteness(session: InterviewSession): {
  score: number;
  dimensionScores: Record<string, number>;
  unanswered: QuestionSpec[];
} {
  const applicable = getApplicableQuestions(session);
  const byDimension = new Map<BlueprintDimension, { totalWeight: number; answeredWeight: number }>();
  const unanswered: QuestionSpec[] = [];

  for (const q of applicable) {
    const weight = q.required ? 2 : 1;
    const entry = byDimension.get(q.dimension) ?? { totalWeight: 0, answeredWeight: 0 };
    entry.totalWeight += weight;
    const val = session.answers[q.id];
    const isAnswered = Array.isArray(val) ? val.length > 0 : typeof val === 'string' && val.trim().length > 0;
    if (isAnswered) {
      entry.answeredWeight += weight;
    } else {
      unanswered.push(q);
    }
    byDimension.set(q.dimension, entry);
  }

  let totalW = 0;
  let answeredW = 0;
  const dimensionScores: Record<string, number> = {};
  for (const [dim, stats] of byDimension.entries()) {
    totalW += stats.totalWeight;
    answeredW += stats.answeredWeight;
    dimensionScores[dim] = stats.totalWeight > 0 ? Math.round((stats.answeredWeight / stats.totalWeight) * 100) : 100;
  }

  const score = totalW > 0 ? Math.round((answeredW / totalW) * 100) : 100;
  return { score, dimensionScores, unanswered };
}

export function lintBlueprint(blueprint: ProjectBlueprint, answers: Record<string, string | string[]>): BlueprintLintIssue[] {
  const issues: BlueprintLintIssue[] = [];
  const archAnswer = asString(answers['data_backend.architecture']);
  const ecomAnswer = asString(answers['integrations.ecommerce']);
  const perfAnswer = asString(answers['performance.budget']);
  const corpus = `${blueprint.summary} ${Object.values(answers).map(v => asString(v)).join(' ')}`;

  // Contradiction 1: Static site + Auth/DB requested
  if (/statis|frontend saja|tanpa backend/i.test(archAnswer) && /\b(login|auth|database|prisma|postgres|mysql|rbac)\b/i.test(blueprint.summary)) {
    issues.push({
      severity: 'error',
      code: 'CONTRADICTION_STATIC_WITH_AUTH',
      dimension: 'data_backend',
      message: 'Kontradiksi terdeteksi: arsitektur dipilih "Frontend saja / statis", tetapi deskripsi proyek menyebut autentikasi atau database.',
      suggestedFix: 'Ubah `data_backend.architecture` ke Fullstack dengan API + Database + Auth, atau hapus kebutuhan login/DB ke Non-Goals.',
      followUpQuestion: QUESTION_BANK.find(q => q.id === 'data_backend.architecture')!
    });
  }

  // Contradiction 2: Light-only/Dark-only + theme toggle mentioned
  if ((blueprint.themePolicy.mode === 'light' || blueprint.themePolicy.mode === 'dark') && /toggle tema|theme switcher|switch theme/i.test(corpus)) {
    issues.push({
      severity: 'warning',
      code: 'CONTRADICTION_SINGLE_THEME_TOGGLE',
      dimension: 'design',
      message: `Mode tema disetel ke "${blueprint.themePolicy.mode}", tetapi deskripsi menyebut toggle tema.`,
      suggestedFix: 'Gunakan `both-system` agar toggle Light/Dark berfungsi penuh dan diaudit di kedua tema.'
    });
  }

  // Payment without security policy
  if (/stripe|midtrans|payment gateway nyata/i.test(ecomAnswer) && !asString(answers['integrations.external'])) {
    issues.push({
      severity: 'warning',
      code: 'PAYMENT_SECURITY_POLICY_IMPLICIT',
      dimension: 'integrations',
      message: 'Integrasi payment gateway nyata dipilih tanpa kebijakan keamanan eksplisit; default keamanan ketat (Zod, .env secrets, verifikasi signature webhook) diterapkan otomatis.',
      suggestedFix: 'Konfirmasi kebijakan secret & webhook verification pada `integrations.external`.'
    });
  }

  // Unmeasurable performance criteria
  if (/\b(cepat|fast|ngebut|kencang|smooth)\b/i.test(corpus) && !/lcp|cls|fps|\d+\s*(ms|s)/i.test(perfAnswer)) {
    issues.push({
      severity: 'warning',
      code: 'UNMEASURABLE_PERFORMANCE_CRITERIA',
      dimension: 'performance',
      message: 'Kriteria performa masih kualitatif ("cepat/smooth"). Target terukur default diterapkan: LCP <= 2.5s, CLS <= 0.1, zero console errors.',
      suggestedFix: 'Tetapkan budget angka eksplisit pada `performance.budget`.'
    });
  }

  // Features without acceptance criteria
  const missingAc = blueprint.requirements.filter(r => r.acceptanceCriteria.length === 0);
  if (missingAc.length > 0) {
    issues.push({
      severity: 'error',
      code: 'REQUIREMENTS_MISSING_ACCEPTANCE',
      dimension: 'acceptance',
      message: `${missingAc.length} requirement belum memiliki acceptance criteria yang bisa diverifikasi.`
    });
  }

  return issues;
}

function buildElicitationSchema(questions: InterviewQuestion[]): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const q of questions) {
    properties[q.id] = {
      type: 'string',
      title: q.question,
      description: `${q.why} Default: ${q.recommendedDefault}`,
      ...(q.options && q.options.length > 0 && !q.multiSelect ? { enum: q.options } : {})
    };
    if (q.required) required.push(q.id);
  }
  return { type: 'object', properties, required };
}

function buildLlmRelayPrompt(session: InterviewSession, questions: InterviewQuestion[]): string {
  const lines = [
    `Blueprint Architect Interview — Ronde ${session.currentRound} (Mode: ${session.mode}, Completeness: ${session.completenessScore}%).`,
    'Tanyakan daftar pertanyaan berikut ke user (gunakan tool pertanyaan interaktif host seperti ask_question jika tersedia, atau chat ringkas).',
    'User boleh memilih opsi rekomendasi, memberi jawaban custom, atau melewati (otomatis memakai recommendedDefault sebagai asumsi tercatat).'
  ];
  for (const q of questions) {
    lines.push(`- [${q.id}] ${q.question} (Default: ${q.recommendedDefault})`);
  }
  lines.push(`Setelah user menjawab, panggil craftrig.answer_blueprint_questions dengan sessionId="${session.id}".`);
  return lines.join('\n');
}

export function renderBlueprintMarkdown(blueprint: ProjectBlueprint): string {
  const lines: string[] = [
    `# ${blueprint.title}`,
    '',
    `> Generated by Craftrig Blueprint Architect (${blueprint.source}, mode: ${blueprint.mode}, autonomy: ${blueprint.autonomyMode})`,
    '',
    '## Summary',
    blueprint.summary,
    '',
    '## Tech Stack & Theme Policy',
    `- Framework: ${blueprint.stack.framework ?? 'TBD / Auto-detect'}`,
    `- Styling: ${blueprint.stack.styling ?? 'Modern CSS / Tailwind'}`,
    `- Database: ${blueprint.stack.database ?? 'None (frontend/static)'}`,
    `- Auth: ${blueprint.stack.auth ?? 'None'}`,
    `- Three.js / 3D: ${blueprint.stack.threejs ? 'Enabled' : 'Disabled (skill skipped)'}`,
    `- Custom Motion: ${blueprint.stack.motion ? 'Enabled' : 'Disabled (skill skipped)'}`,
    `- Theme Mode: ${blueprint.themePolicy.mode}${blueprint.themePolicy.direction ? ` (${blueprint.themePolicy.direction})` : ''}`,
    `- Routes: ${blueprint.routes.join(', ')}`,
    ''
  ];

  for (const phase of blueprint.phases) {
    lines.push(`## ${phase.name}`);
    lines.push(`**Goal:** ${phase.goal}`);
    if (phase.dependsOnPhases.length > 0) {
      lines.push(`Depends on: ${phase.dependsOnPhases.join(', ')}`);
    }
    lines.push(`**Routes:** ${phase.routes.join(', ')}`);
    lines.push('### Features & Requirements');
    for (const reqId of phase.requirementIds) {
      const req = blueprint.requirements.find(r => r.id === reqId);
      if (req) {
        lines.push(`- [ ] **${req.id}** (${req.priority.toUpperCase()}): ${req.title}`);
        for (const ac of req.acceptanceCriteria) {
          lines.push(`  - AC: ${ac}`);
        }
      }
    }
    lines.push('');
  }

  if (blueprint.nonGoals.length > 0) {
    lines.push('## Non-Goals');
    for (const ng of blueprint.nonGoals) lines.push(`- ${ng}`);
    lines.push('');
  }

  if (blueprint.assumptions.length > 0) {
    lines.push('## Assumptions');
    for (const a of blueprint.assumptions) lines.push(`- ${a}`);
    lines.push('');
  }

  return lines.join('\n');
}

export interface StartInterviewInput {
  initialIdea: string;
  title?: string;
  mode?: InterviewMode;
  preset?: BlueprintPresetId;
}

export interface InterviewRoundResponse {
  status: 'in_progress' | 'needs_lint_resolution' | 'completed';
  sessionId: string;
  mode: InterviewMode;
  round: number;
  completenessScore: number;
  threshold: number;
  dimensionScores: Record<string, number>;
  detectedRepo: DetectedRepoContext;
  assumptions: Record<string, string>;
  questions: InterviewQuestion[];
  elicitationSchema: Record<string, unknown> | null;
  llmRelayPrompt: string | null;
  lintIssues: BlueprintLintIssue[];
  blueprint: ProjectBlueprint | null;
  nextAction: string;
}

export class BlueprintArchitectService {
  constructor(
    private readonly repository: StateRepository,
    private readonly repoScanner: RepoScannerPort,
    private readonly artifactWriter?: BlueprintArtifactWriterPort
  ) {}

  async startInterview(input: StartInterviewInput): Promise<InterviewRoundResponse> {
    const idea = input.initialIdea.trim();
    if (idea.length < 5) {
      throw new ValidationError('initialIdea must be at least 5 characters.');
    }

    const mode: InterviewMode = input.mode ?? 'deep';
    const preset = detectPreset(idea, input.preset);
    const detectedRepo = await this.repoScanner.scan();
    const timestamp = now();
    const prefilledAnswers: Record<string, string | string[]> = {};
    const assumptions: Record<string, string> = { ...detectedRepo.assumptions };

    // Pre-fill answers that are unambiguously detected from the repo or idea
    if (detectedRepo.hasThreeJs) {
      prefilledAnswers['threejs_motion.need'] = 'Ya, butuh 3D WebGL / Three.js interaktif (terdeteksi dari package.json)';
    }
    if (detectedRepo.hasDatabase && detectedRepo.hasAuth) {
      prefilledAnswers['data_backend.architecture'] = 'Fullstack lengkap dengan API + Database + Autentikasi (terdeteksi dari package.json)';
    } else if (detectedRepo.hasDatabase) {
      prefilledAnswers['data_backend.architecture'] = 'Fullstack dengan REST/Route API + Database (terdeteksi dari package.json)';
    }

    const session: InterviewSession = {
      id: randomUUID(),
      title: input.title?.trim() || idea.slice(0, 80),
      initialIdea: idea,
      mode,
      preset,
      status: 'in_progress',
      currentRound: 1,
      detectedRepo,
      answers: prefilledAnswers,
      skippedAsDefault: [],
      assumptions,
      completenessScore: 0,
      dimensionScores: {},
      blueprintId: null,
      createdAt: timestamp,
      updatedAt: timestamp
    };

    const { score, dimensionScores, unanswered } = computeCompleteness(session);
    session.completenessScore = score;
    session.dimensionScores = dimensionScores;

    await this.repository.transact(state => {
      state.interviews = state.interviews ?? {};
      state.interviews[session.id] = session;
    });

    const roundQuestions = unanswered.slice(0, 4).map(({ minMode: _m, condition: _c, ...q }) => q);
    return {
      status: 'in_progress',
      sessionId: session.id,
      mode: session.mode,
      round: session.currentRound,
      completenessScore: session.completenessScore,
      threshold: COMPLETENESS_THRESHOLD[session.mode],
      dimensionScores: session.dimensionScores,
      detectedRepo,
      assumptions: session.assumptions,
      questions: roundQuestions,
      elicitationSchema: roundQuestions.length > 0 ? buildElicitationSchema(roundQuestions) : null,
      llmRelayPrompt: roundQuestions.length > 0 ? buildLlmRelayPrompt(session, roundQuestions) : null,
      lintIssues: [],
      blueprint: null,
      nextAction: 'Present questions[] to the user (via host ask_question / form elicitation / chat) and submit answers via craftrig.answer_blueprint_questions.'
    };
  }

  async answerQuestions(input: {
    sessionId: string;
    answers: Record<string, string | string[]>;
    skipWithDefaults?: string[];
    finalizeNow?: boolean;
  }): Promise<InterviewRoundResponse> {
    const state = await this.repository.read();
    const existing = state.interviews?.[input.sessionId];
    if (!existing) throw new NotFoundError('InterviewSession', input.sessionId);

    const session: InterviewSession = structuredClone(existing);
    for (const [qId, val] of Object.entries(input.answers)) {
      if (Array.isArray(val) ? val.length > 0 : val.trim().length > 0) {
        session.answers[qId] = val;
      }
    }

    for (const skippedId of input.skipWithDefaults ?? []) {
      const spec = QUESTION_BANK.find(q => q.id === skippedId);
      if (spec && !session.answers[skippedId]) {
        session.answers[skippedId] = spec.recommendedDefault;
        if (!session.skippedAsDefault.includes(skippedId)) {
          session.skippedAsDefault.push(skippedId);
        }
        session.assumptions[skippedId] = `Default diterapkan (dilewati user): ${spec.recommendedDefault}`;
      }
    }

    if (input.finalizeNow) {
      for (const spec of getApplicableQuestions(session)) {
        if (!session.answers[spec.id]) {
          session.answers[spec.id] = spec.recommendedDefault;
          if (!session.skippedAsDefault.includes(spec.id)) {
            session.skippedAsDefault.push(spec.id);
          }
          session.assumptions[spec.id] = `Default otomatis (finalizeNow): ${spec.recommendedDefault}`;
        }
      }
    }

    session.currentRound += 1;
    session.updatedAt = now();
    const { score, dimensionScores, unanswered } = computeCompleteness(session);
    session.completenessScore = score;
    session.dimensionScores = dimensionScores;

    const threshold = COMPLETENESS_THRESHOLD[session.mode];
    const readyToCompile = input.finalizeNow || (score >= threshold && unanswered.filter(q => q.required).length === 0) || unanswered.length === 0;

    if (!readyToCompile) {
      await this.repository.transact(s => {
        s.interviews = s.interviews ?? {};
        s.interviews[session.id] = session;
      });
      const roundQuestions = unanswered.slice(0, 4).map(({ minMode: _m, condition: _c, ...q }) => q);
      return {
        status: 'in_progress',
        sessionId: session.id,
        mode: session.mode,
        round: session.currentRound,
        completenessScore: session.completenessScore,
        threshold,
        dimensionScores: session.dimensionScores,
        detectedRepo: session.detectedRepo,
        assumptions: session.assumptions,
        questions: roundQuestions,
        elicitationSchema: buildElicitationSchema(roundQuestions),
        llmRelayPrompt: buildLlmRelayPrompt(session, roundQuestions),
        lintIssues: [],
        blueprint: null,
        nextAction: `Ask round ${session.currentRound} questions (${roundQuestions.length} item(s)) and call craftrig.answer_blueprint_questions again.`
      };
    }

    // Fill any optional unanswered questions with defaults before compiling
    for (const q of unanswered) {
      session.answers[q.id] = q.recommendedDefault;
      session.assumptions[q.id] = `Default rekomendasi: ${q.recommendedDefault}`;
    }

    const blueprint = this.compileBlueprint(session);
    const lintIssues = lintBlueprint(blueprint, session.answers);
    blueprint.lintIssues = lintIssues;

    const blockingErrors = lintIssues.filter(issue => issue.severity === 'error');
    if (blockingErrors.length > 0 && !input.finalizeNow) {
      session.status = 'needs_lint_resolution';
      await this.repository.transact(s => {
        s.interviews = s.interviews ?? {};
        s.interviews[session.id] = session;
      });
      const followUps = blockingErrors
        .map(err => err.followUpQuestion)
        .filter((q): q is InterviewQuestion => Boolean(q));
      return {
        status: 'needs_lint_resolution',
        sessionId: session.id,
        mode: session.mode,
        round: session.currentRound,
        completenessScore: session.completenessScore,
        threshold,
        dimensionScores: session.dimensionScores,
        detectedRepo: session.detectedRepo,
        assumptions: session.assumptions,
        questions: followUps,
        elicitationSchema: followUps.length > 0 ? buildElicitationSchema(followUps) : null,
        llmRelayPrompt: followUps.length > 0 ? buildLlmRelayPrompt(session, followUps) : null,
        lintIssues,
        blueprint: null,
        nextAction: 'Resolve blocking blueprint lint contradiction(s) with the user via craftrig.answer_blueprint_questions.'
      };
    }

    if (this.artifactWriter) {
      const markdown = renderBlueprintMarkdown(blueprint);
      const written = await this.artifactWriter.write(blueprint, markdown);
      blueprint.markdownPath = written.markdownPath;
      blueprint.jsonPath = written.jsonPath;
    }

    session.status = 'completed';
    session.completenessScore = 100;
    session.blueprintId = blueprint.id;

    await this.repository.transact(s => {
      s.interviews = s.interviews ?? {};
      s.blueprints = s.blueprints ?? {};
      s.interviews[session.id] = session;
      s.blueprints[blueprint.id] = blueprint;
    });

    return {
      status: 'completed',
      sessionId: session.id,
      mode: session.mode,
      round: session.currentRound,
      completenessScore: 100,
      threshold,
      dimensionScores: session.dimensionScores,
      detectedRepo: session.detectedRepo,
      assumptions: session.assumptions,
      questions: [],
      elicitationSchema: null,
      llmRelayPrompt: null,
      lintIssues,
      blueprint,
      nextAction: `Blueprint "${blueprint.title}" (${blueprint.id}) is ready with ${blueprint.phases.length} phases and ${blueprint.requirements.length} requirements. Ask user for quick approval, then call craftrig.ingest_blueprint with blueprintId="${blueprint.id}" and run craftrig.autopilot_next until done.`
    };
  }

  private compileBlueprint(session: InterviewSession): ProjectBlueprint {
    const ans = (id: string) => asString(session.answers[id]);
    const archAns = ans('data_backend.architecture');
    const threeAns = ans('threejs_motion.need');
    const themeAns = ans('design.theme');
    const autonomyAns = ans('autonomy.mode');
    const presetMeta = PRESET_SIGNALS.find(p => p.id === session.preset);

    const hasBackend = hasYesSignal(archAns);
    const hasAuth = hasBackend && /auth|login|rbac|role/i.test(`${archAns} ${ans('data_backend.entities')}`);
    const declinedThreeJs = /tidak perlu 3d|tanpa 3d|no 3d|skip 3d/i.test(threeAns);
    const hasThreeJs = !declinedThreeJs && (/3d|three|webgl|showroom/i.test(threeAns) || session.detectedRepo.hasThreeJs);
    const hasMotion = /motion|animasi|framer|gsap/i.test(threeAns) && !/tidak perlu 3d; cukup micro/i.test(threeAns);

    const domains = new Set<WorkDomain>(['frontend', 'design', 'responsive']);
    if (hasBackend) { domains.add('backend'); domains.add('data'); }
    if (hasAuth || /payment|stripe|midtrans/i.test(ans('integrations.ecommerce'))) domains.add('security');
    if (hasThreeJs) domains.add('threejs');
    if (hasMotion) domains.add('motion');
    for (const d of detectDomainsFromText(session.initialIdea)) {
      if (d === 'threejs' && !hasThreeJs) continue;
      if (d === 'motion' && !hasMotion) continue;
      if ((d === 'backend' || d === 'data') && !hasBackend) continue;
      domains.add(d);
    }

    const themeMode: ProjectBlueprint['themePolicy']['mode'] =
      /light\s*\+\s*dark|fleksibel|system/i.test(themeAns) ? 'both-system'
      : /dark mode saja|dark saja/i.test(themeAns) ? 'dark'
      : /light mode saja|light saja/i.test(themeAns) ? 'light'
      : 'both-system';

    const autonomyMode: AutonomyMode = /phase-gate|berhenti/i.test(autonomyAns) ? 'phase-gate' : 'full-auto';

    const routes = [
      ...new Set([
        ...(session.detectedRepo.existingRoutes.length > 0 ? session.detectedRepo.existingRoutes : []),
        ...(presetMeta?.defaultRoutes ?? ['/'])
      ])
    ];

    const requirements: BlueprintRequirement[] = [];
    const phases: BlueprintPhase[] = [];
    let reqSeq = 1;
    const nextReqId = () => `REQ-${String(reqSeq++).padStart(3, '0')}`;

    // Phase 0: Foundation & Design Contract
    const phase0Id = 'phase-0-foundation';
    const r0 = nextReqId();
    const p0Domains: WorkDomain[] = ['frontend', 'design', ...(hasBackend ? ['backend', 'data'] as WorkDomain[] : [])];
    requirements.push({
      id: r0,
      phaseId: phase0Id,
      title: `Project architecture, design tokens (${themeMode}), and base layout shell`,
      priority: 'must',
      acceptanceCriteria: [
        'Project builds and passes typecheck with zero errors.',
        `Semantic design tokens support theme mode: ${themeMode}.`
      ],
      domains: p0Domains
    });
    phases.push({
      id: phase0Id,
      order: 0,
      name: 'Phase 0 — Foundation & Design Contract',
      goal: 'Establish clean architecture boundaries, semantic design tokens, typography, and layout shell.',
      dependsOnPhases: [],
      features: ['Architecture & shared contracts', `Design system (${ans('design.direction') || 'Editorial Minimal'})`],
      routes: ['/'],
      domains: p0Domains,
      requirementIds: [r0],
      acceptanceCriteria: ['Build & typecheck pass cleanly with design tokens verified.']
    });

    let phaseOrder = 1;
    const parallelFeaturePhaseIds: string[] = [];

    // Backend / Auth / Data Phase (if needed)
    if (hasBackend || hasAuth) {
      const backendPhaseId = `phase-${phaseOrder}-backend-data`;
      const rApi = nextReqId();
      const bDomains: WorkDomain[] = ['backend', 'data', ...(hasAuth ? ['security'] as WorkDomain[] : [])];
      requirements.push({
        id: rApi,
        phaseId: backendPhaseId,
        title: `Data schema, validated API endpoints${hasAuth ? ', and authentication/RBAC' : ''}`,
        priority: 'must',
        acceptanceCriteria: [
          'All API boundaries validate input with explicit schemas and safe error handling.',
          hasAuth ? 'Protected routes enforce authentication and least-privilege permissions.' : 'CRUD endpoints pass integration checks.'
        ],
        domains: bDomains
      });
      phases.push({
        id: backendPhaseId,
        order: phaseOrder++,
        name: `Phase ${phaseOrder - 1} — Backend API, Data Model${hasAuth ? ' & Auth' : ''}`,
        goal: ans('data_backend.entities') || 'Implement validated backend services and data persistence.',
        dependsOnPhases: [phase0Id],
        features: ['Domain models & database schema', 'Validated API endpoints', ...(hasAuth ? ['Authentication & access control'] : [])],
        routes: hasAuth ? ['/login', '/register'] : ['/'],
        domains: bDomains,
        requirementIds: [rApi],
        acceptanceCriteria: ['Backend tests & contract validation pass without secrets in repo.']
      });
      parallelFeaturePhaseIds.push(backendPhaseId);
    }

    // Core UI / Feature Phases from preset or user scope
    const coreFeatures = presetMeta?.defaultFeatures ?? ['Core Experience & Primary Views', 'Secondary Workflows & Edge States'];
    const corePhaseId = `phase-${phaseOrder}-core-ui`;
    const coreReqIds: string[] = [];
    for (const feat of coreFeatures.slice(0, 3)) {
      const reqId = nextReqId();
      coreReqIds.push(reqId);
      requirements.push({
        id: reqId,
        phaseId: corePhaseId,
        title: feat,
        priority: 'must',
        acceptanceCriteria: [
          `${feat} renders cleanly across mobile & desktop viewports with zero horizontal overflow.`,
          `Passes WCAG contrast check (${ans('accessibility.standard') || 'WCAG 2.2 AA'}) in all enabled themes.`
        ],
        domains: ['frontend', 'design', 'responsive']
      });
    }
    phases.push({
      id: corePhaseId,
      order: phaseOrder++,
      name: `Phase ${phaseOrder - 1} — Core Pages & Primary Features`,
      goal: `Deliver ${coreFeatures.slice(0, 3).join(', ')} with responsive layout and edge states.`,
      dependsOnPhases: [phase0Id],
      features: coreFeatures.slice(0, 3),
      routes: routes.slice(0, 4),
      domains: ['frontend', 'design', 'responsive', ...(hasMotion ? ['motion'] as WorkDomain[] : [])],
      requirementIds: coreReqIds,
      acceptanceCriteria: [
        ans('pages.edge_states') || 'Loading, empty, and error states handled cleanly.',
        ans('performance.budget') || 'LCP <= 2.5s, CLS <= 0.1, zero console errors.'
      ]
    });
    parallelFeaturePhaseIds.push(corePhaseId);

    // 3D Showroom Phase (ONLY if 3D requested!)
    if (hasThreeJs) {
      const threePhaseId = `phase-${phaseOrder}-3d-experience`;
      const r3d = nextReqId();
      requirements.push({
        id: r3d,
        phaseId: threePhaseId,
        title: 'Interactive Three.js / WebGL 3D experience with PBR materials and lifecycle cleanup',
        priority: 'must',
        acceptanceCriteria: [
          ans('threejs_motion.detail') || 'Sculpted multi-part PBR meshes with RoomEnvironment IBL and smooth curves.',
          'Zero blank WebGL canvases, zero shader warnings, and proper geometry/material disposal on unmount.'
        ],
        domains: ['threejs', 'frontend']
      });
      phases.push({
        id: threePhaseId,
        order: phaseOrder++,
        name: `Phase ${phaseOrder - 1} — Interactive 3D / WebGL Experience`,
        goal: 'Build sculpted Three.js scenes with PBR shading, responsive framing, and GPU fallback.',
        dependsOnPhases: [phase0Id],
        features: ['Sculpted 3D Geometry & PBR Materials', 'Interactive Camera/Controls & GPU Fallback'],
        routes: routes.filter(r => /3d|showroom|atelier/i.test(r)).length > 0
          ? routes.filter(r => /3d|showroom|atelier/i.test(r))
          : ['/showroom'],
        domains: ['threejs', 'frontend'],
        requirementIds: [r3d],
        acceptanceCriteria: ['WebGL audit passes with rendered non-blank canvas and <= 4 WebGL contexts.']
      });
      parallelFeaturePhaseIds.push(threePhaseId);
    }

    // Transactional / Integration / Final Workflow Phase (depends on prior feature phases)
    const remainingFeatures = coreFeatures.slice(3);
    if (remainingFeatures.length > 0 || ans('integrations.ecommerce')) {
      const flowPhaseId = `phase-${phaseOrder}-workflows-integration`;
      const rFlow = nextReqId();
      const flowDomains: WorkDomain[] = ['frontend', ...(hasBackend ? ['backend', 'security'] as WorkDomain[] : [])];
      const flowTitle = remainingFeatures.length > 0
        ? remainingFeatures.join(' & ')
        : 'Checkout, Integrations & End-to-End Flow';
      requirements.push({
        id: rFlow,
        phaseId: flowPhaseId,
        title: flowTitle,
        priority: 'must',
        acceptanceCriteria: [
          ans('integrations.ecommerce') || 'End-to-end user journey completes without errors.',
          'Interactive Playwright scenario verifies key user flows.'
        ],
        domains: flowDomains
      });
      phases.push({
        id: flowPhaseId,
        order: phaseOrder++,
        name: `Phase ${phaseOrder - 1} — End-to-End Workflows & Integrations`,
        goal: `Connect upstream phases into complete user flows: ${flowTitle}.`,
        dependsOnPhases: [...parallelFeaturePhaseIds],
        features: remainingFeatures.length > 0 ? remainingFeatures : [flowTitle],
        routes: routes.filter(r => /cart|checkout|order|settings|contact/i.test(r)).length > 0
          ? routes.filter(r => /cart|checkout|order|settings|contact/i.test(r))
          : routes.slice(-2),
        domains: flowDomains,
        requirementIds: [rFlow],
        acceptanceCriteria: [ans('acceptance.dod') || 'All end-to-end journeys verified with evidence.']
      });
    }

    const timestamp = now();
    return {
      id: randomUUID(),
      title: session.title,
      summary: `${session.initialIdea} | Audience: ${ans('goal.audience')} | Scope: ${ans('scope.features')}`,
      mode: session.mode,
      source: 'interview',
      stack: {
        framework: session.detectedRepo.framework,
        styling: session.detectedRepo.hasTailwind ? 'Tailwind CSS' : 'Modern CSS',
        database: hasBackend ? (session.detectedRepo.hasDatabase ? 'Detected ORM/DB' : 'SQLite / Prisma') : null,
        auth: hasAuth ? (session.detectedRepo.hasAuth ? 'Detected Auth' : 'Session/JWT Auth') : null,
        threejs: hasThreeJs,
        motion: hasMotion
      },
      themePolicy: {
        mode: themeMode,
        direction: ans('design.direction') || null
      },
      autonomyMode,
      routes,
      domains: [...domains],
      nonGoals: ans('scope.nongoals') ? [ans('scope.nongoals')] : ['No automatic production deployment without explicit user authorization.'],
      assumptions: Object.values(session.assumptions),
      requirements,
      phases,
      lintIssues: [],
      markdownPath: null,
      jsonPath: null,
      createdAt: timestamp,
      updatedAt: timestamp
    };
  }
}
