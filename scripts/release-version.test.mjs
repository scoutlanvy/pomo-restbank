import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { releaseVersion } from './release-version.mjs';
import { developmentVersion } from './dev-version.mjs';

test('release versions come only from one supported tag on the current commit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pomo-restbank-version-test-'));
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
  };
  try {
    git('init');
    git('-c', 'user.name=Version Test', '-c', 'user.email=version@example.invalid', 'commit', '--allow-empty', '-m', 'fixture');
    assert.equal(developmentVersion(root, "0.1.0"), "0.1.0-dev");
    assert.throws(() => releaseVersion(root), /exactly one version tag/);
    git('tag', 'unrelated');
    git('tag', 'v0.2.0');
    assert.deepEqual(releaseVersion(root), { tag: 'v0.2.0', version: '0.2.0' });
    assert.equal(developmentVersion(root, '0.1.0'), '0.2.0-dev');
    git('tag', 'v0.3.0');
    assert.equal(developmentVersion(root, '0.1.0'), '0.3.0-dev');
    assert.throws(() => releaseVersion(root), /exactly one version tag/);
    git('tag', '-d', 'v0.3.0');
    git('-c', 'user.name=Version Test', '-c', 'user.email=version@example.invalid', 'commit', '--allow-empty', '-m', 'newer code');
    assert.throws(() => releaseVersion(root), /exactly one version tag/);
    assert.equal(developmentVersion(root, '0.1.0'), '0.2.0-dev');
    for (const tag of ['v01.2.0', 'v0.3.0-beta.1', 'v65536.0.0']) {
      git('tag', tag);
      assert.throws(() => releaseVersion(root), /Unsupported release tag/);
      git('tag', '-d', tag);
    }
    git('-c', 'user.name=Version Test', '-c', 'user.email=version@example.invalid', 'tag', '-a', 'v1.2.3', '-m', 'annotated release');
    assert.deepEqual(releaseVersion(root), { tag: 'v1.2.3', version: '1.2.3' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
