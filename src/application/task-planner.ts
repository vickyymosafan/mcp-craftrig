import { randomUUID } from 'node:crypto';
import type { AutonomyMode, ProjectBlueprint } from '../domain/blueprint.js';
import type { ExecutionPlan, ExecutionPlanPhaseSummary, TaskNode, WorkDomain } from '../domain/models.js';
import { QUALITY_DIMENSIONS } from '../domain/models.js';
import { assertAcyclicDependencyGraph } from '../domain/dag-validator.js';
import { routeSkillsForBlueprint, selectTaskEffortProfile } from './skill-router.js';

const now = () => new Date().toISOString();

export interface CreatePlanInput {
  title: string;
  request: string;
  domains?: WorkDomain[];
  maxRepairIterations?: number;
}

const DOMAIN_RULES: Array<{ domain: WorkDomain; pattern: RegExp }> = [
  { domain: 'frontend', pattern: /frontend|website|web app|ui|ux|page|dashboard|portfolio|landing/i },
  { domain: 'backend', pattern: /backend|api|server|service|endpoint/i },
  { domain: 'design', pattern: /design|interface|layout|theme|typography|color|component/i },
  { domain: 'responsive', pattern: /responsive|mobile|tablet|viewport|breakpoint/i },
  { domain: 'threejs', pattern: /three\.?js|3d|webgl|shader|glsl|scene/i },
  { domain: 'motion', pattern: /animation|motion|transition|gesture|scroll effect/i },
  { domain: 'security', pattern: /security|auth|permission|privacy|vulnerability/i },
  { domain: 'data', pattern: /database|migration|schema|data model/i }
];

function inferDomains(request: string): WorkDomain[] {
  const found = DOMAIN_RULES.filter(rule => rule.pattern.test(request)).map(rule => rule.domain);
  return found.length > 0 ? [...new Set(found)] : ['frontend'];
}

type PlannerTaskDraft = Omit<
  TaskNode,
  'id' | 'planId' | 'ownedPaths' | 'status' | 'evidenceIds' | 'claimedBy' | 'createdAt' | 'updatedAt' | 'completedAt' | 'failureReason'
> & { ownedPaths?: string[]; recommendedPaths?: string[] };

const DOMAIN_RECOMMENDED_PATHS: Record<string, string[]> = {
  frontend: ['src/ui', 'src/components', 'src/pages'],
  backend: ['src/application', 'src/domain', 'src/infrastructure'],
  threejs: ['src/three', 'src/shaders', 'src/scenes'],
  motion: ['src/motion', 'src/animations'],
  security: ['src/security', 'src/auth'],
  data: ['src/database', 'src/migrations', 'src/schema']
};

function createTask(planId: string, partial: PlannerTaskDraft): TaskNode {
  const timestamp = now();
  return {
    id: randomUUID(), planId, ...partial,
    ownedPaths: partial.ownedPaths ?? [],
    recommendedPaths: partial.recommendedPaths ?? [],
    status: 'pending', evidenceIds: [], claimedBy: null,
    createdAt: timestamp, updatedAt: timestamp, completedAt: null, failureReason: null
  };
}

export class TaskPlanner {
  constructor(private readonly defaultMaxRepairIterations = 5) {}

