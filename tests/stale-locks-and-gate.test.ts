import test from 'node:test';
import assert from 'node:assert/strict';
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

test('recoverStaleLocks cleans up orphaned locks from non-in-progress tasks', async () => {
  const service = new TaskService(new MemoryRepository());
  const created = await service.createPlan({
    title: 'Stale lock test',
    request: 'Build test features',
    domains: ['frontend']
  });
  const discovery = created.tasks[0]!;
  await service.claimTask(discovery.id, 'agent-1', ['src/discovery.ts']);

  // Manually simulate a crashed/abandoned task state in repository
  await service.recoverStaleLocks(created.plan.id);

  // Claimed task is still in_progress, so lock is valid and not recovered
  const activeLocks = await service.listFileLocks();
  assert.equal(activeLocks.length, 1);

  // Now complete the task (or simulate task crash) and add an orphaned lock
  const repo = (service as any).repository;
  await repo.transact((state: HarnessState) => {
    state.fileLocks['src/orphaned.ts'] = {
      path: 'src/orphaned.ts',
      planId: created.plan.id,
      taskId: 'ghost-task-id',
      agentId: 'ghost-agent',
      acquiredAt: new Date(Date.now() - 3600000).toISOString()
    };
  });

  const recovered = await service.recoverStaleLocks(created.plan.id);
  assert.equal(recovered.recovered.length, 1);
  assert.equal(recovered.recovered[0]!.path, 'src/orphaned.ts');

  const afterRecovery = await service.listFileLocks();
  assert.equal(afterRecovery.length, 1);
  assert.equal(afterRecovery[0]!.path, 'src/discovery.ts');
});

test('evaluateGate detects and rejects stale evidence linked to uncompleted tasks', async () => {
  const service = new TaskService(new MemoryRepository());
  const created = await service.createPlan({
    title: 'Stale evidence test',
    request: 'Build frontend features',
    domains: ['frontend']
  });
  const discovery = created.tasks[0]!;
  await service.claimTask(discovery.id, 'agent-1');

  // Record evidence linked to in-progress task (not yet completed)
  const evidence = await service.recordEvidence({
    planId: created.plan.id,
    taskId: discovery.id,
    kind: 'test-report',
    title: 'Premature evidence',
    description: 'Evidence recorded before task completion',
    path: 'tests/report.json',
    uri: null,
    metadata: {},
    createdBy: 'agent-1'
  });

  // Attempt to pass checkpoint using this premature/stale evidence
  await service.updateCheckpoint(created.plan.id, 'security', 'pass', [evidence.id], null);

  const gateResult = await service.evaluateGate(created.plan.id);
  assert.equal(gateResult.status, 'blocked');
  assert.ok(
    gateResult.failed.some(f => f.includes('stale evidence linked to non-completed task')),
    'Gate should detect stale evidence linked to uncompleted task'
  );
});
