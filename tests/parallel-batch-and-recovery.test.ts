import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TaskPlanner } from '../src/application/task-planner.js';
import { TaskService } from '../src/application/task-service.js';
import { SqliteStateRepository } from '../src/infrastructure/persistence/sqlite-state-repository.js';
import { WorkspaceGuard } from '../src/infrastructure/security/workspace-guard.js';
import { ChecklistDocumentWriter } from '../src/infrastructure/persistence/checklist-document-writer.js';
import { FileSkillRegistry } from '../src/infrastructure/skills/file-skill-registry.js';
import { ModuleRegistry } from '../src/infrastructure/catalog/module-registry.js';
import { createMcpServer } from '../src/interfaces/mcp/server.js';
import type { BrowserInspectorPort, DevServerPort } from '../src/domain/ports.js';

test('TaskPlanner creates parallel QA wave after integration task for UI plans', () => {
  const planner = new TaskPlanner();
  const { tasks } = planner.create({
    title: 'Test Parallel QA Wave',
    request: 'Build a luxury fashion showroom with Three.js WebGL and responsive UI'
  });

  const integrateTask = tasks.find(t => t.parallelGroup === 'integration');
  assert.ok(integrateTask, 'Expected integration task to exist');
  assert.equal(integrateTask.ownerRole, 'integration-lead');

  const qaWaveTasks = tasks.filter(t => t.parallelGroup === 'qa-wave');
  assert.ok(qaWaveTasks.length >= 5, `Expected at least 5 parallel QA tasks, got ${qaWaveTasks.length}`);

  // All parallel QA wave tasks must depend on integrateTask
  for (const qaTask of qaWaveTasks) {
    assert.ok(
      qaTask.dependsOn.includes(integrateTask.id),
      `Task "${qaTask.title}" (${qaTask.ownerRole}) must depend on integration task`
    );
  }

  // Final assurance tasks must depend on QA wave tasks
  const finalTasks = tasks.filter(t => t.parallelGroup === 'final-assurance');
  assert.ok(finalTasks.length >= 2, 'Expected security and performance final assurance tasks');
  for (const finalTask of finalTasks) {
    for (const qaTask of qaWaveTasks) {
      assert.ok(
        finalTask.dependsOn.includes(qaTask.id),
        `Final task "${finalTask.title}" must depend on QA task "${qaTask.title}"`
      );
    }
  }
});

test('claimReadyBatch claims multiple ready tasks atomically and rejects conflicting locks', async () => {
  const repo = new SqliteStateRepository(':memory:');
  const service = new TaskService(repo);

  try {
    const { plan } = await service.createPlan({
      title: 'Batch Claim Test',
      request: 'Backend and security API service'
    });

    const readyTasks = await service.getReadyTasks(plan.id);
    assert.equal(readyTasks.length, 1);
    const discoveryTask = readyTasks[0]!;

    // Complete discovery so downstream planning tasks become ready together
    await service.claimTask(discoveryTask.id, 'lead-1', ['docs/discovery']);
    await service.recordEvidence({
      planId: plan.id,
      taskId: discoveryTask.id,
      kind: 'manual-review',
      title: 'Discovery findings',
      description: 'Context verified',
      path: null,
      uri: 'https://internal.test/evidence',
      metadata: {},
      createdBy: 'lead-1'
    });
    const evidence = await service.getEvidenceForPlan(plan.id);
    await service.completeTask(discoveryTask.id, 'completed', [evidence[0]!.id]);

    const batchReady = await service.getReadyTasks(plan.id);
    assert.ok(batchReady.length >= 2, 'Expected multiple ready planning tasks');

    // Claim batch of tasks simultaneously
    const claimResult = await service.claimReadyBatch(plan.id, [
      { taskId: batchReady[0]!.id, agentId: 'agent-alpha', ownedPaths: ['src/domain'], leaseTimeoutMs: 20 * 60 * 1000 },
      { taskId: batchReady[1]!.id, agentId: 'agent-beta', ownedPaths: ['src/application'], leaseTimeoutMs: 20 * 60 * 1000 }
    ]);

    assert.equal(claimResult.claimedTasks.length, 2);
    assert.equal(claimResult.failedTasks.length, 0);
    assert.equal(claimResult.claimedTasks[0]!.status, 'in_progress');
    assert.equal(claimResult.claimedTasks[0]!.claimedBy, 'agent-alpha');
    assert.ok(claimResult.claimedTasks[0]!.leaseExpiresAt);
    assert.equal(claimResult.claimedTasks[1]!.claimedBy, 'agent-beta');

    // Attempting to batch claim an already claimed task or overlapping path reports clean failure
    const conflictResult = await service.claimReadyBatch(plan.id, [
      { taskId: batchReady[0]!.id, agentId: 'agent-gamma' }
    ]);
    assert.equal(conflictResult.claimedTasks.length, 0);
    assert.equal(conflictResult.failedTasks.length, 1);
    assert.match(conflictResult.failedTasks[0]!.reason, /cannot be claimed from status in_progress/);
  } finally {
    repo.close();
  }
});

