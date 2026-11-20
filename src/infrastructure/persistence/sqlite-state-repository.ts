import { DatabaseSync } from 'node:sqlite';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { EMPTY_STATE, type HarnessState } from '../../domain/models.js';
import type { StateRepository } from '../../domain/ports.js';

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

export class SqliteStateRepository implements StateRepository {
  private readonly mutex = new AsyncMutex();
  private db: DatabaseSync | null = null;

  constructor(private readonly dbPath: string) {}

  private async getDb(): Promise<DatabaseSync> {
    if (this.db) return this.db;
    if (this.dbPath !== ':memory:') {
      await mkdir(path.dirname(this.dbPath), { recursive: true });
    }
    const db = new DatabaseSync(this.dbPath);
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA synchronous = NORMAL;');
    db.exec('PRAGMA busy_timeout = 5000;');
    db.exec(`
      CREATE TABLE IF NOT EXISTS craftrig_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;
    `);
    this.db = db;
    return db;
  }

  async read(): Promise<HarnessState> {
    return this.mutex.run(async () => {
      const db = await this.getDb();
      const stmt = db.prepare('SELECT value FROM craftrig_state WHERE key = ?');
      const row = stmt.get('state') as { value: string } | undefined;
      if (!row) {
        return structuredClone(EMPTY_STATE);
      }
      try {
        const parsed = JSON.parse(row.value) as Partial<HarnessState>;
        const tasks = Object.fromEntries(
          Object.entries(parsed.tasks ?? {}).map(([id, task]) => [id, { ...task, ownedPaths: task.ownedPaths ?? [] }])
        );
        return {
          ...structuredClone(EMPTY_STATE),
          ...parsed,
          tasks,
          fileLocks: parsed.fileLocks ?? {}
        };
      } catch {
        return structuredClone(EMPTY_STATE);
      }
    });
  }

  async transact<T>(operation: (state: HarnessState) => T | Promise<T>): Promise<T> {
    return this.mutex.run(async () => {
      const db = await this.getDb();
      db.exec('BEGIN IMMEDIATE;');
      try {
        const selectStmt = db.prepare('SELECT value FROM craftrig_state WHERE key = ?');
        const row = selectStmt.get('state') as { value: string } | undefined;
        let state: HarnessState;
        if (!row) {
          state = structuredClone(EMPTY_STATE);
        } else {
          try {
            const parsed = JSON.parse(row.value) as Partial<HarnessState>;
            const tasks = Object.fromEntries(
              Object.entries(parsed.tasks ?? {}).map(([id, task]) => [id, { ...task, ownedPaths: task.ownedPaths ?? [] }])
            );
            state = {
              ...structuredClone(EMPTY_STATE),
              ...parsed,
              tasks,
              fileLocks: parsed.fileLocks ?? {}
            };
          } catch {
            state = structuredClone(EMPTY_STATE);
          }
        }

        const result = await operation(state);

        const upsertStmt = db.prepare(`
          INSERT INTO craftrig_state (key, value)
          VALUES ('state', ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value;
        `);
        upsertStmt.run(JSON.stringify(state));
        db.exec('COMMIT;');
        return result;
      } catch (error) {
        try {
          db.exec('ROLLBACK;');
        } catch {
          // Ignore rollback failure if transaction was not started
        }
        throw error;
      }
    });
  }

  close(): void {
    if (this.db) {
      try {
        this.db.close();
      } finally {
        this.db = null;
      }
    }
  }
}
