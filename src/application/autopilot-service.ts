import type {
  ExecutionMode,
  ModelTier,
  PlanTelemetry,
  RequirementTraceabilityEntry,
  TaskHandoff
} from '../domain/blueprint.js';
import type { TaskNode } from '../domain/models.js';
import { pathsOverlap } from '../domain/file-ownership.js';
import type { TaskService } from './task-service.js';
import { estimateTokens, skillPathFor } from './skill-router.js';

export type AutopilotState = 'dispatch' | 'verify' | 'repair' | 'waiting' | 'needs_human' | 'done';

export interface AutopilotWaveItem {
  taskId: string;
  title: string;
  phaseId: string | null;
  phaseName: string | null;
  mode: ExecutionMode;
  ownerRole: string;
  primarySkill: string | null;
  skillPath: string | null;
  ownedPaths: string[];
  packetUri: string;
  modelTier: ModelTier;
  requirementIds: string[];
  estimatedPacketTokens: number;
  outputSchema: {
    requiredFields: string[];
    handoffFields: Array<keyof TaskHandoff>;
  };
}

export interface DeterministicCheckItem {
  taskId: string;
  title: string;
  phaseId: string | null;
  phaseName: string | null;
  suggestedTools: string[];
  routes: string[];
  colorSchemes: Array<'light' | 'dark'>;
  zeroSubagentTokenNote: string;
}

export interface AutopilotNextResult {
  planId: string;
  state: AutopilotState;
  phase: { id: string; name: string; order: number } | null;
  progress: {
    phasesDone: number;
    phasesTotal: number;
    tasksDone: number;
    tasksTotal: number;
    percentage: number;
  };
  deterministicChecks: DeterministicCheckItem[];
  dispatchWave: AutopilotWaveItem[];
  inProgressTasks: Array<{ taskId: string; title: string; claimedBy: string | null; leaseExpiresAt: string | null }>;
  humanPrompt: string | null;
  gateStatus: { status: 'pass' | 'blocked'; missing: string[]; failed: string[] } | null;
  traceability: RequirementTraceabilityEntry[];
  telemetry: PlanTelemetry | null;
  instructions: string;
}

export interface CompactTaskPacket {
  planId: string;
  planTitle: string;
  task: {
    id: string;
    title: string;
    description: string;
    ownerRole: string;
    phaseId: string | null;
    phaseName: string | null;
    executionMode: ExecutionMode;
    modelTier: ModelTier;
    ownedPaths: string[];
    recommendedPaths: string[];
    requirementIds: string[];
  };
  primarySkill: { name: string; path: string } | null;
  additionalSkills: Array<{ name: string; path: string }>;
  requirements: Array<{ id: string; title: string; priority: string; acceptanceCriteria: string[] }>;
  upstreamHandoffs: Array<{
    taskId: string;
    title: string;
    summary: string;
    changedFiles: string[];
    contracts: string[];
    decisions: string[];
  }>;
  themePolicy: { mode: string; direction: string | null } | null;
  estimatedTokens: number;
  tokenBudgetApplied: number;
}

export class AutopilotService {
  constructor(
    private readonly taskService: TaskService,
    private readonly defaultMaxParallelTasks = 4
  ) {}

