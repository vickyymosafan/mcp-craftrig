import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildConventionalCommit } from '../src/domain/conventional-commit.js';
import { GitChangesReader, parseGitPorcelainOutput } from '../src/infrastructure/discovery/git-changes-reader.js';
import { TaskService } from '../src/application/task-service.js';
import { SqliteStateRepository } from '../src/infrastructure/persistence/sqlite-state-repository.js';
import { WorkspaceGuard } from '../src/infrastructure/security/workspace-guard.js';
import { FileSkillRegistry } from '../src/infrastructure/skills/file-skill-registry.js';
import { ModuleRegistry } from '../src/infrastructure/catalog/module-registry.js';
import { ChecklistDocumentWriter } from '../src/infrastructure/persistence/checklist-document-writer.js';
import { createMcpServer } from '../src/interfaces/mcp/server.js';
import type { BrowserInspectorPort, DevServerPort } from '../src/domain/ports.js';
import { EMPTY_STATE, type HarnessState } from '../src/domain/models.js';
import type { StateRepository } from '../src/domain/ports.js';

const execFileAsync = promisify(execFile);

class MemoryRepository implements StateRepository {
  private state: HarnessState = structuredClone(EMPTY_STATE);
  async read(): Promise<HarnessState> { return structuredClone(this.state); }
  async transact<T>(operation: (state: HarnessState) => T | Promise<T>): Promise<T> {
    return operation(this.state);
  }
}

test('buildConventionalCommit formats Conventional Commits 1.0.0 with noPush policy', () => {
  const commit = buildConventionalCommit({
    title: 'Add user authentication and JWT session guard.',
    summaryPoints: ['Implement login endpoint', 'Validate JWT expiration at boundary'],
    changedFiles: ['src/auth/login.ts', 'tests/auth.test.ts'],
    requirementIds: ['REQ-001', 'REQ-002'],
    testsRun: ['npm test'],
    domains: ['backend']
  });

  assert.equal(commit.specVersion, '1.0.0');
  assert.equal(commit.type, 'feat');
  assert.equal(commit.scope, 'backend');
  assert.equal(commit.breaking, false);
  assert.equal(commit.header, 'feat(backend): add user authentication and JWT session guard');
  assert.ok(commit.header.length <= 72);
  assert.match(commit.fullMessage, /^feat\(backend\): add user authentication and JWT session guard\n\n/);
  assert.match(commit.fullMessage, /Refs: REQ-001, REQ-002$/);
  assert.equal(commit.noPush, true);
  assert.doesNotMatch(commit.suggestedCommand, /\bgit\s+push\b/i);
  assert.match(commit.suggestedCommand, /^git commit -m /);
});

test('buildConventionalCommit infers docs/test/fix types and formats breaking changes', () => {
  const docsCommit = buildConventionalCommit({
    title: 'Update architecture guide',
    changedFiles: ['README.md', 'docs/ARCHITECTURE.md']
  });
  assert.equal(docsCommit.type, 'docs');

  const testCommit = buildConventionalCommit({
    title: 'Cover edge cases',
    changedFiles: ['tests/edge.test.ts']
  });
  assert.equal(testCommit.type, 'test');

  const breakingFix = buildConventionalCommit({
    title: 'Fix token parser overflow',
    scope: 'MCP Server',
    breakingChange: 'Reject tokens longer than 4096 bytes'
  });
  assert.equal(breakingFix.type, 'fix');
  assert.equal(breakingFix.scope, 'mcp-server');
  assert.equal(breakingFix.breaking, true);
  assert.equal(breakingFix.header, 'fix(mcp-server)!: fix token parser overflow');
  assert.match(breakingFix.footer ?? '', /^BREAKING CHANGE: Reject tokens longer than 4096 bytes/);
});

test('parseGitPorcelainOutput and GitChangesReader read workspace changes safely', async () => {
  assert.deepEqual(
    parseGitPorcelainOutput(' M src/a.ts\n?? "docs/my file.md"\nR  old.ts -> new.ts\n'),
    ['src/a.ts', 'docs/my file.md', 'new.ts']
  );

  const nonGitDir = await mkdtemp(path.join(tmpdir(), 'craftrig-nongit-'));
  try {
    const reader = new GitChangesReader(nonGitDir);
    const res = await reader.readWorkingTreeChanges();
    assert.equal(res.isGitRepo, false);
    assert.deepEqual(res.changedFiles, []);
  } finally {
    await rm(nonGitDir, { recursive: true, force: true });
  }

  const gitDir = await mkdtemp(path.join(tmpdir(), 'craftrig-git-'));
  try {
    await execFileAsync('git', ['init'], { cwd: gitDir });
    await writeFile(path.join(gitDir, 'feature.ts'), 'export const x = 1;\n', 'utf8');
    const reader = new GitChangesReader(gitDir);
    const res = await reader.readWorkingTreeChanges();
    assert.equal(res.isGitRepo, true);
    assert.deepEqual(res.changedFiles, ['feature.ts']);
  } finally {
    await rm(gitDir, { recursive: true, force: true });
  }
});

