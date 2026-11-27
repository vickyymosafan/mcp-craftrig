import { readFile, stat } from 'node:fs/promises';
import { EMPTY_STATE, type HarnessState } from '../../domain/models.js';
import type { StateRepository, StorageStats } from '../../domain/ports.js';
import { writeFileAtomicIfChanged } from './atomic-file-writer.js';

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

export class JsonStateRepository implements StateRepository {
  private readonly mutex = new AsyncMutex();
  constructor(private readonly stateFile: string) {}

  async read(): Promise<HarnessState> {
    return this.mutex.run(async () => this.readUnsafe());
  }

  async transact<T>(operation: (state: HarnessState) => T | Promise<T>): Promise<T> {
    return this.mutex.run(async () => {
      const state = await this.readUnsafe();
      const result = await operation(state);
      await writeFileAtomicIfChanged(this.stateFile, JSON.stringify(state, null, 2), { skipIfUnchanged: true });
      return result;
    });
  }

  private async readUnsafe(): Promise<HarnessState> {
    try {
      const raw = await readFile(this.stateFile, 'utf8');
      const parsed = JSON.parse(raw) as Partial<HarnessState>;
      if (parsed.schemaVersion !== 1) throw new Error(`Unsupported state schema version: ${String(parsed.schemaVersion)}`);
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
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return structuredClone(EMPTY_STATE);
      throw error;
    }
  }

  async getStorageStats(): Promise<StorageStats> {
    const state = await this.read();
    const dbBytes = await stat(this.stateFile).then(s => s.size).catch(() => 0);
    return {
      backend: 'json',
      dbBytes,
      walBytes: 0,
      isOpen: false,
      counts: {
        plans: Object.keys(state.plans).length,
        tasks: Object.keys(state.tasks).length,
        checkpoints: Object.keys(state.checkpoints).length,
        evidence: Object.keys(state.evidence).length,
        fileLocks: Object.keys(state.fileLocks ?? {}).length,
        blueprints: Object.keys(state.blueprints ?? {}).length,
        interviews: Object.keys(state.interviews ?? {}).length
      }
    };
  }
}
