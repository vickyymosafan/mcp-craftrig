import { ValidationError } from './errors.js';

export interface DagNodeLike {
  id: string;
  dependsOn: readonly string[];
  title?: string;
}

/**
 * Asserts that the given task dependency graph is strictly acyclic using Kahn's algorithm.
 * Throws ValidationError if any circular dependency or self-dependency is detected.
 */
export function assertAcyclicDependencyGraph(nodes: readonly DagNodeLike[]): void {
  const nodeMap = new Map<string, DagNodeLike>();
  for (const node of nodes) {
    if (node.dependsOn.includes(node.id)) {
      throw new ValidationError(`Self-referencing dependency detected on task "${node.title ?? node.id}".`);
    }
    nodeMap.set(node.id, node);
  }

  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();

  for (const node of nodes) {
    inDegree.set(node.id, 0);
    dependents.set(node.id, []);
  }

  for (const node of nodes) {
    for (const depId of node.dependsOn) {
      if (nodeMap.has(depId)) {
        inDegree.set(node.id, (inDegree.get(node.id) ?? 0) + 1);
        dependents.get(depId)!.push(node.id);
      }
    }
  }

  const queue: string[] = [];
  for (const [id, deg] of inDegree.entries()) {
    if (deg === 0) {
      queue.push(id);
    }
  }

  let visitedCount = 0;
  while (queue.length > 0) {
    const currentId = queue.shift()!;
    visitedCount++;

    const nextNodes = dependents.get(currentId) ?? [];
    for (const nextId of nextNodes) {
      const currentDeg = inDegree.get(nextId)! - 1;
      inDegree.set(nextId, currentDeg);
      if (currentDeg === 0) {
        queue.push(nextId);
      }
    }
  }

  if (visitedCount < nodes.length) {
    const cycleNodes = nodes
      .filter(n => (inDegree.get(n.id) ?? 0) > 0)
      .map(n => `"${n.title ?? n.id}"`);
    throw new ValidationError(
      `Circular dependency deadlock detected in task graph among nodes: ${cycleNodes.join(', ')}.`
    );
  }
}
