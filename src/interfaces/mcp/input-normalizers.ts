import type { StartInterviewInput } from '../../application/blueprint-architect.js';
import type { CreatePlanInput } from '../../application/task-planner.js';
import type { ListFileLocksFilter } from '../../application/task-service.js';
import type { AutonomyMode, BlueprintPresetId, InterviewMode } from '../../domain/blueprint.js';
import type { ColorSchemeMode, InteractionAction, ScreenshotCaptureMode, SectionPolarityMode, ViewportProfile, VisualA11yAuditInput } from '../../domain/ports.js';
import type { WorkDomain } from '../../domain/models.js';

/**
 * Shape emitted by the MCP/Zod adapter. With exactOptionalPropertyTypes,
 * optional input fields may be present with `undefined`, while domain inputs
 * represent absence by omitting the property entirely.
 */
export interface CreatePlanToolInput {
  title: string;
  request: string;
  domains?: WorkDomain[] | undefined;
  maxRepairIterations?: number | undefined;
}

export interface ClaimTaskToolInput {
  taskId: string;
  agentId: string;
  ownedPaths?: string[] | undefined;
  leaseTimeoutMinutes?: number | undefined;
}

export interface ClaimReadyBatchItemToolInput {
  taskId: string;
  agentId: string;
  ownedPaths?: string[] | undefined;
  leaseTimeoutMinutes?: number | undefined;
}

export interface ClaimReadyBatchToolInput {
  planId: string;
  claims: ClaimReadyBatchItemToolInput[];
}

export interface ReleaseFileLocksToolInput {
  taskId: string;
  agentId: string;
  paths?: string[] | undefined;
}

export interface ListFileLocksToolInput {
  planId?: string | undefined;
  taskId?: string | undefined;
  path?: string | undefined;
}

export interface InteractionActionToolInput {
  action: InteractionAction['action'];
  selector: string;
  value?: string | undefined;
  timeoutMs?: number | undefined;
}

/** Convert transport input into the stricter application-layer contract. */
export function toCreatePlanInput(input: CreatePlanToolInput): CreatePlanInput {
  return {
    title: input.title,
    request: input.request,
    ...(input.domains !== undefined ? { domains: input.domains } : {}),
    ...(input.maxRepairIterations !== undefined
      ? { maxRepairIterations: input.maxRepairIterations }
      : {})
  };
}

/** Remove absent ownedPaths before crossing into TaskService. */
export function toClaimTaskInput(input: ClaimTaskToolInput): { taskId: string; agentId: string; ownedPaths?: string[]; leaseTimeoutMs?: number } {
  return {
    taskId: input.taskId,
    agentId: input.agentId,
    ...(input.ownedPaths !== undefined ? { ownedPaths: input.ownedPaths } : {}),
    ...(input.leaseTimeoutMinutes !== undefined ? { leaseTimeoutMs: input.leaseTimeoutMinutes * 60 * 1000 } : {})
  };
}

export function toClaimReadyBatchInput(input: ClaimReadyBatchToolInput): {
  planId: string;
  claims: Array<{ taskId: string; agentId: string; ownedPaths?: string[]; leaseTimeoutMs?: number }>;
} {
  return {
    planId: input.planId,
    claims: input.claims.map(claim => ({
      taskId: claim.taskId,
      agentId: claim.agentId,
      ...(claim.ownedPaths !== undefined ? { ownedPaths: claim.ownedPaths } : {}),
      ...(claim.leaseTimeoutMinutes !== undefined ? { leaseTimeoutMs: claim.leaseTimeoutMinutes * 60 * 1000 } : {})
    }))
  };
}

/** Remove absent paths before releasing file locks in TaskService. */
export function toReleaseFileLocksInput(input: ReleaseFileLocksToolInput): { taskId: string; agentId: string; paths?: string[] } {
  return {
    taskId: input.taskId,
    agentId: input.agentId,
    ...(input.paths !== undefined ? { paths: input.paths } : {})
  };
}

/** Remove absent filter fields before listing active file locks. */
export function toListFileLocksFilter(input: ListFileLocksToolInput): ListFileLocksFilter {
  return {
    ...(input.planId !== undefined ? { planId: input.planId } : {}),
    ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
    ...(input.path !== undefined ? { path: input.path } : {})
  };
}

