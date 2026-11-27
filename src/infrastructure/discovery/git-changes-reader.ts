import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { GitChangesReaderPort, WorkingTreeChanges } from '../../domain/ports.js';

const execFileAsync = promisify(execFile);

export function parseGitPorcelainOutput(stdout: string): string[] {
  const files: string[] = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    if (rawLine.length < 4) continue;
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
    if (normalized) files.push(normalized);
  }
  return [...new Set(files)];
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
      return {
        isGitRepo: true,
        changedFiles: parseGitPorcelainOutput(stdout)
      };
    } catch {
      return {
        isGitRepo: false,
        changedFiles: []
      };
    }
  }
}
