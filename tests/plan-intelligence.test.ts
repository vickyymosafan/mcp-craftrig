import test from 'node:test';
import assert from 'node:assert/strict';
import { computeDownstreamMetrics, type DagNodeLike } from '../src/domain/dag-validator.js';
import { TaskPlanner } from '../src/application/task-planner.js';
import { TaskService } from '../src/application/task-service.js';
import { EMPTY_STATE, type HarnessState } from '../src/domain/models.js';
import type { StateRepository } from '../src/domain/ports.js';

class MemoryRepository implements StateRepository {
  private state: HarnessState = structuredClone(EMPTY_STATE);
  async read(): Promise<HarnessState> { return structuredClone(this.state); }
  async transact<T>(operation: (state: HarnessState) => T | Promise<T>): Promise<T> {
    return operation(this.state);
  }
}

test('computeDownstreamMetrics calculates exact transitive downstream counts and depths', () => {
  const dag: DagNodeLike[] = [
    { id: 'root', dependsOn: [] },
    { id: 'branch-a', dependsOn: ['root'] },
    { id: 'branch-b', dependsOn: ['root'] },
    { id: 'child-a1', dependsOn: ['branch-a'] },
    { id: 'child-a2', dependsOn: ['branch-a'] },
    { id: 'join', dependsOn: ['child-a1', 'branch-b'] }
  ];

  const metrics = computeDownstreamMetrics(dag);

  // root reaches: branch-a, branch-b, child-a1, child-a2, join (5 nodes)
  assert.equal(metrics.get('root')?.transitiveCount, 5);
  // branch-a reaches: child-a1, child-a2, join (3 nodes)
  assert.equal(metrics.get('branch-a')?.transitiveCount, 3);
  // branch-b reaches: join (1 node)
  assert.equal(metrics.get('branch-b')?.transitiveCount, 1);
  // leaf child-a2 reaches 0
  assert.equal(metrics.get('child-a2')?.transitiveCount, 0);
  // join reaches 0
  assert.equal(metrics.get('join')?.transitiveCount, 0);

  // Depth verification: root -> branch-a -> child-a1 -> join = 3 edges
  assert.equal(metrics.get('root')?.maxDepth, 3);
  assert.equal(metrics.get('branch-a')?.maxDepth, 2);
  assert.equal(metrics.get('branch-b')?.maxDepth, 1);
});

test('getReadyTasks prioritizes tasks with higher downstream transitive impact', async () => {
  const service = new TaskService(new MemoryRepository());
  const created = await service.createPlan({
    title: 'Fullstack App',
    request: 'Build fullstack dashboard with frontend and backend API',
    domains: ['frontend', 'backend']
  });

  const discovery = created.tasks[0]!;
  await service.claimTask(discovery.id, 'lead');
  const evidence = await service.recordEvidence({
    planId: created.plan.id,
    taskId: discovery.id,
    kind: 'manual-review',
    title: 'Discovery confirmed',
    description: 'Repo context extracted',
    path: null,
    uri: 'https://example.com/spec',
    metadata: {},
    createdBy: 'lead'
  });
  await service.completeTask(discovery.id, 'completed', [evidence.id]);

  const ready = await service.getReadyTasks(created.plan.id);
  assert.ok(ready.length >= 2);

  // Architecture blocks backend, frontend and design, so it must be ranked before governance or isolated leaves
  const archIndex = ready.findIndex(t => t.ownerRole === 'architecture-lead');
  assert.ok(archIndex !== -1, 'architecture-lead must be ready');
  // First ready task must have highest or equal downstream dependent count
  const metrics = computeDownstreamMetrics(created.tasks);
  const firstCount = metrics.get(ready[0]!.id)?.transitiveCount ?? 0;
  for (let i = 1; i < ready.length; i++) {
    const nextCount = metrics.get(ready[i]!.id)?.transitiveCount ?? 0;
    assert.ok(firstCount >= nextCount, `Task ${ready[0]!.title} (${firstCount}) should have >= impact than ${ready[i]!.title} (${nextCount})`);
  }
});

test('TaskPlanner seeds domain-aware recommendedPaths for zero-guesswork file locking', () => {
  const planner = new TaskPlanner();
  const { tasks } = planner.create({
    title: 'Web Platform',
    request: 'Build frontend and backend system with Three.js graphics and motion',
    domains: ['frontend', 'backend', 'threejs', 'motion']
  });

  const frontendTask = tasks.find(t => t.ownerRole === 'frontend-developer');
  assert.ok(frontendTask);
  assert.deepEqual(frontendTask.recommendedPaths, ['src/ui', 'src/components', 'src/pages']);

  const backendTask = tasks.find(t => t.ownerRole === 'backend-developer');
  assert.ok(backendTask);
  assert.deepEqual(backendTask.recommendedPaths, ['src/application', 'src/domain', 'src/infrastructure']);

  const threejsTask = tasks.find(t => t.ownerRole === 'threejs-developer');
  assert.ok(threejsTask);
  assert.deepEqual(threejsTask.recommendedPaths, ['src/three', 'src/shaders', 'src/scenes']);
});

test('getPlanInsights returns critical path chain, active bottlenecks, and recommended actions', async () => {
  const service = new TaskService(new MemoryRepository());
  const created = await service.createPlan({
    title: 'SaaS App',
    request: 'Build fullstack dashboard',
    domains: ['frontend', 'backend']
  });

  const insightsBefore = await service.getPlanInsights(created.plan.id);
  assert.equal(insightsBefore.completionPercentage, 0);
  assert.ok(insightsBefore.totalTasks > 5);
  assert.ok(insightsBefore.criticalPath.length > 3);
  assert.ok(insightsBefore.criticalPath.taskTitles[0]!.includes('Discover'));
  assert.equal(insightsBefore.lockContentionRisk, 'low');
  assert.ok(insightsBefore.recommendedActions.some(a => a.type === 'delegate_ready_tasks'));

  // Complete discovery task
  const discovery = created.tasks[0]!;
  await service.claimTask(discovery.id, 'lead');
  const evidence = await service.recordEvidence({
    planId: created.plan.id,
    taskId: discovery.id,
    kind: 'manual-review',
    title: 'Discovery confirmed',
    description: 'Repo context extracted',
    path: null,
    uri: 'https://example.com/spec',
    metadata: {},
    createdBy: 'lead'
  });
  await service.completeTask(discovery.id, 'completed', [evidence.id]);

  const insightsAfter = await service.getPlanInsights(created.plan.id);
  assert.ok(insightsAfter.completionPercentage > 0);
  assert.equal(insightsAfter.completedTasks, 1);
  // Discovery should no longer be the root of unfinished critical path
  assert.ok(!insightsAfter.criticalPath.taskTitles[0]!.includes('Discover'));
});
