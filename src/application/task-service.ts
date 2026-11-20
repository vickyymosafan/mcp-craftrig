import { randomUUID } from 'node:crypto';
import type { StateRepository } from '../domain/ports.js';
import type { EvidenceRecord, ExecutionPlan, FileLockRecord, HarnessState, PlanInsights, QualityCheckpoint, ServerProcessRecord, TaskNode, TaskStatus } from '../domain/models.js';
import { QUALITY_DIMENSIONS } from '../domain/models.js';
import { ConflictError, NotFoundError, ValidationError } from '../domain/errors.js';
import { findLockConflict, normalizeOwnedPath, normalizeOwnedPaths, pathsOverlap } from '../domain/file-ownership.js';
import { computeDownstreamMetrics } from '../domain/dag-validator.js';
import { TaskPlanner, type CreatePlanInput } from './task-planner.js';

const now = () => new Date().toISOString();

function ensureFileLocks(state: HarnessState): Record<string, FileLockRecord> {
  return (state.fileLocks ??= {});
}

function acquireTaskLocks(
  state: HarnessState,
  task: TaskNode,
  agentId: string,
  pathsToLock: readonly string[],
  timestamp: string
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
    fileLocks[candidate] = {
      path: candidate,
      planId: task.planId,
      taskId: task.id,
      agentId,
      acquiredAt: timestamp
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

export interface ListFileLocksFilter {
  planId?: string;
  taskId?: string;
  path?: string;
}

export class TaskService {
  constructor(private readonly repository: StateRepository, private readonly planner = new TaskPlanner()) {}

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
    const state = await this.repository.read();
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
        message: 'All plan execution tasks are completed. Evaluate quality gate via harness.evaluate_quality_gate.'
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

  async claimTask(taskId: string, agentId: string, ownedPaths?: readonly string[]): Promise<TaskNode> {
    if (!agentId.trim()) throw new ValidationError('agentId must not be empty.');
    return this.repository.transact(state => {
      const task = state.tasks[taskId];
      if (!task) throw new NotFoundError('Task', taskId);
      if (task.status !== 'pending') throw new ConflictError(`Task cannot be claimed from status ${task.status}.`);
      const blockedBy = task.dependsOn.filter(id => state.tasks[id]?.status !== 'completed');
      if (blockedBy.length) throw new ConflictError(`Task dependencies are not complete: ${blockedBy.join(', ')}`);
      const timestamp = now();
      const targetPaths = ownedPaths !== undefined ? ownedPaths : (task.ownedPaths ?? []);
      const lockedPaths = acquireTaskLocks(state, task, agentId, targetPaths, timestamp);
      const updated: TaskNode = { ...task, ownedPaths: lockedPaths, status: 'in_progress', claimedBy: agentId, updatedAt: timestamp };
      state.tasks[taskId] = updated;
      const plan = state.plans[task.planId];
      if (plan) state.plans[task.planId] = { ...plan, updatedAt: timestamp };
      return updated;
    });
  }

  async acquireFileLocks(taskId: string, agentId: string, paths: readonly string[]): Promise<{ task: TaskNode; locks: FileLockRecord[] }> {
    if (!agentId.trim()) throw new ValidationError('agentId must not be empty.');
    if (paths.length === 0) throw new ValidationError('At least one workspace-relative path is required.');
    return this.repository.transact(state => {
      const task = state.tasks[taskId];
      if (!task) throw new NotFoundError('Task', taskId);
      if (task.status !== 'in_progress') throw new ConflictError(`Task must be in_progress to acquire file locks. Current: ${task.status}`);
      if (task.claimedBy !== agentId) throw new ConflictError(`Task is claimed by "${task.claimedBy ?? 'unassigned'}", not "${agentId}".`);
      const timestamp = now();
      const acquiredPaths = acquireTaskLocks(state, task, agentId, paths, timestamp);
      const ownedPaths = [...new Set([...(task.ownedPaths ?? []), ...acquiredPaths])];
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
      const targetSet = paths !== undefined ? new Set(normalizeOwnedPaths(paths)) : null;
      const releasedPaths: string[] = [];
      for (const [lockPath, lock] of Object.entries(fileLocks)) {
        if (lock.taskId === taskId && (targetSet === null || targetSet.has(lockPath))) {
          delete fileLocks[lockPath];
          releasedPaths.push(lockPath);
        }
      }
      const nextOwned = targetSet === null
        ? []
        : (task.ownedPaths ?? []).filter(ownedPath => !targetSet.has(ownedPath));
      const timestamp = now();
      const updated: TaskNode = { ...task, ownedPaths: nextOwned, updatedAt: timestamp };
      state.tasks[taskId] = updated;
      const plan = state.plans[task.planId];
      if (plan) state.plans[task.planId] = { ...plan, updatedAt: timestamp };
      return { task: updated, releasedPaths: releasedPaths.sort() };
    });
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

      for (const [lockPath, lock] of Object.entries(fileLocks)) {
        if (planId && lock.planId !== planId) continue;
        const task = state.tasks[lock.taskId];
        const isOrphaned = !task || task.status !== 'in_progress';
        const lockAge = currentTime - Date.parse(lock.acquiredAt);
        const isExpired = Number.isFinite(lockAge) && lockAge > maxAgeMs;

        if (isOrphaned || isExpired) {
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

  async completeTask(taskId: string, status: Extract<TaskStatus, 'completed' | 'blocked' | 'failed'>, evidenceIds: string[] = [], reason: string | null = null): Promise<TaskNode> {
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
      const updated: TaskNode = { ...task, status, evidenceIds: [...new Set([...task.evidenceIds, ...evidenceIds])], failureReason: reason, completedAt: status === 'completed' ? timestamp : null, updatedAt: timestamp };
      state.tasks[taskId] = updated;
      const plan = state.plans[task.planId];
      if (plan) state.plans[task.planId] = { ...plan, updatedAt: timestamp };
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
      const checkpointId = `${planId}:${dimension}`;
      const previous = state.checkpoints[checkpointId];
      if (!previous) throw new NotFoundError('Checkpoint', checkpointId);
      const checkpoint: QualityCheckpoint = { ...previous, status, evidenceIds: [...new Set(evidenceIds)], reason, updatedAt: now() };
      state.checkpoints[checkpointId] = checkpoint;
      state.plans[planId] = { ...plan, updatedAt: now() };
      return checkpoint;
    });
  }

  async evaluateGate(planId: string): Promise<{ status: 'pass' | 'blocked'; missing: string[]; failed: string[]; checkpoints: QualityCheckpoint[] }> {
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
    return { status: incomplete ? 'blocked' : 'pass', missing, failed: [...failed, ...invalidNA, ...passWithoutEvidence, ...staleEvidence], checkpoints };
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
}
