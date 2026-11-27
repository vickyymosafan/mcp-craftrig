import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createStateRepository } from './infrastructure/persistence/state-repository-factory.js';
import { WorkspaceGuard } from './infrastructure/security/workspace-guard.js';
import { PlaywrightInspector } from './infrastructure/browser/playwright-inspector.js';
import { LocalDevServerManager } from './infrastructure/runtime/local-dev-server.js';
import { FileSkillRegistry } from './infrastructure/skills/file-skill-registry.js';
import { ModuleRegistry } from './infrastructure/catalog/module-registry.js';
import { WorkspaceRepoScanner } from './infrastructure/discovery/repo-scanner.js';
import { GitChangesReader } from './infrastructure/discovery/git-changes-reader.js';
import { WorkspaceFileFingerprinter } from './infrastructure/persistence/file-fingerprinter.js';
import { FileBlueprintArtifactWriter } from './infrastructure/persistence/blueprint-artifact-writer.js';
import { TaskService } from './application/task-service.js';
import { BlueprintArchitectService } from './application/blueprint-architect.js';
import { AutopilotService } from './application/autopilot-service.js';
import { ChecklistDocumentWriter } from './infrastructure/persistence/checklist-document-writer.js';
import { createMcpServer } from './interfaces/mcp/server.js';
import { createRuntimeConfig } from './infrastructure/config/runtime-config.js';
import { TaskPlanner } from './application/task-planner.js';

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const rootCandidates = [path.resolve(currentDirectory, '../..'), path.resolve(currentDirectory, '..'), process.cwd()];
const projectRoot = rootCandidates.find(candidate => existsSync(path.join(candidate, 'catalogs', 'modules.json'))) ?? process.cwd();
const runtimeConfig = createRuntimeConfig();
const workspaceRoot = await realpath(runtimeConfig.workspaceRoot);
const guard = new WorkspaceGuard(workspaceRoot);
const stateDirectory = await guard.ensureEvidenceDirectory(runtimeConfig.stateDirectory);
const { repository, selectedBackend } = createStateRepository({
  stateDirectory,
  backend: runtimeConfig.stateBackend,
  maxParallelTasks: runtimeConfig.maxParallelTasks,
  sqliteIdleCloseMs: runtimeConfig.sqliteIdleCloseMs
});
const gitChangesReader = new GitChangesReader(workspaceRoot);
const fileFingerprinter = new WorkspaceFileFingerprinter(guard);
const taskService = new TaskService(repository, new TaskPlanner(runtimeConfig.maxRepairIterations), gitChangesReader, fileFingerprinter);
const repoScanner = new WorkspaceRepoScanner(workspaceRoot);
const blueprintWriter = new FileBlueprintArtifactWriter(guard, workspaceRoot);
const blueprintArchitect = new BlueprintArchitectService(repository, repoScanner, blueprintWriter);
const autopilotService = new AutopilotService(taskService, runtimeConfig.maxParallelTasks, gitChangesReader);
const inspector = new PlaywrightInspector();
const devServer = new LocalDevServerManager(workspaceRoot, taskService);
const skillRegistry = new FileSkillRegistry(path.join(projectRoot, '.agent', 'skills'));
const moduleRegistry = new ModuleRegistry(path.join(projectRoot, 'catalogs', 'modules.json'));
const checklistWriter = new ChecklistDocumentWriter(taskService, guard);
const evidenceQuotaBytes = runtimeConfig.evidenceQuotaMb * 1024 * 1024;

const shutdown = async () => {
  await devServer.stopAll();
  repository.close?.();
  process.exit(0);
};
process.once('SIGINT', () => { void shutdown(); });
process.once('SIGTERM', () => { void shutdown(); });

console.error(`Craftrig MCP server ready. Workspace: ${workspaceRoot} | Backend: ${selectedBackend} | Evidence quota: ${runtimeConfig.evidenceQuotaMb}MB`);
await serveStdio(() => createMcpServer({
  workspaceRoot,
  harnessRoot: projectRoot,
  guard,
  taskService,
  blueprintArchitect,
  autopilotService,
  inspector,
  devServer,
  skillRegistry,
  moduleRegistry,
  checklistWriter,
  maxParallelTasks: runtimeConfig.maxParallelTasks,
  browserTimeoutMs: runtimeConfig.browserTimeoutMs,
  evidenceQuotaBytes,
  gitChangesReader,
  fileFingerprinter
}));
