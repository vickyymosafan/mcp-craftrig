import type {
  ExecutionMode,
  ModelTier,
  ProjectBlueprint
} from '../domain/blueprint.js';
import type { WorkDomain } from '../domain/models.js';

export interface SkillRoutingRule {
  skill: string;
  domains: WorkDomain[];
  pattern?: RegExp;
  alwaysIfUi?: boolean;
  deterministicOnlyUnlessFailure?: boolean;
  reasonWhenSkipped: string;
}

export const SKILL_ROUTING_RULES: readonly SkillRoutingRule[] = [
  {
    skill: 'repository-discovery',
    domains: ['frontend', 'backend', 'design', 'data', 'security'],
    reasonWhenSkipped: 'Skipped because workspace context was already pre-filled or not needed for this task.'
  },
  {
    skill: 'clean-architecture-development',
    domains: ['frontend', 'backend', 'data', 'security'],
    reasonWhenSkipped: 'Skipped because no architectural boundary or domain layer changes are scoped.'
  },
  {
    skill: 'design-direction',
    domains: ['design', 'frontend'],
    alwaysIfUi: true,
    reasonWhenSkipped: 'Skipped because blueprint has no UI/visual design surface.'
  },
  {
    skill: 'design-systems-governance',
    domains: ['design', 'frontend'],
    alwaysIfUi: true,
    reasonWhenSkipped: 'Skipped because blueprint has no reusable UI component/token surface.'
  },
  {
    skill: 'color-theming',
    domains: ['design', 'frontend'],
    alwaysIfUi: true,
    reasonWhenSkipped: 'Skipped because blueprint has no visual theme or color surface.'
  },
  {
    skill: 'typography-engineering',
    domains: ['design', 'frontend'],
    alwaysIfUi: true,
    reasonWhenSkipped: 'Skipped because blueprint has no UI typography surface.'
  },
  {
    skill: 'frontend-implementation',
    domains: ['frontend', 'design', 'responsive'],
    alwaysIfUi: true,
    reasonWhenSkipped: 'Skipped because blueprint has no frontend UI workstream.'
  },
  {
    skill: 'backend-implementation',
    domains: ['backend', 'data'],
    pattern: /backend|api|server|endpoint|database|prisma|drizzle|sql|auth|webhook|payment/i,
    reasonWhenSkipped: 'Skipped because blueprint specifies no backend API, database, or server logic.'
  },
  {
    skill: 'threejs-shaders',
    domains: ['threejs'],
    pattern: /three\.?js|3d|webgl|shader|glsl|r3f|showroom|mesh|scene/i,
    reasonWhenSkipped: 'Skipped because blueprint has no 3D, WebGL, or Three.js requirements.'
  },
  {
    skill: 'motion-animation',
    domains: ['motion'],
    pattern: /motion|animation|framer|gsap|lenis|parallax|scroll effect|micro-interaction/i,
    reasonWhenSkipped: 'Skipped because blueprint has no custom motion or animation requirements.'
  },
  {
    skill: 'security-review',
    domains: ['security', 'backend', 'data'],
    pattern: /auth|login|oauth|jwt|payment|stripe|midtrans|checkout|rbac|permission|privacy|api|database|form/i,
    reasonWhenSkipped: 'Skipped deep security subagent because blueprint is static/read-only without auth, payments, or backend.'
  },
  {
    skill: 'local-development-runtime',
    domains: ['frontend', 'backend', 'responsive'],
    alwaysIfUi: true,
    reasonWhenSkipped: 'Skipped because no local dev server verification is required.'
  },
  {
    skill: 'responsive-first-browser-qa',
    domains: ['responsive', 'frontend'],
    alwaysIfUi: true,
    deterministicOnlyUnlessFailure: true,
    reasonWhenSkipped: 'Handled by deterministic localhost_inspect_responsive (0 LLM tokens); subagent spawned only on defect.'
  },
  {
    skill: 'ui-layout-repair',
    domains: ['design', 'frontend'],
    alwaysIfUi: true,
    deterministicOnlyUnlessFailure: true,
    reasonWhenSkipped: 'Deferred until deterministic browser audit reports layout/overflow defects.'
  },
  {
    skill: 'interaction-functional-qa',
    domains: ['frontend'],
    alwaysIfUi: true,
    deterministicOnlyUnlessFailure: true,
    reasonWhenSkipped: 'Handled by deterministic localhost_run_interaction_scenario (0 LLM tokens); subagent spawned only on defect.'
  },
  {
    skill: 'accessibility-qa',
    domains: ['frontend', 'design'],
    alwaysIfUi: true,
    deterministicOnlyUnlessFailure: true,
    reasonWhenSkipped: 'Handled by deterministic localhost_audit_visual_a11y (0 LLM tokens); subagent spawned only on contrast/axe violation.'
  },
  {
    skill: 'performance-qa',
    domains: ['frontend', 'threejs', 'motion'],
    alwaysIfUi: true,
    deterministicOnlyUnlessFailure: true,
    reasonWhenSkipped: 'Handled by deterministic CDP metrics & build checks; subagent spawned only if budgets fail.'
  },
  {
    skill: 'evidence-and-release-governance',
    domains: ['release'],
    reasonWhenSkipped: 'Handled by deterministic quality gate evaluation.'
  }
];

export interface BlueprintSkillRoutingResult {
  activeSkills: string[];
  deterministicDeferredSkills: Array<{ skill: string; reason: string }>;
  skippedSkills: Array<{ skill: string; reason: string }>;
}

