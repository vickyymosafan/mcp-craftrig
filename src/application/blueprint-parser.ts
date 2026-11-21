import { randomUUID } from 'node:crypto';
import type {
  AutonomyMode,
  BlueprintPhase,
  BlueprintRequirement,
  ProjectBlueprint
} from '../domain/blueprint.js';
import type { WorkDomain } from '../domain/models.js';
import { ValidationError } from '../domain/errors.js';

const DOMAIN_PATTERNS: Array<{ domain: WorkDomain; pattern: RegExp }> = [
  { domain: 'frontend', pattern: /frontend|website|web app|ui|ux|page|halaman|dashboard|portfolio|landing|catalog|katalog|checkout|cart|toko|e-?commerce/i },
  { domain: 'backend', pattern: /backend|api|server|service|endpoint|rest|graphql|webhook|payment|stripe|midtrans|worker/i },
  { domain: 'design', pattern: /design|interface|layout|theme|tema|typography|color|warna|component|brand|editorial|luxury/i },
  { domain: 'responsive', pattern: /responsive|mobile|tablet|viewport|breakpoint/i },
  { domain: 'threejs', pattern: /three\.?js|3d|webgl|shader|glsl|showroom|r3f|fiber/i },
  { domain: 'motion', pattern: /animation|animasi|motion|transition|gesture|scroll effect|framer|gsap|parallax/i },
  { domain: 'security', pattern: /security|keamanan|auth|login|register|oauth|jwt|rbac|permission|privacy|payment|checkout/i },
  { domain: 'data', pattern: /database|db|migration|schema|prisma|drizzle|postgres|mysql|sqlite|supabase|model data|inventory|stok/i }
];

export function detectDomainsFromText(text: string): WorkDomain[] {
  const found = DOMAIN_PATTERNS.filter(entry => entry.pattern.test(text)).map(entry => entry.domain);
  const unique = [...new Set(found)];
  return unique.length > 0 ? unique : ['frontend'];
}