  create(input: CreatePlanInput): { plan: ExecutionPlan; tasks: TaskNode[] } {
    const planId = randomUUID();
    const selectedDomains: WorkDomain[] = input.domains?.length ? [...new Set(input.domains)] : inferDomains(input.request);
    const hasUi = selectedDomains.some(domain => ['frontend', 'design', 'responsive', 'threejs', 'motion'].includes(domain));
    const domains: WorkDomain[] = hasUi && !selectedDomains.includes('frontend')
      ? ['frontend', ...selectedDomains]
      : selectedDomains;
    const hasThreeJs = domains.includes('threejs');
    const tasks: TaskNode[] = [];
    const add = (task: Parameters<typeof createTask>[1]) => {
      const created = createTask(planId, task);
      tasks.push(created);
      return created.id;
    };

    const discovery = add({
      title: 'Discover requirements and repository context',
      description: 'Extract acceptance criteria, inspect source-of-truth files, identify unknowns and map affected areas.',
      ownerRole: 'discovery-lead', skillIds: ['repository-discovery', 'requirements-evidence'],
      moduleIds: [1, 20, 39, 49, 64, 67], domains, dependsOn: [], parallelGroup: null, requiredEvidence: true,
      recommendedPaths: ['docs', 'catalogs']
    });
    const governance = add({
      title: 'Resolve policy, permissions and risk profile',
      description: 'Apply least privilege, privacy boundaries, safe defaults, tool contracts and risk-based autonomy.',
      ownerRole: 'governance-lead', skillIds: ['security-review', 'agentic-task-delegation'],
      moduleIds: [5, 8, 23, 29, 31, 33, 38, 45, 59, 62, 66], domains: ['security'], dependsOn: [discovery], parallelGroup: 'planning', requiredEvidence: true,
      recommendedPaths: ['docs/security', 'docs/governance']
    });
    const architecture = add({
      title: 'Design architecture and change boundaries',
      description: 'Define affected layers, dependency direction, contracts, migration risks and patch boundaries.',
      ownerRole: 'architecture-lead', skillIds: ['clean-architecture-development', 'repository-discovery'],
      moduleIds: [19, 21, 35, 40, 50, 56, 57, 58, 69, 70], domains, dependsOn: [discovery], parallelGroup: 'planning', requiredEvidence: true,
      recommendedPaths: ['docs/architecture', 'src/domain']
    });
    const design = hasUi ? add({
      title: 'Prepare design and experience contract',
      description: 'Resolve design direction, component system, color, typography, motion and responsive constraints.',
      ownerRole: 'design-lead', skillIds: ['design-systems-governance', 'design-direction', 'typography-engineering', 'color-theming', 'motion-animation'],
      moduleIds: [13, 15, 17, 18, 21, 22], domains: ['design', ...domains.filter(d => ['frontend', 'responsive', 'threejs', 'motion'].includes(d))],
      dependsOn: [discovery], parallelGroup: 'planning', requiredEvidence: true,
      recommendedPaths: ['src/styles', 'src/theme', 'src/tokens']
    }) : null;

    const implementationIds: string[] = [];
    for (const domain of domains.filter(d => d !== 'release' && d !== 'responsive' && d !== 'design')) {
      const role = domain === 'frontend' ? 'frontend-developer' : domain === 'backend' ? 'backend-developer' : domain === 'threejs' ? 'threejs-developer' : domain === 'motion' ? 'motion-developer' : domain === 'security' ? 'security-engineer' : 'data-engineer';
      const skills = domain === 'frontend' ? ['frontend-implementation', 'design-systems-governance'] : domain === 'backend' ? ['backend-implementation', 'clean-architecture-development'] : domain === 'threejs' ? ['threejs-shaders'] : domain === 'motion' ? ['motion-animation'] : domain === 'security' ? ['security-review'] : ['clean-architecture-development'];
      implementationIds.push(add({
        title: `Implement ${domain} workstream`,
        description: `Implement the ${domain} workstream within approved architecture, scope, design contract and security boundaries.`,
        ownerRole: role, skillIds: skills, moduleIds: [6, 19, 21, 25, 26, 37, 57, 65], domains: [domain],
        dependsOn: [governance, architecture, ...(design ? [design] : [])], parallelGroup: 'implementation', requiredEvidence: true,
        recommendedPaths: DOMAIN_RECOMMENDED_PATHS[domain] ?? ['src']
      }));
    }

    const implementationJoin = implementationIds.length ? implementationIds : [architecture];
    const qaTasks: string[] = [];
    if (hasUi) {
      const integrateTask = add({
        title: 'Integrate workstreams and verify local runtime ready',
        description: 'Verify workspace builds cleanly, bundle size limits are met, clean architecture boundaries are intact, and dev runtime responds on loopback.',
        ownerRole: 'integration-lead', skillIds: ['clean-architecture-development', 'local-development-runtime'],
        moduleIds: [6, 12, 19, 21, 26, 65], domains: ['frontend'], dependsOn: implementationJoin, parallelGroup: 'integration', requiredEvidence: true,
        recommendedPaths: ['package.json', 'src']
      });
      qaTasks.push(integrateTask);

      const responsiveTask = add({
        title: 'Responsive-first localhost browser inspection',
        description: 'Inspect every supplied route across the viewport matrix, collect screenshots and DOM metrics, repair defects, then re-run affected profiles until PASS or BLOCKED.',
        ownerRole: 'responsive-qa-agent', skillIds: ['responsive-first-browser-qa', 'local-development-runtime'],
        moduleIds: [9, 15, 18, 39, 42, 43, 63], domains: ['responsive'], dependsOn: [integrateTask], parallelGroup: 'qa-wave', requiredEvidence: true,
        recommendedPaths: ['tests/e2e/responsive', 'evidence/responsive']
      });
      const layout = add({
        title: 'Inspect and repair layout and visual structure',
        description: 'Audit hierarchy, alignment, spacing, overflow, clipping, composition and design-system consistency.',
        ownerRole: 'visual-qa-agent', skillIds: ['ui-layout-repair', 'design-direction'], moduleIds: [13, 15, 17, 18, 22, 61, 63],
        domains: ['design'], dependsOn: [integrateTask], parallelGroup: 'qa-wave', requiredEvidence: true,
        recommendedPaths: ['evidence/layout', 'src/styles']
      });
      const interaction = add({
        title: 'Inspect functional interaction states',
        description: 'Test navigation, forms, controls, keyboard and touch interactions with explicit non-destructive scenarios.',
        ownerRole: 'functional-qa-agent', skillIds: ['interaction-functional-qa'], moduleIds: [15, 18, 34, 60, 63],
        domains: ['frontend'], dependsOn: [integrateTask], parallelGroup: 'qa-wave', requiredEvidence: true,
        recommendedPaths: ['tests/e2e/interaction', 'evidence/interaction']
      });
      const visual = add({
        title: 'Inspect typography, color and motion',
        description: 'Run localhost_audit_visual_a11y across every enabled color scheme (light/dark) and validate typography scale, webfont loading, semantic colors, surface polarity, contrast, component states, animation intent and reduced-motion behavior.',
        ownerRole: 'design-qa-agent', skillIds: ['typography-engineering', 'color-theming', 'motion-animation'], moduleIds: [13, 15, 17, 21, 63],
        domains: ['design', 'motion'], dependsOn: [integrateTask], parallelGroup: 'qa-wave', requiredEvidence: true,
        recommendedPaths: ['evidence/visual', 'src/theme']
      });
      const threeDReview = hasThreeJs ? add({
        title: 'Inspect 3D scene, sculptural detail, shader and lifecycle stability',
        description: 'Inspect multi-part 3D silhouette accuracy per category (no flat 2D cutouts or mismatched placeholders), smooth curvature/bevels, Line2/TubeGeometry seam detail, RoomEnvironment IBL + MeshPhysicalMaterial PBR shading, tonal separation in enabled themes, shader compilation, resource disposal, deterministic scroll behavior, GPU evidence and device fallback.',
        ownerRole: 'threejs-qa-agent', skillIds: ['threejs-shaders', 'performance-qa'], moduleIds: [15, 18, 19, 30, 34, 44, 63],
        domains: ['threejs'], dependsOn: [integrateTask], parallelGroup: 'qa-wave', requiredEvidence: true,
        recommendedPaths: ['evidence/threejs', 'src/shaders']
      }) : null;
      const accessibility = add({
        title: 'Run accessibility verification',
        description: 'Run localhost_audit_visual_a11y (@axe-core/playwright + alpha-composited contrast + ARIA snapshot) across all enabled color schemes, then manually verify incomplete contrast items, keyboard order, focus visibility, zoom and reduced motion.',
        ownerRole: 'accessibility-qa-agent', skillIds: ['accessibility-qa'], moduleIds: [15, 17, 18, 59, 63],
        domains: ['frontend'], dependsOn: [integrateTask], parallelGroup: 'qa-wave', requiredEvidence: true,
        recommendedPaths: ['evidence/a11y', 'tests/a11y']
      });
      qaTasks.push(responsiveTask, layout, interaction, visual, ...(threeDReview ? [threeDReview] : []), accessibility);
    }
    const finalDeps = qaTasks.length > 0 ? qaTasks : implementationJoin;
    const securityQA = add({
      title: 'Run security and reliability checks',
      description: 'Inspect exposed surfaces, dependencies, input handling, runtime errors and policy conformance.',
      ownerRole: 'security-qa-agent', skillIds: ['security-review'], moduleIds: [7, 8, 29, 37, 38, 45, 59],
      domains: ['security'], dependsOn: finalDeps, parallelGroup: 'final-assurance', requiredEvidence: true,
      recommendedPaths: ['evidence/security', 'tests/security']
    });
    const performanceQA = hasUi ? add({
      title: 'Run performance and runtime checks',
      description: 'Inspect build output, loading, console/network errors, browser rendering and relevant GPU/frame budgets.',
      ownerRole: 'performance-qa-agent', skillIds: ['performance-qa', 'threejs-shaders'], moduleIds: [12, 15, 26, 30, 36, 44],
      domains: ['frontend', ...domains.filter(d => ['threejs', 'motion'].includes(d))], dependsOn: finalDeps, parallelGroup: 'final-assurance', requiredEvidence: true,
      recommendedPaths: ['evidence/performance', 'tests/performance']
    }) : null;
    const finalRegression = add({
      title: 'Run final regression and quality gate',
      description: 'Re-run impacted checks, verify evidence freshness, deduplicate findings and evaluate all required acceptance criteria.',
      ownerRole: 'independent-assurance-lead', skillIds: ['evidence-and-release-governance', 'agentic-quality-governance'],
      moduleIds: [9, 10, 14, 16, 39, 43, 51, 54, 61, 63], domains, dependsOn: [securityQA, ...(performanceQA ? [performanceQA] : [])], parallelGroup: null, requiredEvidence: true,
      recommendedPaths: ['evidence/regression']
    });
    add({
      title: 'Prepare release and update engineering records',
      description: 'Prepare a release decision packet, verification receipt, documentation updates and handoff. Do not deploy without explicit authorization.',
      ownerRole: 'release-lead', skillIds: ['evidence-and-release-governance'],
      moduleIds: [10, 12, 32, 36, 46, 53], domains: ['release'], dependsOn: [finalRegression], parallelGroup: null, requiredEvidence: true,
      recommendedPaths: ['docs/release', 'evidence/release']
    });

    const timestamp = now();
    const plan: ExecutionPlan = {
      id: planId, title: input.title, request: input.request, domains, taskIds: tasks.map(task => task.id),
      checkpointIds: QUALITY_DIMENSIONS.filter(item => {
        if (item.id === '3d-rendering') return hasThreeJs;
        if (item.id === 'motion') return domains.includes('motion');
        if (['responsive', 'layout', 'interaction', 'typography-color', 'accessibility'].includes(item.id)) return hasUi;
        return true;
      }).map(item => item.id),
      maxRepairIterations: Math.max(1, Math.min(input.maxRepairIterations ?? this.defaultMaxRepairIterations, 12)), repairIterations: 0,
      createdAt: timestamp, updatedAt: timestamp
    };
    assertAcyclicDependencyGraph(tasks);
    return { plan, tasks };
  }

