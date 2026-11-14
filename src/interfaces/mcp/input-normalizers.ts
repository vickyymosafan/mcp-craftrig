import type { CreatePlanInput } from '../../application/task-planner.js';
import type { ListFileLocksFilter } from '../../application/task-service.js';
import type { InteractionAction } from '../../domain/ports.js';
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
export function toClaimTaskInput(input: ClaimTaskToolInput): { taskId: string; agentId: string; ownedPaths?: string[] } {
  return {
    taskId: input.taskId,
    agentId: input.agentId,
    ...(input.ownedPaths !== undefined ? { ownedPaths: input.ownedPaths } : {})
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