function extractRoutes(text: string): string[] {
  const matches = text.match(/(?:^|[\s(`"'])(\/[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_:\[\]-]+)*)/gm) ?? [];
  const routes = new Set<string>(['/']);
  for (const raw of matches) {
    const cleaned = raw.trim().replace(/^[(`"']+|[)`"',.;:]+$/g, '');
    if (!cleaned.startsWith('/')) continue;
    if (/^\/(api\/|node_modules|src\/|dist\/|docs\/|assets\/|images\/)/.test(cleaned)) continue;
    if (cleaned.length <= 48) routes.add(cleaned);
  }
  return [...routes].slice(0, 30);
}

function extractThemeMode(text: string): ProjectBlueprint['themePolicy']['mode'] {
  if (/light\s*(\+|and|dan|\/)\s*dark|dual[- ]theme|system|mengikuti sistem/i.test(text)) return 'both-system';
  if (/dark[- ]only|always[- ]dark|dark saja|hanya dark/i.test(text)) return 'dark';
  if (/light[- ]only|always[- ]light|light saja|hanya light/i.test(text)) return 'light';
  return 'both-system';
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 36) || 'phase';
}

export interface ParseBlueprintMarkdownInput {
  markdown: string;
  title?: string;
  autonomyMode?: AutonomyMode;
}

export function parseMarkdownBlueprint(input: ParseBlueprintMarkdownInput): ProjectBlueprint {
  const markdown = input.markdown.trim();
  if (markdown.length < 20) {
    throw new ValidationError('Blueprint markdown must contain at least 20 characters.');
  }

  const lines = markdown.split(/\r?\n/);
  const h1 = lines.find(line => /^#\s+/.test(line))?.replace(/^#\s+/, '').trim();
  const title = (input.title?.trim() || h1 || 'Project Blueprint').slice(0, 160);

  // Split by ## headings
  interface RawSection {
    heading: string;
    bodyLines: string[];
  }
  const sections: RawSection[] = [];
  let current: RawSection | null = null;
  const introLines: string[] = [];

  for (const line of lines) {
    const headingMatch = line.match(/^##\s+(.+)$/);
    if (headingMatch) {
      if (current) sections.push(current);
      current = { heading: headingMatch[1]!.trim(), bodyLines: [] };
    } else if (current) {
      current.bodyLines.push(line);
    } else if (!/^#\s+/.test(line)) {
      introLines.push(line);
    }
  }
  if (current) sections.push(current);

  const nonGoals: string[] = [];
  const globalAcceptance: string[] = [];
  const rawPhaseSections: RawSection[] = [];

  for (const section of sections) {
    if (/non[- ]?goals|out of scope|tidak termasuk/i.test(section.heading)) {
      for (const line of section.bodyLines) {
        const bullet = line.match(/^\s*[-*]\s+(?:\[[ xX]\]\s*)?(.+)$/);
        if (bullet) nonGoals.push(bullet[1]!.trim());
      }
      continue;
    }
    if (/^(acceptance criteria|definition of done|dod|kriteria terima)$/i.test(section.heading)) {
      for (const line of section.bodyLines) {
        const bullet = line.match(/^\s*[-*]\s+(?:\[[ xX]\]\s*)?(.+)$/);
        if (bullet) globalAcceptance.push(bullet[1]!.trim());
      }
      continue;
    }
    if (/^(tech stack|stack|architecture|overview|summary|ringkasan|assumptions|asumsi)$/i.test(section.heading)) {
      continue;
    }
    rawPhaseSections.push(section);
  }

  const allDomains = detectDomainsFromText(markdown);
  const allRoutes = extractRoutes(markdown);
  const requirements: BlueprintRequirement[] = [];
  const phases: BlueprintPhase[] = [];
  let reqCounter = 1;

  const makeReqId = () => `REQ-${String(reqCounter++).padStart(3, '0')}`;

  // Always check if Phase 0 Foundation exists; if not, create it when there are multiple phases
  const hasExplicitFoundation = rawPhaseSections.some(s => /phase\s*0|foundation|fondasi|setup|scaffold/i.test(s.heading));
  const foundationId = 'phase-0-foundation';

  if (rawPhaseSections.length > 0) {
    if (!hasExplicitFoundation) {
      const reqId = makeReqId();
      const foundationDomains: WorkDomain[] = [...new Set<WorkDomain>([
        ...(allDomains.some(d => ['frontend', 'design', 'responsive', 'threejs', 'motion'].includes(d)) ? ['frontend', 'design'] as WorkDomain[] : []),
        ...(allDomains.includes('backend') ? ['backend'] as WorkDomain[] : []),
        ...(allDomains.includes('data') ? ['data'] as WorkDomain[] : [])
      ])];
      requirements.push({
        id: reqId,
        phaseId: foundationId,
        title: 'Project foundation, architecture boundaries, and shared contracts',
        priority: 'must',
        acceptanceCriteria: ['Build and typecheck pass cleanly with shared design tokens/contracts ready.'],
        domains: foundationDomains.length ? foundationDomains : ['frontend']
      });
      phases.push({
        id: foundationId,
        order: 0,
        name: 'Phase 0 — Foundation & Shared Contracts',
        goal: 'Establish project scaffold, architecture boundaries, design tokens, and shared schemas before feature phases.',
        dependsOnPhases: [],
        features: ['Workspace scaffold & configuration', 'Shared contracts / design system'],
        routes: ['/'],
        domains: foundationDomains.length ? foundationDomains : ['frontend'],
        requirementIds: [reqId],
        acceptanceCriteria: ['Project compiles cleanly and core layout/contracts are in place.']
      });
    }

    let orderIndex = hasExplicitFoundation ? 0 : 1;
    const previousPhaseIds: string[] = hasExplicitFoundation ? [] : [foundationId];

    for (const sec of rawPhaseSections) {
      const bodyText = sec.bodyLines.join('\n');
      const phaseDomains = detectDomainsFromText(`${sec.heading}\n${bodyText}`);
      const phaseRoutes = extractRoutes(`${sec.heading}\n${bodyText}`);
      const bullets = sec.bodyLines
        .map(line => line.match(/^\s*(?:[-*]|\d+\.)\s+(?:\[[ xX]\]\s*)?(.+)$/)?.[1]?.trim())
        .filter((item): item is string => Boolean(item));

      const features = bullets.length > 0 ? bullets.slice(0, 12) : [sec.heading];
      const phaseId = `phase-${orderIndex}-${slugify(sec.heading)}`;
      const phaseReqIds: string[] = [];

      for (const feature of features.slice(0, 6)) {
        const reqId = makeReqId();
        phaseReqIds.push(reqId);
        requirements.push({
          id: reqId,
          phaseId,
          title: feature,
          priority: /optional|nice to have|could/i.test(feature) ? 'could' : 'must',
          acceptanceCriteria: [`Feature "${feature}" is implemented, integrated, and verified without console/type errors.`],
          domains: phaseDomains
        });
      }

      // Infer inter-phase dependencies:
      // - Explicit "Depends on: Phase X" in body
      // - Otherwise depends on foundation (enabling independent feature phases to run in parallel!),
      //   except checkout/integration/polish phases which depend on all prior phases.
      let deps: string[] = [];
      const explicitDepMatch = bodyText.match(/depends?\s+on\s*:\s*(.+)$/im);
      if (explicitDepMatch) {
        const depText = explicitDepMatch[1]!.toLowerCase();
        deps = phases
          .filter(p => depText.includes(p.id) || depText.includes(`phase ${p.order}`) || depText.includes(p.name.toLowerCase()))
          .map(p => p.id);
      }
      if (deps.length === 0) {
        if (orderIndex === 0) {
          deps = [];
        } else if (/checkout|payment|order|integrat|polish|deploy|release|admin|analytics/i.test(sec.heading) && phases.length > 1) {
          deps = phases.map(p => p.id);
        } else if (previousPhaseIds.length > 0) {
          deps = [previousPhaseIds[0]!];
        }
      }

      phases.push({
        id: phaseId,
        order: orderIndex,
        name: sec.heading,
        goal: bullets[0] ?? `Deliver ${sec.heading} end-to-end with verified evidence.`,
        dependsOnPhases: [...new Set(deps)],
        features,
        routes: phaseRoutes.length > 0 ? phaseRoutes : ['/'],
        domains: phaseDomains,
        requirementIds: phaseReqIds,
        acceptanceCriteria: globalAcceptance.length > 0
          ? globalAcceptance.slice(0, 4)
          : [`All ${sec.heading} requirements (${phaseReqIds.join(', ')}) pass build and automated checks.`]
      });

      if (orderIndex === 0) previousPhaseIds.push(phaseId);
      orderIndex++;
    }
  } else {
    // Freeform paragraph blueprint without headings: synthesize sensible multi-phase plan
    const req0 = makeReqId();
    phases.push({
      id: foundationId,
      order: 0,
      name: 'Phase 0 — Foundation & Design Contract',
      goal: 'Set up architecture, shared tokens, and base structure.',
      dependsOnPhases: [],
      features: ['Core architecture & tokens'],
      routes: ['/'],
      domains: allDomains.filter(d => ['frontend', 'design', 'backend', 'data'].includes(d)),
      requirementIds: [req0],
      acceptanceCriteria: ['Project compiles cleanly with design tokens and contracts defined.']
    });
    requirements.push({
      id: req0,
      phaseId: foundationId,
      title: 'Foundation architecture and design system',
      priority: 'must',
      acceptanceCriteria: ['Typecheck and build pass.'],
      domains: allDomains
    });

    const corePhaseId = 'phase-1-core-implementation';
    const req1 = makeReqId();
    phases.push({
      id: corePhaseId,
      order: 1,
      name: 'Phase 1 — Core Feature Implementation',
      goal: markdown.slice(0, 240),
      dependsOnPhases: [foundationId],
      features: [title],
      routes: allRoutes,
      domains: allDomains,
      requirementIds: [req1],
      acceptanceCriteria: ['All routes render cleanly and pass responsive, contrast, and functional checks.']
    });
    requirements.push({
      id: req1,
      phaseId: corePhaseId,
      title: `Deliver ${title}`,
      priority: 'must',
      acceptanceCriteria: ['All routes pass automated verification.'],
      domains: allDomains
    });
  }

  const timestamp = new Date().toISOString();
  return {
    id: randomUUID(),
    title,
    summary: introLines.join(' ').trim().slice(0, 500) || markdown.slice(0, 300),
    mode: 'deep',
    source: 'markdown',
    stack: {
      framework: /next\.?js/i.test(markdown) ? 'Next.js' : /vite|react/i.test(markdown) ? 'React + Vite' : /vue|nuxt/i.test(markdown) ? 'Vue / Nuxt' : /svelte/i.test(markdown) ? 'SvelteKit' : null,
      styling: /tailwind/i.test(markdown) ? 'Tailwind CSS' : /css modules|vanilla css/i.test(markdown) ? 'CSS' : null,
      database: /postgres|supabase/i.test(markdown) ? 'PostgreSQL' : /prisma/i.test(markdown) ? 'Prisma' : /sqlite/i.test(markdown) ? 'SQLite' : /mongo/i.test(markdown) ? 'MongoDB' : null,
      auth: /clerk/i.test(markdown) ? 'Clerk' : /next-?auth|auth\.js/i.test(markdown) ? 'Auth.js' : /jwt|oauth|login|auth/i.test(markdown) ? 'Session/JWT Auth' : null,
      threejs: allDomains.includes('threejs'),
      motion: allDomains.includes('motion')
    },
    themePolicy: {
      mode: extractThemeMode(markdown),
      direction: null
    },
    autonomyMode: input.autonomyMode ?? 'full-auto',
    routes: allRoutes,
    domains: allDomains,
    nonGoals,
    assumptions: [],
    requirements,
    phases,
    lintIssues: [],
    markdownPath: null,
    jsonPath: null,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}
