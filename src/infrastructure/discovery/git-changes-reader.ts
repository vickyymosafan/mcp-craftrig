import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { GitChangesReaderPort, GitFileChangeEntry, WorkingTreeChanges } from '../../domain/ports.js';

const execFileAsync = promisify(execFile);

const UNMERGED_STATUSES = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);

export function parseGitPorcelainEntries(stdout: string): GitFileChangeEntry[] {
  const byPath = new Map<string, GitFileChangeEntry>();
  for (const rawLine of stdout.split(/\r?\n/)) {
    if (rawLine.length < 4) continue;
    const rawStatus = rawLine.slice(0, 2);
    const indexStatus = rawLine[0] ?? ' ';
    const workingTreeStatus = rawLine[1] ?? ' ';
    let filePath = rawLine.slice(3).trim();
    if (!filePath) continue;
    const renameIdx = filePath.indexOf(' -> ');
    if (renameIdx !== -1) {
      filePath = filePath.slice(renameIdx + 4).trim();
    }
    if (filePath.startsWith('"') && filePath.endsWith('"') && filePath.length >= 2) {
      filePath = filePath.slice(1, -1);
    }
    const normalized = filePath.replace(/\\/g, '/');
    if (!normalized) continue;
    byPath.set(normalized.toLowerCase(), {
      path: normalized,
      indexStatus,
      workingTreeStatus,
      rawStatus,
      isUnmergedConflict: UNMERGED_STATUSES.has(rawStatus)
    });
  }
  return [...byPath.values()];
}

export function parseGitPorcelainOutput(stdout: string): string[] {
  return parseGitPorcelainEntries(stdout).map(entry => entry.path);
}

export class GitChangesReader implements GitChangesReaderPort {
  constructor(private readonly workspaceRoot: string) {}

  async readWorkingTreeChanges(): Promise<WorkingTreeChanges> {
    try {
      const { stdout } = await execFileAsync(
        'git',
        ['status', '--porcelain', '-uall'],
        { cwd: this.workspaceRoot, timeout: 3000, windowsHide: true }
      );
      const entries = parseGitPorcelainEntries(stdout);
      return {
        isGitRepo: true,
        changedFiles: entries.map(e => e.path),
        entries
      };
    } catch {
      return {
        isGitRepo: false,
        changedFiles: [],
        entries: []
      };
    }
  }
}
