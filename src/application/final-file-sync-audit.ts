import type { FileLockRecord } from '../domain/models.js';
import type { FileFingerprinterPort, GitChangesReaderPort, GitFileChangeEntry } from '../domain/ports.js';
import { normalizeOwnedPaths, pathsOverlap } from '../domain/file-ownership.js';

export type AuditedFileStatus =
  | 'verified_on_disk'
  | 'missing_on_disk'
  | 'empty_file'
  | 'unmerged_conflict'
  | 'drifted_lock';

export interface AuditedFileEntry {
  path: string;
  exists: boolean;
  sha256Short: string | null;
  sizeBytes: number;
  mtimeIso: string | null;
  gitStatus: string | null;
  status: AuditedFileStatus;
}

export interface FinalFileSyncAudit {
  checkedAt: string;
  allFilesVerifiedOnDisk: boolean;
  staleTabRisk: 'none' | 'advisory' | 'critical';
  totalChecked: number;
  verifiedCount: number;
  issuesCount: number;
  staleEditorTabFiles: string[];
  missingOnDiskFiles: string[];
  emptyFiles: string[];
  unmergedConflictFiles: string[];
  driftedLockFiles: string[];
  files: AuditedFileEntry[];
  editorSyncGuidance: string;
}

const MAX_AUDITED_FILES = 50;

function isInternalRigPath(relativePath: string): boolean {
  const lower = relativePath.toLowerCase();
  return lower === '.craftrig' || lower.startsWith('.craftrig/');
}

function isDeletedInGit(entry: GitFileChangeEntry | undefined): boolean {
  if (!entry) return false;
  return entry.indexStatus === 'D' || entry.workingTreeStatus === 'D';
}

