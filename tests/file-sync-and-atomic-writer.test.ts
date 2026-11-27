import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeFileAtomicIfChanged } from '../src/infrastructure/persistence/atomic-file-writer.js';
import { WorkspaceFileFingerprinter } from '../src/infrastructure/persistence/file-fingerprinter.js';
import { ChecklistDocumentWriter } from '../src/infrastructure/persistence/checklist-document-writer.js';
import { SqliteStateRepository } from '../src/infrastructure/persistence/sqlite-state-repository.js';
import { WorkspaceGuard } from '../src/infrastructure/security/workspace-guard.js';
import { FileSkillRegistry } from '../src/infrastructure/skills/file-skill-registry.js';
import { ModuleRegistry } from '../src/infrastructure/catalog/module-registry.js';
import { TaskService } from '../src/application/task-service.js';
import { AutopilotService } from '../src/application/autopilot-service.js';
import { pathsOverlap, normalizeOwnedPaths } from '../src/domain/file-ownership.js';
import { createMcpServer } from '../src/interfaces/mcp/server.js';
import type { BrowserInspectorPort, DevServerPort } from '../src/domain/ports.js';

test('writeFileAtomicIfChanged skips identical writes and serializes concurrent writes safely', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'craftrig-atomic-'));
  try {
    const target = path.join(dir, 'doc.md');
    const first = await writeFileAtomicIfChanged(target, '# Hello\n');
    assert.equal(first.written, true);
    assert.equal(first.unchanged, false);

    const beforeStat = await stat(target);
    await new Promise(resolve => setTimeout(resolve, 35));

    const second = await writeFileAtomicIfChanged(target, '# Hello\n');
    assert.equal(second.written, false);
    assert.equal(second.unchanged, true);
    const afterStat = await stat(target);
    assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs, 'Unchanged file must not touch mtime on disk');

    // Concurrent writes to the same file must serialize cleanly without throwing EPERM/EBUSY
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, idx) => writeFileAtomicIfChanged(target, `revision-${idx}`))
    );
    assert.equal(results.length, 12);
    const finalContent = await readFile(target, 'utf8');
    assert.match(finalContent, /^revision-\d+$/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('ChecklistDocumentWriter avoids unnecessary disk rewrites when plan state is unchanged', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'craftrig-checklist-idempotent-'));
  const repo = new SqliteStateRepository(':memory:');
  try {
    const canonicalRoot = await realpath(dir);
    const guard = new WorkspaceGuard(canonicalRoot);
    const taskService = new TaskService(repo);
    const writer = new ChecklistDocumentWriter(taskService, guard);

    const created = await taskService.createPlan({ title: 'Idempotent checklist', request: 'Build frontend landing page' });
    const relPath = await writer.write(created.plan.id);
    const fullPath = path.join(canonicalRoot, relPath);
    const firstStat = await stat(fullPath);

    await new Promise(resolve => setTimeout(resolve, 40));
    await writer.write(created.plan.id);
    const secondStat = await stat(fullPath);
    assert.equal(secondStat.mtimeMs, firstStat.mtimeMs, 'Checklist rewrite with unchanged plan state must not touch disk');
  } finally {
    repo.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('file-ownership detects case-insensitive Windows path overlaps across tasks', async () => {
  assert.equal(pathsOverlap('src/components/Hero.tsx', 'src/components/hero.tsx'), true);
  assert.equal(pathsOverlap('SRC/Components', 'src/components/Navbar.tsx'), true);
  assert.deepEqual(normalizeOwnedPaths(['src/App.tsx', 'src/app.tsx']), ['src/App.tsx']);

  const repo = new SqliteStateRepository(':memory:');
  try {
    const service = new TaskService(repo);
    const created = await service.createPlan({
      title: 'Case-insensitive lock check',
      request: 'Build frontend and backend modules',
      domains: ['frontend', 'backend']
    });
    const discovery = created.tasks[0]!;
    await service.claimTask(discovery.id, 'lead');
    const ev = await service.recordEvidence({
      planId: created.plan.id,
      taskId: discovery.id,
      kind: 'manual-review',
      title: 'Discovery complete',
      description: 'Done',
      path: null,
      uri: 'https://internal.test/ok',
      metadata: {},
      createdBy: 'lead'
    });
    await service.completeTask(discovery.id, 'completed', [ev.id]);

    const ready = await service.getReadyTasks(created.plan.id);
    assert.ok(ready.length >= 2);
    await service.claimTask(ready[0]!.id, 'agent-a', ['src/components/Hero.tsx']);
    await assert.rejects(
      () => service.claimTask(ready[1]!.id, 'agent-b', ['src/components/hero.tsx']),
      /File ownership conflict/i
    );
  } finally {
    repo.close();
  }
});

test('craftrig_check_file_sync detects external on-disk drift and craftrig_doctor reports Compare/Overwrite risk', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'craftrig-sync-doctor-'));
  try {
    const canonicalRoot = await realpath(dir);
    await mkdir(path.join(canonicalRoot, 'src'), { recursive: true });
    const targetFile = path.join(canonicalRoot, 'src', 'page.tsx');
    await writeFile(targetFile, 'export const v = 1;\n', 'utf8');

    const guard = new WorkspaceGuard(canonicalRoot);
    const repo = new SqliteStateRepository(path.join(canonicalRoot, '.craftrig', 'state.sqlite'), { idleCloseMs: 0 });
    const fingerprinter = new WorkspaceFileFingerprinter(guard);
    const taskService = new TaskService(repo, undefined, undefined, fingerprinter);
    const checklistWriter = new ChecklistDocumentWriter(taskService, guard);

    const noopInspector: BrowserInspectorPort = {
      discoverRoutes: async () => ({ baseUrl: 'http://127.0.0.1:3000/', routes: ['/'], discoveredAt: new Date().toISOString() }),
      inspectResponsive: async () => { throw new Error('Not used'); },
      runInteractionScenario: async () => { throw new Error('Not used'); },
      auditVisualA11y: async () => { throw new Error('Not used'); }
    };
    const noopDevServer: DevServerPort = {
      start: async () => ({ id: 'd1', pid: 1, status: 'running' }),
      ensure: async () => ({ id: 'd1', pid: 1, status: 'running', reused: true }),
      status: async () => ({ id: 'd1', status: 'running' }),
      stop: async () => ({ id: 'd1', status: 'stopped' }),
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

    const tools = (server as any)._registeredTools;
    assert.ok(tools['craftrig_check_file_sync']);
    assert.ok(tools['craftrig_doctor']);

    const plan = await taskService.createPlan({ title: 'Sync Guard Test', request: 'Update page component safely' });
    const task = plan.tasks[0]!;
    await taskService.claimTask(task.id, 'agent-1', ['src/page.tsx']);

    // Initially clean for owning agent, blocked for another agent
    const cleanRes = JSON.parse((await tools['craftrig_check_file_sync'].handler({
      paths: ['src/page.tsx'],
      taskId: task.id
    })).content[0].text);
    assert.equal(cleanRes.allSafeToWrite, true);
    assert.equal(cleanRes.files[0].status, 'clean');

    const otherAgentRes = JSON.parse((await tools['craftrig_check_file_sync'].handler({
      paths: ['src/PAGE.tsx'],
      agentId: 'agent-2'
    })).content[0].text);
    assert.equal(otherAgentRes.allSafeToWrite, false);
    assert.equal(otherAgentRes.files[0].status, 'locked_by_other_agent');

    // Simulate external editor/formatter editing the file on disk -> triggers drift guard!
    await writeFile(targetFile, 'export const v = 2;\n', 'utf8');
    const driftedRes = JSON.parse((await tools['craftrig_check_file_sync'].handler({
      paths: ['src/page.tsx'],
      taskId: task.id
    })).content[0].text);
    assert.equal(driftedRes.allSafeToWrite, false);
    assert.equal(driftedRes.files[0].status, 'drifted_on_disk');
    assert.equal(driftedRes.files[0].recoveryAction, 'reload_file_before_edit');

    // Doctor detects high Compare/Overwrite risk + missing watcherExclude
    const doctorRes = JSON.parse((await tools['craftrig_doctor'].handler({ planId: plan.plan.id })).content[0].text);
    assert.equal(doctorRes.compareOverwriteRisk, 'high');
    assert.equal(doctorRes.locks.driftedFiles.length, 1);
    assert.equal(doctorRes.ideWatcherHygiene.hasCraftrigWatcherExclude, false);
    assert.deepEqual(doctorRes.tools.invalidToolNames, []);

    // Adding .vscode/settings.json watcher exclude clears watcher warning
    await mkdir(path.join(canonicalRoot, '.vscode'), { recursive: true });
    await writeFile(
      path.join(canonicalRoot, '.vscode', 'settings.json'),
      JSON.stringify({ 'files.watcherExclude': { '**/.craftrig/**': true } }),
      'utf8'
    );
    const doctorAfterSettings = JSON.parse((await tools['craftrig_doctor'].handler({ planId: plan.plan.id })).content[0].text);
    assert.equal(doctorAfterSettings.ideWatcherHygiene.hasCraftrigWatcherExclude, true);

    repo.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('AutopilotService.selectDisjointWave skips ready tasks overlapping active in-progress file locks', async () => {
  const repo = new SqliteStateRepository(':memory:');
  try {
    const taskService = new TaskService(repo);
    const autopilot = new AutopilotService(taskService, 4);
    const created = await taskService.createPlan({
      title: 'Active Lock Wave Test',
      request: 'Build frontend and backend modules',
      domains: ['frontend', 'backend']
    });
    const discovery = created.tasks[0]!;
    await taskService.claimTask(discovery.id, 'lead');
    const ev = await taskService.recordEvidence({
      planId: created.plan.id,
      taskId: discovery.id,
      kind: 'manual-review',
      title: 'Discovery done',
      description: 'ok',
      path: null,
      uri: 'https://internal.test/ok',
      metadata: {},
      createdBy: 'lead'
    });
    await taskService.completeTask(discovery.id, 'completed', [ev.id]);

    const ready = await taskService.getReadyTasks(created.plan.id);
    const archTask = ready.find(t => t.recommendedPaths?.includes('src/domain'))!;
    const govTask = ready.find(t => t.id !== archTask.id)!;
    // Claim govTask with a lock on src/domain (overlapping archTask's recommendedPaths!)
    await taskService.claimTask(govTask.id, 'agent-gov', ['src/domain/shared.ts']);

    const nextWave = await autopilot.next(created.plan.id);
    const dispatchedIds = nextWave.dispatchWave.map(w => w.taskId);
    assert.ok(!dispatchedIds.includes(archTask.id), 'Must not dispatch task overlapping active in_progress file lock');
  } finally {
    repo.close();
  }
});