export function routeSkillsForBlueprint(blueprint: ProjectBlueprint): BlueprintSkillRoutingResult {
  const domains = new Set<WorkDomain>(blueprint.domains);
  const hasUi = ['frontend', 'design', 'responsive', 'threejs', 'motion'].some(d => domains.has(d as WorkDomain));
  const corpus = [
    blueprint.title,
    blueprint.summary,
    ...blueprint.phases.flatMap(p => [p.name, p.goal, ...p.features, ...p.acceptanceCriteria]),
    ...blueprint.requirements.map(r => r.title)
  ].join(' ');

  const activeSkills: string[] = [];
  const deterministicDeferredSkills: Array<{ skill: string; reason: string }> = [];
  const skippedSkills: Array<{ skill: string; reason: string }> = [];

  for (const rule of SKILL_ROUTING_RULES) {
    const domainMatch = rule.domains.some(d => domains.has(d));
    const patternMatch = rule.pattern ? rule.pattern.test(corpus) : false;
    const uiMatch = Boolean(rule.alwaysIfUi && hasUi);

    let needed = domainMatch || patternMatch || uiMatch;
    // Strict guards for expensive specialist skills
    if (rule.skill === 'threejs-shaders') {
      needed = domains.has('threejs') || blueprint.stack.threejs || patternMatch;
    } else if (rule.skill === 'motion-animation') {
      needed = domains.has('motion') || blueprint.stack.motion || patternMatch;
    } else if (rule.skill === 'backend-implementation') {
      needed = domains.has('backend') || domains.has('data') || Boolean(blueprint.stack.database) || Boolean(blueprint.stack.auth);
    } else if (rule.skill === 'security-review') {
      needed = domains.has('security') || domains.has('backend') || Boolean(blueprint.stack.auth) || patternMatch;
    }

    if (!needed) {
      skippedSkills.push({ skill: rule.skill, reason: rule.reasonWhenSkipped });
      continue;
    }

    if (rule.deterministicOnlyUnlessFailure) {
      deterministicDeferredSkills.push({ skill: rule.skill, reason: rule.reasonWhenSkipped });
      continue;
    }

    activeSkills.push(rule.skill);
  }

  return { activeSkills, deterministicDeferredSkills, skippedSkills };
}

export interface TaskEffortProfile {
  primarySkill: string;
  skillIds: string[];
  executionMode: ExecutionMode;
  modelTier: ModelTier;
}

export function selectTaskEffortProfile(
  kind: 'foundation' | 'design-contract' | 'feature-implement' | 'phase-verify' | 'final-verify' | 'security-audit' | 'release' | 'repair',
  domain: WorkDomain,
  featureCount = 1
): TaskEffortProfile {
  switch (kind) {
    case 'foundation':
      return {
        primarySkill: 'clean-architecture-development',
        skillIds: ['clean-architecture-development'],
        executionMode: 'subagent',
        modelTier: 'deep'
      };
    case 'design-contract':
      return {
        primarySkill: 'design-systems-governance',
        skillIds: ['design-systems-governance', 'color-theming'],
        executionMode: 'subagent',
        modelTier: 'standard'
      };
    case 'feature-implement': {
      if (domain === 'threejs') {
        return { primarySkill: 'threejs-shaders', skillIds: ['threejs-shaders'], executionMode: 'subagent', modelTier: 'deep' };
      }
      if (domain === 'backend' || domain === 'data') {
        return { primarySkill: 'backend-implementation', skillIds: ['backend-implementation'], executionMode: 'subagent', modelTier: 'standard' };
      }
      if (domain === 'security') {
        return { primarySkill: 'security-review', skillIds: ['security-review'], executionMode: 'subagent', modelTier: 'deep' };
      }
      if (domain === 'motion') {
        return { primarySkill: 'motion-animation', skillIds: ['motion-animation'], executionMode: 'subagent', modelTier: 'standard' };
      }
      return {
        primarySkill: 'frontend-implementation',
        skillIds: ['frontend-implementation'],
        executionMode: featureCount <= 1 ? 'subagent' : 'subagent',
        modelTier: 'standard'
      };
    }
    case 'phase-verify':
      return {
        primarySkill: 'local-development-runtime',
        skillIds: ['local-development-runtime'],
        executionMode: 'tool',
        modelTier: 'fast'
      };
    case 'final-verify':
      return {
        primarySkill: 'responsive-first-browser-qa',
        skillIds: ['responsive-first-browser-qa'],
        executionMode: 'tool',
        modelTier: 'fast'
      };
    case 'security-audit':
      return {
        primarySkill: 'security-review',
        skillIds: ['security-review'],
        executionMode: 'subagent',
        modelTier: 'deep'
      };
    case 'release':
      return {
        primarySkill: 'evidence-and-release-governance',
        skillIds: ['evidence-and-release-governance'],
        executionMode: 'inline',
        modelTier: 'fast'
      };
    case 'repair': {
      const skill =
        domain === 'threejs' ? 'threejs-shaders'
        : domain === 'design' ? 'ui-layout-repair'
        : domain === 'responsive' ? 'responsive-first-browser-qa'
        : domain === 'motion' ? 'motion-animation'
        : domain === 'security' ? 'security-review'
        : domain === 'backend' || domain === 'data' ? 'backend-implementation'
        : 'frontend-implementation';
      return {
        primarySkill: skill,
        skillIds: [skill],
        executionMode: 'subagent',
        modelTier: domain === 'threejs' || domain === 'security' ? 'deep' : 'standard'
      };
    }
  }
}

export function estimateTokens(value: unknown): number {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  return Math.max(1, Math.ceil(serialized.length / 4));
}

export function skillPathFor(skillId: string): string {
  return `.agent/skills/${skillId}/SKILL.md`;
}
