import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JsonStateRepository } from '../src/infrastructure/persistence/json-state-repository.js';

test('JSON state repository persists transactions atomically', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'principal-harness-state-'));
  const stateFile = path.join(root, '.harness', 'state.json');
  try {
    const repository = new JsonStateRepository(stateFile);
    await repository.transact(state => {
      state.plans['plan-1'] = {
        id: 'plan-1', title: 'Test plan', request: 'Test repository persistence', domains: ['frontend'],
        taskIds: [], checkpointIds: [], maxRepairIterations: 3, repairIterations: 0,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
      };
    });
    const persisted = JSON.parse(await readFile(stateFile, 'utf8')) as { plans: Record<string, { title: string }> };
    assert.equal(persisted.plans['plan-1']?.title, 'Test plan');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('JSON state repository serializes concurrent transactions in one process', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'principal-harness-lock-'));
  const stateFile = path.join(root, 'state.json');
  try {
    const repository = new JsonStateRepository(stateFile);
    await Promise.all(Array.from({ length: 20 }, () => repository.transact(state => {
      const current = Number((state as unknown as { counter?: number }).counter ?? 0);
      (state as unknown as { counter: number }).counter = current + 1;
    })));
    const state = JSON.parse(await readFile(stateFile, 'utf8')) as { counter: number };
    assert.equal(state.counter, 20);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('JSON state repository normalizes legacy v1 state lacking fileLocks and ownedPaths', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'principal-harness-legacy-'));
  const stateFile = path.join(root, 'state.json');
  try {
    const legacy = {
      schemaVersion: 1,
      plans: {},
      tasks: {
        'task-1': {
          id: 'task-1', planId: 'plan-1', title: 'Legacy task', description: 'Legacy',
          ownerRole: 'frontend-developer', skillIds: [], moduleIds: [], domains: ['frontend'],
          dependsOn: [], status: 'pending', parallelGroup: null, requiredEvidence: true,
          evidenceIds: [], claimedBy: null, createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z', completedAt: null, failureReason: null
        }
      },
      checkpoints: {},
      evidence: {},
      serverProcesses: {}
    };
    const { writeFile } = await import('node:fs/promises');
    await writeFile(stateFile, JSON.stringify(legacy), 'utf8');
    const repository = new JsonStateRepository(stateFile);
    const loaded = await repository.read();
    assert.deepEqual(loaded.fileLocks, {});
    assert.deepEqual(loaded.tasks['task-1']?.ownedPaths, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
