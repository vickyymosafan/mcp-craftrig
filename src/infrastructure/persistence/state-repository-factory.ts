import path from 'node:path';
import type { StateRepository } from '../../domain/ports.js';
import type { StateBackendMode } from '../config/runtime-config.js';
import { JsonStateRepository } from './json-state-repository.js';
import { SqliteStateRepository } from './sqlite-state-repository.js';

export interface CreateStateRepositoryOptions {
  stateDirectory: string;
  backend: StateBackendMode;
  maxParallelTasks: number;
  sqliteIdleCloseMs: number;
}

export function createStateRepository(options: CreateStateRepositoryOptions): {
  repository: StateRepository;
  selectedBackend: 'json' | 'sqlite';
  statePath: string;
} {
  const preferSqlite =
    options.backend === 'sqlite' ||
    (options.backend === 'auto' && options.maxParallelTasks > 1);

  if (preferSqlite) {
    try {
      const dbPath = path.join(options.stateDirectory, 'state.sqlite');
      return {
        repository: new SqliteStateRepository(dbPath, { idleCloseMs: options.sqliteIdleCloseMs }),
        selectedBackend: 'sqlite',
        statePath: dbPath
      };
    } catch {
      if (options.backend === 'sqlite') {
        throw new Error('SQLite backend was explicitly requested but node:sqlite could not be initialized.');
      }
    }
  }

  const jsonPath = path.join(options.stateDirectory, 'state.json');
  return {
    repository: new JsonStateRepository(jsonPath),
    selectedBackend: 'json',
    statePath: jsonPath
  };
}
