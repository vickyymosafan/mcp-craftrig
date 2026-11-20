import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { InMemoryTransport, LATEST_PROTOCOL_VERSION, type JSONRPCMessage, type JSONRPCResultResponse } from '@modelcontextprotocol/server';
import { TaskService } from '../src/application/task-service.js';
import { findLockConflict, normalizeOwnedPath, normalizeOwnedPaths, pathsOverlap } from '../src/domain/file-ownership.js';
import { EMPTY_STATE, type HarnessState } from '../src/domain/models.js';
import type { BrowserInspectorPort, DevServerPort, StateRepository } from '../src/domain/ports.js';
import { ModuleRegistry } from '../src/infrastructure/catalog/module-registry.js';
import { ChecklistDocumentWriter } from '../src/infrastructure/persistence/checklist-document-writer.js';
import { JsonStateRepository } from '../src/infrastructure/persistence/json-state-repository.js';
import { WorkspaceGuard } from '../src/infrastructure/security/workspace-guard.js';
import { FileSkillRegistry } from '../src/infrastructure/skills/file-skill-registry.js';
import { createMcpServer } from '../src/interfaces/mcp/server.js';

class MemoryRepository implements StateRepository {
  private state: HarnessState = structuredClone(EMPTY_STATE);
  async read(): Promise<HarnessState> { return structuredClone(this.state); }
  async transact<T>(operation: (state: HarnessState) => T | Promise<T>): Promise<T> {
    return operation(this.state);
  }
}

const evidenceInput = (planId: string, taskId: string, createdBy: string) => ({
  planId,
  taskId,
  kind: 'manual-review' as const,
  title: 'Verification evidence',
  description: 'Verified change within owned file boundary.',
  path: '.harness/evidence/check.json',
  uri: null,
  metadata: {},
  createdBy
});

async function prepareParallelPlanningTasks(service: TaskService) {
  const created = await service.createPlan({
    title: 'Parallel UI + API',
    request: 'Build frontend dashboard and backend API service',
    domains: ['frontend', 'backend']
  });
  const discovery = created.tasks[0]!;
  await service.claimTask(discovery.id, 'discovery-agent');
  const evidence = await service.recordEvidence(evidenceInput(created.plan.id, discovery.id, 'discovery-agent'));
  await service.completeTask(discovery.id, 'completed', [evidence.id]);
  const ready = await service.getReadyTasks(created.plan.id);
  assert.ok(ready.length >= 2);
  return { planId: created.plan.id, tasks: ready };
}

test('normalizeOwnedPath canonicalizes separators and rejects escapes or root', () => {
  assert.equal(normalizeOwnedPath('./src\\components/Button.tsx'), 'src/components/Button.tsx');
  assert.equal(normalizeOwnedPath('src/ui/sub/../Button.tsx/'), 'src/ui/Button.tsx');
  assert.deepEqual(normalizeOwnedPaths(['src\\a.ts', './src/a.ts', 'src/b.ts']), ['src/a.ts', 'src/b.ts']);

  assert.throws(() => normalizeOwnedPath(''), /must not be empty/i);
  assert.throws(() => normalizeOwnedPath('   '), /must not be empty/i);
  assert.throws(() => normalizeOwnedPath('.'), /subdirectory/i);
  assert.throws(() => normalizeOwnedPath('./'), /subdirectory/i);
  assert.throws(() => normalizeOwnedPath('../secret.ts'), /escapes/i);
  assert.throws(() => normalizeOwnedPath('src/../../secret.ts'), /escapes/i);
  assert.throws(() => normalizeOwnedPath('/etc/passwd'), /Absolute/i);
  assert.throws(() => normalizeOwnedPath('C:\\repo\\file.ts'), /Absolute/i);
  assert.throws(() => normalizeOwnedPath('src/\0file.ts'), /null bytes/i);
});

test('pathsOverlap distinguishes parent-child containment from shared-prefix siblings', () => {
  assert.equal(pathsOverlap('src/index.ts', 'src/index.ts'), true);
  assert.equal(pathsOverlap('src/components', 'src/components/Button.tsx'), true);
  assert.equal(pathsOverlap('src/components/Button.tsx', 'src/components'), true);
  assert.equal(pathsOverlap('src/task', 'src/task-service.ts'), false);
  assert.equal(pathsOverlap('src/a.ts', 'src/b.ts'), false);

  const lock = {
    path: 'src/components',
    planId: 'p1',
    taskId: 't1',
    agentId: 'agent-1',
    acquiredAt: '2026-11-14T00:00:00.000Z'
  };
  assert.equal(findLockConflict('src/components/Button.tsx', [lock], 't2')?.taskId, 't1');
  assert.equal(findLockConflict('src/components/Button.tsx', [lock], 't1'), null);
});

