import test from 'node:test';
import assert from 'node:assert/strict';
import {
  toClaimTaskInput,
  toCreatePlanInput,
  toInteractionActions,
  toListFileLocksFilter,
  toReleaseFileLocksInput
} from '../src/interfaces/mcp/input-normalizers.js';

test('create plan normalizer omits undefined optional properties', () => {
  const normalized = toCreatePlanInput({
    title: 'Responsive portfolio',
    request: 'Build a responsive portfolio website',
    domains: undefined,
    maxRepairIterations: undefined
  });

  assert.deepEqual(normalized, {
    title: 'Responsive portfolio',
    request: 'Build a responsive portfolio website'
  });
  assert.equal('domains' in normalized, false);
  assert.equal('maxRepairIterations' in normalized, false);
});

test('create plan normalizer preserves provided optional properties', () => {
  const normalized = toCreatePlanInput({
    title: '3D portfolio',
    request: 'Build a Three.js portfolio',
    domains: ['frontend', 'threejs'],
    maxRepairIterations: 7
  });

  assert.deepEqual(normalized.domains, ['frontend', 'threejs']);
  assert.equal(normalized.maxRepairIterations, 7);
});

test('interaction normalizer omits undefined optional action properties', () => {
  const normalized = toInteractionActions([
    { action: 'click', selector: '[data-testid="open-menu"]', value: undefined, timeoutMs: undefined }
  ]);

  assert.deepEqual(normalized, [
    { action: 'click', selector: '[data-testid="open-menu"]' }
  ]);
  assert.equal('value' in normalized[0]!, false);
  assert.equal('timeoutMs' in normalized[0]!, false);
});

test('interaction normalizer preserves provided action properties', () => {
  const normalized = toInteractionActions([
    { action: 'fill', selector: '#email', value: 'qa@example.test', timeoutMs: 5000 },
    { action: 'press', selector: '#email', value: 'Enter' }
  ]);

  assert.deepEqual(normalized, [
    { action: 'fill', selector: '#email', value: 'qa@example.test', timeoutMs: 5000 },
    { action: 'press', selector: '#email', value: 'Enter' }
  ]);
});

test('claim and file lock normalizers omit undefined optional properties', () => {
  const claim = toClaimTaskInput({ taskId: 't1', agentId: 'a1', ownedPaths: undefined });
  assert.equal('ownedPaths' in claim, false);
  assert.deepEqual(toClaimTaskInput({ taskId: 't1', agentId: 'a1', ownedPaths: ['src/a.ts'] }).ownedPaths, ['src/a.ts']);

  const release = toReleaseFileLocksInput({ taskId: 't1', agentId: 'a1', paths: undefined });
  assert.equal('paths' in release, false);
  assert.deepEqual(toReleaseFileLocksInput({ taskId: 't1', agentId: 'a1', paths: ['src/a.ts'] }).paths, ['src/a.ts']);

  const filter = toListFileLocksFilter({ planId: undefined, taskId: undefined, path: 'src/a.ts' });
  assert.equal('planId' in filter, false);
  assert.equal('taskId' in filter, false);
  assert.equal(filter.path, 'src/a.ts');
});