/** Remove absent optional values before crossing into the domain port. */
export function toInteractionActions(
  actions: readonly InteractionActionToolInput[]
): InteractionAction[] {
  return actions.map(action => ({
    action: action.action,
    selector: action.selector,
    ...(action.value !== undefined ? { value: action.value } : {}),
    ...(action.timeoutMs !== undefined ? { timeoutMs: action.timeoutMs } : {})
  }));
}

export interface VisualA11yToolInput {
  baseUrl: string;
  routes: string[];
  colorSchemes: ColorSchemeMode[];
  viewports?: ViewportProfile[] | undefined;
  expectedSectionPolarity?: SectionPolarityMode | undefined;
  themeToggleSelector?: string | undefined;
  testReducedMotion: boolean;
  evidenceDirectory: string;
  timeoutMs: number;
  captureScreenshots?: ScreenshotCaptureMode | undefined;
}

/** Normalize optional visual/a11y audit fields before crossing into BrowserInspectorPort. */
export function toVisualA11yAuditInput(input: VisualA11yToolInput): VisualA11yAuditInput {
  return {
    baseUrl: input.baseUrl,
    routes: input.routes,
    colorSchemes: input.colorSchemes,
    viewports: input.viewports ?? [],
    ...(input.expectedSectionPolarity !== undefined
      ? { expectedSectionPolarity: input.expectedSectionPolarity }
      : {}),
    ...(input.themeToggleSelector !== undefined
      ? { themeToggleSelector: input.themeToggleSelector }
      : {}),
    ...(input.captureScreenshots !== undefined
      ? { captureScreenshots: input.captureScreenshots }
      : {}),
    testReducedMotion: input.testReducedMotion,
    evidenceDirectory: input.evidenceDirectory,
    timeoutMs: input.timeoutMs
  };
}

export function toStartInterviewInput(input: {
  initialIdea: string;
  title?: string | undefined;
  mode?: InterviewMode | undefined;
  preset?: BlueprintPresetId | undefined;
}): StartInterviewInput {
  return {
    initialIdea: input.initialIdea,
    ...(input.title !== undefined ? { title: input.title } : {}),
    ...(input.mode !== undefined ? { mode: input.mode } : {}),
    ...(input.preset !== undefined ? { preset: input.preset } : {})
  };
}

export function toAnswerInterviewInput(input: {
  sessionId: string;
  answers: Record<string, string | string[]>;
  skipWithDefaults?: string[] | undefined;
  finalizeNow?: boolean | undefined;
}): {
  sessionId: string;
  answers: Record<string, string | string[]>;
  skipWithDefaults?: string[];
  finalizeNow?: boolean;
} {
  return {
    sessionId: input.sessionId,
    answers: input.answers,
    ...(input.skipWithDefaults !== undefined ? { skipWithDefaults: input.skipWithDefaults } : {}),
    ...(input.finalizeNow !== undefined ? { finalizeNow: input.finalizeNow } : {})
  };
}

export function toAutopilotNextOptions(input: {
  approvePhaseId?: string | undefined;
  maxWaveSize?: number | undefined;
}): { approvePhaseId?: string; maxWaveSize?: number } {
  return {
    ...(input.approvePhaseId !== undefined ? { approvePhaseId: input.approvePhaseId } : {}),
    ...(input.maxWaveSize !== undefined ? { maxWaveSize: input.maxWaveSize } : {})
  };
}

export function toIngestBlueprintOptions(input: {
  autonomyMode?: AutonomyMode | undefined;
  maxRepairIterations?: number | undefined;
  maxSubagentsPerWave?: number | undefined;
  tokenBudget?: number | null | undefined;
}): {
  autonomyMode?: AutonomyMode;
  maxRepairIterations?: number;
  maxSubagentsPerWave?: number;
  tokenBudget?: number | null;
} {
  return {
    ...(input.autonomyMode !== undefined ? { autonomyMode: input.autonomyMode } : {}),
    ...(input.maxRepairIterations !== undefined ? { maxRepairIterations: input.maxRepairIterations } : {}),
    ...(input.maxSubagentsPerWave !== undefined ? { maxSubagentsPerWave: input.maxSubagentsPerWave } : {}),
    ...(input.tokenBudget !== undefined ? { tokenBudget: input.tokenBudget } : {})
  };
}
