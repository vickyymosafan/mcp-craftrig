import path from 'node:path';
import { ValidationError } from '../../domain/errors.js';

export interface CraftrigRuntimeConfig {
  workspaceRoot: string;
  stateDirectory: string;
  maxParallelTasks: number;
  maxRepairIterations: number;
  browserTimeoutMs: number;
}
export type HarnessRuntimeConfig = CraftrigRuntimeConfig;

function boundedInteger(value: string | undefined, fallback: number, minimum: number, maximum: number, variableName: string): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new ValidationError(`${variableName} must be an integer between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

export function createRuntimeConfig(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): CraftrigRuntimeConfig {
  const workspaceRoot = path.resolve(env.CRAFTRIG_WORKSPACE_ROOT ?? env.HARNESS_WORKSPACE_ROOT ?? cwd);
  const stateDirectory = env.CRAFTRIG_STATE_DIR ?? env.HARNESS_STATE_DIR ?? '.craftrig';
  if (path.isAbsolute(stateDirectory)) throw new ValidationError('State directory must be relative to the workspace root.');

  return {
    workspaceRoot,
    stateDirectory,
    maxParallelTasks: boundedInteger(env.CRAFTRIG_MAX_PARALLEL_TASKS ?? env.HARNESS_MAX_PARALLEL_TASKS, 4, 1, 16, 'CRAFTRIG_MAX_PARALLEL_TASKS'),
    maxRepairIterations: boundedInteger(env.CRAFTRIG_MAX_REPAIR_ITERATIONS ?? env.HARNESS_MAX_REPAIR_ITERATIONS, 5, 1, 12, 'CRAFTRIG_MAX_REPAIR_ITERATIONS'),
    browserTimeoutMs: boundedInteger(env.CRAFTRIG_BROWSER_TIMEOUT_MS ?? env.HARNESS_BROWSER_TIMEOUT_MS, 20_000, 1_000, 120_000, 'CRAFTRIG_BROWSER_TIMEOUT_MS')
  };
}
