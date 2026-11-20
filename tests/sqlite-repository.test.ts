import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SqliteStateRepository } from '../src/infrastructure/persistence/sqlite-state-repository.js';
import type { TaskNode } from '../src/domain/models.js';

test('SqliteStateRepository creates schema in WAL mode and reads initial empty state', async () => {
  const repo = new SqliteStateRepository(':memory:');
  try {
    const state = await repo.read();
    assert.equal(state.schemaVersion, 1);
    assert.deepEqual(state.plans, {});
    assert.deepEqual(state.tasks, {});
    assert.deepEqual(state.fileLocks, {});
  } finally {
    repo.close();
  }
});

test('SqliteStateRepository commits state mutations atomically across transactions', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'craftrig-sqlite-test-'));
  const dbFile = path.join(tempDir, 'state.sqlite');
  const repo = new SqliteStateRepository(dbFile);

  try {
    const task: TaskNode = {
      id: 'task-1',
      planId: 'plan-1',
      title: 'Test SQLite Task',
      description: 'Verifying persistence',
      ownerRole: 'lead-dev',
      skillIds: ['clean-architecture-development'],
      moduleIds: [1, 2],
      domains: ['frontend'],
      dependsOn: [],
      ownedPaths: ['src/app.ts'],
      status: 'pending',
      parallelGroup: null,
      requiredEvidence: false,
      evidenceIds: [],
      claimedBy: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      completedAt: null,
      failureReason: null
    };

    await repo.transact(state => {
      state.tasks[task.id] = task;
    });

    const readState = await repo.read();
    assert.equal(readState.tasks['task-1']?.title, 'Test SQLite Task');
    assert.deepEqual(readState.tasks['task-1']?.ownedPaths, ['src/app.ts']);

    // Verify rollback on error
    await assert.rejects(
      repo.transact(state => {
        state.tasks['task-fail'] = { ...task, id: 'task-fail', title: 'Should Rollback' };
        throw new Error('Simulated atomic transaction failure');
      }),
      /Simulated atomic transaction failure/
    );

    const afterFail = await repo.read();
    assert.equal(afterFail.tasks['task-fail'], undefined);
    assert.equal(afterFail.tasks['task-1']?.title, 'Test SQLite Task');
  } finally {
    repo.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('SqliteStateRepository handles concurrent in-process transactions without deadlock', async () => {
  const repo = new SqliteStateRepository(':memory:');
  try {
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        repo.transact(state => {
          state.tasks[`task-concurrent-${i}`] = {
            id: `task-concurrent-${i}`,
            planId: 'plan-1',
            title: `Concurrent Task ${i}`,
            description: 'Concurrency test',
            ownerRole: 'worker',
            skillIds: [],
            moduleIds: [],
            domains: ['frontend'],
            dependsOn: [],
            ownedPaths: [],
            status: 'pending',
            parallelGroup: null,
            requiredEvidence: false,
            evidenceIds: [],
            claimedBy: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            completedAt: null,
            failureReason: null
          };
        })
      )
    );

    const finalState = await repo.read();
    assert.equal(Object.keys(finalState.tasks).length, 10);
  } finally {
    repo.close();
  }
});