test('claimTask rejects overlapping ownedPaths and preserves atomic state', async () => {
  const service = new TaskService(new MemoryRepository());
  const { tasks } = await prepareParallelPlanningTasks(service);
  const first = tasks[0]!;
  const second = tasks[1]!;

  const claimedFirst = await service.claimTask(first.id, 'agent-1', ['src/ui/', 'src\\shared\\tokens.ts']);
  assert.deepEqual(claimedFirst.ownedPaths, ['src/ui', 'src/shared/tokens.ts']);

  // Exact match, descendant under directory, and ancestor containing locked file must conflict.
  await assert.rejects(() => service.claimTask(second.id, 'agent-2', ['src/shared/tokens.ts']), /File ownership conflict/i);
  await assert.rejects(() => service.claimTask(second.id, 'agent-2', ['src/ui/Button.tsx']), /File ownership conflict/i);
  await assert.rejects(() => service.claimTask(second.id, 'agent-2', ['src/shared']), /File ownership conflict/i);

  // Verify failed claim did not mutate second task or create partial locks.
  const remainingLocks = await service.listFileLocks();
  assert.equal(remainingLocks.length, 2);

  // Sibling prefix and disjoint files succeed in parallel.
  const claimedSecond = await service.claimTask(second.id, 'agent-2', ['src/ui-tests/spec.ts', 'src/api/routes.ts']);
  assert.equal(claimedSecond.status, 'in_progress');
  assert.equal((await service.listFileLocks()).length, 4);
});

test('completing, blocking, failing, or reopening a task releases its file locks', async () => {
  const service = new TaskService(new MemoryRepository());
  const { planId, tasks } = await prepareParallelPlanningTasks(service);
  const first = tasks[0]!;
  const second = tasks[1]!;

  await service.claimTask(first.id, 'agent-1', ['src/domain/models.ts']);
  const evidence = await service.recordEvidence(evidenceInput(planId, first.id, 'agent-1'));
  await service.completeTask(first.id, 'completed', [evidence.id]);

  assert.equal((await service.listFileLocks({ path: 'src/domain/models.ts' })).length, 0);
  const claimedSecond = await service.claimTask(second.id, 'agent-2', ['src/domain/models.ts']);
  assert.equal(claimedSecond.status, 'in_progress');

  await service.reopenTask(second.id, 'Requirement changed');
  assert.equal((await service.listFileLocks()).length, 0);
  const plan = await service.getPlan(planId);
  assert.deepEqual(plan.tasks.find(t => t.id === second.id)?.ownedPaths, []);
});

test('acquireFileLocks and releaseFileLocks enforce claiming agent identity and atomicity', async () => {
  const service = new TaskService(new MemoryRepository());
  const { planId, tasks } = await prepareParallelPlanningTasks(service);
  const first = tasks[0]!;
  const second = tasks[1]!;

  await service.claimTask(first.id, 'agent-1', ['src/a.ts']);
  await service.claimTask(second.id, 'agent-2', ['src/b.ts']);

  // Atomic check: first path is free, second path conflicts with second task -> none acquired.
  await assert.rejects(() => service.acquireFileLocks(first.id, 'agent-1', ['src/c.ts', 'src/b.ts']), /File ownership conflict/i);
  assert.equal((await service.listFileLocks({ path: 'src/c.ts' })).length, 0);

  // Wrong agent cannot acquire or release locks on someone else's claimed task.
  await assert.rejects(() => service.acquireFileLocks(first.id, 'rogue-agent', ['src/c.ts']), /claimed by "agent-1"/i);
  await assert.rejects(() => service.releaseFileLocks(first.id, 'rogue-agent', ['src/a.ts']), /claimed by "agent-1"/i);

  const acquired = await service.acquireFileLocks(first.id, 'agent-1', ['src/c.ts']);
  assert.deepEqual(acquired.task.ownedPaths, ['src/a.ts', 'src/c.ts']);

  const partialRelease = await service.releaseFileLocks(first.id, 'agent-1', ['src/a.ts']);
  assert.deepEqual(partialRelease.releasedPaths, ['src/a.ts']);
  assert.deepEqual(partialRelease.task.ownedPaths, ['src/c.ts']);

  const filteredByPath = await service.listFileLocks({ planId, path: 'src' });
  assert.deepEqual(filteredByPath.map(lock => lock.path), ['src/b.ts', 'src/c.ts']);

  const fullRelease = await service.releaseFileLocks(first.id, 'agent-1');
  assert.deepEqual(fullRelease.releasedPaths, ['src/c.ts']);
  assert.deepEqual(fullRelease.task.ownedPaths, []);
});

