import type { HarnessState } from './models.js';

export interface StateRepository {
  read(): Promise<HarnessState>;
  transact<T>(operation: (state: HarnessState) => T | Promise<T>): Promise<T>;
}

export interface BrowserInspectorPort {
  discoverRoutes(baseUrl: string, timeoutMs: number): Promise<{ baseUrl: string; routes: string[]; discoveredAt: string }>;
  inspectResponsive(input: ResponsiveInspectionInput): Promise<ResponsiveInspectionReport>;
  runInteractionScenario(input: InteractionScenarioInput): Promise<InteractionScenarioReport>;
  auditVisualA11y(input: VisualA11yAuditInput): Promise<VisualA11yAuditReport>;
}

export type ColorSchemeMode = 'light' | 'dark';
export type SectionPolarityMode =
  | 'follow-active-theme'
  | 'contrast-bands'
  | 'always-dark-media-showcase'
  | 'always-light-reading'
  | 'custom';

export interface VisualA11yAuditInput {
  baseUrl: string;
  routes: string[];
  colorSchemes: ColorSchemeMode[];
  viewports: ViewportProfile[];
  expectedSectionPolarity?: SectionPolarityMode;
  themeToggleSelector?: string;
  testReducedMotion: boolean;
  evidenceDirectory: string;
  timeoutMs: number;
}

export interface AxeViolationSummary {
  id: string;
  impact: string | null;
  help: string;
  description: string;
  targets: string[];
  failureSummary: string;
}

export interface ContrastDefect {
  selector: string;
  textSample: string;
  foreground: string;
  background: string;
  ratio: number;
  requiredRatio: number;
  fontSizePx: number;
  isLargeText: boolean;
  source: 'axe' | 'dom-composited';
}

export interface IncompleteContrastItem {
  selector: string;
  textSample: string;
  reason: string;
  foreground?: string;
  background?: string;
}

export interface TypographyIssue {
  selector: string;
  kind: 'tiny-text' | 'clipped-text' | 'wide-measure' | 'font-load-error';
  detail: string;
}

export interface TargetSizeIssue {
  selector: string;
  width: number;
  height: number;
  requiredWidth: number;
  requiredHeight: number;
}

export interface OcclusionIssue {
  selector: string;
  occludingSelector: string;
  textSample: string;
}

export interface PolarityMismatchIssue {
  selector: string;
  background: string;
  luminance: number;
  detail: string;
}

export interface VisualA11yCaseResult {
  route: string;
  colorScheme: ColorSchemeMode;
  viewport: ViewportProfile;
  finalUrl: string;
  axeViolations: AxeViolationSummary[];
  contrastIssues: ContrastDefect[];
  incompleteContrast: IncompleteContrastItem[];
  typographyIssues: TypographyIssue[];
  targetSizeIssues: TargetSizeIssue[];
  occlusionIssues: OcclusionIssue[];
  polarityIssues: PolarityMismatchIssue[];
  reducedMotionHiddenCount: number;
  fontErrors: string[];
  clsScore: number | null;
  ariaSnapshotPath: string;
  screenshotPath: string;
  tracePath?: string | null | undefined;
  cdpMetrics?: {
    jsHeapUsedSize?: number | undefined;
    jsHeapTotalSize?: number | undefined;
    nodes?: number | undefined;
    layoutCount?: number | undefined;
    recalcStyleCount?: number | undefined;
  } | null | undefined;
  consoleErrors: string[];
  pageErrors: string[];
  passed: boolean;
  issues: string[];
}

export interface ThemeToggleVerification {
  tested: boolean;
  selector: string;
  changed: boolean;
  beforeState: string;
  afterState: string;
  detail: string;
}

export interface VisualA11yAuditReport {
  runId: string;
  baseUrl: string;
  startedAt: string;
  finishedAt: string;
  testedColorSchemes: ColorSchemeMode[];
  totalCases: number;
  passedCases: number;
  failedCases: number;
  totalContrastViolations: number;
  totalAxeViolations: number;
  totalIncompleteContrast: number;
  themeToggleCheck: ThemeToggleVerification | null;
  overallStatus: 'pass' | 'fail';
  results: VisualA11yCaseResult[];
  reportPath: string;
}

export interface ResponsiveInspectionInput {
  baseUrl: string;
  routes: string[];
  viewports: ViewportProfile[];
  evidenceDirectory: string;
  timeoutMs: number;
  allowedOverflowSelectors: string[];
}

export interface ViewportProfile {
  name: string;
  width: number;
  height: number;
  isMobile: boolean;
  hasTouch: boolean;
  deviceScaleFactor: number;
}

export interface ResponsiveViewportResult {
  route: string;
  viewport: ViewportProfile;
  finalUrl: string;
  documentWidth: number;
  viewportWidth: number;
  horizontalOverflow: number;
  overflowElements: Array<{ selector: string; scrollWidth: number; clientWidth: number }>;
  outOfBoundsElements: Array<{ selector: string; left: number; right: number; width: number }>;
  consoleErrors: string[];
  pageErrors: string[];
  failedRequests: string[];
  httpErrors: Array<{ status: number; url: string }>;
  screenshotPath: string;
  tracePath?: string | null | undefined;
  cdpMetrics?: {
    jsHeapUsedSize?: number | undefined;
    jsHeapTotalSize?: number | undefined;
    nodes?: number | undefined;
    layoutCount?: number | undefined;
    recalcStyleCount?: number | undefined;
  } | null | undefined;
  passed: boolean;
  issues: string[];
}

export interface ResponsiveInspectionReport {
  runId: string;
  baseUrl: string;
  startedAt: string;
  finishedAt: string;
  routeCount: number;
  viewportCount: number;
  totalCases: number;
  passedCases: number;
  failedCases: number;
  overallStatus: 'pass' | 'fail';
  results: ResponsiveViewportResult[];
  reportPath: string;
}

export interface InteractionAction {
  action: 'click' | 'fill' | 'check' | 'uncheck' | 'select' | 'press' | 'expect-visible' | 'expect-text';
  selector: string;
  value?: string;
  timeoutMs?: number;
}

export interface InteractionScenarioInput {
  baseUrl: string;
  route: string;
  actions: InteractionAction[];
  evidenceDirectory: string;
  timeoutMs: number;
  allowRiskyActions: boolean;
}

export interface InteractionScenarioReport {
  runId: string;
  route: string;
  passed: boolean;
  startedAt: string;
  finishedAt: string;
  steps: Array<{ action: string; selector: string; status: 'pass' | 'fail' | 'skipped'; error?: string }>;
  consoleErrors: string[];
  pageErrors: string[];
  failedRequests: string[];
  httpErrors: Array<{ status: number; url: string }>;
  screenshotPath: string;
  reportPath: string;
}

export interface DevServerPort {
  start(packageManager: 'npm' | 'pnpm' | 'yarn' | 'bun', script: 'dev' | 'start' | 'preview'): Promise<{ id: string; pid: number | null; status: string }>;
  ensure(packageManager: 'npm' | 'pnpm' | 'yarn' | 'bun', script: 'dev' | 'start' | 'preview'): Promise<{ id: string; pid: number | null; status: string; reused: boolean }>;
  status(id: string): Promise<unknown>;
  stop(id: string): Promise<{ id: string; status: string }>;
  stopAll(): Promise<void>;
}
