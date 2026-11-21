import path from 'node:path';
import { ValidationError } from '../../domain/errors.js';

export type StateBackendMode = 'auto' | 'json' | 'sqlite';

export interface CraftrigRuntimeConfig {
  workspaceRoot: string;
  stateDirectory: string;
  maxParallelTasks: number;
  maxRepairIterations: number;
  browserTimeoutMs: number;
  evidenceQuotaMb: number;
  stateBackend: StateBackendMode;
  sqliteIdleCloseMs: number;
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

function parseStateBackend(value: string | undefined): StateBackendMode {
  if (value === undefined || value.trim() === '') return 'auto';
  const normalized = value.trim().toLowerCase();
  if (normalized === 'auto' || normalized === 'json' || normalized === 'sqlite') {
    return normalized;
  }
  throw new ValidationError('CRAFTRIG_STATE_BACKEND must be one of: auto, json, sqlite.');
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
    browserTimeoutMs: boundedInteger(env.CRAFTRIG_BROWSER_TIMEOUT_MS ?? env.HARNESS_BROWSER_TIMEOUT_MS, 20_000, 1_000, 120_000, 'CRAFTRIG_BROWSER_TIMEOUT_MS'),
    evidenceQuotaMb: boundedInteger(env.CRAFTRIG_EVIDENCE_QUOTA_MB ?? env.HARNESS_EVIDENCE_QUOTA_MB, 50, 5, 2000, 'CRAFTRIG_EVIDENCE_QUOTA_MB'),
    stateBackend: parseStateBackend(env.CRAFTRIG_STATE_BACKEND ?? env.HARNESS_STATE_BACKEND),
    sqliteIdleCloseMs: boundedInteger(env.CRAFTRIG_SQLITE_IDLE_CLOSE_MS ?? env.HARNESS_SQLITE_IDLE_CLOSE_MS, 30_000, 1_000, 600_000, 'CRAFTRIG_SQLITE_IDLE_CLOSE_MS')
  };
}
