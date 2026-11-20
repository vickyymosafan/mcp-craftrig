import { ValidationError } from './errors.js';

export interface DagNodeLike {
  id: string;
  dependsOn: readonly string[];
  title?: string;
}

export interface DagDownstreamMetric {
  transitiveCount: number;
  maxDepth: number;
  directDependents: string[];
}

/**
 * Computes downstream metrics (transitive dependent count, max path depth to exit, direct dependents)
 * for each node in a directed task graph using Kahn's topological sort and reverse topological dynamic programming.
 * Throws ValidationError if any circular dependency or self-dependency is detected.
 */
export function computeDownstreamMetrics(nodes: readonly DagNodeLike[]): Map<string, DagDownstreamMetric> {
  const nodeMap = new Map<string, DagNodeLike>();
  for (const node of nodes) {
    if (node.dependsOn.includes(node.id)) {
      throw new ValidationError(`Self-referencing dependency detected on task "${node.title ?? node.id}".`);
    }
    nodeMap.set(node.id, node);
  }

  const inDegree = new Map<string, number>();
  const directDependents = new Map<string, string[]>();

  for (const node of nodes) {
    inDegree.set(node.id, 0);
    directDependents.set(node.id, []);
  }

  for (const node of nodes) {
    for (const depId of node.dependsOn) {
      if (nodeMap.has(depId)) {
        inDegree.set(node.id, (inDegree.get(node.id) ?? 0) + 1);
        directDependents.get(depId)!.push(node.id);
      }
    }
  }

  const queue: string[] = [];
  for (const [id, deg] of inDegree.entries()) {
    if (deg === 0) {
      queue.push(id);
    }
  }

  const topoOrder: string[] = [];
  while (queue.length > 0) {
    const currentId = queue.shift()!;
    topoOrder.push(currentId);

    const nextNodes = directDependents.get(currentId) ?? [];
    for (const nextId of nextNodes) {
      const currentDeg = inDegree.get(nextId)! - 1;
      inDegree.set(nextId, currentDeg);
      if (currentDeg === 0) {
        queue.push(nextId);
      }
    }
  }

  if (topoOrder.length < nodes.length) {
    const cycleNodes = nodes
      .filter(n => (inDegree.get(n.id) ?? 0) > 0)
      .map(n => `"${n.title ?? n.id}"`);
    throw new ValidationError(
      `Circular dependency deadlock detected in task graph among nodes: ${cycleNodes.join(', ')}.`
    );
  }

  const metrics = new Map<string, DagDownstreamMetric>();
  const transitiveSets = new Map<string, Set<string>>();

  for (let i = topoOrder.length - 1; i >= 0; i--) {
    const id = topoOrder[i]!;
    const deps = directDependents.get(id) ?? [];
    const transSet = new Set<string>();
    let maxDepth = 0;

    for (const dep of deps) {
      transSet.add(dep);
      const childTrans = transitiveSets.get(dep);
      if (childTrans) {
        for (const item of childTrans) transSet.add(item);
      }
      const childMetric = metrics.get(dep);
      const childDepth = childMetric ? childMetric.maxDepth + 1 : 1;
      if (childDepth > maxDepth) maxDepth = childDepth;
    }

    transitiveSets.set(id, transSet);
    metrics.set(id, {
      transitiveCount: transSet.size,
      maxDepth,
      directDependents: deps
    });
  }

  return metrics;
}

/**
 * Asserts that the given task dependency graph is strictly acyclic using Kahn's algorithm.
 * Throws ValidationError if any circular dependency or self-dependency is detected.
 */
export function assertAcyclicDependencyGraph(nodes: readonly DagNodeLike[]): void {
  computeDownstreamMetrics(nodes);
}
