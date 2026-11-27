import { randomUUID } from 'node:crypto';
import type {
  AutonomyMode,
  ProjectBlueprint,
  RequirementTraceabilityEntry,
  TaskHandoff
} from '../domain/blueprint.js';
import type { StateRepository, GitChangesReaderPort, FileFingerprinterPort } from '../domain/ports.js';
import type { ConventionalCommitArtifact } from '../domain/conventional-commit.js';
import { buildPlanConventionalCommit, type CommitOverrides } from './commit-message-builder.js';
import { buildFinalFileSyncAudit, type FinalFileSyncAudit } from './final-file-sync-audit.js';
import type {
  BatchClaimItem,
  BatchClaimResult,
  EvidenceRecord,
  ExecutionPlan,
  FileFingerprint,
  FileLockRecord,
  HarnessState,
  PlanInsights,
  QualityCheckpoint,
  ServerProcessRecord,
  TaskNode,
  TaskStatus,
  WorkDomain
} from '../domain/models.js';
import { QUALITY_DIMENSIONS } from '../domain/models.js';
import { ConflictError, NotFoundError, ValidationError } from '../domain/errors.js';
import { findLockConflict, normalizeOwnedPath, normalizeOwnedPaths, pathsOverlap } from '../domain/file-ownership.js';
import { computeDownstreamMetrics } from '../domain/dag-validator.js';
import { TaskPlanner, type CreatePlanInput } from './task-planner.js';
import { selectTaskEffortProfile } from './skill-router.js';

const now = () => new Date().toISOString();

function ensureFileLocks(state: HarnessState): Record<string, FileLockRecord> {
  return (state.fileLocks ??= {});
}

function autoRecoverExpiredLeases(state: HarnessState, nowMs = Date.now()): number {
  let recoveredCount = 0;
  const fileLocks = ensureFileLocks(state);
  for (const task of Object.values(state.tasks)) {
    if (task.status === 'in_progress' && task.leaseExpiresAt) {
      const expires = Date.parse(task.leaseExpiresAt);
      if (Number.isFinite(expires) && nowMs > expires) {
        task.status = 'pending';
        task.claimedBy = null;
        task.leaseExpiresAt = null;
        task.updatedAt = new Date(nowMs).toISOString();
        task.failureReason = `Auto-recovered: agent lease expired at ${new Date(expires).toISOString()}`;
        for (const [lockPath, lock] of Object.entries(fileLocks)) {
          if (lock.taskId === task.id) {
            delete fileLocks[lockPath];
          }
        }
        recoveredCount++;
      }
    }
  }
  return recoveredCount;
}

function acquireTaskLocks(
  state: HarnessState,
  task: TaskNode,
  agentId: string,
  pathsToLock: readonly string[],
  timestamp: string,
  expiresAt?: string | null,
  fingerprints?: ReadonlyMap<string, FileFingerprint>
): string[] {
  const normalized = normalizeOwnedPaths(pathsToLock);
  const fileLocks = ensureFileLocks(state);
  const activeLocks = Object.values(fileLocks);

  const sortedCandidates = [...normalized].sort();
  for (const candidate of sortedCandidates) {
    const conflict = findLockConflict(candidate, activeLocks, task.id);
    if (conflict) {
      throw new ConflictError(
        `File ownership conflict: "${candidate}" overlaps with active lock "${conflict.path}" held by agent "${conflict.agentId}" on task "${conflict.taskId}". Hint: wait for task "${conflict.taskId}" to complete or claim disjoint subpaths.`
      );
    }
  }

  for (const candidate of normalized) {
    // Remove any case-variant key owned by the same task to keep locks deduplicated on case-insensitive FS
    const lowerCandidate = candidate.toLowerCase();
    for (const [existingKey, existingLock] of Object.entries(fileLocks)) {
      if (existingLock.taskId === task.id && existingKey.toLowerCase() === lowerCandidate && existingKey !== candidate) {
        delete fileLocks[existingKey];
      }
    }
    const existingRecord = fileLocks[candidate];
    const baselineFingerprint = fingerprints?.get(lowerCandidate) ?? existingRecord?.baselineFingerprint ?? null;
    fileLocks[candidate] = {
      path: candidate,
      planId: task.planId,
      taskId: task.id,
      agentId,
      acquiredAt: timestamp,
      expiresAt: expiresAt ?? null,
      baselineFingerprint
    };
  }
  return normalized;
}

function releaseLocksForTasks(state: HarnessState, taskIds: ReadonlySet<string>): void {
  const fileLocks = ensureFileLocks(state);
  for (const [lockPath, lock] of Object.entries(fileLocks)) {
    if (taskIds.has(lock.taskId)) {
      delete fileLocks[lockPath];
    }
  }
}

function validateVisualOrA11yCheckpointEvidence(dimension: string, attached: readonly EvidenceRecord[]): void {
  if (dimension !== 'typography-color' && dimension !== 'accessibility') return;

  if (attached.every(ev => ev.kind === 'screenshot')) {
    throw new ValidationError(
      `Cannot mark ${dimension} PASS using screenshot evidence alone; run localhost_audit_visual_a11y or attach verified contrast/a11y audit evidence.`
    );
  }

  const visualA11yReports = attached.filter(
    ev => ev.kind === 'browser-report' && ev.metadata.auditType === 'visual-a11y'
  );
  const nonVisualBrowserReports = attached.filter(
    ev => ev.kind === 'browser-report' && ev.metadata.auditType !== 'visual-a11y'
  );

  if (visualA11yReports.length === 0 && nonVisualBrowserReports.length > 0) {
    throw new ValidationError(
      `Cannot mark ${dimension} PASS using responsive/interaction browser reports alone; run localhost_audit_visual_a11y first.`
    );
  }

  for (const report of visualA11yReports) {
    const contrastViolations = Number(report.metadata.totalContrastViolations ?? 0);
    const axeViolations = Number(report.metadata.totalAxeViolations ?? 0);
    if (report.metadata.overallStatus !== 'pass' || contrastViolations > 0 || axeViolations > 0) {
      throw new ValidationError(
        `Cannot mark ${dimension} PASS while visual-a11y audit reports failures (status=${String(report.metadata.overallStatus)}, contrastViolations=${contrastViolations}, axeViolations=${axeViolations}).`
      );
    }

    const expectedSchemes = Array.isArray(report.metadata.expectedColorSchemes)
      ? report.metadata.expectedColorSchemes.map(String)
      : [];
    const testedSchemes = Array.isArray(report.metadata.testedColorSchemes)
      ? new Set(report.metadata.testedColorSchemes.map(String))
      : new Set<string>();
    if (expectedSchemes.some(scheme => !testedSchemes.has(scheme))) {
      throw new ValidationError(
        `Cannot mark ${dimension} PASS: visual-a11y audit did not test all expected color schemes.`
      );
    }
  }
}

export interface ListFileLocksFilter {
  planId?: string;
  taskId?: string;
  path?: string;
}

