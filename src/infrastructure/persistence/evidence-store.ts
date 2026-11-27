import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { brotliCompressSync, brotliDecompressSync, constants as zlibConstants } from 'node:zlib';
import { writeFileAtomicIfChanged } from './atomic-file-writer.js';

export interface SavedBlobResult {
  path: string;
  sha256: string;
  bytes: number;
  deduplicated: boolean;
}

export interface QuotaEnforcementResult {
  quotaBytes: number;
  totalBytesBefore: number;
  totalBytesAfter: number;
  evictedFiles: string[];
  evictedBytes: number;
  protectedCount: number;
}

export interface ArchivedPlanResult {
  archivePath: string;
  rawBytes: number;
  compressedBytes: number;
  compressionRatio: number;
}

export function computeMetricsHash(payload: unknown): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 24);
}

export async function saveContentAddressedBlob(
  evidenceRoot: string,
  buffer: Buffer,
  extension: string
): Promise<SavedBlobResult> {
  const normalizedExt = extension.startsWith('.') ? extension : `.${extension}`;
  const sha256 = createHash('sha256').update(buffer).digest('hex');
  const blobsDir = path.join(path.resolve(evidenceRoot), 'blobs');
  await mkdir(blobsDir, { recursive: true });
  const targetPath = path.join(blobsDir, `${sha256}${normalizedExt}`);
  if (existsSync(targetPath)) {
    return { path: targetPath, sha256, bytes: buffer.length, deduplicated: true };
  }
  await writeFileAtomicIfChanged(targetPath, buffer, { skipIfUnchanged: true });
  return { path: targetPath, sha256, bytes: buffer.length, deduplicated: false };
}

interface ScannedFile {
  fullPath: string;
  size: number;
  mtimeMs: number;
}

async function scanFilesRecursive(dir: string, acc: ScannedFile[] = []): Promise<ScannedFile[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await scanFilesRecursive(fullPath, acc);
    } else if (entry.isFile()) {
      try {
        const info = await stat(fullPath);
        acc.push({ fullPath, size: info.size, mtimeMs: info.mtimeMs });
      } catch {
        // Ignore vanished files during concurrent cleanup
      }
    }
  }
  return acc;
}

export async function enforceEvidenceQuota(
  evidenceRoot: string,
  quotaBytes: number,
  protectedPaths: ReadonlySet<string> = new Set()
): Promise<QuotaEnforcementResult> {
  const root = path.resolve(evidenceRoot);
  const normalizedProtected = new Set(
    [...protectedPaths].map(item => path.resolve(item).toLowerCase())
  );
  const files = await scanFilesRecursive(root);
  const totalBytesBefore = files.reduce((sum, f) => sum + f.size, 0);

  if (totalBytesBefore <= quotaBytes) {
    return {
      quotaBytes,
      totalBytesBefore,
      totalBytesAfter: totalBytesBefore,
      evictedFiles: [],
      evictedBytes: 0,
      protectedCount: normalizedProtected.size
    };
  }

  // Sort oldest first (LRU eviction)
  const candidates = files
    .filter(f => !normalizedProtected.has(path.resolve(f.fullPath).toLowerCase()))
    .sort((a, b) => a.mtimeMs - b.mtimeMs);

  let currentBytes = totalBytesBefore;
  const evictedFiles: string[] = [];
  let evictedBytes = 0;

  for (const candidate of candidates) {
    if (currentBytes <= quotaBytes) break;
    try {
      await unlink(candidate.fullPath);
      currentBytes -= candidate.size;
      evictedBytes += candidate.size;
      evictedFiles.push(candidate.fullPath);
    } catch {
      // Ignore unlink failure on locked files
    }
  }

  return {
    quotaBytes,
    totalBytesBefore,
    totalBytesAfter: currentBytes,
    evictedFiles,
    evictedBytes,
    protectedCount: normalizedProtected.size
  };
}

export async function archivePlanSnapshot(
  archiveDirectory: string,
  planId: string,
  snapshot: unknown
): Promise<ArchivedPlanResult> {
  const dir = path.resolve(archiveDirectory);
  await mkdir(dir, { recursive: true });
  const raw = Buffer.from(JSON.stringify(snapshot), 'utf8');
  const compressed = brotliCompressSync(raw, {
    params: {
      [zlibConstants.BROTLI_PARAM_QUALITY]: 6
    }
  });
  const archivePath = path.join(dir, `${planId}.json.br`);
  await writeFileAtomicIfChanged(archivePath, compressed, { skipIfUnchanged: true });
  return {
    archivePath,
    rawBytes: raw.length,
    compressedBytes: compressed.length,
    compressionRatio: raw.length > 0 ? Number((compressed.length / raw.length).toFixed(3)) : 1
  };
}

export async function readArchivedPlanSnapshot<T = unknown>(archivePath: string): Promise<T> {
  const compressed = await readFile(archivePath);
  const raw = brotliDecompressSync(compressed);
  return JSON.parse(raw.toString('utf8')) as T;
}
