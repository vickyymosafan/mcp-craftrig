import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ProjectBlueprint } from '../../domain/blueprint.js';
import type { BlueprintArtifactWriterPort } from '../../domain/ports.js';
import type { WorkspaceGuard } from '../security/workspace-guard.js';

export class FileBlueprintArtifactWriter implements BlueprintArtifactWriterPort {
  constructor(private readonly guard: WorkspaceGuard, private readonly workspaceRoot: string) {}

  async write(blueprint: ProjectBlueprint, markdown: string): Promise<{ markdownPath: string; jsonPath: string }> {
    const dir = await this.guard.ensureEvidenceDirectory(path.join('.craftrig', 'blueprints'));
    await mkdir(dir, { recursive: true });
    const safeId = blueprint.id.replace(/[^a-zA-Z0-9_-]/g, '');
    const mdFull = path.join(dir, `${safeId}.md`);
    const jsonFull = path.join(dir, `${safeId}.json`);
    await writeFile(mdFull, markdown, 'utf8');
    await writeFile(jsonFull, JSON.stringify(blueprint, null, 2), 'utf8');
    return {
      markdownPath: path.relative(this.workspaceRoot, mdFull).replace(/\\/g, '/'),
      jsonPath: path.relative(this.workspaceRoot, jsonFull).replace(/\\/g, '/')
    };
  }
}
