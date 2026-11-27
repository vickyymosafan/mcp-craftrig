import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BlueprintArchitectService, lintBlueprint } from '../src/application/blueprint-architect.js';
import { parseMarkdownBlueprint } from '../src/application/blueprint-parser.js';
import { routeSkillsForBlueprint } from '../src/application/skill-router.js';
import { TaskPlanner } from '../src/application/task-planner.js';
import { TaskService } from '../src/application/task-service.js';
import { AutopilotService } from '../src/application/autopilot-service.js';
import { SqliteStateRepository } from '../src/infrastructure/persistence/sqlite-state-repository.js';
import { WorkspaceRepoScanner } from '../src/infrastructure/discovery/repo-scanner.js';
import { FileBlueprintArtifactWriter } from '../src/infrastructure/persistence/blueprint-artifact-writer.js';
import { WorkspaceGuard } from '../src/infrastructure/security/workspace-guard.js';
import { ChecklistDocumentWriter } from '../src/infrastructure/persistence/checklist-document-writer.js';
import { FileSkillRegistry } from '../src/infrastructure/skills/file-skill-registry.js';
import { ModuleRegistry } from '../src/infrastructure/catalog/module-registry.js';
import { createMcpServer } from '../src/interfaces/mcp/server.js';
import type { BrowserInspectorPort, DevServerPort } from '../src/domain/ports.js';

