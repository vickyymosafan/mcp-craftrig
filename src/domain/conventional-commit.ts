export type ConventionalCommitType =
  | 'feat'
  | 'fix'
  | 'refactor'
  | 'docs'
  | 'test'
  | 'build'
  | 'ci'
  | 'perf'
  | 'style'
  | 'chore';

export interface ConventionalCommitArtifact {
  specVersion: '1.0.0';
  type: ConventionalCommitType;
  scope: string | null;
  breaking: boolean;
  description: string;
  header: string;
  body: string;
  footer: string | null;
  fullMessage: string;
  changedFiles: string[];
  suggestedCommand: string;
  noPush: true;
  pushPolicy: string;
}

export interface BuildConventionalCommitInput {
  title: string;
  summaryPoints?: readonly string[];
  changedFiles?: readonly string[];
  requirementIds?: readonly string[];
  testsRun?: readonly string[];
  domains?: readonly string[];
  repairIterations?: number;
  type?: ConventionalCommitType;
  scope?: string | null;
  breakingChange?: string | null;
}

const MAX_HEADER_LENGTH = 72;
const NO_PUSH_POLICY = 'Commit locally only. Do NOT run git push without explicit user authorization.';

function sanitizeScope(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned.length > 0 ? cleaned.slice(0, 24) : null;
}

function inferCommitType(input: BuildConventionalCommitInput, files: readonly string[]): ConventionalCommitType {
  if (input.type) return input.type;

  if (files.length > 0) {
    const allDocs = files.every(f => /(^|\/)(docs|README|CHANGELOG|LICENSE)|\.md$/i.test(f));
    if (allDocs) return 'docs';
    const allTests = files.every(f => /(^|\/)tests?\/|\.(test|spec)\.[jt]sx?$/i.test(f));
    if (allTests) return 'test';
  }

  const text = `${input.title} ${(input.summaryPoints ?? []).join(' ')}`.toLowerCase();
  if (/^\s*(fix|bug|hotfix|patch|repair|resolve)\b/.test(text) || ((input.repairIterations ?? 0) > 0 && /\b(fix|repair|defect|bug)\b/.test(text))) {
    return 'fix';
  }
  if (/^\s*(refactor|cleanup|restructure|rename)\b/.test(text)) return 'refactor';
  if (/^\s*(perf|optimize|speed|cache)\b/.test(text)) return 'perf';
  if (/^\s*(docs|document|readme)\b/.test(text)) return 'docs';
  if (/^\s*(test|spec|e2e)\b/.test(text)) return 'test';
  if (/^\s*(build|deps|upgrade|package)\b/.test(text)) return 'build';
  if (/^\s*(ci|workflow|pipeline)\b/.test(text)) return 'ci';
  if (/^\s*(chore|maint|archive)\b/.test(text)) return 'chore';
  return 'feat';
}

function toImperativeDescription(rawTitle: string, prefix: string): string {
  let desc = rawTitle
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(feat|fix|refactor|docs|test|build|ci|perf|style|chore)(\([^)]+\))?!?:\s*/i, '')
    .replace(/[.!?]+$/, '')
    .trim();

  if (!desc) {
    desc = 'apply verified changes';
  }

  // Lowercase leading character unless it begins with an uppercase acronym like MCP/API/UI
  if (/^[A-Z][a-z]/.test(desc)) {
    desc = desc.charAt(0).toLowerCase() + desc.slice(1);
  }

  const maxDescLen = Math.max(16, MAX_HEADER_LENGTH - prefix.length);
  if (desc.length > maxDescLen) {
    desc = desc.slice(0, maxDescLen).replace(/\s+\S*$/, '').trim() || desc.slice(0, maxDescLen).trim();
  }
  return desc;
}

function quoteShellSingleLine(text: string): string {
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function buildConventionalCommit(input: BuildConventionalCommitInput): ConventionalCommitArtifact {
  const uniqueFiles = [...new Set((input.changedFiles ?? []).map(f => f.replace(/\\/g, '/').trim()).filter(Boolean))];
  const type = inferCommitType(input, uniqueFiles);
  const scope = input.scope !== undefined
    ? sanitizeScope(input.scope)
    : sanitizeScope(input.domains?.[0] ?? null);
  const breakingText = input.breakingChange?.trim() || null;
  const breaking = Boolean(breakingText);

  const prefix = `${type}${scope ? `(${scope})` : ''}${breaking ? '!' : ''}: `;
  const description = toImperativeDescription(input.title, prefix);
  const header = `${prefix}${description}`;

  const bodyLines: string[] = [];
  const summaries = [...new Set((input.summaryPoints ?? []).map(s => s.replace(/[\r\n]+/g, ' ').trim()).filter(Boolean))];
  for (const item of summaries.slice(0, 6)) {
    bodyLines.push(`- ${item}`);
  }
  if (uniqueFiles.length > 0) {
    const shown = uniqueFiles.slice(0, 10);
    const extra = uniqueFiles.length > shown.length ? ` (+${uniqueFiles.length - shown.length} more)` : '';
    bodyLines.push(`- Files: ${shown.join(', ')}${extra}`);
  }
  const tests = [...new Set((input.testsRun ?? []).map(t => t.replace(/[\r\n]+/g, ' ').trim()).filter(Boolean))];
  if (tests.length > 0) {
    bodyLines.push(`- Verified: ${tests.slice(0, 5).join(', ')}`);
  }
  const body = bodyLines.join('\n');

  const footerLines: string[] = [];
  if (breakingText) {
    footerLines.push(`BREAKING CHANGE: ${breakingText.replace(/[\r\n]+/g, ' ').trim()}`);
  }
  const reqs = [...new Set((input.requirementIds ?? []).map(r => r.trim()).filter(Boolean))];
  if (reqs.length > 0) {
    footerLines.push(`Refs: ${reqs.slice(0, 16).join(', ')}`);
  }
  const footer = footerLines.length > 0 ? footerLines.join('\n') : null;

  const sections = [header];
  if (body) sections.push(body);
  if (footer) sections.push(footer);
  const fullMessage = sections.join('\n\n');

  const commandArgs = [`git commit -m ${quoteShellSingleLine(header)}`];
  if (body) commandArgs.push(`-m ${quoteShellSingleLine(body)}`);
  if (footer) commandArgs.push(`-m ${quoteShellSingleLine(footer)}`);

  return {
    specVersion: '1.0.0',
    type,
    scope,
    breaking,
    description,
    header,
    body,
    footer,
    fullMessage,
    changedFiles: uniqueFiles,
    suggestedCommand: commandArgs.join(' '),
    noPush: true,
    pushPolicy: NO_PUSH_POLICY
  };
}