test('heartbeatTask extends lease timeout for in-progress tasks', async () => {
  const repo = new SqliteStateRepository(':memory:');
  const service = new TaskService(repo);

  try {
    const { plan } = await service.createPlan({
      title: 'Heartbeat Test',
      request: 'Service implementation'
    });

    const ready = await service.getReadyTasks(plan.id);
    const task = ready[0]!;

    const claimed = await service.claimTask(task.id, 'agent-1', ['src/service.ts'], 5 * 60 * 1000);
    const initialExpiry = claimed.leaseExpiresAt;
    assert.ok(initialExpiry);

    // Send heartbeat extending by 30 minutes
    const beat = await service.heartbeatTask(task.id, 'agent-1', 30 * 60 * 1000);
    assert.ok(Date.parse(beat.leaseExpiresAt!) > Date.parse(initialExpiry));

    // Non-owner cannot heartbeat
    await assert.rejects(
      service.heartbeatTask(task.id, 'rogue-agent', 10 * 60 * 1000),
      /claimed by "agent-1", not "rogue-agent"/
    );
  } finally {
    repo.close();
  }
});

test('autoRecoverExpiredLeases automatically recovers abandoned tasks and releases file locks', async () => {
  const repo = new SqliteStateRepository(':memory:');
  const service = new TaskService(repo);

  try {
    const { plan } = await service.createPlan({
      title: 'Lease Expiry Auto-Recovery Test',
      request: 'Automated recovery verification'
    });

    const ready = await service.getReadyTasks(plan.id);
    const task = ready[0]!;

    // Claim task with negative lease (already expired)
    await service.claimTask(task.id, 'crashed-agent', ['src/core.ts'], -10000);

    // Verify task is currently in_progress and holds a lock
    const locksBefore = await service.listFileLocks({ planId: plan.id });
    assert.equal(locksBefore.length, 1);

    // Calling getReadyTasks automatically recovers expired task!
    const readyAfter = await service.getReadyTasks(plan.id);
    const recovered = readyAfter.find(t => t.id === task.id);
    assert.ok(recovered, 'Task should be recovered back to pending');
    assert.equal(recovered.status, 'pending');
    assert.equal(recovered.claimedBy, null);
    assert.match(recovered.failureReason ?? '', /Auto-recovered: agent lease expired/);

    // Verify file lock was also cleanly released
    const locksAfter = await service.listFileLocks({ planId: plan.id });
    assert.equal(locksAfter.length, 0);
  } finally {
    repo.close();
  }
});

test('MCP server exposes claim_ready_batch, heartbeat_task, and resource templates', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'craftrig-mcp-v24-test-'));
  try {
    const canonicalRoot = await realpath(tempDir);
    const guard = new WorkspaceGuard(canonicalRoot);
    const repo = new SqliteStateRepository(path.join(canonicalRoot, 'state.sqlite'));
    const taskService = new TaskService(repo);
    const checklistWriter = new ChecklistDocumentWriter(taskService, guard);

    const noopInspector: BrowserInspectorPort = {
      discoverRoutes: async () => ({ baseUrl: 'http://127.0.0.1:3000/', routes: ['/'], discoveredAt: new Date().toISOString() }),
      inspectResponsive: async () => { throw new Error('Not used'); },
      runInteractionScenario: async () => { throw new Error('Not used'); },
      auditVisualA11y: async () => { throw new Error('Not used'); }
    };
    const noopDevServer: DevServerPort = {
      start: async () => ({ id: 'dev-1', pid: 1234, status: 'starting' }),
      ensure: async () => ({ id: 'dev-1', pid: 1234, status: 'running', reused: true }),
      status: async () => ({ id: 'dev-1', status: 'running' }),
      stop: async () => ({ id: 'dev-1', status: 'stopped' }),
      stopAll: async () => undefined
    };

    const server = createMcpServer({
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

    const registeredTools = (server as any)._registeredTools;
    assert.ok(registeredTools['craftrig.claim_ready_batch'], 'craftrig.claim_ready_batch must be registered');
    assert.equal(registeredTools['harness.claim_ready_batch'], undefined, 'Legacy harness.* duplicate tools must not be registered');
    assert.ok(registeredTools['craftrig.heartbeat_task'], 'craftrig.heartbeat_task must be registered');
    assert.ok(registeredTools['localhost.ensure_dev_server'], 'localhost.ensure_dev_server must be registered');

    // Verify tool annotations
    assert.deepEqual(registeredTools['craftrig.get_ready_tasks'].annotations, {
      readOnlyHint: true,
      idempotentHint: true,
      destructiveHint: false
    });
    assert.deepEqual(registeredTools['craftrig.reopen_task'].annotations, {
      readOnlyHint: false,
      idempotentHint: false,
      destructiveHint: true
    });

    // Test ensure_dev_server tool handler
    const ensureHandler = registeredTools['localhost.ensure_dev_server'].handler;
    const ensureResult = await ensureHandler({ packageManager: 'npm', script: 'dev' });
    const ensureParsed = JSON.parse(ensureResult.content[0].text);
    assert.equal(ensureParsed.reused, true);
    assert.equal(ensureParsed.status, 'running');

    repo.close();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
