import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

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

const pathMutexes = new Map<string, AsyncMutex>();

function mutexForPath(targetPath: string): AsyncMutex {
  const key = path.resolve(targetPath).toLowerCase();
  let mutex = pathMutexes.get(key);
  if (!mutex) {
    mutex = new AsyncMutex();
    pathMutexes.set(key, mutex);
  }
  return mutex;
}

function sha256Of(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

const TRANSIENT_WINDOWS_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

async function renameWithRetry(source: string, target: string, maxAttempts = 6): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await rename(source, target);
      return;
    } catch (error) {
      lastError = error;
      const code = (error as NodeJS.ErrnoException)?.code;
      if (!code || !TRANSIENT_WINDOWS_CODES.has(code) || attempt === maxAttempts) {
        throw error;
      }
      await sleep(25 * attempt);
    }
  }
  throw lastError;
}

export interface AtomicWriteResult {
  written: boolean;
  unchanged: boolean;
  sha256: string;
  bytes: number;
}

export interface AtomicWriteOptions {
  mode?: number;
  skipIfUnchanged?: boolean;
}

/**
 * Serialized, content-deduplicated, Windows-safe atomic file writer.
 * Prevents IDE "Compare / Overwrite" save conflicts by:
 * 1. Serializing concurrent writes targeting the same path via a per-path mutex.
 * 2. Skipping disk writes completely when existing bytes match the new content SHA-256.
 * 3. Flushing to a unique temp file before atomic rename with Windows EPERM/EBUSY retry.
 */
export async function writeFileAtomicIfChanged(
  targetPath: string,
  content: string | Buffer,
  options: AtomicWriteOptions = {}
): Promise<AtomicWriteResult> {
  const resolved = path.resolve(targetPath);
  const buffer = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
  const nextHash = sha256Of(buffer);
  const skipIfUnchanged = options.skipIfUnchanged ?? true;

  return mutexForPath(resolved).run(async () => {
    if (skipIfUnchanged) {
      try {
        const existing = await readFile(resolved);
        if (existing.length === buffer.length && sha256Of(existing) === nextHash) {
          return { written: false, unchanged: true, sha256: nextHash, bytes: buffer.length };
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
          // Fall through and attempt write if read failed for non-ENOENT reasons
        }
      }
    }

    await mkdir(path.dirname(resolved), { recursive: true });
    const temporary = `${resolved}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, buffer, {
        flag: 'wx',
        flush: true,
        ...(options.mode !== undefined ? { mode: options.mode } : {})
      });
      await renameWithRetry(temporary, resolved);
      return { written: true, unchanged: false, sha256: nextHash, bytes: buffer.length };
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  });
}