export interface FileSyncEntry {
  path: string;
  status: 'clean' | 'drifted_on_disk' | 'deleted_on_disk' | 'locked_by_other_agent' | 'untracked_new';
  safeToWrite: boolean;
  recoveryAction: 'proceed' | 'reload_file_before_edit' | 'wait_for_lock_owner';
  lockOwner: { taskId: string; agentId: string; lockPath: string } | null;
  baselineFingerprint: FileFingerprint | null;
  currentFingerprint: FileFingerprint | null;
  detail: string;
}

export interface FileSyncCheckResult {
  allSafeToWrite: boolean;
  conflictsCount: number;
  files: FileSyncEntry[];
  guidance: string;
}

export class TaskService {
  constructor(
    private readonly repository: StateRepository,
    private readonly planner = new TaskPlanner(),
    private readonly gitChangesReader?: GitChangesReaderPort,
    private readonly fileFingerprinter?: FileFingerprinterPort
  ) {}

  private async captureFingerprints(paths: readonly string[]): Promise<Map<string, FileFingerprint>> {
    const map = new Map<string, FileFingerprint>();
    if (!this.fileFingerprinter || paths.length === 0) return map;
    const normalized = normalizeOwnedPaths(paths);
    await Promise.all(normalized.map(async p => {
      try {
        const fp = await this.fileFingerprinter!.capture(p);
        map.set(p.toLowerCase(), fp);
      } catch {
        // Non-fatal: lock acquisition proceeds even if file cannot be stat'd
      }
    }));
    return map;
  }

  async createPlan(input: CreatePlanInput): Promise<{ plan: ExecutionPlan; tasks: TaskNode[]; checkpoints: QualityCheckpoint[] }> {
    const { plan, tasks } = this.planner.create(input);
    const checkpointSet = QUALITY_DIMENSIONS.filter(item => plan.checkpointIds.includes(item.id));
    const checkpoints: QualityCheckpoint[] = checkpointSet.map(item => ({
      id: `${plan.id}:${item.id}`, title: item.title, status: 'pending',
      required: item.required || (item.id === 'motion' && plan.domains.includes('motion')) || (item.id === '3d-rendering' && plan.domains.includes('threejs')),
      evidenceIds: [], reason: null, updatedAt: now()
    }));
    await this.repository.transact(state => {
      state.plans[plan.id] = plan;
      for (const task of tasks) state.tasks[task.id] = task;
      for (const checkpoint of checkpoints) state.checkpoints[checkpoint.id] = checkpoint;
    });
    return { plan, tasks, checkpoints };
  }

  async createPlanFromBlueprint(
    blueprint: ProjectBlueprint,
    options: {
      autonomyMode?: AutonomyMode;
      maxRepairIterations?: number;
      maxSubagentsPerWave?: number;
      tokenBudget?: number | null;
    } = {}
  ): Promise<{ plan: ExecutionPlan; tasks: TaskNode[]; checkpoints: QualityCheckpoint[]; blueprint: ProjectBlueprint }> {
    const { plan, tasks } = this.planner.createFromBlueprint(blueprint, options);
    const checkpointSet = QUALITY_DIMENSIONS.filter(item => plan.checkpointIds.includes(item.id));
    const checkpoints: QualityCheckpoint[] = checkpointSet.map(item => ({
      id: `${plan.id}:${item.id}`,
      title: item.title,
      status: 'pending',
      required: item.required || (item.id === 'motion' && plan.domains.includes('motion')) || (item.id === '3d-rendering' && plan.domains.includes('threejs')),
      evidenceIds: [],
      reason: null,
      updatedAt: now()
    }));

    await this.repository.transact(state => {
      state.blueprints = state.blueprints ?? {};
      state.blueprints[blueprint.id] = blueprint;
      state.plans[plan.id] = plan;
      for (const task of tasks) state.tasks[task.id] = task;
      for (const checkpoint of checkpoints) state.checkpoints[checkpoint.id] = checkpoint;
    });

    return { plan, tasks, checkpoints, blueprint };
  }

  async getBlueprint(blueprintId: string): Promise<ProjectBlueprint> {
    const state = await this.repository.read();
    const bp = state.blueprints?.[blueprintId];
    if (!bp) throw new NotFoundError('Blueprint', blueprintId);
    return bp;
  }

  async getPlan(planId: string): Promise<{ plan: ExecutionPlan; tasks: TaskNode[]; checkpoints: QualityCheckpoint[] }> {
    const state = await this.repository.read();
    const plan = state.plans[planId];
    if (!plan) throw new NotFoundError('Plan', planId);
    return {
      plan,
      tasks: plan.taskIds.map(id => state.tasks[id]).filter((task): task is TaskNode => Boolean(task)),
      checkpoints: plan.checkpointIds.map(id => state.checkpoints[`${plan.id}:${id}`]).filter((item): item is QualityCheckpoint => Boolean(item))
    };
  }