  createFromBlueprint(
    blueprint: ProjectBlueprint,
    options: {
      autonomyMode?: AutonomyMode;
      maxRepairIterations?: number;
      maxSubagentsPerWave?: number;
      tokenBudget?: number | null;
    } = {}
  ): { plan: ExecutionPlan; tasks: TaskNode[] } {
    const planId = randomUUID();
    const domains: WorkDomain[] = [...new Set(blueprint.domains)];
    const hasUi = domains.some(d => ['frontend', 'design', 'responsive', 'threejs', 'motion'].includes(d));
    const hasThreeJs = domains.includes('threejs') || blueprint.stack.threejs;
    const hasMotion = domains.includes('motion') || blueprint.stack.motion;
    const hasSecurityOrBackend = domains.includes('security') || domains.includes('backend') || Boolean(blueprint.stack.auth);

    const routing = routeSkillsForBlueprint(blueprint);
    const tasks: TaskNode[] = [];
    const add = (task: Parameters<typeof createTask>[1]) => {
      const created = createTask(planId, task);
      tasks.push(created);
      return created.id;
    };

    const phaseVerifyTaskId = new Map<string, string>();
    const phaseSummaries: ExecutionPlanPhaseSummary[] = [];
    const sortedPhases = [...blueprint.phases].sort((a, b) => a.order - b.order);
    const usedSkills = new Set<string>();
    let deterministicToolTasks = 0;

    for (const phase of sortedPhases) {
      const upstreamTaskIds = phase.dependsOnPhases
        .map(depPhaseId => phaseVerifyTaskId.get(depPhaseId))
        .filter((id): id is string => Boolean(id));

      const phaseTaskIds: string[] = [];
      const phaseSlug = phase.id.replace(/[^a-z0-9-]/gi, '-').toLowerCase();

      if (phase.order === 0) {
        // Phase 0: lean architecture + design contract (only if UI exists)
        const archProfile = selectTaskEffortProfile('foundation', 'frontend', phase.features.length);
        archProfile.skillIds.forEach(s => usedSkills.add(s));
        const archTask = add({
          title: `[${phase.name}] Architecture, scaffold & shared contracts`,
          description: `${phase.goal} Features: ${phase.features.join('; ')}. Acceptance: ${phase.acceptanceCriteria.join(' | ')}`,
          ownerRole: 'architecture-lead',
          skillIds: archProfile.skillIds,
          primarySkill: archProfile.primarySkill,
          executionMode: archProfile.executionMode,
          modelTier: archProfile.modelTier,
          moduleIds: [19, 21, 35, 50, 56],
          domains: phase.domains.length ? phase.domains : ['frontend'],
          dependsOn: upstreamTaskIds,
          parallelGroup: `phase-${phase.order}`,
          requiredEvidence: true,
          recommendedPaths: ['src/domain', 'src/shared', 'package.json'],
          phaseId: phase.id,
          phaseName: phase.name,
          phaseOrder: phase.order,
          requirementIds: phase.requirementIds
        });
        phaseTaskIds.push(archTask);

        if (hasUi) {
          const designProfile = selectTaskEffortProfile('design-contract', 'design', 1);
          designProfile.skillIds.forEach(s => usedSkills.add(s));
          const designTask = add({
            title: `[${phase.name}] Design tokens & theme contract (${blueprint.themePolicy.mode})`,
            description: `Establish semantic color tokens (${blueprint.themePolicy.mode}${blueprint.themePolicy.direction ? `, ${blueprint.themePolicy.direction}` : ''}), typography scale, and base layout shell.`,
            ownerRole: 'design-lead',
            skillIds: designProfile.skillIds,
            primarySkill: designProfile.primarySkill,
            executionMode: designProfile.executionMode,
            modelTier: designProfile.modelTier,
            moduleIds: [13, 15, 17, 21, 22],
            domains: ['design', 'frontend'],
            dependsOn: upstreamTaskIds,
            parallelGroup: `phase-${phase.order}`,
            requiredEvidence: true,
            recommendedPaths: ['src/styles', 'src/theme', 'src/tokens'],
            phaseId: phase.id,
            phaseName: phase.name,
            phaseOrder: phase.order,
            requirementIds: phase.requirementIds
          });
          phaseTaskIds.push(designTask);
        }
      } else {
        // Feature phases: split cleanly only across distinct specialist workstreams (backend/data vs frontend vs threejs)
        const implDomains: WorkDomain[] = [];
        if (phase.domains.some(d => d === 'backend' || d === 'data')) implDomains.push('backend');
        if (phase.domains.includes('threejs') && hasThreeJs) implDomains.push('threejs');
        if (phase.domains.some(d => ['frontend', 'design', 'responsive', 'motion'].includes(d)) || implDomains.length === 0) {
          implDomains.push('frontend');
        }

        for (const workDomain of implDomains) {
          const profile = selectTaskEffortProfile('feature-implement', workDomain, phase.features.length);
          profile.skillIds.forEach(s => usedSkills.add(s));
          const ownerRole =
            workDomain === 'threejs' ? 'threejs-developer'
            : workDomain === 'backend' ? 'backend-developer'
            : 'frontend-developer';
          const scopedPaths =
            workDomain === 'threejs' ? [`src/three/${phaseSlug}`, 'src/scenes']
            : workDomain === 'backend' ? [`src/api/${phaseSlug}`, `src/services/${phaseSlug}`]
            : [`src/features/${phaseSlug}`, `src/pages/${phaseSlug}`];

          const taskId = add({
            title: `[${phase.name}] Implement ${workDomain} (${phase.features.slice(0, 2).join(', ')})`,
            description: `Goal: ${phase.goal}. Routes: ${phase.routes.join(', ')}. Features: ${phase.features.join('; ')}. Acceptance: ${phase.acceptanceCriteria.join(' | ')}`,
            ownerRole,
            skillIds: profile.skillIds,
            primarySkill: profile.primarySkill,
            executionMode: profile.executionMode,
            modelTier: profile.modelTier,
            moduleIds: [6, 19, 21, 25, 26, 57],
            domains: [workDomain],
            dependsOn: upstreamTaskIds,
            parallelGroup: `phase-${phase.order}-impl`,
            requiredEvidence: true,
            recommendedPaths: scopedPaths,
            phaseId: phase.id,
            phaseName: phase.name,
            phaseOrder: phase.order,
            requirementIds: phase.requirementIds
          });
          phaseTaskIds.push(taskId);
        }
      }

      // Per-phase deterministic verification gate (0 subagent LLM tokens!)
      const verifyProfile = selectTaskEffortProfile('phase-verify', 'frontend', 1);
      deterministicToolTasks++;
      const verifyId = add({
        title: `[${phase.name}] Deterministic build & route verification`,
        description: `Run zero-token deterministic checks (typecheck, build, and for UI routes [${phase.routes.join(', ')}]: localhost_inspect_responsive + localhost_audit_visual_a11y). Only spawn targeted repair subagent if checks fail.`,
        ownerRole: 'integration-lead',
        skillIds: verifyProfile.skillIds,
        primarySkill: verifyProfile.primarySkill,
        executionMode: 'tool',
        modelTier: 'fast',
        moduleIds: [6, 12, 15, 18, 63],
        domains: hasUi ? ['frontend', 'responsive'] : ['backend'],
        dependsOn: [...phaseTaskIds],
        parallelGroup: `phase-${phase.order}-verify`,
        requiredEvidence: true,
        recommendedPaths: ['evidence/verify'],
        phaseId: phase.id,
        phaseName: phase.name,
        phaseOrder: phase.order,
        requirementIds: phase.requirementIds
      });
      phaseTaskIds.push(verifyId);
      phaseVerifyTaskId.set(phase.id, verifyId);

      phaseSummaries.push({
        id: phase.id,
        order: phase.order,
        name: phase.name,
        taskIds: phaseTaskIds,
        requirementIds: phase.requirementIds
      });
    }

    // Final cross-phase deterministic verification (0 subagent tokens unless defect found!)
    const allPhaseGates = [...phaseVerifyTaskId.values()];
    const finalGateDeps: string[] = [];

    if (hasUi) {
      const finalQaProfile = selectTaskEffortProfile('final-verify', 'responsive', 1);
      deterministicToolTasks++;
      const finalDeterministicQa = add({
        title: 'Final cross-phase deterministic UI, Contrast, A11y & WebGL verification',
        description: `Run localhost_inspect_responsive and localhost_audit_visual_a11y across all blueprint routes [${blueprint.routes.join(', ')}] in enabled color scheme(s) (${blueprint.themePolicy.mode}). Zero subagents spawned if all checks PASS; targeted repair subagent spawned only on defects.`,
        ownerRole: 'responsive-qa-agent',
        skillIds: finalQaProfile.skillIds,
        primarySkill: finalQaProfile.primarySkill,
        executionMode: 'tool',
        modelTier: 'fast',
        moduleIds: [9, 15, 17, 18, 42, 43, 63],
        domains: ['responsive', 'design', ...(hasThreeJs ? ['threejs'] as WorkDomain[] : [])],
        dependsOn: allPhaseGates,
        parallelGroup: 'final-assurance',
        requiredEvidence: true,
        recommendedPaths: ['evidence/final-qa'],
        phaseId: 'final-assurance',
        phaseName: 'Final Assurance & Gate',
        phaseOrder: sortedPhases.length,
        requirementIds: blueprint.requirements.map(r => r.id)
      });
      finalGateDeps.push(finalDeterministicQa);
    }

    if (hasSecurityOrBackend) {
      const secProfile = selectTaskEffortProfile('security-audit', 'security', 1);
      secProfile.skillIds.forEach(s => usedSkills.add(s));
      const secTask = add({
        title: 'Targeted security, auth & boundary verification',
        description: 'Verify input validation, secret hygiene (no hardcoded keys), auth boundaries, and dependency safety.',
        ownerRole: 'security-qa-agent',
        skillIds: secProfile.skillIds,
        primarySkill: secProfile.primarySkill,
        executionMode: 'subagent',
        modelTier: 'deep',
        moduleIds: [7, 8, 29, 37, 38, 45, 59],
        domains: ['security'],
        dependsOn: allPhaseGates,
        parallelGroup: 'final-assurance',
        requiredEvidence: true,
        recommendedPaths: ['evidence/security'],
        phaseId: 'final-assurance',
        phaseName: 'Final Assurance & Gate',
        phaseOrder: sortedPhases.length,
        requirementIds: blueprint.requirements.filter(r => r.domains.includes('security') || r.domains.includes('backend')).map(r => r.id)
      });
      finalGateDeps.push(secTask);
    }

    const releaseProfile = selectTaskEffortProfile('release', 'release', 1);
    releaseProfile.skillIds.forEach(s => usedSkills.add(s));
    const releaseTask = add({
      title: 'Evaluate quality gate & prepare release handoff packet',
      description: 'Verify REQ-ID traceability matrix, evaluate all quality checkpoints, and prepare release handoff without deploying automatically.',
      ownerRole: 'release-lead',
      skillIds: releaseProfile.skillIds,
      primarySkill: releaseProfile.primarySkill,
      executionMode: 'inline',
      modelTier: 'fast',
      moduleIds: [10, 12, 32, 46, 53],
      domains: ['release'],
      dependsOn: finalGateDeps.length ? finalGateDeps : allPhaseGates,
      parallelGroup: null,
      requiredEvidence: true,
      recommendedPaths: ['docs/release'],
      phaseId: 'release',
      phaseName: 'Release Readiness',
      phaseOrder: sortedPhases.length + 1,
      requirementIds: blueprint.requirements.map(r => r.id)
    });

    phaseSummaries.push({
      id: 'final-assurance',
      order: sortedPhases.length,
      name: 'Final Assurance & Release Readiness',
      taskIds: [...finalGateDeps, releaseTask],
      requirementIds: blueprint.requirements.map(r => r.id)
    });

    // Estimate subagents saved: each UI phase + final QA avoids spawning up to 5-6 redundant QA subagents
    const savedByDeterministic = deterministicToolTasks + (hasUi ? 5 : 0);

    const timestamp = now();
    const plan: ExecutionPlan = {
      id: planId,
      title: blueprint.title,
      request: blueprint.summary,
      domains,
      taskIds: tasks.map(t => t.id),
      checkpointIds: QUALITY_DIMENSIONS.filter(item => {
        if (item.id === '3d-rendering') return hasThreeJs;
        if (item.id === 'motion') return hasMotion;
        if (['responsive', 'layout', 'interaction', 'typography-color', 'accessibility'].includes(item.id)) return hasUi;
        return true;
      }).map(item => item.id),
      maxRepairIterations: Math.max(1, Math.min(options.maxRepairIterations ?? this.defaultMaxRepairIterations, 12)),
      repairIterations: 0,
      blueprintId: blueprint.id,
      autonomyMode: options.autonomyMode ?? blueprint.autonomyMode,
      phases: phaseSummaries,
      approvedPhaseIds: [],
      tokenBudget: options.tokenBudget ?? null,
      maxSubagentsPerWave: options.maxSubagentsPerWave ?? 4,
      telemetry: {
        totalPacketTokens: 0,
        subagentsSpawned: 0,
        subagentsSavedByDeterministicTools: savedByDeterministic,
        skillsUsed: [...usedSkills].sort(),
        skillsSkipped: [...routing.skippedSkills, ...routing.deterministicDeferredSkills]
      },
      createdAt: timestamp,
      updatedAt: timestamp
    };

    assertAcyclicDependencyGraph(tasks);
    return { plan, tasks };
  }
}