test('TaskService.evaluateGate emits conventionalCommit on PASS only and craftrig_prepare_commit_message works standalone', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'craftrig-commit-mcp-'));
  try {
    const canonicalRoot = await realpath(tempDir);
    await execFileAsync('git', ['init'], { cwd: canonicalRoot });
    await writeFile(path.join(canonicalRoot, 'src-change.ts'), 'export const ok = true;\n', 'utf8');

    const guard = new WorkspaceGuard(canonicalRoot);
    const repo = new SqliteStateRepository(path.join(canonicalRoot, 'state.sqlite'), { idleCloseMs: 0 });
    const gitReader = new GitChangesReader(canonicalRoot);
    const taskService = new TaskService(repo, undefined, gitReader);
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
      browserTimeoutMs: 5000,
      gitChangesReader: gitReader
    });

    const tools = (server as any)._registeredTools;
    assert.ok(tools['craftrig_prepare_commit_message'], 'craftrig_prepare_commit_message must be registered');

    // Standalone commit message from git working tree (without planId)
    const standaloneRes = await tools['craftrig_prepare_commit_message'].handler({
      summary: 'Add git working tree inspection'
    });
    const standalone = JSON.parse(standaloneRes.content[0].text);
    assert.equal(standalone.specVersion, '1.0.0');
    assert.equal(standalone.noPush, true);
    assert.match(standalone.header, /^feat: add git working tree inspection$/);
    assert.ok(standalone.changedFiles.includes('src-change.ts'));
    assert.doesNotMatch(standalone.suggestedCommand, /\bgit\s+push\b/i);

    // Gate blocked -> no conventionalCommit
    const memService = new TaskService(new MemoryRepository());
    const created = await memService.createPlan({
      title: 'Backend API endpoints',
      request: 'Implement backend health endpoint',
      domains: ['backend']
    });
    const blockedGate = await memService.evaluateGate(created.plan.id);
    assert.equal(blockedGate.status, 'blocked');
    assert.equal(blockedGate.conventionalCommit, undefined);

    // Complete all tasks & required checkpoints -> gate PASS emits conventionalCommit
    for (const task of created.tasks) {
      await memService.claimTask(task.id, 'backend-dev', ['src/health.ts']);
      const ev = await memService.recordEvidence({
        planId: created.plan.id,
        taskId: task.id,
        kind: 'test-report',
        title: `Verified ${task.title}`,
        description: 'Unit tests passed',
        path: null,
        uri: 'https://internal.test/ok',
        metadata: {},
        createdBy: 'backend-dev'
      });
      await memService.completeTask(task.id, 'completed', [ev.id], null, {
        summary: `Finished ${task.title}`,
        changedFiles: ['src/health.ts'],
        contracts: [],
        decisions: [],
        testsRun: ['npm test']
      });
    }
    const snap = await memService.getPlan(created.plan.id);
    const gateEv = await memService.recordEvidence({
      planId: created.plan.id,
      taskId: null,
      kind: 'security-report',
      title: 'All checkpoints verified',
      description: 'Security and regression passed',
      path: null,
      uri: 'https://internal.test/gate',
      metadata: {},
      createdBy: 'qa-verifier'
    });
    for (const cp of snap.checkpoints) {
      await memService.updateCheckpoint(created.plan.id, cp.id.split(':')[1]!, 'pass', [gateEv.id], null);
    }

    const passedGate = await memService.evaluateGate(created.plan.id);
    assert.equal(passedGate.status, 'pass');
    assert.ok(passedGate.conventionalCommit, 'PASS gate must include conventionalCommit');
    assert.equal(passedGate.conventionalCommit.noPush, true);
    assert.match(passedGate.conventionalCommit.header, /^feat\(backend\): backend API endpoints$/i);
    assert.match(passedGate.finalOutputRequirement ?? '', /(?:Do NOT|NEVER) run git push/i);

    repo.close();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
