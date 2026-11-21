import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { EMPTY_STATE, type HarnessState } from '../../domain/models.js';
import type { StateRepository, StorageStats } from '../../domain/ports.js';

class AsyncMutex {
  private tail: Promise<void> = Promise.resolve();
  async run<T>(operation: () => Promise<T> | T): Promise<T> {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const previous = this.tail;
    this.tail = previous.then(() => gate);
    await previous;
    try { return await operation(); } finally { release(); }
  }
}

interface EntityTableConfig {
  table: string;
  keyColumn: string;
  stateKey: 'plans' | 'tasks' | 'checkpoints' | 'evidence' | 'fileLocks' | 'serverProcesses' | 'blueprints' | 'interviews';
}

const ENTITY_TABLES: readonly EntityTableConfig[] = [
  { table: 'plans', keyColumn: 'id', stateKey: 'plans' },
  { table: 'tasks', keyColumn: 'id', stateKey: 'tasks' },
  { table: 'checkpoints', keyColumn: 'id', stateKey: 'checkpoints' },
  { table: 'evidence', keyColumn: 'id', stateKey: 'evidence' },
  { table: 'file_locks', keyColumn: 'path', stateKey: 'fileLocks' },
  { table: 'server_processes', keyColumn: 'id', stateKey: 'serverProcesses' },
  { table: 'blueprints', keyColumn: 'id', stateKey: 'blueprints' },
  { table: 'interviews', keyColumn: 'id', stateKey: 'interviews' }
] as const;

export interface SqliteStateRepositoryOptions {
  idleCloseMs?: number;
}

export class SqliteStateRepository implements StateRepository {
  private readonly mutex = new AsyncMutex();
  private readonly idleCloseMs: number;
  private db: DatabaseSync | null = null;
  private idleTimer: NodeJS.Timeout | null = null;

  constructor(private readonly dbPath: string, options: SqliteStateRepositoryOptions = {}) {
    this.idleCloseMs = options.idleCloseMs ?? 30_000;
  }

