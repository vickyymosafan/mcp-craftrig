import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import type { FileFingerprint } from '../../domain/models.js';
import type { FileFingerprinterPort } from '../../domain/ports.js';
import type { WorkspaceGuard } from '../security/workspace-guard.js';

export class WorkspaceFileFingerprinter implements FileFingerprinterPort {
  constructor(private readonly guard: WorkspaceGuard) {}

  async capture(relativePath: string): Promise<FileFingerprint> {
    const capturedAt = new Date().toISOString();
    const resolved = this.guard.resolveInsideWorkspace(relativePath);
    try {
      const info = await stat(resolved);
      if (info.isDirectory()) {
        return {
          exists: true,
          sha256: null,
          size: 0,
          mtimeMs: Math.round(info.mtimeMs),
          capturedAt
        };
      }
      if (!info.isFile()) {
        return { exists: false, sha256: null, size: 0, mtimeMs: null, capturedAt };
      }
      const data = await readFile(resolved);
      const sha256 = createHash('sha256').update(data).digest('hex');
      return {
        exists: true,
        sha256,
        size: data.length,
        mtimeMs: Math.round(info.mtimeMs),
        capturedAt
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
        return { exists: false, sha256: null, size: 0, mtimeMs: null, capturedAt };
      }
      throw error;
    }
  }
}
