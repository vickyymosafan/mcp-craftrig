import path from 'node:path';
import type { ProjectBlueprint } from '../../domain/blueprint.js';
import type { BlueprintArtifactWriterPort } from '../../domain/ports.js';
import type { WorkspaceGuard } from '../security/workspace-guard.js';
import { writeFileAtomicIfChanged } from './atomic-file-writer.js';

export class FileBlueprintArtifactWriter implements BlueprintArtifactWriterPort {
  constructor(private readonly guard: WorkspaceGuard, private readonly workspaceRoot: string) {}

  async write(blueprint: ProjectBlueprint, markdown: string): Promise<{ markdownPath: string; jsonPath: string }> {
    const dir = await this.guard.ensureEvidenceDirectory(path.join('.craftrig', 'blueprints'));
    const safeId = blueprint.id.replace(/[^a-zA-Z0-9_-]/g, '');
    const mdFull = path.join(dir, `${safeId}.md`);
    const jsonFull = path.join(dir, `${safeId}.json`);
    await writeFileAtomicIfChanged(mdFull, markdown, { skipIfUnchanged: true });
    await writeFileAtomicIfChanged(jsonFull, JSON.stringify(blueprint, null, 2), { skipIfUnchanged: true });
    return {
      markdownPath: path.relative(this.workspaceRoot, mdFull).replace(/\\/g, '/'),
      jsonPath: path.relative(this.workspaceRoot, jsonFull).replace(/\\/g, '/')
    };
  }
}