  private scheduleIdleClose(): void {
    if (this.dbPath === ':memory:' || this.idleCloseMs <= 0) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      void this.mutex.run(() => {
        this.closeInternal(true);
      });
    }, this.idleCloseMs);
    this.idleTimer.unref?.();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private async getDb(): Promise<DatabaseSync> {
    this.clearIdleTimer();
    if (this.db) return this.db;
    const isFreshFile = this.dbPath !== ':memory:' && !existsSync(this.dbPath);
    if (this.dbPath !== ':memory:') {
      await mkdir(path.dirname(this.dbPath), { recursive: true });
    }
    const db = new DatabaseSync(this.dbPath);
    if (isFreshFile || this.dbPath === ':memory:') {
      db.exec('PRAGMA auto_vacuum = INCREMENTAL;');
    }
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA synchronous = NORMAL;');
    db.exec('PRAGMA busy_timeout = 5000;');
    db.exec('PRAGMA cache_size = -512;');
    db.exec('PRAGMA temp_store = MEMORY;');
    db.exec('PRAGMA journal_size_limit = 1048576;');
    db.exec('PRAGMA wal_autocheckpoint = 200;');

    db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS plans (
        id TEXT PRIMARY KEY,
        updated_at TEXT NOT NULL,
        data TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        plan_id TEXT NOT NULL,
        status TEXT NOT NULL,
        phase_id TEXT,
        updated_at TEXT NOT NULL,
        data TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_tasks_plan_status ON tasks(plan_id, status);
      CREATE TABLE IF NOT EXISTS checkpoints (
        id TEXT PRIMARY KEY,
        plan_id TEXT NOT NULL,
        status TEXT NOT NULL,
        data TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_checkpoints_plan ON checkpoints(plan_id);
      CREATE TABLE IF NOT EXISTS evidence (
        id TEXT PRIMARY KEY,
        plan_id TEXT,
        task_id TEXT,
        kind TEXT NOT NULL,
        data TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_evidence_plan ON evidence(plan_id);
      CREATE TABLE IF NOT EXISTS file_locks (
        path TEXT PRIMARY KEY,
        plan_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        data TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS server_processes (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        data TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS blueprints (
        id TEXT PRIMARY KEY,
        updated_at TEXT NOT NULL,
        data TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS interviews (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        data TEXT NOT NULL
      ) STRICT;
    `);

    this.migrateLegacyBlobIfPresent(db);
    this.db = db;
    return db;
  }

  private migrateLegacyBlobIfPresent(db: DatabaseSync): void {
    const legacyTable = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'craftrig_state'")
      .get() as { name: string } | undefined;
    if (!legacyTable) return;
    const row = db.prepare("SELECT value FROM craftrig_state WHERE key = 'state'").get() as { value: string } | undefined;
    if (row) {
      try {
        const parsed = JSON.parse(row.value) as Partial<HarnessState>;
        const state = this.normalizeState(parsed);
        db.exec('BEGIN IMMEDIATE;');
        try {
          this.writeDiff(db, this.snapshotSerialized(structuredClone(EMPTY_STATE)), state);
          db.exec('DROP TABLE craftrig_state;');
          db.exec('COMMIT;');
        } catch (err) {
          try { db.exec('ROLLBACK;'); } catch { /* ignore */ }
          throw err;
        }
      } catch {
        // Leave legacy table untouched if unreadable
      }
    } else {
      db.exec('DROP TABLE IF EXISTS craftrig_state;');
    }
  }

  private normalizeState(parsed: Partial<HarnessState>): HarnessState {
    const tasks = Object.fromEntries(
      Object.entries(parsed.tasks ?? {}).map(([id, task]) => [id, { ...task, ownedPaths: task.ownedPaths ?? [] }])
    );
    return {
      ...structuredClone(EMPTY_STATE),
      ...parsed,
      tasks,
      fileLocks: parsed.fileLocks ?? {},
      blueprints: parsed.blueprints ?? {},
      interviews: parsed.interviews ?? {}
    };
  }

  private loadStateSync(db: DatabaseSync): HarnessState {
    const state = structuredClone(EMPTY_STATE);
    for (const cfg of ENTITY_TABLES) {
      const rows = db.prepare(`SELECT ${cfg.keyColumn} AS k, data FROM ${cfg.table}`).all() as Array<{ k: string; data: string }>;
      const target = (state[cfg.stateKey] ??= {}) as Record<string, unknown>;
      for (const row of rows) {
        try {
          const parsed = JSON.parse(row.data) as Record<string, unknown>;
          if (cfg.stateKey === 'tasks' && !Array.isArray(parsed.ownedPaths)) {
            parsed.ownedPaths = [];
          }
          target[row.k] = parsed;
        } catch {
          // Skip corrupted row
        }
      }
    }
    return state;
  }

  private snapshotSerialized(state: HarnessState): Record<string, Map<string, string>> {
    const snapshots: Record<string, Map<string, string>> = {};
    for (const cfg of ENTITY_TABLES) {
      const map = new Map<string, string>();
      const collection = (state[cfg.stateKey] ?? {}) as Record<string, unknown>;
      for (const [key, value] of Object.entries(collection)) {
        map.set(key, JSON.stringify(value));
      }
      snapshots[cfg.stateKey] = map;
    }
    return snapshots;
  }

  private upsertEntity(db: DatabaseSync, cfg: EntityTableConfig, key: string, raw: Record<string, unknown>, serialized: string): void {
    switch (cfg.table) {
      case 'plans':
        db.prepare('INSERT INTO plans (id, updated_at, data) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at, data = excluded.data')
          .run(key, String(raw.updatedAt ?? ''), serialized);
        break;
      case 'tasks':
        db.prepare('INSERT INTO tasks (id, plan_id, status, phase_id, updated_at, data) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET plan_id = excluded.plan_id, status = excluded.status, phase_id = excluded.phase_id, updated_at = excluded.updated_at, data = excluded.data')
          .run(key, String(raw.planId ?? ''), String(raw.status ?? 'pending'), raw.phaseId ? String(raw.phaseId) : null, String(raw.updatedAt ?? ''), serialized);
        break;
      case 'checkpoints': {
        const planId = key.includes(':') ? key.slice(0, key.indexOf(':')) : '';
        db.prepare('INSERT INTO checkpoints (id, plan_id, status, data) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET plan_id = excluded.plan_id, status = excluded.status, data = excluded.data')
          .run(key, planId, String(raw.status ?? 'pending'), serialized);
        break;
      }
      case 'evidence':
        db.prepare('INSERT INTO evidence (id, plan_id, task_id, kind, data) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET plan_id = excluded.plan_id, task_id = excluded.task_id, kind = excluded.kind, data = excluded.data')
          .run(key, raw.planId ? String(raw.planId) : null, raw.taskId ? String(raw.taskId) : null, String(raw.kind ?? 'other'), serialized);
        break;
      case 'file_locks':
        db.prepare('INSERT INTO file_locks (path, plan_id, task_id, data) VALUES (?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET plan_id = excluded.plan_id, task_id = excluded.task_id, data = excluded.data')
          .run(key, String(raw.planId ?? ''), String(raw.taskId ?? ''), serialized);
        break;
      case 'server_processes':
        db.prepare('INSERT INTO server_processes (id, status, data) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET status = excluded.status, data = excluded.data')
          .run(key, String(raw.status ?? 'starting'), serialized);
        break;
      case 'blueprints':
        db.prepare('INSERT INTO blueprints (id, updated_at, data) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at, data = excluded.data')
          .run(key, String(raw.updatedAt ?? ''), serialized);
        break;
      case 'interviews':
        db.prepare('INSERT INTO interviews (id, status, updated_at, data) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at, data = excluded.data')
          .run(key, String(raw.status ?? 'in_progress'), String(raw.updatedAt ?? ''), serialized);
        break;
    }
  }

  private writeDiff(db: DatabaseSync, before: Record<string, Map<string, string>>, afterState: HarnessState): void {
    for (const cfg of ENTITY_TABLES) {
      const prevMap = before[cfg.stateKey] ?? new Map<string, string>();
      const nextCollection = ((afterState[cfg.stateKey] ?? {}) as unknown) as Record<string, Record<string, unknown>>;
      const nextKeys = new Set(Object.keys(nextCollection));

      for (const oldKey of prevMap.keys()) {
        if (!nextKeys.has(oldKey)) {
          db.prepare(`DELETE FROM ${cfg.table} WHERE ${cfg.keyColumn} = ?`).run(oldKey);
        }
      }

      for (const [key, value] of Object.entries(nextCollection)) {
        const serialized = JSON.stringify(value);
        if (prevMap.get(key) !== serialized) {
          this.upsertEntity(db, cfg, key, value, serialized);
        }
      }
    }
  }

  async read(): Promise<HarnessState> {
    return this.mutex.run(async () => {
      const db = await this.getDb();
      try {
        return this.loadStateSync(db);
      } finally {
        this.scheduleIdleClose();
      }
    });
  }

  async transact<T>(operation: (state: HarnessState) => T | Promise<T>): Promise<T> {
    return this.mutex.run(async () => {
      const db = await this.getDb();
      db.exec('BEGIN IMMEDIATE;');
      try {
        const state = this.loadStateSync(db);
        const before = this.snapshotSerialized(state);
        const result = await operation(state);
        this.writeDiff(db, before, state);
        db.exec('COMMIT;');
        return result;
      } catch (error) {
        try {
          db.exec('ROLLBACK;');
        } catch {
          // Ignore rollback failure if transaction was not started
        }
        throw error;
      } finally {
        this.scheduleIdleClose();
      }
    });
  }

  async vacuumIncremental(pages = 100): Promise<void> {
    await this.mutex.run(async () => {
      const db = await this.getDb();
      try {
        db.exec(`PRAGMA incremental_vacuum(${Math.max(1, Math.floor(pages))});`);
        db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
      } finally {
        this.scheduleIdleClose();
      }
    });
  }

  async getStorageStats(): Promise<StorageStats> {
    return this.mutex.run(async () => {
      const wasOpen = this.db !== null;
      const db = await this.getDb();
      const countOf = (table: string) => {
        const row = db.prepare(`SELECT COUNT(*) AS cnt FROM ${table}`).get() as { cnt: number };
        return Number(row?.cnt ?? 0);
      };
      const counts = {
        plans: countOf('plans'),
        tasks: countOf('tasks'),
        checkpoints: countOf('checkpoints'),
        evidence: countOf('evidence'),
        fileLocks: countOf('file_locks'),
        blueprints: countOf('blueprints'),
        interviews: countOf('interviews')
      };
      let dbBytes = 0;
      let walBytes = 0;
      if (this.dbPath !== ':memory:') {
        dbBytes = await stat(this.dbPath).then(s => s.size).catch(() => 0);
        walBytes = await stat(`${this.dbPath}-wal`).then(s => s.size).catch(() => 0);
      }
      this.scheduleIdleClose();
      return {
        backend: 'sqlite',
        dbBytes,
        walBytes,
        isOpen: wasOpen,
        counts
      };
    });
  }

  isOpen(): boolean {
    return this.db !== null;
  }

  private closeInternal(truncateWal: boolean): void {
    this.clearIdleTimer();
    if (!this.db) return;
    try {
      if (truncateWal && this.dbPath !== ':memory:') {
        try { this.db.exec('PRAGMA wal_checkpoint(TRUNCATE);'); } catch { /* ignore */ }
        try { this.db.exec('PRAGMA optimize;'); } catch { /* ignore */ }
      }
      this.db.close();
    } finally {
      this.db = null;
    }
  }

  close(): void {
    this.closeInternal(true);
  }
}
