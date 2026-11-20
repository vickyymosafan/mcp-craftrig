import test from 'node:test';
import assert from 'node:assert/strict';
import { assertAcyclicDependencyGraph, type DagNodeLike } from '../src/domain/dag-validator.js';

test('assertAcyclicDependencyGraph accepts valid linear and diamond DAGs', () => {
  const linear: DagNodeLike[] = [
    { id: '1', dependsOn: [], title: 'Discovery' },
    { id: '2', dependsOn: ['1'], title: 'Architecture' },
    { id: '3', dependsOn: ['2'], title: 'Implementation' }
  ];
  assert.doesNotThrow(() => assertAcyclicDependencyGraph(linear));

  const diamond: DagNodeLike[] = [
    { id: 'start', dependsOn: [] },
    { id: 'branch-a', dependsOn: ['start'] },
    { id: 'branch-b', dependsOn: ['start'] },
    { id: 'join', dependsOn: ['branch-a', 'branch-b'] }
  ];
  assert.doesNotThrow(() => assertAcyclicDependencyGraph(diamond));
});

test('assertAcyclicDependencyGraph rejects self-referencing dependency', () => {
  const selfCycle: DagNodeLike[] = [
    { id: 'task-1', dependsOn: ['task-1'], title: 'Self looping task' }
  ];
  assert.throws(
    () => assertAcyclicDependencyGraph(selfCycle),
    /Self-referencing dependency detected on task "Self looping task"/i
  );
});

test('assertAcyclicDependencyGraph rejects circular dependency deadlocks with Kahn algorithm', () => {
  const circular: DagNodeLike[] = [
    { id: 'A', dependsOn: ['B'], title: 'Task A' },
    { id: 'B', dependsOn: ['A'], title: 'Task B' }
  ];
  assert.throws(
    () => assertAcyclicDependencyGraph(circular),
    /Circular dependency deadlock detected in task graph among nodes: "Task A", "Task B"/i
  );

  const threeNodeCycle: DagNodeLike[] = [
    { id: 'A', dependsOn: ['C'], title: 'Node A' },
    { id: 'B', dependsOn: ['A'], title: 'Node B' },
    { id: 'C', dependsOn: ['B'], title: 'Node C' },
    { id: 'D', dependsOn: ['A'], title: 'Node D' }
  ];
  assert.throws(
    () => assertAcyclicDependencyGraph(threeNodeCycle),
    /Circular dependency deadlock detected in task graph/i
  );
});