  async buildCompactPacket(planId: string, taskId: string, maxPacketTokens = 2500): Promise<CompactTaskPacket> {
    const { plan, tasks } = await this.taskService.getPlan(planId);
    const task = tasks.find(t => t.id === taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found in plan ${planId}`);
    }

    const blueprint = plan.blueprintId
      ? await this.taskService.getBlueprint(plan.blueprintId).catch(() => null)
      : null;

    const directDeps = tasks.filter(t => task.dependsOn.includes(t.id));
    const upstreamHandoffs = directDeps.map(dep => ({
      taskId: dep.id,
      title: dep.title,
      summary: dep.handoff?.summary ?? `Completed (${dep.evidenceIds.length} evidence record(s)).`,
      changedFiles: (dep.handoff?.changedFiles ?? dep.ownedPaths).slice(0, 12),
      contracts: (dep.handoff?.contracts ?? []).slice(0, 10),
      decisions: (dep.handoff?.decisions ?? []).slice(0, 6)
    }));

    const linkedReqs = blueprint
      ? blueprint.requirements
          .filter(r => (task.requirementIds ?? []).includes(r.id))
          .map(r => ({
            id: r.id,
            title: r.title,
            priority: r.priority,
            acceptanceCriteria: r.acceptanceCriteria.slice(0, 4)
          }))
      : [];

    const primaryName = task.primarySkill ?? task.skillIds[0] ?? null;
    const primarySkill = primaryName ? { name: primaryName, path: skillPathFor(primaryName) } : null;
    const additionalSkills = task.skillIds
      .filter(s => s !== primaryName)
      .slice(0, 1)
      .map(s => ({ name: s, path: skillPathFor(s) }));

    const packet: CompactTaskPacket = {
      planId,
      planTitle: plan.title,
      task: {
        id: task.id,
        title: task.title,
        description: task.description,
        ownerRole: task.ownerRole,
        phaseId: task.phaseId ?? null,
        phaseName: task.phaseName ?? null,
        executionMode: task.executionMode ?? 'subagent',
        modelTier: task.modelTier ?? 'standard',
        ownedPaths: task.ownedPaths,
        recommendedPaths: task.recommendedPaths ?? [],
        requirementIds: task.requirementIds ?? []
      },
      primarySkill,
      additionalSkills,
      requirements: linkedReqs,
      upstreamHandoffs,
      themePolicy: blueprint ? blueprint.themePolicy : null,
      estimatedTokens: 0,
      tokenBudgetApplied: maxPacketTokens
    };

    let tokens = estimateTokens(packet);
    if (tokens > maxPacketTokens) {
      // Trim verbose fields while preserving contracts, ownedPaths, skill paths, and requirements
      packet.task.description = packet.task.description.slice(0, 400);
      packet.upstreamHandoffs = packet.upstreamHandoffs.map(h => ({
        ...h,
        summary: h.summary.slice(0, 180),
        decisions: h.decisions.slice(0, 2)
      }));
      tokens = estimateTokens(packet);
    }
    packet.estimatedTokens = tokens;
    return packet;
  }

  private selectDisjointWave(ready: TaskNode[], limit: number): TaskNode[] {
    const selected: TaskNode[] = [];
    const claimedPaths: string[] = [];

    for (const task of ready) {
      if (selected.length >= limit) break;
      const candidatePaths = task.ownedPaths.length > 0 ? task.ownedPaths : (task.recommendedPaths ?? []);
      const conflicts = candidatePaths.some(p => claimedPaths.some(existing => pathsOverlap(p, existing)));
      if (conflicts && selected.length > 0) continue;
      selected.push(task);
      claimedPaths.push(...candidatePaths);
    }
    return selected;
  }

  async next(
    planId: string,
    options: { approvePhaseId?: string; maxWaveSize?: number } = {}
  ): Promise<AutopilotNextResult> {
    if (options.approvePhaseId) {
      await this.taskService.approvePhase(planId, options.approvePhaseId);
    }

    // Trigger automatic lease expiration recovery first
    const readyTasks = await this.taskService.getReadyTasks(planId);
    const { plan, tasks } = await this.taskService.getPlan(planId);
    const blueprint = plan.blueprintId
      ? await this.taskService.getBlueprint(plan.blueprintId).catch(() => null)
      : null;
    const traceability = await this.taskService.getRequirementTraceability(planId);

    const phases = plan.phases ?? [];
    const completedTaskIds = new Set(tasks.filter(t => t.status === 'completed').map(t => t.id));
    const phasesDone = phases.filter(p => p.taskIds.length > 0 && p.taskIds.every(id => completedTaskIds.has(id))).length;
    const tasksDone = completedTaskIds.size;
    const tasksTotal = tasks.length;
    const progress = {
      phasesDone,
      phasesTotal: phases.length || 1,
      tasksDone,
      tasksTotal,
      percentage: tasksTotal > 0 ? Math.round((tasksDone / tasksTotal) * 100) : 0
    };

    const currentPhaseSummary = phases.find(p => p.taskIds.some(id => !completedTaskIds.has(id))) ?? phases[phases.length - 1] ?? null;
    const phaseInfo = currentPhaseSummary
      ? { id: currentPhaseSummary.id, name: currentPhaseSummary.name, order: currentPhaseSummary.order }
      : null;

    const inProgressTasks = tasks
      .filter(t => t.status === 'in_progress')
      .map(t => ({
        taskId: t.id,
        title: t.title,
        claimedBy: t.claimedBy,
        leaseExpiresAt: t.leaseExpiresAt ?? null
      }));

    // 1. Check failed or blocked tasks -> auto-create targeted repair or escalate
    const failedTasks = tasks.filter(t => t.status === 'failed' || t.status === 'blocked');
    if (failedTasks.length > 0) {
      const target = failedTasks[0]!;
      if (plan.repairIterations >= plan.maxRepairIterations) {
        return {
          planId,
          state: 'needs_human',
          phase: phaseInfo,
          progress,
          deterministicChecks: [],
          dispatchWave: [],
          inProgressTasks,
          humanPrompt: `Repair budget exhausted (${plan.repairIterations}/${plan.maxRepairIterations}) on "${target.title}": ${target.failureReason ?? 'unknown error'}. Human decision required.`,
          gateStatus: null,
          traceability,
          telemetry: plan.telemetry ?? null,
          instructions: 'Pause autopilot and report the failure details and evidence to the user for manual direction.'
        };
      }

      const { repairTask } = await this.taskService.createTargetedRepairTask(
        planId,
        target.id,
        target.failureReason ?? 'Verification failed',
        target.evidenceIds,
        target.domains[0]
      );
      const packet = await this.buildCompactPacket(planId, repairTask.id);
      const waveItem: AutopilotWaveItem = {
        taskId: repairTask.id,
        title: repairTask.title,
        phaseId: repairTask.phaseId ?? null,
        phaseName: repairTask.phaseName ?? null,
        mode: 'subagent',
        ownerRole: repairTask.ownerRole,
        primarySkill: repairTask.primarySkill ?? repairTask.skillIds[0] ?? null,
        skillPath: repairTask.primarySkill ? skillPathFor(repairTask.primarySkill) : null,
        ownedPaths: repairTask.recommendedPaths ?? ['src'],
        packetUri: `craftrig://plans/${planId}/tasks/${repairTask.id}/packet`,
        modelTier: repairTask.modelTier ?? 'standard',
        requirementIds: repairTask.requirementIds ?? [],
        estimatedPacketTokens: packet.estimatedTokens,
        outputSchema: {
          requiredFields: ['taskId', 'status', 'evidenceIds', 'handoff'],
          handoffFields: ['summary', 'changedFiles', 'contracts', 'decisions', 'testsRun']
        }
      };

      return {
        planId,
        state: 'repair',
        phase: phaseInfo,
        progress,
        deterministicChecks: [],
        dispatchWave: [waveItem],
        inProgressTasks,
        humanPrompt: null,
        gateStatus: null,
        traceability,
        telemetry: plan.telemetry ?? null,
        instructions: `Targeted repair created (iteration ${plan.repairIterations + 1}/${plan.maxRepairIterations}). Claim and dispatch ONLY this 1 repair subagent with its packetUri and single primarySkill, complete it with evidence, then call autopilot_next to re-verify.`
      };
    }