export async function buildFinalFileSyncAudit(options: {
  candidatePaths?: readonly string[];
  activeLocks?: readonly FileLockRecord[];
  gitChangesReader?: GitChangesReaderPort;
  fileFingerprinter?: FileFingerprinterPort;
}): Promise<FinalFileSyncAudit> {
  const checkedAt = new Date().toISOString();
  const workingTree = options.gitChangesReader
    ? await options.gitChangesReader.readWorkingTreeChanges().catch(() => ({
        isGitRepo: false,
        changedFiles: [],
        entries: [] as GitFileChangeEntry[]
      }))
    : { isGitRepo: false, changedFiles: [], entries: [] as GitFileChangeEntry[] };

  const gitEntryByLower = new Map<string, GitFileChangeEntry>();
  for (const entry of workingTree.entries ?? []) {
    gitEntryByLower.set(entry.path.toLowerCase(), entry);
  }

  const rawPaths: string[] = [
    ...workingTree.changedFiles,
    ...(options.candidatePaths ?? [])
  ].filter(p => {
    const trimmed = p.trim();
    if (!trimmed) return false;
    const posix = trimmed.replace(/\\/g, '/');
    return !isInternalRigPath(posix);
  });

  let normalizedPaths: string[] = [];
  try {
    normalizedPaths = normalizeOwnedPaths(rawPaths).slice(0, MAX_AUDITED_FILES);
  } catch {
    const seen = new Set<string>();
    for (const raw of rawPaths) {
      const cleaned = raw.replace(/\\/g, '/').replace(/^\.\//, '').trim();
      if (!cleaned || cleaned.startsWith('..') || cleaned.startsWith('/')) continue;
      const key = cleaned.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        normalizedPaths.push(cleaned);
        if (normalizedPaths.length >= MAX_AUDITED_FILES) break;
      }
    }
  }

  const locks = options.activeLocks ?? [];
  const files: AuditedFileEntry[] = [];
  const staleEditorTabFiles: string[] = [];
  const missingOnDiskFiles: string[] = [];
  const emptyFiles: string[] = [];
  const unmergedConflictFiles: string[] = [];
  const driftedLockFiles: string[] = [];

  for (const relPath of normalizedPaths) {
    const gitEntry = gitEntryByLower.get(relPath.toLowerCase());
    const fingerprint = options.fileFingerprinter
      ? await options.fileFingerprinter.capture(relPath).catch(() => null)
      : null;

    // Skip directories (e.g., directory-level ownedPaths like "src/components") unless missing
    if (fingerprint && fingerprint.exists && fingerprint.sha256 === null && fingerprint.size === 0) {
      continue;
    }

    const exists = fingerprint ? fingerprint.exists : !isDeletedInGit(gitEntry);
    const sha256Short = fingerprint?.sha256 ? fingerprint.sha256.slice(0, 12) : null;
    const sizeBytes = fingerprint?.size ?? 0;
    const mtimeIso = fingerprint?.mtimeMs !== null && fingerprint?.mtimeMs !== undefined
      ? new Date(fingerprint.mtimeMs).toISOString()
      : null;

    const matchingLock = locks.find(l => pathsOverlap(relPath, l.path) && l.baselineFingerprint?.sha256);
    const hasDrift = Boolean(
      matchingLock?.baselineFingerprint?.sha256 &&
      fingerprint?.sha256 &&
      matchingLock.baselineFingerprint.sha256 !== fingerprint.sha256
    );

    let status: AuditedFileStatus = 'verified_on_disk';
    if (gitEntry?.isUnmergedConflict) {
      status = 'unmerged_conflict';
      unmergedConflictFiles.push(relPath);
    } else if (!exists && !isDeletedInGit(gitEntry)) {
      status = 'missing_on_disk';
      missingOnDiskFiles.push(relPath);
    } else if (hasDrift) {
      status = 'drifted_lock';
      driftedLockFiles.push(relPath);
      staleEditorTabFiles.push(relPath);
    } else if (exists && fingerprint && sizeBytes === 0) {
      status = 'empty_file';
      emptyFiles.push(relPath);
      staleEditorTabFiles.push(relPath);
    } else if (exists) {
      status = 'verified_on_disk';
      staleEditorTabFiles.push(relPath);
    }

    files.push({
      path: relPath,
      exists,
      sha256Short,
      sizeBytes,
      mtimeIso,
      gitStatus: gitEntry?.rawStatus ?? null,
      status
    });
  }

  const issuesCount = missingOnDiskFiles.length + emptyFiles.length + unmergedConflictFiles.length + driftedLockFiles.length;
  const verifiedCount = files.filter(f => f.status === 'verified_on_disk').length;
  const staleTabRisk: 'none' | 'advisory' | 'critical' =
    issuesCount > 0
      ? 'critical'
      : staleEditorTabFiles.length > 0
        ? 'advisory'
        : 'none';

  let editorSyncGuidance: string;
  if (issuesCount > 0) {
    editorSyncGuidance =
      `CRITICAL: Detected ${issuesCount} file-sync issue(s) (missing: ${missingOnDiskFiles.length}, empty: ${emptyFiles.length}, unmerged: ${unmergedConflictFiles.length}, drifted locks: ${driftedLockFiles.length}). Inspect before saving and NEVER click Overwrite on stale editor tabs.`;
  } else if (staleEditorTabFiles.length > 0) {
    const sample = staleEditorTabFiles.slice(0, 8).join(', ');
    const extra = staleEditorTabFiles.length > 8 ? ` (+${staleEditorTabFiles.length - 8} more)` : '';
    editorSyncGuidance =
      `Verified ${verifiedCount} updated file(s) on disk (${sample}${extra}). If any of these tabs are still open with unsaved/stale content in your editor, DO NOT click Overwrite — close the tab (Don't Save) or run Ctrl+Shift+P -> "File: Revert File" to reload the latest version from disk.`;
  } else {
    editorSyncGuidance = 'No modified workspace source files detected; no stale-tab overwrite risk.';
  }

  return {
    checkedAt,
    allFilesVerifiedOnDisk: issuesCount === 0,
    staleTabRisk,
    totalChecked: files.length,
    verifiedCount,
    issuesCount,
    staleEditorTabFiles,
    missingOnDiskFiles,
    emptyFiles,
    unmergedConflictFiles,
    driftedLockFiles,
    files,
    editorSyncGuidance
  };
}
