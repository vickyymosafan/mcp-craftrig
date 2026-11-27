import { McpServer, ResourceTemplate } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { waitForLocalUrl } from '../../infrastructure/runtime/localhost-readiness.js';
import type { TaskService } from '../../application/task-service.js';
import type { BlueprintArchitectService } from '../../application/blueprint-architect.js';
import { AutopilotService } from '../../application/autopilot-service.js';
import { buildPlanConventionalCommit } from '../../application/commit-message-builder.js';
import { parseMarkdownBlueprint } from '../../application/blueprint-parser.js';
import { archivePlanSnapshot, enforceEvidenceQuota } from '../../infrastructure/persistence/evidence-store.js';
import { buildConventionalCommit } from '../../domain/conventional-commit.js';
import type { BrowserInspectorPort, DevServerPort, GitChangesReaderPort } from '../../domain/ports.js';
import type { ProjectBlueprint } from '../../domain/blueprint.js';
import type { WorkspaceGuard } from '../../infrastructure/security/workspace-guard.js';
import type { FileSkillRegistry } from '../../infrastructure/skills/file-skill-registry.js';
import type { ModuleRegistry } from '../../infrastructure/catalog/module-registry.js';
import type { ChecklistDocumentWriter } from '../../infrastructure/persistence/checklist-document-writer.js';
import {
  toAnswerInterviewInput,
  toAutopilotNextOptions,
  toClaimReadyBatchInput,
  toClaimTaskInput,
  toCreatePlanInput,
  toIngestBlueprintOptions,
  toInteractionActions,
  toListFileLocksFilter,
  toReleaseFileLocksInput,
  toStartInterviewInput,
  toVisualA11yAuditInput
} from './input-normalizers.js';

interface Dependencies {
  workspaceRoot: string;
  harnessRoot: string;
  guard: WorkspaceGuard;
  taskService: TaskService;
  blueprintArchitect?: BlueprintArchitectService;
  autopilotService?: AutopilotService;
  inspector: BrowserInspectorPort;
  devServer: DevServerPort;
  skillRegistry: FileSkillRegistry;
  moduleRegistry: ModuleRegistry;
  checklistWriter: ChecklistDocumentWriter;
  maxParallelTasks: number;
  browserTimeoutMs: number;
  evidenceQuotaBytes?: number;
  gitChangesReader?: GitChangesReaderPort;
}

const commitTypes = ['feat', 'fix', 'refactor', 'docs', 'test', 'build', 'ci', 'perf', 'style', 'chore'] as const;

const workDomains = ['frontend', 'backend', 'design', 'responsive', 'threejs', 'motion', 'security', 'data', 'release'] as const;
const checkpointIds = ['responsive', 'layout', 'interaction', 'typography-color', 'motion', '3d-rendering', 'accessibility', 'performance', 'security', 'final-regression'] as const;
const interviewModes = ['quick', 'standard', 'deep'] as const;
const blueprintPresets = ['portfolio', 'landing', 'ecommerce', 'saas-dashboard', '3d-showroom', 'fullstack-app'] as const;
const autonomyModes = ['full-auto', 'phase-gate'] as const;
const captureModes = ['failures-only', 'all'] as const;
const ownedPathSchema = z.string().min(1).max(500);
const viewportSchema = z.object({ name: z.string().min(1), width: z.number().int().min(240).max(7680), height: z.number().int().min(320).max(4320), isMobile: z.boolean(), hasTouch: z.boolean(), deviceScaleFactor: z.number().min(1).max(3) });
const actionSchema = z.object({ action: z.enum(['click', 'fill', 'check', 'uncheck', 'select', 'press', 'expect-visible', 'expect-text']), selector: z.string().min(1), value: z.string().optional(), timeoutMs: z.number().int().min(500).max(120000).optional() });
const handoffSchema = z.object({
  summary: z.string().min(1).max(2000),
  changedFiles: z.array(z.string().max(500)).max(200).default([]),
  contracts: z.array(z.string().max(500)).max(100).default([]),
  decisions: z.array(z.string().max(500)).max(50).default([]),
  testsRun: z.array(z.string().max(500)).max(50).default([])
});

async function emitProgress(ctx: unknown, progress: number, total: number, message: string): Promise<void> {
  const mcpReq = (ctx as { mcpReq?: { _meta?: { progressToken?: string | number }; notify?: (payload: unknown) => Promise<void> } } | undefined)?.mcpReq;
  const progressToken = mcpReq?._meta?.progressToken;
  if (progressToken !== undefined && typeof mcpReq?.notify === 'function') {
    await mcpReq.notify({
      method: 'notifications/progress',
      params: { progressToken, progress, total, message }
    }).catch(() => undefined);
  }
}

function result(value: unknown) { return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] }; }
function errorResult(error: unknown, recoveryHint?: string) {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  let hint = recoveryHint;

  if (!hint && error instanceof Error) {
    if (error.name === 'ConflictError') {
      if (error.message.includes('dependencies are not complete')) {
        hint = 'Use craftrig_get_ready_tasks to find tasks whose dependencies are already satisfied.';
      } else if (error.message.includes('File ownership conflict')) {
        hint = 'Use craftrig_list_file_locks to inspect active locks, wait for the conflicting task, or claim disjoint subpaths.';
      } else if (error.message.includes('Repair budget exhausted')) {
        hint = 'Escalate to human review; do not continue automatic repair loops without authorization.';
      }
    } else if (error.name === 'NotFoundError') {
      hint = 'Verify the UUID using craftrig_get_execution_plan or check the active plan ID.';
    } else if (error.name === 'ValidationError') {
      if (error.message.includes('requires at least one evidence')) {
        hint = 'Record evidence first using craftrig_record_evidence before completing this task.';
      } else if (error.message.includes('A PASS checkpoint requires evidence')) {
        hint = 'Attach valid plan-scoped evidence IDs when marking a quality checkpoint as PASS.';
      }
    }
  }

  const content: Array<{ type: 'text'; text: string }> = [{ type: 'text', text: message }];
  if (hint) {
    content.push({ type: 'text', text: `[Actionable Recovery Guidance]: ${hint}` });
  }

  return { isError: true, content };
}