test('BlueprintArchitectService defaults to deep mode, pre-fills repo context, branches adaptively, and outputs REQ-ID blueprint artifacts', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'craftrig-architect-'));
  try {
    const canonicalRoot = await realpath(tempDir);
    await writeFile(
      path.join(canonicalRoot, 'package.json'),
      JSON.stringify({ dependencies: { next: '15.0.0', react: '19.0.0', tailwindcss: '4.0.0' } }),
      'utf8'
    );

    const guard = new WorkspaceGuard(canonicalRoot);
    const repo = new SqliteStateRepository(':memory:');
    const scanner = new WorkspaceRepoScanner(canonicalRoot);
    const writer = new FileBlueprintArtifactWriter(guard, canonicalRoot);
    const architect = new BlueprintArchitectService(repo, scanner, writer);

    try {
      const round1 = await architect.startInterview({
        initialIdea: 'Buatkan toko online fashion modern lengkap dengan katalog, detail produk, keranjang, dan checkout'
      });

      assert.equal(round1.mode, 'deep', 'Default interview mode must be deep');
      assert.equal(round1.status, 'in_progress');
      assert.equal(round1.detectedRepo.framework, 'Next.js');
      assert.equal(round1.detectedRepo.hasTailwind, true);
      assert.ok(round1.questions.length >= 2 && round1.questions.length <= 4);
      assert.ok(round1.elicitationSchema, 'Should provide MCP elicitation schema');
      assert.ok(round1.llmRelayPrompt, 'Should provide LLM relay prompt');

      // Answer core questions cleanly: static frontend, NO 3D, full-auto
      let current = await architect.answerQuestions({
        sessionId: round1.sessionId,
        answers: {
          'goal.audience': 'End-user konsumen fashion',
          'scope.features': 'Katalog, detail produk, keranjang, checkout',
          'pages.routes': '/, /products, /cart, /checkout',
          'data_backend.architecture': 'Frontend saja / data statis tanpa backend',
          'design.theme': 'Light + Dark fleksibel mengikuti sistem',
          'design.direction': 'Editorial Minimal',
          'threejs_motion.need': 'Tidak perlu 3D; cukup micro-interaction CSS halus',
          'integrations.ecommerce': 'Cart + Checkout lengkap dengan simulasi payment lokal',
          'acceptance.dod': 'Semua phase lulus build, responsive, dan kontras light/dark PASS',
          'autonomy.mode': 'Full-Auto — kerjakan semua phase sampai selesai'
        },
        finalizeNow: true
      });

      assert.equal(current.status, 'completed');
      assert.ok(current.blueprint);
      assert.equal(current.blueprint.stack.threejs, false, '3D must stay disabled when user declined');
      assert.equal(current.blueprint.stack.database, null, 'DB must stay null for frontend-only');
      assert.ok(current.blueprint.phases.length >= 3, 'Should compile multiple phases, not just landing');
      assert.ok(current.blueprint.requirements.every(r => /^REQ-\d{3}$/.test(r.id)));
      assert.ok(current.blueprint.markdownPath && existsSync(path.join(canonicalRoot, current.blueprint.markdownPath)));
      assert.ok(current.blueprint.jsonPath && existsSync(path.join(canonicalRoot, current.blueprint.jsonPath)));

      // Verify Skill Router skips unneeded 3D and backend skills!
      const routed = routeSkillsForBlueprint(current.blueprint);
      assert.ok(routed.skippedSkills.some(s => s.skill === 'threejs-shaders'));
      assert.ok(routed.skippedSkills.some(s => s.skill === 'backend-implementation'));
      assert.ok(routed.deterministicDeferredSkills.some(s => s.skill === 'responsive-first-browser-qa'));
    } finally {
      repo.close();
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('lintBlueprint catches static+auth contradiction and unmeasurable performance wording', () => {
  const bp = parseMarkdownBlueprint({
    title: 'Contradictory App',
    markdown: `# Contradictory App\n\nAplikasi dengan login user dan database prisma yang harus sangat cepat.\n\n## Phase 1: Auth\n- Login & Register`
  });
  const issues = lintBlueprint(bp, {
    'data_backend.architecture': 'Frontend saja / statis tanpa backend',
    'performance.budget': 'harus cepat'
  });
  assert.ok(issues.some(i => i.code === 'CONTRADICTION_STATIC_WITH_AUTH' && i.severity === 'error'));
  assert.ok(issues.some(i => i.code === 'UNMEASURABLE_PERFORMANCE_CRITERIA' && i.severity === 'warning'));
});

test('parseMarkdownBlueprint + TaskPlanner.createFromBlueprint compiles ALL phases with 1-primary-skill routing and zero-token verification tasks', () => {
  const blueprint = parseMarkdownBlueprint({
    markdown: `# Full E-Commerce Suite

## Phase 1: Product Catalog
- Listing grid on /products with filters
- Product detail page /products/[id]

## Phase 2: Authentication & API
- REST API endpoints and Prisma schema for users and orders
- Login and registration on /login

## Phase 3: Checkout & Orders
Depends on: Phase 1, Phase 2
- Cart drawer and /checkout flow
- Order confirmation receipt
`
  });

  assert.equal(blueprint.phases.length, 4, 'Should include Phase 0 Foundation + 3 feature phases');
  assert.equal(blueprint.stack.threejs, false, 'No 3D mentioned -> threejs must be false');

  const planner = new TaskPlanner();
  const { plan, tasks } = planner.createFromBlueprint(blueprint);

  // Three.js skill must NEVER be assigned to any task and must appear in skillsSkipped
  assert.ok(tasks.every(t => !t.skillIds.includes('threejs-shaders')));
  assert.ok(plan.telemetry?.skillsSkipped.some(s => s.skill === 'threejs-shaders'));

  // Every task must have at most 2 skills (no 5-skill dump!)
  for (const task of tasks) {
    assert.ok(task.skillIds.length <= 2, `Task "${task.title}" loaded too many skills: ${task.skillIds.join(', ')}`);
    assert.ok(task.primarySkill, `Task "${task.title}" must designate a primarySkill`);
  }

  // Deterministic verification tasks exist with executionMode === 'tool'
  const toolTasks = tasks.filter(t => t.executionMode === 'tool');
  assert.ok(toolTasks.length >= 4, 'Each phase + final QA should have a deterministic tool gate');
  assert.ok((plan.telemetry?.subagentsSavedByDeterministicTools ?? 0) > 0);
});

test('AutopilotService runs multi-phase blueprint from dispatch -> structured handoff -> verify -> targeted repair -> done with REQ traceability', async () => {
  const repo = new SqliteStateRepository(':memory:');
  const taskService = new TaskService(repo);
  const autopilot = new AutopilotService(taskService, 4);

  try {
    const blueprint = parseMarkdownBlueprint({
      title: 'Two-Phase Portfolio',
      markdown: `# Two-Phase Portfolio\n\n## Phase 1: Showcase & Projects\n- Hero and projects grid on / and /projects\n\n## Phase 2: Case Studies & Contact\n- Case study detail /projects/[slug] and /contact form`
    });

    const { plan } = await taskService.createPlanFromBlueprint(blueprint, { autonomyMode: 'full-auto' });

    let safetyGuard = 0;
    let simulatedFailureOnce = false;
    let sawRepairState = false;
    let sawVerifyState = false;

    while (safetyGuard < 40) {
      safetyGuard++;
      const step = await autopilot.next(plan.id);

      if (step.state === 'done') {
        assert.equal(step.progress.percentage, 100);
        assert.equal(step.gateStatus?.status, 'pass');
        assert.ok(step.traceability.length > 0);
        assert.ok(step.traceability.every(t => t.verified), 'Every REQ-ID must be verified with evidence');
        assert.ok(step.conventionalCommit, 'Done state must include Conventional Commit message');
        assert.equal(step.conventionalCommit.specVersion, '1.0.0');
        assert.equal(step.conventionalCommit.noPush, true);
        assert.match(step.conventionalCommit.fullMessage, /^(feat|fix|chore|refactor|docs|test|build|ci|perf|style)(\([a-z0-9-]+\))?!?: .+/);
        assert.match(step.instructions, /NEVER run git push/i);
        assert.ok(sawVerifyState, 'Must have executed deterministic verify state');
        assert.ok(sawRepairState, 'Must have executed targeted repair state after simulated failure');
        return;
      }

      if (step.state === 'dispatch' || step.state === 'repair') {
        if (step.state === 'repair') {
          sawRepairState = true;
          assert.equal(step.dispatchWave.length, 1, 'Targeted repair should spawn ONLY 1 focused subagent');
        }
        // Verify compact packet respects Tier-1 skill path & token budget
        const firstItem = step.dispatchWave[0]!;
        const packet = await autopilot.buildCompactPacket(plan.id, firstItem.taskId);
        assert.ok(packet.estimatedTokens <= 2500);
        assert.ok(packet.primarySkill?.path.startsWith('.agent/skills/'));

        const claimed = await taskService.claimReadyBatch(
          plan.id,
          step.dispatchWave.map((item, idx) => ({
            taskId: item.taskId,
            agentId: `subagent-${idx}`,
            ownedPaths: item.ownedPaths
          }))
        );
        assert.equal(claimed.failedTasks.length, 0);

        for (const task of claimed.claimedTasks) {
          const ev = await taskService.recordEvidence({
            planId: plan.id,
            taskId: task.id,
            kind: 'test-report',
            title: `Work completed for ${task.title}`,
            description: 'Verified build and contracts',
            path: null,
            uri: 'https://internal.test/work-ok',
            metadata: {},
            createdBy: task.claimedBy ?? 'subagent'
          });
          await taskService.completeTask(task.id, 'completed', [ev.id], null, {
            summary: `Completed ${task.title}`,
            changedFiles: task.ownedPaths,
            contracts: [`Contract from ${task.phaseId}`],
            decisions: ['Kept clean boundaries'],
            testsRun: ['npm run typecheck']
          });
        }
        continue;
      }

      if (step.state === 'verify') {
        sawVerifyState = true;
        if (step.deterministicChecks.length > 0) {
          for (const check of step.deterministicChecks) {
            await taskService.claimTask(check.taskId, 'deterministic-runner', ['evidence/verify']);
            if (!simulatedFailureOnce) {
              simulatedFailureOnce = true;
              await taskService.completeTask(check.taskId, 'failed', [], 'Simulated responsive overflow defect on /projects');
              continue;
            }
            const ev = await taskService.recordEvidence({
              planId: plan.id,
              taskId: check.taskId,
              kind: 'browser-report',
              title: 'Deterministic visual-a11y + responsive pass',
              description: 'All routes passed with zero violations',
              path: null,
              uri: 'https://internal.test/qa-pass',
              metadata: {
                auditType: 'visual-a11y',
                overallStatus: 'pass',
                totalContrastViolations: 0,
                totalAxeViolations: 0,
                testedColorSchemes: ['light', 'dark'],
                expectedColorSchemes: ['light', 'dark']
              },
              createdBy: 'deterministic-runner'
            });
            await taskService.completeTask(check.taskId, 'completed', [ev.id]);
          }
        } else if (step.gateStatus && step.gateStatus.status === 'blocked') {
          // Pass remaining checkpoints with verified evidence
          const snapshot = await taskService.getPlan(plan.id);
          const ev = await taskService.recordEvidence({
            planId: plan.id,
            taskId: null,
            kind: 'browser-report',
            title: 'Verified gate audit evidence',
            description: 'All required quality dimensions passed',
            path: null,
            uri: 'https://internal.test/final-gate-pass',
            metadata: {
              auditType: 'visual-a11y',
              overallStatus: 'pass',
              totalContrastViolations: 0,
              totalAxeViolations: 0,
              testedColorSchemes: ['light', 'dark'],
              expectedColorSchemes: ['light', 'dark']
            },
            createdBy: 'deterministic-runner'
          });
          for (const cp of snapshot.checkpoints) {
            if (cp.status !== 'pass') {
              const dim = cp.id.split(':')[1]!;
              await taskService.updateCheckpoint(plan.id, dim, 'pass', [ev.id], null);
            }
          }
        }
        continue;
      }

      assert.fail(`Unexpected autopilot state: ${step.state}`);
    }

    assert.fail('Autopilot loop did not reach done state within safety bound');
  } finally {
    repo.close();
  }
});

test('AutopilotService enforces phase-gate pause and autopilotResume recovers expired leases', async () => {
  const repo = new SqliteStateRepository(':memory:');
  const taskService = new TaskService(repo);
  const autopilot = new AutopilotService(taskService, 4);

  try {
    const blueprint = parseMarkdownBlueprint({
      title: 'Phase-Gate App',
      markdown: `# Phase-Gate App\n\n## Phase 1: Core\n- Build /dashboard`,
      autonomyMode: 'phase-gate'
    });
    const { plan } = await taskService.createPlanFromBlueprint(blueprint, { autonomyMode: 'phase-gate' });

    // Complete Phase 0 tasks
    const wave0 = await autopilot.next(plan.id);
    assert.equal(wave0.state, 'dispatch');
    for (const item of wave0.dispatchWave) {
      // Test crash recovery on first item: claim with expired lease, then resume
      await taskService.claimTask(item.taskId, 'crashed-agent', item.ownedPaths, -5000);
    }
    const resumed = await autopilot.resume(plan.id);
    assert.equal(resumed.state, 'dispatch');
    assert.ok(resumed.dispatchWave.length >= 1);

    // Complete Phase 0 implementation & verify
    for (const item of resumed.dispatchWave) {
      await taskService.claimTask(item.taskId, 'agent-ok', item.ownedPaths);
      const ev = await taskService.recordEvidence({ planId: plan.id, taskId: item.taskId, kind: 'build-log', title: 'ok', description: 'ok', path: null, uri: 'https://internal.test/ok', metadata: {}, createdBy: 'agent-ok' });
      await taskService.completeTask(item.taskId, 'completed', [ev.id]);
    }
    const verify0 = await autopilot.next(plan.id);
    assert.equal(verify0.state, 'verify');
    for (const check of verify0.deterministicChecks) {
      await taskService.claimTask(check.taskId, 'det', ['evidence/v']);
      const ev = await taskService.recordEvidence({ planId: plan.id, taskId: check.taskId, kind: 'test-report', title: 'ok', description: 'ok', path: null, uri: 'https://internal.test/v', metadata: {}, createdBy: 'det' });
      await taskService.completeTask(check.taskId, 'completed', [ev.id]);
    }

    // Now phase-gate must pause before Phase 1!
    const paused = await autopilot.next(plan.id);
    assert.equal(paused.state, 'needs_human');
    assert.ok(paused.humanPrompt?.includes('phase-0-foundation'));

    // Approving Phase 0 unlocks Phase 1 dispatch immediately
    const resumedPhase1 = await autopilot.next(plan.id, { approvePhaseId: 'phase-0-foundation' });
    assert.equal(resumedPhase1.state, 'dispatch');
    assert.ok(resumedPhase1.phase?.id.startsWith('phase-1'));
  } finally {
    repo.close();
  }
});

test('MCP server wires Blueprint Architect, ingest_blueprint, autopilot_next, archive_plan, storage_maintenance, and craftrig-autopilot prompt', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'craftrig-mcp-autopilot-'));
  try {
    const canonicalRoot = await realpath(tempDir);
    const guard = new WorkspaceGuard(canonicalRoot);
    const repo = new SqliteStateRepository(path.join(canonicalRoot, 'state.sqlite'), { idleCloseMs: 0 });
    const taskService = new TaskService(repo);
    const architect = new BlueprintArchitectService(repo, new WorkspaceRepoScanner(canonicalRoot), new FileBlueprintArtifactWriter(guard, canonicalRoot));
    const checklistWriter = new ChecklistDocumentWriter(taskService, guard);

    const noopInspector: BrowserInspectorPort = {
      discoverRoutes: async () => ({ baseUrl: 'http://127.0.0.1:3000/', routes: ['/'], discoveredAt: new Date().toISOString() }),
      inspectResponsive: async () => { throw new Error('Not used'); },
      runInteractionScenario: async () => { throw new Error('Not used'); },
      auditVisualA11y: async () => { throw new Error('Not used'); }
    };
    const noopDevServer: DevServerPort = {
      start: async () => ({ id: 'd1', pid: 1, status: 'running' }),
      ensure: async () => ({ id: 'd1', pid: 1, status: 'running', reused: true }),
      status: async () => ({ id: 'd1', status: 'running' }),
      stop: async () => ({ id: 'd1', status: 'stopped' }),
      stopAll: async () => undefined
    };

    const server = createMcpServer({
      workspaceRoot: canonicalRoot,
      harnessRoot: process.cwd(),
      guard,
      taskService,
      blueprintArchitect: architect,
      inspector: noopInspector,
      devServer: noopDevServer,
      skillRegistry: new FileSkillRegistry(path.join(process.cwd(), '.agent', 'skills')),
      moduleRegistry: new ModuleRegistry(path.join(process.cwd(), 'catalogs', 'modules.json')),
      checklistWriter,
      maxParallelTasks: 4,
      browserTimeoutMs: 5000,
      evidenceQuotaBytes: 50 * 1024 * 1024
    });

    const tools = (server as any)._registeredTools;
    for (const name of [
      'craftrig_start_blueprint_interview',
      'craftrig_answer_blueprint_questions',
      'craftrig_ingest_blueprint',
      'craftrig_autopilot_next',
      'craftrig_autopilot_resume',
      'craftrig_archive_plan',
      'craftrig_storage_maintenance'
    ]) {
      assert.ok(tools[name], `Tool ${name} must be registered`);
    }
    assert.equal(tools['harness.autopilot_next'], undefined, 'Legacy harness.* alias must not be registered');

    const prompts = (server as any)._registeredPrompts;
    assert.ok(prompts['craftrig-autopilot'], 'Prompt craftrig-autopilot must be registered');

    // End-to-end call: ingest_blueprint -> storage_maintenance -> archive_plan (force)
    const ingestRes = await tools['craftrig_ingest_blueprint'].handler({
      markdown: '# Test Blueprint\n\n## Phase 1: Catalog\n- Product listing on /products\n\n## Phase 2: Cart\n- Cart page on /cart'
    });
    const ingested = JSON.parse(ingestRes.content[0].text);
    assert.ok(ingested.plan.id);
    assert.equal(ingested.firstWave.state, 'dispatch');

    const maintRes = await tools['craftrig_storage_maintenance'].handler({ enforceQuota: true, vacuumPages: 50 });
    const maint = JSON.parse(maintRes.content[0].text);
    assert.equal(maint.configuredQuotaMb, 50);
    assert.equal(maint.stats.backend, 'sqlite');

    const archiveRes = await tools['craftrig_archive_plan'].handler({ planId: ingested.plan.id, force: true });
    const archived = JSON.parse(archiveRes.content[0].text);
    assert.ok(archived.archivePath.endsWith('.json.br'));
    assert.ok(archived.purged.removedTasks > 0);
    assert.ok(archived.conventionalCommit, 'Archive output must include Conventional Commit message');
    assert.equal(archived.conventionalCommit.noPush, true);
    assert.match(archived.finalOutputRequirement, /Do NOT run git push/i);

    repo.close();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