    // 2. Check phase-gate autonomy pause
    if (plan.autonomyMode === 'phase-gate' && phases.length > 1) {
      const approved = new Set(plan.approvedPhaseIds ?? []);
      const finishedUnapproved = phases.find(p =>
        p.id !== 'final-assurance' &&
        p.taskIds.length > 0 &&
        p.taskIds.every(id => completedTaskIds.has(id)) &&
        !approved.has(p.id)
      );
      if (finishedUnapproved && tasksDone < tasksTotal) {
        return {
          planId,
          state: 'needs_human',
          phase: { id: finishedUnapproved.id, name: finishedUnapproved.name, order: finishedUnapproved.order },
          progress,
          deterministicChecks: [],
          dispatchWave: [],
          inProgressTasks,
          humanPrompt: `Phase "${finishedUnapproved.name}" is completed and verified. Review progress and call autopilot_next with approvePhaseId="${finishedUnapproved.id}" to proceed to the next phase.`,
          gateStatus: null,
          traceability,
          telemetry: plan.telemetry ?? null,
          instructions: 'Present the completed phase summary to the user. Once approved, call craftrig_autopilot_next with approvePhaseId.'
        };
      }
    }

    // 3. Deterministic zero-token tool tasks FIRST before spawning any subagents
    const toolReady = readyTasks.filter(t => t.executionMode === 'tool');
    if (toolReady.length > 0) {
      const schemes: Array<'light' | 'dark'> =
        blueprint?.themePolicy.mode === 'light' ? ['light']
        : blueprint?.themePolicy.mode === 'dark' ? ['dark']
        : ['light', 'dark'];
      const routes = blueprint?.routes.length ? blueprint.routes : ['/'];

      const deterministicChecks: DeterministicCheckItem[] = toolReady.map(t => ({
        taskId: t.id,
        title: t.title,
        phaseId: t.phaseId ?? null,
        phaseName: t.phaseName ?? null,
        suggestedTools: [
          'localhost_ensure_dev_server',
          'localhost_inspect_responsive',
          'localhost_audit_visual_a11y'
        ],
        routes,
        colorSchemes: schemes,
        zeroSubagentTokenNote: 'Execute directly with MCP tools (0 subagent tokens). If all checks PASS, record evidence and complete_task without spawning QA subagents; if FAIL, complete_task with status="failed" so autopilot spawns a single targeted repair subagent.'
      }));

      return {
        planId,
        state: 'verify',
        phase: phaseInfo,
        progress,
        deterministicChecks,
        dispatchWave: [],
        inProgressTasks,
        humanPrompt: null,
        gateStatus: null,
        traceability,
        telemetry: plan.telemetry ?? null,
        instructions: 'Run deterministicChecks directly using MCP/CLI tools (no QA subagents needed if PASS). Claim each check task, record evidence, update matching quality checkpoints, complete_task, and call autopilot_next.'
      };
    }