export function createMcpServer(deps: Dependencies): McpServer {
  const server = new McpServer({ name: 'craftrig', version: '0.2.0' });
  const autopilot = deps.autopilotService ?? new AutopilotService(deps.taskService, deps.maxParallelTasks, deps.gitChangesReader);
  const evidenceQuotaBytes = deps.evidenceQuotaBytes ?? 50 * 1024 * 1024;
  const assertWorkspacePaths = async (paths: readonly string[]) => {
    await Promise.all(paths.map(target => deps.guard.resolvePotentialPathInsideWorkspace(target)));
  };

  function registerToolWithAlias<T extends z.ZodTypeAny>(
    name: string,
    config: {
      description: string;
      inputSchema?: T;
      annotations?: { readOnlyHint?: boolean; idempotentHint?: boolean; destructiveHint?: boolean };
    },
    handler: (input: z.infer<T>, ctx?: unknown) => Promise<any>
  ) {
    (server.registerTool as any)(`craftrig_${name}`, config, handler);
  }

  registerToolWithAlias('start_blueprint_interview', {
    description: 'Start an adaptive Blueprint Architect interview when the user does not have a full blueprint yet. Scans the workspace first to pre-fill detectable tech stack/routes, then returns 2-4 crisp questions per round (default mode: deep) with recommended defaults and elicitation schema ready for the host LLM to ask the user.',
    annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false },
    inputSchema: z.object({
      initialIdea: z.string().min(5).max(8000),
      title: z.string().min(1).max(160).optional(),
      mode: z.enum(interviewModes).default('deep'),
      preset: z.enum(blueprintPresets).optional()
    })
  }, async input => {
    try {
      if (!deps.blueprintArchitect) {
        return errorResult(new Error('BlueprintArchitectService is not configured on this MCP server instance.'));
      }
      return result(await deps.blueprintArchitect.startInterview(toStartInterviewInput(input)));
    } catch (error) {
      return errorResult(error);
    }
  });

  registerToolWithAlias('answer_blueprint_questions', {
    description: 'Submit user answers (or skipWithDefaults) for an active Blueprint Architect interview. Adapts follow-up questions dynamically, runs the Blueprint Linter for contradictions/unmeasurable criteria, and compiles blueprint.md + blueprint.json with REQ-ID traceability once complete.',
    annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false },
    inputSchema: z.object({
      sessionId: z.string().uuid(),
      answers: z.record(z.string(), z.union([z.string(), z.array(z.string())])).default({}),
      skipWithDefaults: z.array(z.string()).optional(),
      finalizeNow: z.boolean().optional()
    })
  }, async input => {
    try {
      if (!deps.blueprintArchitect) {
        return errorResult(new Error('BlueprintArchitectService is not configured on this MCP server instance.'));
      }
      return result(await deps.blueprintArchitect.answerQuestions(toAnswerInterviewInput(input)));
    } catch (error) {
      return errorResult(error);
    }
  });

  registerToolWithAlias('ingest_blueprint', {
    description: 'Ingest a full project blueprint (by blueprintId from Blueprint Architect, freeform Markdown, or structured JSON) and compile a token-efficient Multi-Phase Execution DAG covering ALL phases, routing only required skills (skipping unneeded skills) and returning the first autopilot_next wave.',
    annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false },
    inputSchema: z.object({
      blueprintId: z.string().uuid().optional(),
      markdown: z.string().min(20).max(60000).optional(),
      title: z.string().min(1).max(160).optional(),
      autonomyMode: z.enum(autonomyModes).optional(),
      maxRepairIterations: z.number().int().min(1).max(12).optional(),
      maxSubagentsPerWave: z.number().int().min(1).max(16).optional(),
      tokenBudget: z.number().int().min(1000).max(500000).nullable().optional()
    })
  }, async (input, ctx) => {
    try {
      let blueprint: ProjectBlueprint;
      if (input.blueprintId) {
        blueprint = await deps.taskService.getBlueprint(input.blueprintId);
      } else if (input.markdown) {
        blueprint = parseMarkdownBlueprint({
          markdown: input.markdown,
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.autonomyMode !== undefined ? { autonomyMode: input.autonomyMode } : {})
        });
      } else {
        return errorResult(new Error('ValidationError: Provide either blueprintId or markdown to ingest_blueprint.'));
      }

      await emitProgress(ctx, 1, 3, `Compiling multi-phase DAG for "${blueprint.title}" (${blueprint.phases.length} phases)...`);
      const created = await deps.taskService.createPlanFromBlueprint(blueprint, toIngestBlueprintOptions(input));
      const checklistPath = await deps.checklistWriter.write(created.plan.id);
      await emitProgress(ctx, 2, 3, 'Preparing first autopilot wave...');
      const firstWave = await autopilot.next(created.plan.id);
      await emitProgress(ctx, 3, 3, `Ready: ${created.tasks.length} tasks across ${created.plan.phases?.length ?? 1} phases.`);
      return result({
        ...created,
        checklistPath,
        firstWave
      });
    } catch (error) {
      return errorResult(error);
    }
  });

  registerToolWithAlias('autopilot_next', {
    description: 'Advance the Craftrig Blueprint Autopilot loop by one step. Auto-recovers expired leases, prioritizes zero-token deterministic checks before spawning QA subagents, returns compact disjoint parallel subagent wave manifests (with Tier-1 skill paths & packet URIs), spawns targeted 1-skill repair tasks on failure, and emits progress notifications.',
    annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false },
    inputSchema: z.object({
      planId: z.string().uuid(),
      approvePhaseId: z.string().min(1).max(120).optional(),
      maxWaveSize: z.number().int().min(1).max(16).optional()
    })
  }, async (input, ctx) => {
    try {
      const nextWave = await autopilot.next(input.planId, toAutopilotNextOptions(input));
      await emitProgress(
        ctx,
        nextWave.progress.tasksDone,
        Math.max(1, nextWave.progress.tasksTotal),
        `[${nextWave.state}] ${nextWave.phase?.name ?? 'Autopilot'} — ${nextWave.progress.tasksDone}/${nextWave.progress.tasksTotal} tasks (${nextWave.progress.percentage}%)`
      );
      return result(nextWave);
    } catch (error) {
      return errorResult(error);
    }
  });

  registerToolWithAlias('autopilot_resume', {
    description: 'Recover orphaned file locks and expired agent leases after a crash or session restart, then resume the exact active phase and wave via autopilot_next.',
    annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false },
    inputSchema: z.object({ planId: z.string().uuid() })
  }, async ({ planId }, ctx) => {
    try {
      const resumed = await autopilot.resume(planId);
      await emitProgress(
        ctx,
        resumed.progress.tasksDone,
        Math.max(1, resumed.progress.tasksTotal),
        `Resumed (${resumed.recoveredLocksCount} lock(s) recovered): ${resumed.phase?.name ?? 'Autopilot'}`
      );
      return result(resumed);
    } catch (error) {
      return errorResult(error);
    }
  });

  registerToolWithAlias('archive_plan', {
    description: 'Compress a completed plan snapshot into a Brotli archive (.craftrig/archive/<planId>.json.br), remove it from active state, run SQLite incremental vacuum, and enforce the evidence disk quota to keep RAM and disk usage minimal.',
    annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: true },
    inputSchema: z.object({ planId: z.string().uuid(), force: z.boolean().default(false) })
  }, async ({ planId, force }) => {
    try {
      const snapshot = await deps.taskService.getPlan(planId);
      const evidence = await deps.taskService.getEvidenceForPlan(planId);
      const traceability = await deps.taskService.getRequirementTraceability(planId);
      const incomplete = snapshot.tasks.some(t => t.status === 'pending' || t.status === 'in_progress');
      if (incomplete && !force) {
        return errorResult(new Error('ConflictError: Plan still has pending or in_progress tasks. Pass force=true to archive anyway.'));
      }
      const archiveDir = await deps.guard.ensureEvidenceDirectory(path.join('.craftrig', 'archive'));
      const conventionalCommit = await buildPlanConventionalCommit(snapshot, traceability, deps.gitChangesReader);
      const archiveResult = await archivePlanSnapshot(archiveDir, planId, {
        ...snapshot,
        evidence,
        traceability,
        archivedAt: new Date().toISOString()
      });
      const purged = await deps.taskService.purgeArchivedPlan(planId);
      await deps.taskService.vacuumStorage(200);
      const evidenceDir = await deps.guard.ensureEvidenceDirectory();
      const protectedRel = await deps.taskService.getProtectedEvidencePaths();
      const protectedAbs = new Set([...protectedRel].map(rel => path.resolve(deps.workspaceRoot, rel)));
      const quotaResult = await enforceEvidenceQuota(evidenceDir, evidenceQuotaBytes, protectedAbs);
      return result({
        archivePath: path.relative(deps.workspaceRoot, archiveResult.archivePath).replace(/\\/g, '/'),
        rawBytes: archiveResult.rawBytes,
        compressedBytes: archiveResult.compressedBytes,
        compressionRatio: archiveResult.compressionRatio,
        purged,
        quotaResult,
        conventionalCommit,
        finalOutputRequirement: 'MANDATORY: Include conventionalCommit.fullMessage in your final output to summarize the changes. Do NOT run git push without explicit user authorization.'
      });
    } catch (error) {
      return errorResult(error);
    }
  });

  registerToolWithAlias('storage_maintenance', {
    description: 'Inspect lean storage statistics (DB size, WAL size, entity counts), run SQLite incremental vacuum + WAL truncate, and enforce the workspace evidence disk quota (LRU eviction that protects active/PASS checkpoint evidence).',
    annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false },
    inputSchema: z.object({
      enforceQuota: z.boolean().default(true),
      vacuumPages: z.number().int().min(10).max(5000).default(200)
    })
  }, async ({ enforceQuota, vacuumPages }) => {
    try {
      await deps.taskService.vacuumStorage(vacuumPages);
      const stats = await deps.taskService.getStorageStats();
      let quota = null;
      if (enforceQuota) {
        const evidenceDir = await deps.guard.ensureEvidenceDirectory();
        const protectedRel = await deps.taskService.getProtectedEvidencePaths();
        const protectedAbs = new Set([...protectedRel].map(rel => path.resolve(deps.workspaceRoot, rel)));
        quota = await enforceEvidenceQuota(evidenceDir, evidenceQuotaBytes, protectedAbs);
      }
      return result({ stats, quota, configuredQuotaMb: Math.round(evidenceQuotaBytes / (1024 * 1024)) });
    } catch (error) {
      return errorResult(error);
    }
  });

  registerToolWithAlias('create_execution_plan', {
    description: 'Create a persistent task DAG for an engineering request. Returns parallel-ready workstreams, agent roles, Skill IDs, module references, and quality checkpoints. The host orchestrator must delegate ready tasks to native subagents.',
    annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false },
    inputSchema: z.object({ title: z.string().min(1).max(160), request: z.string().min(10).max(12000), domains: z.array(z.enum(workDomains)).optional(), maxRepairIterations: z.number().int().min(1).max(12).optional() })
  }, async input => { try { const created = await deps.taskService.createPlan(toCreatePlanInput(input)); const checklistPath = await deps.checklistWriter.write(created.plan.id); return result({ ...created, checklistPath }); } catch (error) { return errorResult(error); } });

  registerToolWithAlias('get_execution_plan', {
    description: 'Read a plan, its tasks, and quality checkpoints.',
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false },
    inputSchema: z.object({ planId: z.string().uuid() })
  }, async ({ planId }) => { try { return result(await deps.taskService.getPlan(planId)); } catch (error) { return errorResult(error); } });

  registerToolWithAlias('get_plan_insights', {
    description: 'Get holistic plan intelligence: remaining critical path chain, active bottlenecks blocking downstream work, lock contention risk, and prioritized recommended orchestration actions.',
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false },
    inputSchema: z.object({ planId: z.string().uuid() })
  }, async ({ planId }) => { try { return result(await deps.taskService.getPlanInsights(planId)); } catch (error) { return errorResult(error); } });

  registerToolWithAlias('get_ready_tasks', {
    description: 'Return all pending tasks whose dependencies are completed. Claim these in parallel using separate host subagents when file ownership and dependencies allow.',
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false },
    inputSchema: z.object({ planId: z.string().uuid() })
  }, async ({ planId }) => { try { return result(await deps.taskService.getReadyTasks(planId)); } catch (error) { return errorResult(error); } });

  registerToolWithAlias('claim_task', {
    description: 'Claim a ready task for one agent and optionally acquire exclusive write locks on workspace-relative ownedPaths. Rejects duplicate task ownership and overlapping active file locks.',
    annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false },
    inputSchema: z.object({
      taskId: z.string().uuid(),
      agentId: z.string().min(1).max(100),
      ownedPaths: z.array(ownedPathSchema).max(200).optional(),
      leaseTimeoutMinutes: z.number().int().min(1).max(180).optional()
    })
  }, async input => { try {
    const normalized = toClaimTaskInput(input);
    if (normalized.ownedPaths) await assertWorkspacePaths(normalized.ownedPaths);
    const task = await deps.taskService.claimTask(normalized.taskId, normalized.agentId, normalized.ownedPaths, normalized.leaseTimeoutMs);
    await deps.checklistWriter.write(task.planId);
    return result(task);
  } catch (error) { return errorResult(error); } });

  registerToolWithAlias('claim_ready_batch', {
    description: 'Atomically claim multiple ready tasks simultaneously for a swarm of parallel agents. Validates dependencies and partitions file locks without starvation or race conditions.',
    annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false },
    inputSchema: z.object({
      planId: z.string().uuid(),
      claims: z.array(z.object({
        taskId: z.string().uuid(),
        agentId: z.string().min(1).max(100),
        ownedPaths: z.array(ownedPathSchema).max(200).optional(),
        leaseTimeoutMinutes: z.number().int().min(1).max(180).optional()
      })).min(1).max(20)
    })
  }, async input => { try {
    const normalized = toClaimReadyBatchInput(input);
    for (const claim of normalized.claims) {
      if (claim.ownedPaths) await assertWorkspacePaths(claim.ownedPaths);
    }
    const batchResult = await deps.taskService.claimReadyBatch(normalized.planId, normalized.claims);
    const checklistPath = await deps.checklistWriter.write(normalized.planId);
    return result({ ...batchResult, checklistPath });
  } catch (error) { return errorResult(error); } });

  registerToolWithAlias('heartbeat_task', {
    description: 'Send a heartbeat for an active in-progress task lease. Extends the expiration timestamp to prevent auto-recovery during long-running tasks.',
    annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false },
    inputSchema: z.object({
      taskId: z.string().uuid(),
      agentId: z.string().min(1).max(100),
      extendMinutes: z.number().int().min(1).max(180).default(15)
    })
  }, async ({ taskId, agentId, extendMinutes }) => { try {
    const task = await deps.taskService.heartbeatTask(taskId, agentId, extendMinutes * 60 * 1000);
    return result(task);
  } catch (error) { return errorResult(error); } });

  registerToolWithAlias('acquire_file_locks', {
    description: 'Acquire exclusive path-level write locks for a claimed in-progress task. Rejects conflicting or overlapping paths held by another active task.',
    annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false },
    inputSchema: z.object({ taskId: z.string().uuid(), agentId: z.string().min(1).max(100), paths: z.array(ownedPathSchema).min(1).max(200) })
  }, async ({ taskId, agentId, paths }) => { try {
    await assertWorkspacePaths(paths);
    const acquired = await deps.taskService.acquireFileLocks(taskId, agentId, paths);
    const checklistPath = await deps.checklistWriter.write(acquired.task.planId);
    return result({ ...acquired, checklistPath });
  } catch (error) { return errorResult(error); } });

  registerToolWithAlias('release_file_locks', {
    description: 'Release path-level file locks owned by the claiming agent on an in-progress task (or all locks held by that task when paths is omitted).',
    annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false },
    inputSchema: z.object({ taskId: z.string().uuid(), agentId: z.string().min(1).max(100), paths: z.array(ownedPathSchema).min(1).max(200).optional() })
  }, async input => { try {
    const normalized = toReleaseFileLocksInput(input);
    if (normalized.paths) await assertWorkspacePaths(normalized.paths);
    const released = await deps.taskService.releaseFileLocks(normalized.taskId, normalized.agentId, normalized.paths);
    const checklistPath = await deps.checklistWriter.write(released.task.planId);
    return result({ ...released, checklistPath });
  } catch (error) { return errorResult(error); } });

  registerToolWithAlias('list_file_locks', {
    description: 'List active path-level file locks, optionally filtered by planId, taskId, or overlapping workspace path.',
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false },
    inputSchema: z.object({ planId: z.string().uuid().optional(), taskId: z.string().uuid().optional(), path: ownedPathSchema.optional() })
  }, async input => { try {
    const filter = toListFileLocksFilter(input);
    if (filter.path !== undefined) deps.guard.resolveInsideWorkspace(filter.path);
    return result(await deps.taskService.listFileLocks(filter));
  } catch (error) { return errorResult(error); } });

  registerToolWithAlias('recover_stale_locks', {
    description: 'Recover stale or orphaned file locks held by completed/failed tasks or abandoned agent leases.',
    annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false },
    inputSchema: z.object({ planId: z.string().uuid().optional(), maxAgeMinutes: z.number().int().min(1).max(1440).optional() })
  }, async ({ planId, maxAgeMinutes }) => { try {
    const maxAgeMs = (maxAgeMinutes ?? 30) * 60 * 1000;
    const recovered = await deps.taskService.recoverStaleLocks(planId, maxAgeMs);
    const checklistPath = planId ? await deps.checklistWriter.write(planId) : null;
    return result({ ...recovered, checklistPath });
  } catch (error) { return errorResult(error); } });

  registerToolWithAlias('complete_task', {
    description: 'Complete, block, or fail a claimed task. Completed tasks that require evidence must include at least one existing evidence ID. Optionally attach a structured handoff (summary, changedFiles, contracts, decisions, testsRun) so downstream subagents receive concise context without transcript bloat.',
    annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false },
    inputSchema: z.object({
      taskId: z.string().uuid(),
      status: z.enum(['completed', 'blocked', 'failed']),
      evidenceIds: z.array(z.string().uuid()).default([]),
      reason: z.string().max(2000).nullable().optional(),
      handoff: handoffSchema.nullable().optional()
    })
  }, async ({ taskId, status, evidenceIds, reason, handoff }) => { try { const task = await deps.taskService.completeTask(taskId, status, evidenceIds, reason ?? null, handoff ?? null); const checklistPath = await deps.checklistWriter.write(task.planId); return result({ task, checklistPath }); } catch (error) { return errorResult(error); } });

  registerToolWithAlias('record_evidence', {
    description: 'Record auditable evidence for a plan or task. Evidence paths must be workspace-relative; do not record an assertion as evidence without an artifact or reproducible source.',
    annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false },
    inputSchema: z.object({ planId: z.string().uuid().nullable().optional(), taskId: z.string().uuid().nullable().optional(), kind: z.enum(['browser-report', 'screenshot', 'test-report', 'build-log', 'security-report', 'manual-review', 'other']), title: z.string().min(1).max(200), description: z.string().max(4000), path: z.string().nullable().optional(), uri: z.string().url().refine(value => value.startsWith('https://'), 'Evidence URI must use HTTPS.').nullable().optional(), metadata: z.record(z.string(), z.unknown()).default({}), createdBy: z.string().min(1).max(100) })
  }, async input => { try {
    const safePath = input.path ? path.relative(deps.workspaceRoot, await deps.guard.resolveExistingFileInsideWorkspace(input.path)) : null;
    return result(await deps.taskService.recordEvidence({ ...input, path: safePath, planId: input.planId ?? null, taskId: input.taskId ?? null, uri: input.uri ?? null }));
  } catch (error) { return errorResult(error); } });

  registerToolWithAlias('update_quality_checkpoint', {
    description: 'Update one quality checkpoint. PASS requires evidence IDs. NOT_APPLICABLE requires an explicit rationale. Use FAIL or BLOCKED when a criterion is not met.',
    annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false },
    inputSchema: z.object({ planId: z.string().uuid(), dimension: z.enum(checkpointIds), status: z.enum(['pass', 'fail', 'blocked', 'not_applicable']), evidenceIds: z.array(z.string().uuid()).default([]), reason: z.string().max(2000).nullable().optional() })
  }, async ({ planId, dimension, status, evidenceIds, reason }) => { try { const checkpoint = await deps.taskService.updateCheckpoint(planId, dimension, status, evidenceIds, reason ?? null); const checklistPath = await deps.checklistWriter.write(planId); return result({ checkpoint, checklistPath }); } catch (error) { return errorResult(error); } });

  registerToolWithAlias('evaluate_quality_gate', {
    description: 'Evaluate required acceptance checkpoints for a plan. A PASS is impossible while any required checkpoint is pending, failed, blocked, or missing valid evidence. On PASS, automatically returns a Conventional Commits 1.0.0 message (no push).',
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false },
    inputSchema: z.object({ planId: z.string().uuid() })
  }, async ({ planId }) => { try { return result(await deps.taskService.evaluateGate(planId)); } catch (error) { return errorResult(error); } });

  registerToolWithAlias('prepare_commit_message', {
    description: 'Generate a Conventional Commits 1.0.0 git commit message summarizing verified plan tasks and/or current workspace git changes without pushing (noPush: true). Use before finishing any task or final output.',
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false },
    inputSchema: z.object({
      planId: z.string().uuid().optional(),
      type: z.enum(commitTypes).optional(),
      scope: z.string().min(1).max(32).optional(),
      summary: z.string().min(3).max(200).optional(),
      breakingChange: z.string().min(3).max(500).optional()
    })
  }, async input => {
    try {
      if (input.planId) {
        const commit = await deps.taskService.buildConventionalCommit(input.planId, {
          ...(input.type !== undefined ? { type: input.type } : {}),
          ...(input.scope !== undefined ? { scope: input.scope } : {}),
          ...(input.summary !== undefined ? { summary: input.summary } : {}),
          ...(input.breakingChange !== undefined ? { breakingChange: input.breakingChange } : {})
        });
        return result({
          ...commit,
          finalOutputRequirement: 'MANDATORY: Include fullMessage in your final output. Do NOT run git push without explicit user authorization.'
        });
      }

      const workingTree = deps.gitChangesReader
        ? await deps.gitChangesReader.readWorkingTreeChanges()
        : { isGitRepo: false, changedFiles: [] };
      const summary = input.summary?.trim();
      if (!summary && workingTree.changedFiles.length === 0) {
        return errorResult(new Error('ValidationError: Provide planId, summary, or have uncommitted git changes in workspaceRoot to build a Conventional Commit message.'));
      }
      const commit = buildConventionalCommit({
        title: summary || `update ${workingTree.changedFiles.slice(0, 2).join(', ')}`,
        ...(summary ? { summaryPoints: [summary] } : {}),
        changedFiles: workingTree.changedFiles,
        ...(input.type !== undefined ? { type: input.type } : {}),
        ...(input.scope !== undefined ? { scope: input.scope } : {}),
        ...(input.breakingChange !== undefined ? { breakingChange: input.breakingChange } : {})
      });
      return result({
        ...commit,
        isGitRepo: workingTree.isGitRepo,
        finalOutputRequirement: 'MANDATORY: Include fullMessage in your final output. Do NOT run git push without explicit user authorization.'
      });
    } catch (error) {
      return errorResult(error);
    }
  });

  registerToolWithAlias('increment_repair_iteration', {
    description: 'Consume one repair-loop iteration from the plan budget. If the budget is exhausted, the task must be escalated instead of looping indefinitely.',
    annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false },
    inputSchema: z.object({ planId: z.string().uuid() })
  }, async ({ planId }) => { try { return result(await deps.taskService.incrementRepairIteration(planId)); } catch (error) { return errorResult(error); } });

  registerToolWithAlias('invalidate_checkpoints', {
    description: 'Invalidate quality checkpoints after a source/configuration change so stale PASS results cannot be reused.',
    annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false },
    inputSchema: z.object({ planId: z.string().uuid(), dimensions: z.array(z.enum(checkpointIds)).min(1), reason: z.string().min(3).max(1000) })
  }, async ({ planId, dimensions, reason }) => { try { const checkpoints = await deps.taskService.invalidateCheckpoints(planId, dimensions, reason); const checklistPath = await deps.checklistWriter.write(planId); return result({ checkpoints, checklistPath }); } catch (error) { return errorResult(error); } });

  registerToolWithAlias('reopen_task', {
    description: 'Reopen a task and optionally all downstream dependent tasks after a requirement change or regression. Existing evidence remains in history but is detached from the reopened tasks.',
    annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: true },
    inputSchema: z.object({ taskId: z.string().uuid(), reason: z.string().min(3).max(1000), cascade: z.boolean().default(true) })
  }, async ({ taskId, reason, cascade }) => { try { const tasks = await deps.taskService.reopenTask(taskId, reason, cascade); const checklistPath = tasks[0] ? await deps.checklistWriter.write(tasks[0].planId) : null; return result({ tasks, checklistPath }); } catch (error) { return errorResult(error); } });

  registerToolWithAlias('list_modules', {
    description: 'Search or list the 70 engineering and governance modules available in the capability catalog.',
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false },
    inputSchema: z.object({ filter: z.string().max(120).optional() })
  }, async ({ filter }) => { try { return result(await deps.moduleRegistry.list(filter)); } catch (error) { return errorResult(error); } });

  registerToolWithAlias('list_skills', {
    description: 'List locally available Agent Skills with their descriptions and paths.',
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false },
    inputSchema: z.object({})
  }, async () => { try { return result(await deps.skillRegistry.list()); } catch (error) { return errorResult(error); } });

  server.registerTool('localhost_discover_routes', {
    description: 'Open a localhost entry route and discover same-origin anchor routes. Supplement this with source-router inspection because hidden, authenticated, or programmatic routes may not be linked from the page.',
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false },
    inputSchema: z.object({ baseUrl: z.string().url(), timeoutMs: z.number().int().min(1000).max(120000).default(deps.browserTimeoutMs) })
  }, async ({ baseUrl, timeoutMs }) => { try { return result(await deps.inspector.discoverRoutes(baseUrl, timeoutMs)); } catch (error) { return errorResult(error); } });

  server.registerTool('localhost_wait_for_ready', {
    description: 'Poll a loopback URL until the development site responds. Only localhost/127.0.0.1/::1 URLs are accepted.',
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false },
    inputSchema: z.object({ url: z.string().url(), timeoutMs: z.number().int().min(1000).max(120000).default(Math.max(30000, deps.browserTimeoutMs)) })
  }, async ({ url, timeoutMs }) => { try { return result(await waitForLocalUrl(url, timeoutMs)); } catch (error) { return errorResult(error); } });

  server.registerTool('localhost_start_dev_server', {
    description: 'Start an allowlisted package.json dev/start/preview script inside the configured workspace. Does not run arbitrary shell commands.',
    annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false },
    inputSchema: z.object({ packageManager: z.enum(['npm', 'pnpm', 'yarn', 'bun']).default('npm'), script: z.enum(['dev', 'start', 'preview']).default('dev') })
  }, async ({ packageManager, script }) => { try { return result(await deps.devServer.start(packageManager, script)); } catch (error) { return errorResult(error); } });

  server.registerTool('localhost_ensure_dev_server', {
    description: 'Idempotently ensure a development server is running for an allowlisted package.json script. Reuses existing active process if already running without port collisions.',
    annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false },
    inputSchema: z.object({ packageManager: z.enum(['npm', 'pnpm', 'yarn', 'bun']).default('npm'), script: z.enum(['dev', 'start', 'preview']).default('dev') })
  }, async ({ packageManager, script }) => { try { return result(await deps.devServer.ensure(packageManager, script)); } catch (error) { return errorResult(error); } });

  (server.registerTool as any)('craftrig_ensure_dev_server', {
    description: 'Idempotently ensure a development server is running for an allowlisted package.json script.',
    annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false },
    inputSchema: z.object({ packageManager: z.enum(['npm', 'pnpm', 'yarn', 'bun']).default('npm'), script: z.enum(['dev', 'start', 'preview']).default('dev') })
  }, async ({ packageManager, script }: any) => { try { return result(await deps.devServer.ensure(packageManager, script)); } catch (error) { return errorResult(error); } });

  server.registerTool('localhost_get_server_status', {
    description: 'Read status and bounded logs for a development server started by this MCP process.',
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false },
    inputSchema: z.object({ processId: z.string().uuid() })
  }, async ({ processId }) => { try { return result(await deps.devServer.status(processId)); } catch (error) { return errorResult(error); } });

  server.registerTool('localhost_stop_dev_server', {
    description: 'Stop only a development server process started and tracked by this MCP process.',
    annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: true },
    inputSchema: z.object({ processId: z.string().uuid() })
  }, async ({ processId }) => { try { return result(await deps.devServer.stop(processId)); } catch (error) { return errorResult(error); } });

  server.registerTool('localhost_inspect_responsive', {
    description: 'Open a localhost website using Playwright. Inspect each route across the default 13 viewport profiles or supplied profiles; collect lean JPEG screenshots (failures-only by default, SHA-256 deduplicated), DOM overflow metrics + metricsHash, console/page/network errors, and a JSON report. This is the responsive-first browser QA tool.',
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false },
    inputSchema: z.object({ baseUrl: z.string().url(), routes: z.array(z.string()).default(['/']), viewports: z.array(viewportSchema).optional(), timeoutMs: z.number().int().min(1000).max(120000).default(deps.browserTimeoutMs), allowedOverflowSelectors: z.array(z.string()).default([]), captureScreenshots: z.enum(captureModes).default('failures-only'), planId: z.string().uuid().nullable().optional(), taskId: z.string().uuid().nullable().optional(), createdBy: z.string().default('responsive-qa-agent') })
  }, async input => { try {
    const evidenceDirectory = await deps.guard.ensureEvidenceDirectory();
    const report = await deps.inspector.inspectResponsive({ baseUrl: input.baseUrl, routes: input.routes, viewports: input.viewports ?? [], evidenceDirectory, timeoutMs: input.timeoutMs, allowedOverflowSelectors: input.allowedOverflowSelectors, captureScreenshots: input.captureScreenshots });
    const evidence = await deps.taskService.recordEvidence({ planId: input.planId ?? null, taskId: input.taskId ?? null, kind: 'browser-report', title: `Responsive inspection: ${report.runId}`, description: `${report.passedCases}/${report.totalCases} route/viewport cases passed. Overall: ${report.overallStatus}.`, path: path.relative(deps.workspaceRoot, report.reportPath), uri: null, metadata: { runId: report.runId, overallStatus: report.overallStatus, passedCases: report.passedCases, failedCases: report.failedCases, results: report.results.map(item => ({ route: item.route, viewport: item.viewport.name, passed: item.passed, metricsHash: item.metricsHash, issues: item.issues })) }, createdBy: input.createdBy });
    const protectedRel = await deps.taskService.getProtectedEvidencePaths();
    const protectedAbs = new Set([...protectedRel].map(rel => path.resolve(deps.workspaceRoot, rel)));
    protectedAbs.add(path.resolve(report.reportPath));
    await enforceEvidenceQuota(evidenceDirectory, evidenceQuotaBytes, protectedAbs).catch(() => undefined);
    return result({ ...report, evidenceId: evidence.id, nextAction: report.overallStatus === 'pass' ? 'Record responsive checkpoint as PASS with this evidence ID, then continue to layout inspection.' : 'Diagnose failed route/viewport cases, repair source code, then rerun this tool. Do not mark responsive PASS.' });
  } catch (error) { return errorResult(error); } });

  server.registerTool('localhost_run_interaction_scenario', {
    description: 'Run an explicit, bounded interaction scenario on localhost using Playwright. Supports click/fill/check/select/press/visibility/text assertions. Potentially destructive selectors are blocked unless allowRiskyActions is explicitly true for an isolated test environment.',
    annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false },
    inputSchema: z.object({ baseUrl: z.string().url(), route: z.string().default('/'), actions: z.array(actionSchema).min(1).max(100), timeoutMs: z.number().int().min(1000).max(120000).default(deps.browserTimeoutMs), allowRiskyActions: z.boolean().default(false), captureScreenshots: z.enum(captureModes).default('failures-only'), planId: z.string().uuid().nullable().optional(), taskId: z.string().uuid().nullable().optional(), createdBy: z.string().default('functional-qa-agent') })
  }, async input => { try {
    const evidenceDirectory = await deps.guard.ensureEvidenceDirectory();
    const report = await deps.inspector.runInteractionScenario({ baseUrl: input.baseUrl, route: input.route, actions: toInteractionActions(input.actions), evidenceDirectory, timeoutMs: input.timeoutMs, allowRiskyActions: input.allowRiskyActions, captureScreenshots: input.captureScreenshots });
    const evidence = await deps.taskService.recordEvidence({ planId: input.planId ?? null, taskId: input.taskId ?? null, kind: 'browser-report', title: `Interaction scenario: ${report.runId}`, description: `${report.steps.filter(step => step.status === 'pass').length}/${report.steps.length} interaction steps passed.`, path: path.relative(deps.workspaceRoot, report.reportPath), uri: null, metadata: { passed: report.passed, metricsHash: report.metricsHash, steps: report.steps }, createdBy: input.createdBy });
    return result({ ...report, evidenceId: evidence.id });
  } catch (error) { return errorResult(error); } });

  server.registerTool('localhost_audit_visual_a11y', {
    description: 'Run automated dual-theme (light/dark) visual, contrast (@axe-core/playwright + alpha-composited DOM guard), typography, occlusion, target-size, reduced-motion, and ARIA snapshot audit on localhost. Captures deduplicated JPEG screenshots on failures-only by default to save disk.',
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false },
    inputSchema: z.object({
      baseUrl: z.string().url(),
      routes: z.array(z.string()).default(['/']),
      colorSchemes: z.array(z.enum(['light', 'dark'])).min(1).default(['light', 'dark']),
      viewports: z.array(viewportSchema).optional(),
      expectedSectionPolarity: z.enum(['follow-active-theme', 'contrast-bands', 'always-dark-media-showcase', 'always-light-reading', 'custom']).optional(),
      themeToggleSelector: z.string().min(1).max(200).optional(),
      testReducedMotion: z.boolean().default(true),
      captureScreenshots: z.enum(captureModes).default('failures-only'),
      timeoutMs: z.number().int().min(1000).max(120000).default(deps.browserTimeoutMs),
      planId: z.string().uuid().nullable().optional(),
      taskId: z.string().uuid().nullable().optional(),
      createdBy: z.string().default('accessibility-qa-agent')
    })
  }, async input => { try {
    const evidenceDirectory = await deps.guard.ensureEvidenceDirectory();
    const report = await deps.inspector.auditVisualA11y(toVisualA11yAuditInput({
      baseUrl: input.baseUrl,
      routes: input.routes,
      colorSchemes: input.colorSchemes,
      viewports: input.viewports,
      expectedSectionPolarity: input.expectedSectionPolarity,
      themeToggleSelector: input.themeToggleSelector,
      testReducedMotion: input.testReducedMotion,
      captureScreenshots: input.captureScreenshots,
      evidenceDirectory,
      timeoutMs: input.timeoutMs
    }));
    const evidence = await deps.taskService.recordEvidence({
      planId: input.planId ?? null,
      taskId: input.taskId ?? null,
      kind: 'browser-report',
      title: `Visual & A11y audit: ${report.runId}`,
      description: `${report.passedCases}/${report.totalCases} cases passed across [${report.testedColorSchemes.join(', ')}]. Contrast violations: ${report.totalContrastViolations}, axe violations: ${report.totalAxeViolations}, incomplete contrast: ${report.totalIncompleteContrast}.`,
      path: path.relative(deps.workspaceRoot, report.reportPath),
      uri: null,
      metadata: {
        auditType: 'visual-a11y',
        runId: report.runId,
        overallStatus: report.overallStatus,
        testedColorSchemes: report.testedColorSchemes,
        expectedColorSchemes: input.colorSchemes,
        totalContrastViolations: report.totalContrastViolations,
        totalAxeViolations: report.totalAxeViolations,
        totalIncompleteContrast: report.totalIncompleteContrast,
        themeToggleCheck: report.themeToggleCheck,
        results: report.results.map(item => ({
          route: item.route,
          colorScheme: item.colorScheme,
          viewport: item.viewport.name,
          passed: item.passed,
          metricsHash: item.metricsHash,
          issues: item.issues
        }))
      },
      createdBy: input.createdBy
    });
    const protectedRel = await deps.taskService.getProtectedEvidencePaths();
    const protectedAbs = new Set([...protectedRel].map(rel => path.resolve(deps.workspaceRoot, rel)));
    protectedAbs.add(path.resolve(report.reportPath));
    await enforceEvidenceQuota(evidenceDirectory, evidenceQuotaBytes, protectedAbs).catch(() => undefined);
    return result({
      ...report,
      evidenceId: evidence.id,
      nextAction: report.overallStatus === 'pass'
        ? 'Review any incompleteContrast items over gradients/canvases, then use this evidence ID for typography-color and accessibility checkpoints.'
        : 'Fix every contrast, polarity, axe, typography, occlusion, or reduced-motion defect and rerun localhost_audit_visual_a11y. Do not pass checkpoints yet.'
    });
  } catch (error) { return errorResult(error); } });

  const registerResourceWithAlias = (name: string, pathSegment: string, meta: { title: string; description: string; mimeType: string }, handler: (uri: URL) => Promise<any>) => {
    server.registerResource(`${name}-craftrig`, `craftrig://${pathSegment}`, meta, handler);
  };

  const registerResourceTemplateWithAlias = (
    name: string,
    templatePattern: string,
    meta: { title: string; description: string; mimeType: string },
    handler: (uri: URL, params: Record<string, string>) => Promise<any>
  ) => {
    server.registerResource(
      `${name}-craftrig`,
      new ResourceTemplate(`craftrig://${templatePattern}`, { list: undefined }),
      meta,
      (uri, params) => handler(uri, params as Record<string, string>)
    );
  };

  registerResourceWithAlias('architecture-blueprint', 'architecture', { title: 'Craftrig Architecture', description: 'Clean Architecture layers, agent delegation model, QA loop and boundaries.', mimeType: 'text/markdown' }, async uri => {
    const file = path.join(deps.harnessRoot, 'docs', 'ARCHITECTURE.md');
    const text = await readFile(file, 'utf8').catch(() => '# Architecture\nArchitecture document is not available in the configured workspace.');
    return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text }] };
  });

  registerResourceWithAlias('principal-development-principles', 'development-principles', { title: 'Craftrig Development Principles', description: 'Clean Architecture, Clean Code, agent delegation, evidence, UI engineering and security rules.', mimeType: 'text/markdown' }, async uri => {
    const file = path.join(deps.harnessRoot, 'docs', 'PRINCIPAL_DEVELOPMENT.md');
    const text = await readFile(file, 'utf8');
    return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text }] };
  });

  registerResourceWithAlias('module-catalog', 'modules', { title: '70-module capability catalog', description: 'Read-only catalog of all engineering, security, design, verification and learning capabilities.', mimeType: 'application/json' }, async uri => {
    const text = await readFile(path.join(deps.harnessRoot, 'catalogs', 'modules.json'), 'utf8');
    return { contents: [{ uri: uri.href, mimeType: 'application/json', text }] };
  });
  registerResourceWithAlias('reference-catalog', 'references', { title: 'Design reference catalog', description: 'Reference source provenance and verification statuses for the seven design categories.', mimeType: 'application/json' }, async uri => {
    const text = await readFile(path.join(deps.harnessRoot, 'catalogs', 'references.json'), 'utf8');
    return { contents: [{ uri: uri.href, mimeType: 'application/json', text }] };
  });
  registerResourceWithAlias('design-options', 'design-options', { title: 'Design options menu', description: 'User-selectable design choices (theme mode, color, fonts, layout, typography, motion, accessibility). Present to the user before building UI.', mimeType: 'application/json' }, async uri => {
    const text = await readFile(path.join(deps.harnessRoot, 'catalogs', 'design-options.json'), 'utf8');
    return { contents: [{ uri: uri.href, mimeType: 'application/json', text }] };
  });
  registerResourceWithAlias('runtime-config', 'runtime-config', { title: 'Craftrig runtime configuration', description: 'Non-secret runtime limits for host orchestration and browser checks.', mimeType: 'application/json' }, async uri => {
    const text = JSON.stringify({ maxParallelTasks: deps.maxParallelTasks, browserTimeoutMs: deps.browserTimeoutMs }, null, 2);
    return { contents: [{ uri: uri.href, mimeType: 'application/json', text }] };
  });

  registerResourceWithAlias('agent-role-catalog', 'agent-roles', { title: 'Agent role catalog', description: 'Specialist agent roles and responsibilities for host-native delegation.', mimeType: 'application/json' }, async uri => {
    const text = await readFile(path.join(deps.harnessRoot, 'catalogs', 'agent-roles.json'), 'utf8');
    return { contents: [{ uri: uri.href, mimeType: 'application/json', text }] };
  });

  registerResourceTemplateWithAlias(
    'task-packet',
    'plans/{planId}/tasks/{taskId}/packet',
    {
      title: 'Compact Task Execution Packet',
      description: 'Token-budgeted prompt context packet for a subagent: task scope, REQ-ID acceptance criteria, Tier-1 primary skill path (progressive disclosure), and structured upstream handoff contracts only.',
      mimeType: 'application/json'
    },
    async (uri, params) => {
      try {
        const planId = String(params.planId ?? '');
        const taskId = String(params.taskId ?? '');
        const packet = await autopilot.buildCompactPacket(planId, taskId, 2500);
        return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(packet, null, 2) }] };
      } catch (err) {
        return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }] };
      }
    }
  );

  registerResourceTemplateWithAlias(
    'skill-guide',
    'skills/{skillId}',
    {
      title: 'Skill Guidance Document',
      description: 'Markdown documentation and operational guidance for an Agent Skill.',
      mimeType: 'text/markdown'
    },
    async (uri, params) => {
      const skillId = String(params.skillId ?? '');
      const skills = await deps.skillRegistry.list();
      const skill = skills.find(s => s.name === skillId);
      if (!skill) return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text: `# Skill not found: ${skillId}` }] };
      const text = await readFile(skill.path, 'utf8').catch(() => `# Unable to read skill file: ${skill.path}`);
      return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text }] };
    }
  );

  server.registerPrompt('principal-orchestrator-workflow', {
    title: 'Principal Orchestrator Workflow',
    description: 'Plan and coordinate a project task using parallel subagents, Skills, MCP tools and independent verification.',
    argsSchema: z.object({ request: z.string().min(10), projectRoot: z.string().optional() })
  }, ({ request, projectRoot }) => ({ messages: [{ role: 'user' as const, content: { type: 'text' as const, text: `Act as Principal Orchestrator. Create an execution plan for this request: ${request}\nWorkspace: ${projectRoot ?? deps.workspaceRoot}\nMaximum parallel tasks: ${deps.maxParallelTasks}. Never exceed this host delegation limit.\nUse craftrig_create_execution_plan, claim tasks with explicit ownedPaths (or acquire locks via craftrig_acquire_file_locks) before delegating dependency-ready tasks to host-native subagents, collect evidence, run localhost browser QA for UI changes, and do not pass quality gates without evidence. In every final output, ALWAYS include a Conventional Commits 1.0.0 git commit message (from craftrig_evaluate_quality_gate or craftrig_prepare_commit_message) summarizing the changes, and NEVER run git push.` } }] }));

  server.registerPrompt('craftrig-autopilot', {
    title: 'Craftrig Full-Blueprint Autopilot',
    description: 'Run an entire project from idea or full blueprint through EVERY phase to verified completion using token-saving lazy skill routing, zero-token deterministic QA, and parallel host subagents.',
    argsSchema: z.object({
      input: z.string().min(5).describe('User project idea OR full Markdown blueprint.'),
      hasBlueprint: z.boolean().default(false),
      interviewMode: z.enum(interviewModes).default('deep'),
      autonomyMode: z.enum(autonomyModes).default('full-auto')
    })
  }, ({ input, hasBlueprint, interviewMode, autonomyMode }) => ({
    messages: [{
      role: 'user' as const,
      content: {
        type: 'text' as const,
        text: [
          'Act as Craftrig Blueprint Autopilot Orchestrator.',
          `Workspace: ${deps.workspaceRoot} | Max parallel subagents: ${deps.maxParallelTasks} | Autonomy: ${autonomyMode}.`,
          '',
          'OPERATING LOOP (DO NOT STOP AFTER PHASE 1 OR LANDING PAGE — FINISH EVERY PHASE):',
          hasBlueprint
            ? '1. Call craftrig_ingest_blueprint with the supplied markdown blueprint.'
            : `1. No blueprint yet: call craftrig_start_blueprint_interview (mode="${interviewMode}"), relay questions[] to the user cleanly (using host interactive question UI if available), submit answers via craftrig_answer_blueprint_questions until blueprint is generated, get quick user approval, then call craftrig_ingest_blueprint.`,
          '2. Loop craftrig_autopilot_next(planId):',
          '   - If state === "verify": run deterministicChecks directly with MCP/CLI tools (0 subagent LLM tokens!). If all pass, record evidence, update quality checkpoints, complete_task, and continue.',
          '   - If state === "dispatch" or "repair": call craftrig_claim_ready_batch for dispatchWave, spawn parallel host subagents ONLY for mode="subagent" tasks. Each subagent MUST read ONLY its packetUri and its single primarySkill file — NEVER load skipped skills!',
          '   - Require every subagent to return structured handoff (summary, changedFiles, contracts, decisions, testsRun) and pass it to craftrig_complete_task.',
          '   - If state === "needs_human": pause and present humanPrompt to the user.',
          '   - Repeat across ALL phases until state === "done".',
          '3. At state === "done": present REQ-ID traceability matrix, skill/token telemetry, and MANDATORY Conventional Commits 1.0.0 git commit message (`conventionalCommit.fullMessage`) summarizing all changes — NEVER run `git push` or deploy without explicit user authorization.',
          '',
          `USER INPUT:\n${input}`
        ].join('\n')
      }
    }]
  }));

  return server;
}
