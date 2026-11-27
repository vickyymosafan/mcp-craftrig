import type { RequirementTraceabilityEntry } from '../domain/blueprint.js';
import {
  buildConventionalCommit,
  type ConventionalCommitArtifact,
  type ConventionalCommitType
} from '../domain/conventional-commit.js';
import type { ExecutionPlan, QualityCheckpoint, TaskNode } from '../domain/models.js';
import type { GitChangesReaderPort } from '../domain/ports.js';

export interface CommitOverrides {
  type?: ConventionalCommitType;
  scope?: string | null;
  summary?: string;
  breakingChange?: string | null;
}

export async function buildPlanConventionalCommit(
  snapshot: { plan: ExecutionPlan; tasks: TaskNode[]; checkpoints: QualityCheckpoint[] },
  traceability: readonly RequirementTraceabilityEntry[],
  gitChangesReader?: GitChangesReaderPort,
  overrides: CommitOverrides = {}
): Promise<ConventionalCommitArtifact> {
  const workingTree = gitChangesReader
    ? await gitChangesReader.readWorkingTreeChanges().catch(() => ({ isGitRepo: false, changedFiles: [] }))
    : { isGitRepo: false, changedFiles: [] };

  const completedTasks = snapshot.tasks.filter(t => t.status === 'completed');
  const handoffFiles = completedTasks.flatMap(t => [
    ...(t.handoff?.changedFiles ?? []),
    ...(t.ownedPaths ?? [])
  ]);
  const changedFiles = [...new Set([...workingTree.changedFiles, ...handoffFiles])];

  const summaryPoints: string[] = [];
  if (overrides.summary?.trim()) {
    summaryPoints.push(overrides.summary.trim());
  }
  for (const task of completedTasks) {
    if (task.handoff?.summary) {
      summaryPoints.push(task.handoff.summary);
    } else {
      summaryPoints.push(task.title);
    }
  }

  const testsRun = completedTasks.flatMap(t => t.handoff?.testsRun ?? []);
  const requirementIds = traceability.map(t => t.requirementId);

  return buildConventionalCommit({
    title: overrides.summary?.trim() || snapshot.plan.title,
    summaryPoints,
    changedFiles,
    requirementIds,
    testsRun,
    domains: snapshot.plan.domains,
    repairIterations: snapshot.plan.repairIterations,
    ...(overrides.type !== undefined ? { type: overrides.type } : {}),
    ...(overrides.scope !== undefined ? { scope: overrides.scope } : {}),
    ...(overrides.breakingChange !== undefined ? { breakingChange: overrides.breakingChange } : {})
  });
}
