import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, join } from 'node:path';
import { releasePaths } from './release-paths.mjs';

test('releases keep separate outputs and reuse a repository-specific cache', () => {
  const root = resolve('release-path-fixture');
  const first = releasePaths(root, 'v0.3.0');
  const next = releasePaths(root, 'v0.4.0');
  assert.equal(first.output, join(root, 'dist', 'v0.3.0'));
  assert.equal(next.output, join(root, 'dist', 'v0.4.0'));
  assert.equal(first.target, next.target);
  assert.notEqual(first.target, releasePaths(resolve('other-fixture'), 'v0.3.0').target);
});

test('explicit output and Cargo cache paths retain their exact meaning', () => {
  const paths = releasePaths(resolve('fixture'), 'v0.4.0', 'custom-output', 'custom-cache');
  assert.equal(paths.output, resolve('custom-output'));
  assert.equal(paths.target, resolve('custom-cache'));
});
