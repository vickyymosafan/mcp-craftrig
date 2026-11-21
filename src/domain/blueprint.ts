import type { WorkDomain } from './models.js';

export type InterviewMode = 'quick' | 'standard' | 'deep';
export type AutonomyMode = 'full-auto' | 'phase-gate';
export type ExecutionMode = 'subagent' | 'tool' | 'inline';
export type ModelTier = 'deep' | 'standard' | 'fast';

export type BlueprintDimension =
  | 'goal'
  | 'scope'
  | 'pages'
  | 'data_backend'
  | 'design'
  | 'threejs_motion'
  | 'responsive'
  | 'accessibility'
  | 'performance'
  | 'content'
  | 'integrations'
  | 'acceptance'
  | 'autonomy';

export type BlueprintPresetId =
  | 'portfolio'
  | 'landing'
  | 'ecommerce'
  | 'saas-dashboard'
  | '3d-showroom'
  | 'fullstack-app';

export interface DetectedRepoContext {
  hasPackageJson: boolean;
  framework: string | null;
  router: string | null;
  hasTailwind: boolean;
  hasThreeJs: boolean;
  hasMotionLib: boolean;
  hasDatabase: boolean;
  hasAuth: boolean;
  hasDarkMode: boolean;
  existingRoutes: string[];
  dependencies: string[];
  assumptions: Record<string, string>;
}

export interface InterviewQuestion {
  id: string;
  dimension: BlueprintDimension;
  question: string;
  options?: string[];
  multiSelect: boolean;
  recommendedDefault: string;
  why: string;
  required: boolean;
  unlocks?: string[];
}

export interface InterviewSession {
  id: string;
  title: string;
  initialIdea: string;
  mode: InterviewMode;
  preset: BlueprintPresetId | null;
  status: 'in_progress' | 'needs_lint_resolution' | 'completed';
  currentRound: number;
  detectedRepo: DetectedRepoContext;
  answers: Record<string, string | string[]>;
  skippedAsDefault: string[];
  assumptions: Record<string, string>;
  completenessScore: number;
  dimensionScores: Record<string, number>;
  blueprintId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BlueprintRequirement {
  id: string;
  phaseId: string;
  title: string;
  priority: 'must' | 'should' | 'could' | 'wont';
  acceptanceCriteria: string[];
  domains: WorkDomain[];
}

export interface BlueprintPhase {
  id: string;
  order: number;
  name: string;
  goal: string;
  dependsOnPhases: string[];
  features: string[];
  routes: string[];
  domains: WorkDomain[];
  requirementIds: string[];
  acceptanceCriteria: string[];
}

export interface BlueprintLintIssue {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  dimension?: BlueprintDimension;
  suggestedFix?: string;
  followUpQuestion?: InterviewQuestion;
}

export interface ProjectBlueprint {
  id: string;
  title: string;
  summary: string;
  mode: InterviewMode;
  source: 'interview' | 'markdown' | 'json';
  stack: {
    framework: string | null;
    styling: string | null;
    database: string | null;
    auth: string | null;
    threejs: boolean;
    motion: boolean;
  };
  themePolicy: {
    mode: 'light' | 'dark' | 'both-system' | 'custom';
    direction: string | null;
  };
  autonomyMode: AutonomyMode;
  routes: string[];
  domains: WorkDomain[];
  nonGoals: string[];
  assumptions: string[];
  requirements: BlueprintRequirement[];
  phases: BlueprintPhase[];
  lintIssues: BlueprintLintIssue[];
  markdownPath?: string | null;
  jsonPath?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TaskHandoff {
  summary: string;
  changedFiles: string[];
  contracts: string[];
  decisions: string[];
  testsRun: string[];
}

export interface PlanTelemetry {
  totalPacketTokens: number;
  subagentsSpawned: number;
  subagentsSavedByDeterministicTools: number;
  skillsUsed: string[];
  skillsSkipped: Array<{ skill: string; reason: string }>;
}

export interface RequirementTraceabilityEntry {
  requirementId: string;
  phaseId: string;
  title: string;
  priority: BlueprintRequirement['priority'];
  taskIds: string[];
  completedTaskIds: string[];
  evidenceIds: string[];
  verified: boolean;
}
