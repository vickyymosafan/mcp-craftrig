import { ValidationError } from './errors.js';
import type { FileLockRecord } from './models.js';

/**
 * Normalize a workspace-relative path to canonical POSIX form for conflict detection.
 * Rejects empty strings, null bytes, absolute/drive paths, root `.`, and workspace escapes.
 */
export function normalizeOwnedPath(rawPath: string): string {
  if (rawPath.includes('\0')) {
    throw new ValidationError('Owned path must not contain null bytes.');
  }
  const trimmed = rawPath.trim();
  if (!trimmed) {
    throw new ValidationError('Owned path must not be empty.');
  }

  const slashNormalized = trimmed.replace(/\\/g, '/');
  if (slashNormalized.startsWith('/') || /^[a-zA-Z]:/.test(slashNormalized)) {
    throw new ValidationError(`Absolute or drive-qualified paths are not allowed for file ownership: ${rawPath}`);
  }

  const resolvedSegments: string[] = [];
  for (const segment of slashNormalized.split('/')) {
    if (!segment || segment === '.') {
      continue;
    }
    if (segment === '..') {
      if (resolvedSegments.length === 0) {
        throw new ValidationError(`Owned path escapes the configured workspace: ${rawPath}`);
      }
      resolvedSegments.pop();
      continue;
    }
    resolvedSegments.push(segment);
  }

  if (resolvedSegments.length === 0) {
    throw new ValidationError('Owned path must name a file or subdirectory inside the workspace.');
  }

  return resolvedSegments.join('/');
}

/** Normalize and deduplicate a list of workspace-relative paths while preserving order. */
export function normalizeOwnedPaths(paths: readonly string[]): string[] {
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const rawPath of paths) {
    const normalized = normalizeOwnedPath(rawPath);
    if (!seen.has(normalized)) {
      seen.add(normalized);
      unique.push(normalized);
    }
  }
  return unique;
}

/**
 * Determine whether two canonical workspace-relative POSIX paths conflict
 * (exact match or ancestor/descendant directory containment).
 */
export function pathsOverlap(firstPath: string, secondPath: string): boolean {
  if (firstPath === secondPath) {
    return true;
  }
  return firstPath.startsWith(`${secondPath}/`) || secondPath.startsWith(`${firstPath}/`);
}

/**
 * Return the first active lock held by a different task that overlaps with candidatePath.
 */
export function findLockConflict(
  candidatePath: string,
  locks: Iterable<FileLockRecord>,
  ownerTaskId: string
): FileLockRecord | null {
  for (const lock of locks) {
    if (lock.taskId !== ownerTaskId && pathsOverlap(candidatePath, lock.path)) {
      return lock;
    }
  }
  return null;
}

