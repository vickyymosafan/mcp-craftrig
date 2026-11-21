import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  archivePlanSnapshot,
  computeMetricsHash,
  enforceEvidenceQuota,
  readArchivedPlanSnapshot,
  saveContentAddressedBlob
} from '../src/infrastructure/persistence/evidence-store.js';
import { SqliteStateRepository } from '../src/infrastructure/persistence/sqlite-state-repository.js';
import { createStateRepository } from '../src/infrastructure/persistence/state-repository-factory.js';
import { PlaywrightInspector } from '../src/infrastructure/browser/playwright-inspector.js';
import type { TaskNode } from '../src/domain/models.js';

test('saveContentAddressedBlob deduplicates identical buffers by SHA-256', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'craftrig-blob-test-'));
  try {
    const payload = Buffer.from('identical-jpeg-screenshot-bytes');
    const first = await saveContentAddressedBlob(tempDir, payload, '.jpg');
    const second = await saveContentAddressedBlob(tempDir, payload, '.jpg');

    assert.equal(first.deduplicated, false);
    assert.equal(second.deduplicated, true);
    assert.equal(first.path, second.path);
    assert.equal(first.sha256, second.sha256);
    assert.ok(existsSync(first.path));
    assert.equal(computeMetricsHash({ a: 1 }).length, 24);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('enforceEvidenceQuota evicts oldest unreferenced files via LRU while protecting PASS checkpoint paths', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'craftrig-quota-test-'));
  try {
    const oldest = path.join(tempDir, 'oldest.jpg');
    const protectedFile = path.join(tempDir, 'protected-pass.jpg');
    const newest = path.join(tempDir, 'newest.jpg');

    await writeFile(oldest, Buffer.alloc(600, 1));
    await writeFile(protectedFile, Buffer.alloc(600, 2));
    await writeFile(newest, Buffer.alloc(600, 3));

    const t1 = new Date(Date.now() - 30_000);
    const t2 = new Date(Date.now() - 20_000);
    const t3 = new Date(Date.now() - 10_000);
    await utimes(oldest, t1, t1);
    await utimes(protectedFile, t2, t2);
    await utimes(newest, t3, t3);

    // Quota 1300 bytes -> must evict oldest (600) leaving protected + newest (1200)
    const res = await enforceEvidenceQuota(tempDir, 1300, new Set([protectedFile]));
    assert.equal(res.evictedFiles.length, 1);
    assert.equal(path.resolve(res.evictedFiles[0]!), path.resolve(oldest));
    assert.ok(!existsSync(oldest));
    assert.ok(existsSync(protectedFile), 'Protected PASS evidence must never be evicted');
    assert.ok(existsSync(newest));
    assert.ok(res.totalBytesAfter <= 1300);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('archivePlanSnapshot compresses with Brotli and round-trips cleanly', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'craftrig-archive-test-'));
  try {
    const sample = {
      planId: 'plan-123',
      tasks: Array.from({ length: 20 }, (_, i) => ({
        id: `task-${i}`,
        title: `Repeated engineering task description ${i}`,
        status: 'completed'
      }))
    };
    const archived = await archivePlanSnapshot(tempDir, 'plan-123', sample);
    assert.ok(archived.archivePath.endsWith('plan-123.json.br'));
    assert.ok(archived.compressedBytes < archived.rawBytes, 'Brotli archive should be smaller than raw JSON');
    const restored = await readArchivedPlanSnapshot<typeof sample>(archived.archivePath);
    assert.deepEqual(restored, sample);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('Lean SqliteStateRepository uses per-entity tables, auto-closes on idle, truncates WAL, and reopens transparently', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'craftrig-lean-sqlite-'));
  const dbPath = path.join(tempDir, 'state.sqlite');
  const repo = new SqliteStateRepository(dbPath, { idleCloseMs: 80 });

  try {
    const task: TaskNode = {
      id: 't-lean-1',
      planId: 'p-lean-1',
      title: 'Lean SQLite Task',
      description: 'Verify diff writes and idle close',
      ownerRole: 'frontend-developer',
      skillIds: ['frontend-implementation'],
      moduleIds: [1],
      domains: ['frontend'],
      dependsOn: [],
      ownedPaths: ['src/ui'],
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
    assert.equal(repo.isOpen(), true);

    // Wait for idle auto-close to release native memory and truncate WAL
    await new Promise(resolve => setTimeout(resolve, 180));
    assert.equal(repo.isOpen(), false, 'SQLite connection must auto-close when idle to drop native RAM to zero');

    const walSize = await stat(`${dbPath}-wal`).then(s => s.size).catch(() => 0);
    assert.equal(walSize, 0, 'WAL file should be truncated to 0 bytes on idle close');

    // Transparently reopens and reads persisted entity
    const loaded = await repo.read();
    assert.equal(loaded.tasks['t-lean-1']?.title, 'Lean SQLite Task');

    const stats = await repo.getStorageStats();
    assert.equal(stats.backend, 'sqlite');
    assert.equal(stats.counts.tasks, 1);
    await repo.vacuumIncremental(50);
  } finally {
    repo.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('Lean SqliteStateRepository automatically migrates legacy single-blob craftrig_state table', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'craftrig-legacy-migrate-'));
  const dbPath = path.join(tempDir, 'state.sqlite');

  // Seed legacy v1 single-blob table
  const seedDb = new DatabaseSync(dbPath);
  seedDb.exec('CREATE TABLE craftrig_state (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;');
  seedDb.prepare("INSERT INTO craftrig_state (key, value) VALUES ('state', ?)").run(
    JSON.stringify({
      schemaVersion: 1,
      plans: {},
      tasks: {
        'legacy-1': {
          id: 'legacy-1',
          planId: 'p1',
          title: 'Legacy Task',
          description: 'Migrated',
          ownerRole: 'dev',
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
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          completedAt: null,
          failureReason: null
        }
      },
      checkpoints: {},
      evidence: {},
      fileLocks: {},
      serverProcesses: {}
    })
  );
  seedDb.close();

  const repo = new SqliteStateRepository(dbPath, { idleCloseMs: 0 });
  try {
    const state = await repo.read();
    assert.equal(state.tasks['legacy-1']?.title, 'Legacy Task');
  } finally {
    repo.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('createStateRepository selects lean sqlite in auto mode when maxParallelTasks > 1 and json when forced', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'craftrig-factory-'));
  try {
    const autoMulti = createStateRepository({
      stateDirectory: tempDir,
      backend: 'auto',
      maxParallelTasks: 4,
      sqliteIdleCloseMs: 1000
    });
    assert.equal(autoMulti.selectedBackend, 'sqlite');
    autoMulti.repository.close?.();

    const autoSingle = createStateRepository({
      stateDirectory: tempDir,
      backend: 'auto',
      maxParallelTasks: 1,
      sqliteIdleCloseMs: 1000
    });
    assert.equal(autoSingle.selectedBackend, 'json');

    const forcedJson = createStateRepository({
      stateDirectory: tempDir,
      backend: 'json',
      maxParallelTasks: 8,
      sqliteIdleCloseMs: 1000
    });
    assert.equal(forcedJson.selectedBackend, 'json');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('PlaywrightInspector failures-only mode skips screenshots on PASS and captures deduplicated JPEG on FAIL', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'craftrig-diet-browser-'));
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (req.url === '/overflow') {
      res.end('<!doctype html><html><body style="margin:0"><div style="width:1600px;height:40px;background:#111;color:#fff">Wide overflow</div></body></html>');
    } else {
      res.end('<!doctype html><html><body style="margin:0;padding:16px"><h1>Clean Pass</h1></body></html>');
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const inspector = new PlaywrightInspector();
    const report = await inspector.inspectResponsive({
      baseUrl,
      routes: ['/', '/overflow'],
      viewports: [{ name: 'mobile-390', width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 1 }],
      evidenceDirectory: tempDir,
      timeoutMs: 15_000,
      allowedOverflowSelectors: [],
      captureScreenshots: 'failures-only'
    });

    const passCase = report.results.find(r => r.route === '/');
    const failCase = report.results.find(r => r.route === '/overflow');
    assert.ok(passCase && failCase);

    assert.equal(passCase.passed, true);
    assert.equal(passCase.screenshotPath, null, 'Passing case must NOT write screenshot in failures-only mode');
    assert.ok(passCase.metricsHash && passCase.metricsHash.length === 24);

    assert.equal(failCase.passed, false);
    assert.ok(failCase.screenshotPath && failCase.screenshotPath.endsWith('.jpg'), 'Failing case must save lean JPEG');
    assert.ok(existsSync(failCase.screenshotPath));
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(tempDir, { recursive: true, force: true });
  }
});