  async getEvidenceForPlan(planId: string): Promise<EvidenceRecord[]> {
    const state = await this.repository.read();
    if (!state.plans[planId]) throw new NotFoundError('Plan', planId);
    return Object.values(state.evidence).filter(item => item.planId === planId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async getReadyTasks(planId: string): Promise<TaskNode[]> {
    return this.repository.transact(state => {
      autoRecoverExpiredLeases(state);
      const plan = state.plans[planId];
      if (!plan) throw new NotFoundError('Plan', planId);
      const planTasks = plan.taskIds.map(id => state.tasks[id]).filter((task): task is TaskNode => Boolean(task));
      const readyTasks = planTasks.filter(task =>
        task.status === 'pending' && task.dependsOn.every(depId => state.tasks[depId]?.status === 'completed')
      );

      if (readyTasks.length <= 1) {
        return readyTasks;
      }

      const metrics = computeDownstreamMetrics(planTasks);
      return [...readyTasks].sort((a, b) => {
        const metricA = metrics.get(a.id) ?? { transitiveCount: 0, maxDepth: 0 };
        const metricB = metrics.get(b.id) ?? { transitiveCount: 0, maxDepth: 0 };
        if (metricB.transitiveCount !== metricA.transitiveCount) {
          return metricB.transitiveCount - metricA.transitiveCount;
        }
        if (metricB.maxDepth !== metricA.maxDepth) {
          return metricB.maxDepth - metricA.maxDepth;
        }
        return 0;
      });
    });
  }

  async getPlanInsights(planId: string): Promise<PlanInsights> {
    const state = await this.repository.read();
    const plan = state.plans[planId];
    if (!plan) throw new NotFoundError('Plan', planId);

    const tasks = plan.taskIds.map(id => state.tasks[id]).filter((task): task is TaskNode => Boolean(task));
    const totalTasks = tasks.length;
    const completedTasks = tasks.filter(t => t.status === 'completed').length;
    const inProgressTasks = tasks.filter(t => t.status === 'in_progress').length;
    const pendingTasks = tasks.filter(t => t.status === 'pending').length;
    const failedOrBlockedTasks = tasks.filter(t => t.status === 'failed' || t.status === 'blocked').length;
    const completionPercentage = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;

    const metrics = computeDownstreamMetrics(tasks);

    // Critical path among unfinished tasks
    const unfinishedMap = new Map<string, TaskNode>();
    for (const task of tasks) {
      if (task.status !== 'completed') {
        unfinishedMap.set(task.id, task);
      }
    }

    let criticalPath: { taskIds: string[]; taskTitles: string[]; length: number } = {
      taskIds: [],
      taskTitles: [],
      length: 0
    };

    if (unfinishedMap.size > 0) {
      const memoPath = new Map<string, string[]>();

      const getLongestPath = (id: string): string[] => {
        if (memoPath.has(id)) return memoPath.get(id)!;
        const taskMetric = metrics.get(id);
        const unfinishedDependents = (taskMetric?.directDependents ?? []).filter(depId => unfinishedMap.has(depId));

        let bestChildPath: string[] = [];
        for (const depId of unfinishedDependents) {
          const childPath = getLongestPath(depId);
          if (childPath.length > bestChildPath.length) {
            bestChildPath = childPath;
          }
        }

        const fullPath = [id, ...bestChildPath];
        memoPath.set(id, fullPath);
        return fullPath;
      };

      let bestPath: string[] = [];
      for (const [id] of unfinishedMap.entries()) {
        const path = getLongestPath(id);
        if (path.length > bestPath.length) {
          bestPath = path;
        }
      }

      criticalPath = {
        taskIds: bestPath,
        taskTitles: bestPath.map(id => state.tasks[id]?.title ?? id),
        length: bestPath.length
      };
    }

    // Top active or pending bottlenecks by downstream dependent count
    const bottlenecks = tasks
      .filter(t => t.status !== 'completed')
      .sort((a, b) => {
        const countA = metrics.get(a.id)?.transitiveCount ?? 0;
        const countB = metrics.get(b.id)?.transitiveCount ?? 0;
        return countB - countA;
      })
      .slice(0, 5)
      .map(t => ({
        taskId: t.id,
        title: t.title,
        status: t.status,
        claimedBy: t.claimedBy,
        downstreamDependentCount: metrics.get(t.id)?.transitiveCount ?? 0,
        ownedPaths: t.ownedPaths
      }));

    // File locks & contention risk
    const fileLocks = ensureFileLocks(state);
    const planLocks = Object.values(fileLocks).filter(l => l.planId === planId);
    const activeLocksCount = planLocks.length;

    let lockContentionRisk: 'low' | 'moderate' | 'high' = 'low';
    if (failedOrBlockedTasks > 1 && activeLocksCount > 0) {
      lockContentionRisk = 'high';
    } else if (activeLocksCount >= 6 || (failedOrBlockedTasks > 0 && activeLocksCount > 0)) {
      lockContentionRisk = 'moderate';
    }

    // Recommended next actions
    const recommendedActions: PlanInsights['recommendedActions'] = [];

    const troubledTasks = tasks.filter(t => t.status === 'blocked' || t.status === 'failed');
    for (const troubled of troubledTasks) {
      recommendedActions.push({
        type: 'unblock_task',
        priority: 'urgent',
        message: `Task "${troubled.title}" is ${troubled.status} (${troubled.failureReason ?? 'no failure reason provided'}). Reopen or unblock to resume workflow.`,
        targetTaskIds: [troubled.id]
      });
    }

    if (plan.repairIterations >= plan.maxRepairIterations) {
      recommendedActions.push({
        type: 'escalate_budget',
        priority: 'urgent',
        message: `Plan reached repair iteration limit (${plan.repairIterations}/${plan.maxRepairIterations}). Escalate to human review before proceeding.`
      });
    }

    const readyTasks = tasks.filter(task =>
      task.status === 'pending' && task.dependsOn.every(depId => state.tasks[depId]?.status === 'completed')
    );
    if (readyTasks.length > 0) {
      const sortedReady = [...readyTasks].sort((a, b) => {
        const countA = metrics.get(a.id)?.transitiveCount ?? 0;
        const countB = metrics.get(b.id)?.transitiveCount ?? 0;
        return countB - countA;
      });
      const topReady = sortedReady[0]!;
      recommendedActions.push({
        type: 'delegate_ready_tasks',
        priority: 'high',
        message: `${sortedReady.length} task(s) ready for delegation. Priority critical path task: "${topReady.title}".`,
        targetTaskIds: sortedReady.map(t => t.id)
      });
    }

    if (completedTasks === totalTasks && totalTasks > 0) {
      recommendedActions.push({
        type: 'evaluate_gate',
        priority: 'high',
        message: 'All plan execution tasks are completed. Evaluate quality gate via craftrig_evaluate_quality_gate.'
      });
    }

    return {
      planId,
      totalTasks,
      completedTasks,
      inProgressTasks,
      pendingTasks,
      failedOrBlockedTasks,
      completionPercentage,
      criticalPath,
      bottlenecks,
      activeLocksCount,
      lockContentionRisk,
      recommendedActions
    };
  }

  async claimTask(taskId: string, agentId: string, ownedPaths?: readonly string[], leaseTimeoutMs?: number): Promise<TaskNode> {
    if (!agentId.trim()) throw new ValidationError('agentId must not be empty.');
    const fingerprints = ownedPaths ? await this.captureFingerprints(ownedPaths) : undefined;
    return this.repository.transact(state => {
      autoRecoverExpiredLeases(state);
      const task = state.tasks[taskId];
      if (!task) throw new NotFoundError('Task', taskId);
      if (task.status !== 'pending') throw new ConflictError(`Task cannot be claimed from status ${task.status}.`);
      const blockedBy = task.dependsOn.filter(id => state.tasks[id]?.status !== 'completed');
      if (blockedBy.length) throw new ConflictError(`Task dependencies are not complete: ${blockedBy.join(', ')}`);
      const timestamp = now();
      const leaseMs = leaseTimeoutMs ?? (15 * 60 * 1000);
      const leaseExpiresAt = new Date(Date.now() + leaseMs).toISOString();
      const targetPaths = ownedPaths !== undefined ? ownedPaths : (task.ownedPaths ?? []);
      const lockedPaths = acquireTaskLocks(state, task, agentId, targetPaths, timestamp, leaseExpiresAt, fingerprints);
      const updated: TaskNode = {
        ...task,
        ownedPaths: lockedPaths,
        status: 'in_progress',
        claimedBy: agentId,
        updatedAt: timestamp,
        leaseExpiresAt,
        leaseTimeoutMs: leaseMs,
        attemptCount: (task.attemptCount ?? 0) + 1
      };
      state.tasks[taskId] = updated;
      const plan = state.plans[task.planId];
      if (plan) state.plans[task.planId] = { ...plan, updatedAt: timestamp };
      return updated;
    });
  }

  async claimReadyBatch(
    planId: string,
    claims: readonly BatchClaimItem[]
  ): Promise<BatchClaimResult> {
    if (claims.length === 0) throw new ValidationError('At least one claim request is required.');
    const preRead = await this.repository.read();
    const candidatePathsToFingerprint: string[] = [];
    for (const item of claims) {
      const t = preRead.tasks[item.taskId];
      const paths = item.ownedPaths !== undefined
        ? item.ownedPaths
        : (t?.ownedPaths?.length ? t.ownedPaths : (claims.length > 1 ? (t?.recommendedPaths ?? []) : []));
      candidatePathsToFingerprint.push(...paths);
    }
    const fingerprints = await this.captureFingerprints(candidatePathsToFingerprint);

    return this.repository.transact(state => {
      autoRecoverExpiredLeases(state);
      const plan = state.plans[planId];
      if (!plan) throw new NotFoundError('Plan', planId);

      const claimedTasks: TaskNode[] = [];
      const failedTasks: Array<{ taskId: string; reason: string }> = [];
      const acquiredLocks: string[] = [];
      const timestamp = now();

      for (const item of claims) {
        if (!item.agentId?.trim()) {
          failedTasks.push({ taskId: item.taskId, reason: 'agentId must not be empty.' });
          continue;
        }
        const task = state.tasks[item.taskId];
        if (!task) {
          failedTasks.push({ taskId: item.taskId, reason: `Task ${item.taskId} not found.` });
          continue;
        }
        if (task.planId !== planId) {
          failedTasks.push({ taskId: item.taskId, reason: `Task ${item.taskId} does not belong to plan ${planId}.` });
          continue;
        }
        if (task.status !== 'pending') {
          failedTasks.push({ taskId: item.taskId, reason: `Task cannot be claimed from status ${task.status}.` });
          continue;
        }
        const blockedBy = task.dependsOn.filter(id => state.tasks[id]?.status !== 'completed');
        if (blockedBy.length > 0) {
          failedTasks.push({ taskId: item.taskId, reason: `Dependencies not complete: ${blockedBy.join(', ')}` });
          continue;
        }

        const leaseMs = item.leaseTimeoutMs ?? (15 * 60 * 1000);
        const leaseExpiresAt = new Date(Date.now() + leaseMs).toISOString();
        const targetPaths = item.ownedPaths !== undefined
          ? item.ownedPaths
          : (task.ownedPaths.length > 0 ? task.ownedPaths : (claims.length > 1 ? (task.recommendedPaths ?? []) : []));

        try {
          const lockedPaths = acquireTaskLocks(state, task, item.agentId, targetPaths, timestamp, leaseExpiresAt, fingerprints);
          acquiredLocks.push(...lockedPaths);
          const updated: TaskNode = {
            ...task,
            ownedPaths: lockedPaths,
            status: 'in_progress',
            claimedBy: item.agentId,
            updatedAt: timestamp,
            leaseExpiresAt,
            leaseTimeoutMs: leaseMs,
            attemptCount: (task.attemptCount ?? 0) + 1
          };
          state.tasks[task.id] = updated;
          claimedTasks.push(updated);
        } catch (err) {
          failedTasks.push({ taskId: item.taskId, reason: err instanceof Error ? err.message : String(err) });
        }
      }

      if (claimedTasks.length > 0) {
        state.plans[planId] = { ...plan, updatedAt: timestamp };
      }

      return {
        claimedTasks,
        failedTasks,
        acquiredLocks
      };
    });
  }

  async heartbeatTask(taskId: string, agentId: string, extendMs = 15 * 60 * 1000): Promise<TaskNode> {
    if (!agentId.trim()) throw new ValidationError('agentId must not be empty.');
    return this.repository.transact(state => {
      const task = state.tasks[taskId];
      if (!task) throw new NotFoundError('Task', taskId);
      if (task.status !== 'in_progress') throw new ConflictError(`Task must be in_progress to heartbeat. Current: ${task.status}`);
      if (task.claimedBy !== agentId) throw new ConflictError(`Task is claimed by "${task.claimedBy ?? 'unassigned'}", not "${agentId}".`);

      const timestamp = now();
      const leaseExpiresAt = new Date(Date.now() + extendMs).toISOString();
      const updated: TaskNode = {
        ...task,
        updatedAt: timestamp,
        leaseExpiresAt,
        leaseTimeoutMs: extendMs
      };
      state.tasks[taskId] = updated;

      const fileLocks = ensureFileLocks(state);
      for (const lock of Object.values(fileLocks)) {
        if (lock.taskId === taskId) {
          lock.expiresAt = leaseExpiresAt;
        }
      }

      const plan = state.plans[task.planId];
      if (plan) state.plans[task.planId] = { ...plan, updatedAt: timestamp };
      return updated;
    });
  }

  async acquireFileLocks(taskId: string, agentId: string, paths: readonly string[]): Promise<{ task: TaskNode; locks: FileLockRecord[] }> {
    if (!agentId.trim()) throw new ValidationError('agentId must not be empty.');
    if (paths.length === 0) throw new ValidationError('At least one workspace-relative path is required.');
    const fingerprints = await this.captureFingerprints(paths);
    return this.repository.transact(state => {
      const task = state.tasks[taskId];
      if (!task) throw new NotFoundError('Task', taskId);
      if (task.status !== 'in_progress') throw new ConflictError(`Task must be in_progress to acquire file locks. Current: ${task.status}`);
      if (task.claimedBy !== agentId) throw new ConflictError(`Task is claimed by "${task.claimedBy ?? 'unassigned'}", not "${agentId}".`);
      const timestamp = now();
      const acquiredPaths = acquireTaskLocks(state, task, agentId, paths, timestamp, task.leaseExpiresAt, fingerprints);
      const ownedPaths = normalizeOwnedPaths([...(task.ownedPaths ?? []), ...acquiredPaths]);
      const updated: TaskNode = { ...task, ownedPaths, updatedAt: timestamp };
      state.tasks[taskId] = updated;
      const plan = state.plans[task.planId];
      if (plan) state.plans[task.planId] = { ...plan, updatedAt: timestamp };
      const fileLocks = ensureFileLocks(state);
      return { task: updated, locks: acquiredPaths.map(lockPath => fileLocks[lockPath]!) };
    });
  }

  async releaseFileLocks(taskId: string, agentId: string, paths?: readonly string[]): Promise<{ task: TaskNode; releasedPaths: string[] }> {
    if (!agentId.trim()) throw new ValidationError('agentId must not be empty.');
    if (paths !== undefined && paths.length === 0) {
      throw new ValidationError('When paths are provided to release, at least one path is required.');
    }
    return this.repository.transact(state => {
      const task = state.tasks[taskId];
      if (!task) throw new NotFoundError('Task', taskId);
      if (task.status !== 'in_progress') throw new ConflictError(`Task must be in_progress to release file locks. Current: ${task.status}`);
      if (task.claimedBy !== agentId) throw new ConflictError(`Task is claimed by "${task.claimedBy ?? 'unassigned'}", not "${agentId}".`);
      const fileLocks = ensureFileLocks(state);
      const targetLowerSet = paths !== undefined ? new Set(normalizeOwnedPaths(paths).map(p => p.toLowerCase())) : null;
      const releasedPaths: string[] = [];
      for (const [lockPath, lock] of Object.entries(fileLocks)) {
        if (lock.taskId === taskId && (targetLowerSet === null || targetLowerSet.has(lockPath.toLowerCase()))) {
          delete fileLocks[lockPath];
          releasedPaths.push(lockPath);
        }
      }
      const nextOwned = targetLowerSet === null
        ? []
        : (task.ownedPaths ?? []).filter(ownedPath => !targetLowerSet.has(ownedPath.toLowerCase()));
      const timestamp = now();
      const updated: TaskNode = { ...task, ownedPaths: nextOwned, updatedAt: timestamp };
      state.tasks[taskId] = updated;
      const plan = state.plans[task.planId];
      if (plan) state.plans[task.planId] = { ...plan, updatedAt: timestamp };
      return { task: updated, releasedPaths: releasedPaths.sort() };
    });
  }

  async checkFileSync(input: {
    paths: readonly string[];
    taskId?: string;
    agentId?: string;
  }): Promise<FileSyncCheckResult> {
    if (input.paths.length === 0) {
      throw new ValidationError('At least one workspace-relative path is required for checkFileSync.');
    }
    const normalized = normalizeOwnedPaths(input.paths);
    const state = await this.repository.read();
    const activeLocks = Object.values(state.fileLocks ?? {});
    const files: FileSyncEntry[] = [];

    for (const candidate of normalized) {
      const matchingLocks = activeLocks.filter(lock => pathsOverlap(candidate, lock.path));
      const conflictingLock = matchingLocks.find(lock => {
        if (input.taskId && lock.taskId === input.taskId) return false;
        if (!input.taskId && input.agentId && lock.agentId === input.agentId) return false;
        return true;
      });
      const ownLock = matchingLocks.find(lock =>
        (input.taskId && lock.taskId === input.taskId) ||
        (!input.taskId && input.agentId && lock.agentId === input.agentId)
      );

      const currentFingerprint = this.fileFingerprinter
        ? await this.fileFingerprinter.capture(candidate).catch(() => null)
        : null;
      const baselineFingerprint = ownLock?.baselineFingerprint ?? null;

      if (conflictingLock) {
        files.push({
          path: candidate,
          status: 'locked_by_other_agent',
          safeToWrite: false,
          recoveryAction: 'wait_for_lock_owner',
          lockOwner: { taskId: conflictingLock.taskId, agentId: conflictingLock.agentId, lockPath: conflictingLock.path },
          baselineFingerprint,
          currentFingerprint,
          detail: `Locked by agent "${conflictingLock.agentId}" on task "${conflictingLock.taskId}" via "${conflictingLock.path}". Do not overwrite concurrently.`
        });
        continue;
      }

      if (baselineFingerprint && currentFingerprint) {
        if (baselineFingerprint.exists && !currentFingerprint.exists) {
          files.push({
            path: candidate,
            status: 'deleted_on_disk',
            safeToWrite: false,
            recoveryAction: 'reload_file_before_edit',
            lockOwner: ownLock ? { taskId: ownLock.taskId, agentId: ownLock.agentId, lockPath: ownLock.path } : null,
            baselineFingerprint,
            currentFingerprint,
            detail: 'File existed when lock was acquired but has been deleted on disk.'
          });
          continue;
        }
        if (baselineFingerprint.sha256 && currentFingerprint.sha256 && baselineFingerprint.sha256 !== currentFingerprint.sha256) {
          files.push({
            path: candidate,
            status: 'drifted_on_disk',
            safeToWrite: false,
            recoveryAction: 'reload_file_before_edit',
            lockOwner: ownLock ? { taskId: ownLock.taskId, agentId: ownLock.agentId, lockPath: ownLock.path } : null,
            baselineFingerprint,
            currentFingerprint,
            detail: 'File content on disk changed since the lock baseline was captured (external editor/formatter/agent edit). Re-read the latest file before editing to prevent Compare/Overwrite conflicts.'
          });
          continue;
        }
      }

      if (currentFingerprint && !currentFingerprint.exists) {
        files.push({
          path: candidate,
          status: 'untracked_new',
          safeToWrite: true,
          recoveryAction: 'proceed',
          lockOwner: ownLock ? { taskId: ownLock.taskId, agentId: ownLock.agentId, lockPath: ownLock.path } : null,
          baselineFingerprint,
          currentFingerprint,
          detail: 'New file path with no active lock conflicts; safe to create.'
        });
        continue;
      }

      files.push({
        path: candidate,
        status: 'clean',
        safeToWrite: true,
        recoveryAction: 'proceed',
        lockOwner: ownLock ? { taskId: ownLock.taskId, agentId: ownLock.agentId, lockPath: ownLock.path } : null,
        baselineFingerprint,
        currentFingerprint,
        detail: 'No conflicting locks or external on-disk drift detected; safe to edit.'
      });
    }

    const conflictsCount = files.filter(f => !f.safeToWrite).length;
    return {
      allSafeToWrite: conflictsCount === 0,
      conflictsCount,
      files,
      guidance: conflictsCount === 0
        ? 'All checked files are synchronized and safe to edit without Compare/Overwrite conflicts.'
        : `${conflictsCount} file(s) have active lock conflicts or on-disk drift. Reload drifted files or wait for lock owners before saving.`
    };
  }

  async listFileLocks(filter?: ListFileLocksFilter): Promise<FileLockRecord[]> {
    const targetPath = filter?.path !== undefined ? normalizeOwnedPath(filter.path) : null;
    const state = await this.repository.read();
    return Object.values(state.fileLocks ?? {})
      .filter(lock => (filter?.planId ? lock.planId === filter.planId : true))
      .filter(lock => (filter?.taskId ? lock.taskId === filter.taskId : true))
      .filter(lock => (targetPath !== null ? pathsOverlap(lock.path, targetPath) : true))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  async recoverStaleLocks(planId?: string, maxAgeMs = 30 * 60 * 1000): Promise<{ recovered: FileLockRecord[]; message: string }> {
    return this.repository.transact(state => {
      const fileLocks = ensureFileLocks(state);
      const currentTime = Date.now();
      const recovered: FileLockRecord[] = [];

      autoRecoverExpiredLeases(state, currentTime);

      for (const [lockPath, lock] of Object.entries(fileLocks)) {
        if (planId && lock.planId !== planId) continue;
        const task = state.tasks[lock.taskId];
        const isOrphaned = !task || task.status !== 'in_progress';
        const lockAge = currentTime - Date.parse(lock.acquiredAt);
        const isExpiredByAge = Number.isFinite(lockAge) && lockAge > maxAgeMs;
        const isExpiredByLease = lock.expiresAt ? currentTime > Date.parse(lock.expiresAt) : false;

        if (isOrphaned || isExpiredByAge || isExpiredByLease) {
          delete fileLocks[lockPath];
          recovered.push(lock);
          if (task && task.ownedPaths.includes(lockPath)) {
            task.ownedPaths = task.ownedPaths.filter(p => p !== lockPath);
            task.updatedAt = now();
          }
        }
      }

      return {
        recovered,
        message: recovered.length > 0
          ? `Successfully recovered ${recovered.length} stale or orphaned file lock(s).`
          : 'No stale or orphaned file locks detected.'
      };
    });
  }

  async completeTask(
    taskId: string,
    status: Extract<TaskStatus, 'completed' | 'blocked' | 'failed'>,
    evidenceIds: string[] = [],
    reason: string | null = null,
    handoff: TaskHandoff | null = null
  ): Promise<TaskNode> {
    return this.repository.transact(state => {
      const task = state.tasks[taskId];
      if (!task) throw new NotFoundError('Task', taskId);
      if (task.status !== 'in_progress') throw new ConflictError(`Task must be in_progress before completion. Current: ${task.status}`);
      if (status !== 'completed' && !reason?.trim()) throw new ValidationError(`${status.toUpperCase()} requires a documented reason.`);
      if (status === 'completed' && task.requiredEvidence && evidenceIds.length === 0) throw new ValidationError('This task requires at least one evidence record before it can be completed.');
      const missing = evidenceIds.filter(id => !state.evidence[id]);
      if (missing.length) throw new ValidationError(`Unknown evidence IDs: ${missing.join(', ')}`);
      const unrelated = evidenceIds.filter(id => { const item = state.evidence[id]!; return item.planId !== task.planId || (item.taskId !== null && item.taskId !== taskId); });
      if (unrelated.length) throw new ValidationError(`Evidence must belong to this plan and may only be linked to this task: ${unrelated.join(', ')}`);
      releaseLocksForTasks(state, new Set([taskId]));
      const timestamp = now();
      const updated: TaskNode = {
        ...task,
        status,
        evidenceIds: [...new Set([...task.evidenceIds, ...evidenceIds])],
        failureReason: reason,
        handoff: handoff ?? task.handoff ?? null,
        completedAt: status === 'completed' ? timestamp : null,
        updatedAt: timestamp
      };
      state.tasks[taskId] = updated;
      const plan = state.plans[task.planId];
      if (plan) {
        const telemetry = plan.telemetry ? { ...plan.telemetry } : undefined;
        if (telemetry && status === 'completed') {
          if (task.executionMode === 'subagent') {
            telemetry.subagentsSpawned += 1;
          }
          const packetTokens = task.estimatedPacketTokens ?? Math.max(80, Math.ceil((task.title.length + task.description.length + JSON.stringify(handoff ?? {}).length) / 4));
          telemetry.totalPacketTokens += packetTokens;
        }
        state.plans[task.planId] = {
          ...plan,
          ...(telemetry ? { telemetry } : {}),
          updatedAt: timestamp
        };
      }
      return updated;
    });
  }

  async recordEvidence(input: Omit<EvidenceRecord, 'id' | 'createdAt'>): Promise<EvidenceRecord> {
    if (!input.path?.trim() && !input.uri?.trim()) {
      throw new ValidationError('Evidence must reference a workspace artifact path or reproducible URI.');
    }
    return this.repository.transact(state => {
      let planId = input.planId;
      if (planId && !state.plans[planId]) throw new NotFoundError('Plan', planId);
      if (input.taskId) {
        const task = state.tasks[input.taskId];
        if (!task) throw new NotFoundError('Task', input.taskId);
        if (planId && planId !== task.planId) throw new ValidationError('Evidence planId does not match the task plan.');
        planId = task.planId;
      }
      const record: EvidenceRecord = { ...input, planId, id: randomUUID(), createdAt: now() };
      state.evidence[record.id] = record;
      return record;
    });
  }

  async updateCheckpoint(planId: string, dimension: string, status: QualityCheckpoint['status'], evidenceIds: string[], reason: string | null): Promise<QualityCheckpoint> {
    return this.repository.transact(state => {
      const plan = state.plans[planId];
      if (!plan) throw new NotFoundError('Plan', planId);
      if (!plan.checkpointIds.includes(dimension)) throw new ValidationError(`Checkpoint is not part of this plan: ${dimension}`);
      if (status === 'pass' && evidenceIds.length === 0) throw new ValidationError('A PASS checkpoint requires evidence.');
      if (['not_applicable', 'fail', 'blocked'].includes(status) && !reason?.trim()) throw new ValidationError(`${status.toUpperCase()} requires a documented reason.`);
      const missing = evidenceIds.filter(id => !state.evidence[id]);
      if (missing.length) throw new ValidationError(`Unknown evidence IDs: ${missing.join(', ')}`);
      const unrelated = evidenceIds.filter(id => state.evidence[id]!.planId !== planId);
      if (unrelated.length) throw new ValidationError(`Checkpoint evidence must belong to this plan: ${unrelated.join(', ')}`);
      const uniqueIds = [...new Set(evidenceIds)];
      if (status === 'pass') {
        validateVisualOrA11yCheckpointEvidence(dimension, uniqueIds.map(id => state.evidence[id]!));
      }
      const checkpointId = `${planId}:${dimension}`;
      const previous = state.checkpoints[checkpointId];
      if (!previous) throw new NotFoundError('Checkpoint', checkpointId);
      const checkpoint: QualityCheckpoint = { ...previous, status, evidenceIds: uniqueIds, reason, updatedAt: now() };
      state.checkpoints[checkpointId] = checkpoint;
      state.plans[planId] = { ...plan, updatedAt: now() };
      return checkpoint;
    });
  }

  async buildConventionalCommit(planId: string, overrides: CommitOverrides = {}): Promise<ConventionalCommitArtifact> {
    const snapshot = await this.getPlan(planId);
    const traceability = await this.getRequirementTraceability(planId);
    return buildPlanConventionalCommit(snapshot, traceability, this.gitChangesReader, overrides);
  }

  async buildFinalFileSyncAudit(planId?: string, extraPaths: readonly string[] = []): Promise<FinalFileSyncAudit> {
    const candidatePaths: string[] = [...extraPaths];
    let activeLocks: FileLockRecord[] = [];
    if (planId) {
      const snapshot = await this.getPlan(planId);
      for (const task of snapshot.tasks) {
        if (task.handoff?.changedFiles?.length) candidatePaths.push(...task.handoff.changedFiles);
        if (task.ownedPaths?.length) candidatePaths.push(...task.ownedPaths);
      }
      activeLocks = await this.listFileLocks({ planId });
    } else {
      activeLocks = await this.listFileLocks();
    }
    return buildFinalFileSyncAudit({
      candidatePaths,
      activeLocks,
      ...(this.gitChangesReader ? { gitChangesReader: this.gitChangesReader } : {}),
      ...(this.fileFingerprinter ? { fileFingerprinter: this.fileFingerprinter } : {})
    });
  }

  async evaluateGate(planId: string): Promise<{
    status: 'pass' | 'blocked';
    missing: string[];
    failed: string[];
    checkpoints: QualityCheckpoint[];
    conventionalCommit?: ConventionalCommitArtifact;
    fileSyncAudit?: FinalFileSyncAudit;
    finalOutputRequirement?: string;
  }> {
    const snapshot = await this.getPlan(planId);
    const evidence = await this.getEvidenceForPlan(planId);
    const evidenceIds = new Set(evidence.map(item => item.id));
    const { checkpoints, tasks } = snapshot;
    const pendingTasks = tasks.filter(task => ['pending', 'in_progress'].includes(task.status)).map(task => `Task: ${task.title}`);
    const failedTasks = tasks.filter(task => ['blocked', 'failed', 'cancelled'].includes(task.status)).map(task => `Task: ${task.title}`);
    const missing = [
      ...pendingTasks,
      ...checkpoints.filter(item => item.required && item.status === 'pending').map(item => item.title)
    ];
    const failed = [
      ...failedTasks,
      ...checkpoints.filter(item => item.required && ['fail', 'blocked'].includes(item.status)).map(item => item.title)
    ];
    const invalidNA = checkpoints.filter(item => item.required && item.status === 'not_applicable' && !item.reason?.trim()).map(item => item.title);
    const passWithoutEvidence = checkpoints.filter(item => item.required && item.status === 'pass' && (item.evidenceIds.length === 0 || item.evidenceIds.some(id => !evidenceIds.has(id)))).map(item => item.title);
    const staleEvidence = checkpoints.filter(item => {
      if (!item.required || item.status !== 'pass') return false;
      return item.evidenceIds.some(id => {
        const ev = evidence.find(e => e.id === id);
        if (!ev || !ev.taskId) return false;
        const linkedTask = tasks.find(t => t.id === ev.taskId);
        return linkedTask && linkedTask.status !== 'completed';
      });
    }).map(item => `${item.title} (stale evidence linked to non-completed task)`);
    const incomplete = missing.length + failed.length + invalidNA.length + passWithoutEvidence.length + staleEvidence.length > 0;
    if (incomplete) {
      return { status: 'blocked', missing, failed: [...failed, ...invalidNA, ...passWithoutEvidence, ...staleEvidence], checkpoints };
    }
    const traceability = await this.getRequirementTraceability(planId);
    const conventionalCommit = await buildPlanConventionalCommit(snapshot, traceability, this.gitChangesReader);
    const fileSyncAudit = await this.buildFinalFileSyncAudit(planId, conventionalCommit.changedFiles);
    return {
      status: 'pass',
      missing,
      failed: [],
      checkpoints,
      conventionalCommit,
      fileSyncAudit,
      finalOutputRequirement: 'MANDATORY: Report fileSyncAudit (verified files on disk + DO NOT click Overwrite on stale editor tabs; use Don\'t Save or File: Revert File) AND include conventionalCommit.fullMessage in your final output. Commit locally only if needed — NEVER run git push without explicit user authorization.'
    };
  }

  async incrementRepairIteration(planId: string): Promise<{ repairIterations: number; maxRepairIterations: number }> {
    return this.repository.transact(state => {
      const plan = state.plans[planId];
      if (!plan) throw new NotFoundError('Plan', planId);
      if (plan.repairIterations >= plan.maxRepairIterations) throw new ConflictError(`Repair budget exhausted (${plan.maxRepairIterations}). Escalate to human review.`);
      const updated = { ...plan, repairIterations: plan.repairIterations + 1, updatedAt: now() };
      state.plans[planId] = updated;
      return { repairIterations: updated.repairIterations, maxRepairIterations: updated.maxRepairIterations };
    });
  }

  async invalidateCheckpoints(planId: string, dimensions: string[], reason: string): Promise<QualityCheckpoint[]> {
    return this.repository.transact(state => {
      const plan = state.plans[planId];
      if (!plan) throw new NotFoundError('Plan', planId);
      const updated: QualityCheckpoint[] = [];
      for (const dimension of dimensions) {
        if (!plan.checkpointIds.includes(dimension)) throw new ValidationError(`Checkpoint is not part of this plan: ${dimension}`);
        const id = `${planId}:${dimension}`;
        const previous = state.checkpoints[id];
        if (!previous) throw new NotFoundError('Checkpoint', id);
        const checkpoint: QualityCheckpoint = { ...previous, status: 'pending', evidenceIds: [], reason: `Invalidated: ${reason}`, updatedAt: now() };
        state.checkpoints[id] = checkpoint;
        updated.push(checkpoint);
      }
      state.plans[planId] = { ...plan, updatedAt: now() };
      return updated;
    });
  }

  async reopenTask(taskId: string, reason: string, cascade = true): Promise<TaskNode[]> {
    return this.repository.transact(state => {
      const target = state.tasks[taskId];
      if (!target) throw new NotFoundError('Task', taskId);
      const affected = new Set<string>([taskId]);
      if (cascade) {
        let changed = true;
        while (changed) {
          changed = false;
          for (const task of Object.values(state.tasks)) {
            if (task.planId === target.planId && !affected.has(task.id) && task.dependsOn.some(dep => affected.has(dep))) {
              affected.add(task.id);
              changed = true;
            }
          }
        }
      }
      releaseLocksForTasks(state, affected);
      const reopened: TaskNode[] = [];
      for (const id of affected) {
        const current = state.tasks[id]!;
        const updated: TaskNode = { ...current, ownedPaths: [], status: 'pending', evidenceIds: [], claimedBy: null, completedAt: null, failureReason: reason, updatedAt: now() };
        state.tasks[id] = updated;
        reopened.push(updated);
      }
      const plan = state.plans[target.planId]!;
      for (const dimension of plan.checkpointIds) {
        const checkpointId = `${target.planId}:${dimension}`;
        const previous = state.checkpoints[checkpointId];
        if (previous) state.checkpoints[checkpointId] = { ...previous, status: 'pending', evidenceIds: [], reason: `Invalidated by reopened task: ${reason}`, updatedAt: now() };
      }
      state.plans[target.planId] = { ...plan, updatedAt: now() };
      return reopened;
    });
  }

  async getServerProcess(id: string): Promise<ServerProcessRecord> {
    const state = await this.repository.read();
    const record = state.serverProcesses[id];
    if (!record) throw new NotFoundError('Server process', id);
    return record;
  }

  async registerServerProcess(record: ServerProcessRecord): Promise<void> {
    await this.repository.transact(state => { state.serverProcesses[record.id] = record; });
  }

  async updateServerProcess(id: string, patch: Partial<ServerProcessRecord>): Promise<void> {
    await this.repository.transact(state => {
      const current = state.serverProcesses[id];
      if (!current) throw new NotFoundError('Server process', id);
      state.serverProcesses[id] = { ...current, ...patch };
    });
  }

  async approvePhase(planId: string, phaseId: string): Promise<ExecutionPlan> {
    return this.repository.transact(state => {
      const plan = state.plans[planId];
      if (!plan) throw new NotFoundError('Plan', planId);
      const approved = new Set(plan.approvedPhaseIds ?? []);
      approved.add(phaseId);
      const updated: ExecutionPlan = { ...plan, approvedPhaseIds: [...approved], updatedAt: now() };
      state.plans[planId] = updated;
      return updated;
    });
  }

  async createTargetedRepairTask(
    planId: string,
    failedTaskId: string,
    defectSummary: string,
    failedEvidenceIds: string[],
    domainOverride?: WorkDomain
  ): Promise<{ repairTask: TaskNode; reopenedTask: TaskNode }> {
    return this.repository.transact(state => {
      const plan = state.plans[planId];
      if (!plan) throw new NotFoundError('Plan', planId);
      const failedTask = state.tasks[failedTaskId];
      if (!failedTask || failedTask.planId !== planId) throw new NotFoundError('Task', failedTaskId);
      if (plan.repairIterations >= plan.maxRepairIterations) {
        throw new ConflictError(`Repair budget exhausted (${plan.maxRepairIterations}). Escalate to human review.`);
      }

      const targetDomain: WorkDomain = domainOverride ?? failedTask.domains[0] ?? 'frontend';
      const profile = selectTaskEffortProfile('repair', targetDomain, 1);
      const timestamp = now();
      const repairId = randomUUID();

      const repairTask: TaskNode = {
        id: repairId,
        planId,
        title: `Targeted repair for: ${failedTask.title}`,
        description: `Fix root-cause defect(s) reported by failed verification: ${defectSummary}. Failed evidence IDs: ${failedEvidenceIds.join(', ') || 'none'}. Do not broaden scope.`,
        ownerRole: targetDomain === 'threejs' ? 'threejs-developer' : targetDomain === 'backend' ? 'backend-developer' : 'frontend-developer',
        skillIds: profile.skillIds,
        primarySkill: profile.primarySkill,
        executionMode: 'subagent',
        modelTier: profile.modelTier,
        moduleIds: [15, 18, 25, 61],
        domains: [targetDomain],
        dependsOn: [],
        ownedPaths: [],
        recommendedPaths: failedTask.recommendedPaths ?? ['src'],
        status: 'pending',
        parallelGroup: 'targeted-repair',
        requiredEvidence: true,
        evidenceIds: [],
        claimedBy: null,
        phaseId: failedTask.phaseId ?? null,
        phaseName: failedTask.phaseName ?? null,
        phaseOrder: failedTask.phaseOrder ?? null,
        requirementIds: failedTask.requirementIds ?? [],
        createdAt: timestamp,
        updatedAt: timestamp,
        completedAt: null,
        failureReason: null
      };

      // Reopen failedTask so it now depends on repairTask
      releaseLocksForTasks(state, new Set([failedTaskId]));
      const reopenedTask: TaskNode = {
        ...failedTask,
        status: 'pending',
        claimedBy: null,
        leaseExpiresAt: null,
        ownedPaths: [],
        dependsOn: [...new Set([...failedTask.dependsOn, repairId])],
        failureReason: `Awaiting targeted repair (${repairId}): ${defectSummary}`,
        updatedAt: timestamp
      };

      state.tasks[repairId] = repairTask;
      state.tasks[failedTaskId] = reopenedTask;

      const updatedPhases = (plan.phases ?? []).map(p =>
        p.id === failedTask.phaseId ? { ...p, taskIds: [...p.taskIds, repairId] } : p
      );
      const telemetry = plan.telemetry
        ? {
            ...plan.telemetry,
            skillsUsed: [...new Set([...plan.telemetry.skillsUsed, ...profile.skillIds])].sort()
          }
        : undefined;

      state.plans[planId] = {
        ...plan,
        taskIds: [...plan.taskIds, repairId],
        repairIterations: plan.repairIterations + 1,
        ...(plan.phases ? { phases: updatedPhases } : {}),
        ...(telemetry ? { telemetry } : {}),
        updatedAt: timestamp
      };

      return { repairTask, reopenedTask };
    });
  }

  async getRequirementTraceability(planId: string): Promise<RequirementTraceabilityEntry[]> {
    const state = await this.repository.read();
    const plan = state.plans[planId];
    if (!plan) throw new NotFoundError('Plan', planId);
    const blueprint = plan.blueprintId ? state.blueprints?.[plan.blueprintId] : undefined;
    if (!blueprint) return [];

    const planTasks = plan.taskIds.map(id => state.tasks[id]).filter((t): t is TaskNode => Boolean(t));
    return blueprint.requirements.map(req => {
      const linkedTasks = planTasks.filter(t => (t.requirementIds ?? []).includes(req.id));
      const completedTasks = linkedTasks.filter(t => t.status === 'completed');
      const evidenceIds = [...new Set(completedTasks.flatMap(t => t.evidenceIds))];
      return {
        requirementId: req.id,
        phaseId: req.phaseId,
        title: req.title,
        priority: req.priority,
        taskIds: linkedTasks.map(t => t.id),
        completedTaskIds: completedTasks.map(t => t.id),
        evidenceIds,
        verified: linkedTasks.length > 0 && completedTasks.length === linkedTasks.length && evidenceIds.length > 0
      };
    });
  }

  async getProtectedEvidencePaths(): Promise<Set<string>> {
    const state = await this.repository.read();
    const protectedIds = new Set<string>();
    for (const cp of Object.values(state.checkpoints)) {
      if (cp.status === 'pass') {
        for (const id of cp.evidenceIds) protectedIds.add(id);
      }
    }
    for (const task of Object.values(state.tasks)) {
      if (task.status === 'in_progress') {
        for (const id of task.evidenceIds) protectedIds.add(id);
      }
    }
    const paths = new Set<string>();
    for (const evId of protectedIds) {
      const ev = state.evidence[evId];
      if (ev?.path) paths.add(ev.path);
    }
    return paths;
  }

  async purgeArchivedPlan(planId: string): Promise<{ removedTasks: number; removedCheckpoints: number; removedEvidence: number }> {
    return this.repository.transact(state => {
      const plan = state.plans[planId];
      if (!plan) throw new NotFoundError('Plan', planId);
      const taskSet = new Set(plan.taskIds);
      releaseLocksForTasks(state, taskSet);
      let removedTasks = 0;
      for (const taskId of plan.taskIds) {
        if (state.tasks[taskId]) { delete state.tasks[taskId]; removedTasks++; }
      }
      let removedCheckpoints = 0;
      for (const cpDim of plan.checkpointIds) {
        const key = `${planId}:${cpDim}`;
        if (state.checkpoints[key]) { delete state.checkpoints[key]; removedCheckpoints++; }
      }
      let removedEvidence = 0;
      for (const [evId, ev] of Object.entries(state.evidence)) {
        if (ev.planId === planId) { delete state.evidence[evId]; removedEvidence++; }
      }
      delete state.plans[planId];
      return { removedTasks, removedCheckpoints, removedEvidence };
    });
  }

  async getStorageStats() {
    return this.repository.getStorageStats ? this.repository.getStorageStats() : null;
  }

  async vacuumStorage(pages = 100): Promise<void> {
    if (this.repository.vacuumIncremental) {
      await this.repository.vacuumIncremental(pages);
    }
  }
}