    // 4. Dispatch subagent / inline wave (respecting maxSubagentsPerWave & disjoint paths)
    const maxWave = Math.max(1, options.maxWaveSize ?? plan.maxSubagentsPerWave ?? this.defaultMaxParallelTasks);
    const waveTasks = this.selectDisjointWave(readyTasks, maxWave);
    if (waveTasks.length > 0) {
      const dispatchWave: AutopilotWaveItem[] = [];
      for (const t of waveTasks) {
        const packet = await this.buildCompactPacket(planId, t.id);
        const primary = t.primarySkill ?? t.skillIds[0] ?? null;
        dispatchWave.push({
          taskId: t.id,
          title: t.title,
          phaseId: t.phaseId ?? null,
          phaseName: t.phaseName ?? null,
          mode: t.executionMode ?? 'subagent',
          ownerRole: t.ownerRole,
          primarySkill: primary,
          skillPath: primary ? skillPathFor(primary) : null,
          ownedPaths: t.ownedPaths.length > 0 ? t.ownedPaths : (t.recommendedPaths ?? ['src']),
          packetUri: `craftrig://plans/${planId}/tasks/${t.id}/packet`,
          modelTier: t.modelTier ?? 'standard',
          requirementIds: t.requirementIds ?? [],
          estimatedPacketTokens: packet.estimatedTokens,
          outputSchema: {
            requiredFields: ['taskId', 'status', 'evidenceIds', 'handoff'],
            handoffFields: ['summary', 'changedFiles', 'contracts', 'decisions', 'testsRun']
          }
        });
      }

      return {
        planId,
        state: 'dispatch',
        phase: phaseInfo,
        progress,
        deterministicChecks: [],
        dispatchWave,
        inProgressTasks,
        humanPrompt: null,
        gateStatus: null,
        traceability,
        telemetry: plan.telemetry ?? null,
        instructions: `Call craftrig_claim_ready_batch for these ${dispatchWave.length} disjoint task(s), dispatch each mode="subagent" task in parallel to a host subagent reading ONLY its packetUri and primarySkill (do not load skipped skills), complete_task with structured handoff + evidence, then call craftrig_autopilot_next.`
      };
    }

    // 5. Tasks still in progress
    if (inProgressTasks.length > 0) {
      return {
        planId,
        state: 'waiting',
        phase: phaseInfo,
        progress,
        deterministicChecks: [],
        dispatchWave: [],
        inProgressTasks,
        humanPrompt: null,
        gateStatus: null,
        traceability,
        telemetry: plan.telemetry ?? null,
        instructions: 'Wait for active subagent(s) to finish and call complete_task (or call heartbeat_task if long-running), then invoke autopilot_next.'
      };
    }

    // 6. All tasks completed -> evaluate quality gate
    const gate = await this.taskService.evaluateGate(planId);
    if (gate.status === 'pass') {
      return {
        planId,
        state: 'done',
        phase: phaseInfo,
        progress: { ...progress, phasesDone: progress.phasesTotal, percentage: 100 },
        deterministicChecks: [],
        dispatchWave: [],
        inProgressTasks: [],
        humanPrompt: null,
        gateStatus: { status: gate.status, missing: gate.missing, failed: gate.failed },
        traceability,
        telemetry: plan.telemetry ?? null,
        instructions: 'All phases, requirements, and quality checkpoints PASSED with evidence. Present the traceability matrix, telemetry report, and release handoff to the user. Optionally call craftrig_archive_plan to compress state and reclaim disk. Never deploy without explicit user authorization.'
      };
    }

    return {
      planId,
      state: 'verify',
      phase: phaseInfo,
      progress,
      deterministicChecks: [],
      dispatchWave: [],
      inProgressTasks: [],
      humanPrompt: null,
      gateStatus: { status: gate.status, missing: gate.missing, failed: gate.failed },
      traceability,
      telemetry: plan.telemetry ?? null,
      instructions: `All execution tasks completed, but quality gate is blocked by: ${[...gate.missing, ...gate.failed].join(', ')}. Attach verified evidence via craftrig_update_quality_checkpoint and call autopilot_next.`
    };
  }

  async resume(planId: string): Promise<AutopilotNextResult & { recoveredLocksCount: number }> {
    const recovered = await this.taskService.recoverStaleLocks(planId);
    const nextState = await this.next(planId);
    return {
      ...nextState,
      recoveredLocksCount: recovered.recovered.length
    };
  }
}