test('MCP server exposes claim_task ownedPaths and file-lock tools end-to-end', async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'harness-mcp-locks-'));
  try {
    const canonicalRoot = await realpath(workspaceRoot);
    const guard = new WorkspaceGuard(canonicalRoot);
    const stateDir = await guard.ensureEvidenceDirectory('.harness');
    const repository = new JsonStateRepository(path.join(stateDir, 'state.json'));
    const taskService = new TaskService(repository);
    const checklistWriter = new ChecklistDocumentWriter(taskService, guard);
    const noopInspector: BrowserInspectorPort = {
      discoverRoutes: async () => ({ baseUrl: 'http://127.0.0.1:3000/', routes: ['/'], discoveredAt: new Date().toISOString() }),
      inspectResponsive: async () => { throw new Error('Not used in lock test'); },
      runInteractionScenario: async () => { throw new Error('Not used in lock test'); },
      auditVisualA11y: async () => { throw new Error('Not used in lock test'); }
    };
    const noopDevServer: DevServerPort = {
      start: async () => { throw new Error('Not used in lock test'); },
      ensure: async () => ({ id: 'none', pid: null, status: 'running', reused: true }),
      status: async () => ({}),
      stop: async () => ({ id: 'none', status: 'stopped' }),
      stopAll: async () => undefined
    };

    const mcpServer = createMcpServer({
      workspaceRoot: canonicalRoot,
      harnessRoot: process.cwd(),
      guard,
      taskService,
      inspector: noopInspector,
      devServer: noopDevServer,
      skillRegistry: new FileSkillRegistry(path.join(process.cwd(), '.agent', 'skills')),
      moduleRegistry: new ModuleRegistry(path.join(process.cwd(), 'catalogs', 'modules.json')),
      checklistWriter,
      maxParallelTasks: 4,
      browserTimeoutMs: 5000
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const pending = new Map<number, { resolve: (value: JSONRPCResultResponse) => void; reject: (err: Error) => void }>();
    let nextId = 1;
    clientTransport.onmessage = (message: JSONRPCMessage) => {
      if ('id' in message && typeof message.id === 'number' && ('result' in message || 'error' in message)) {
        const waiter = pending.get(message.id);
        if (!waiter) return;
        pending.delete(message.id);
        if ('error' in message) {
          waiter.reject(new Error(message.error.message));
        } else {
          waiter.resolve(message);
        }
      }
    };
    const request = async (method: string, params?: Record<string, unknown>) => {
      const id = nextId++;
      const promise = new Promise<JSONRPCResultResponse>((resolve, reject) => pending.set(id, { resolve, reject }));
      await clientTransport.send({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) });
      return (await promise).result as Record<string, unknown>;
    };
    const callTool = async (name: string, args: Record<string, unknown>) =>
      request('tools/call', { name, arguments: args }) as Promise<{ isError?: boolean; content: Array<{ text: string }> }>;

    await mcpServer.connect(serverTransport);
    await clientTransport.start();
    await request('initialize', {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1.0.0' }
    });
    await clientTransport.send({ jsonrpc: '2.0', method: 'notifications/initialized' });

    const createdRes = await callTool('harness.create_execution_plan', {
      title: 'Locking check',
      request: 'Build backend service with strict path locking'
    });
    const created = JSON.parse(createdRes.content[0]!.text) as { plan: { id: string }; tasks: Array<{ id: string }> };
    const taskId = created.tasks[0]!.id;

    const escapeAttempt = await callTool('harness.claim_task', {
      taskId,
      agentId: 'mcp-agent-escape',
      ownedPaths: ['../outside.ts']
    });
    assert.equal(escapeAttempt.isError, true);

    const claimRes = await callTool('harness.claim_task', {
      taskId,
      agentId: 'mcp-agent-1',
      ownedPaths: ['src/index.ts']
    });
    assert.equal(claimRes.isError, undefined);
    const claimedTask = JSON.parse(claimRes.content[0]!.text) as { ownedPaths: string[] };
    assert.deepEqual(claimedTask.ownedPaths, ['src/index.ts']);

    const acquireRes = await callTool('harness.acquire_file_locks', {
      taskId,
      agentId: 'mcp-agent-1',
      paths: ['src/server.ts']
    });
    assert.equal(acquireRes.isError, undefined);

    const listRes = await callTool('harness.list_file_locks', { planId: created.plan.id });
    const locks = JSON.parse(listRes.content[0]!.text) as Array<{ path: string }>;
    assert.deepEqual(locks.map(l => l.path), ['src/index.ts', 'src/server.ts']);

    const badRelease = await callTool('harness.release_file_locks', {
      taskId,
      agentId: 'other-agent',
      paths: ['src/index.ts']
    });
    assert.equal(badRelease.isError, true);

    const goodRelease = await callTool('harness.release_file_locks', {
      taskId,
      agentId: 'mcp-agent-1'
    });
    assert.equal(goodRelease.isError, undefined);
    const afterLocks = JSON.parse((await callTool('harness.list_file_locks', { planId: created.plan.id })).content[0]!.text) as unknown[];
    assert.equal(afterLocks.length, 0);

    await clientTransport.close();
    await mcpServer.close();
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});
