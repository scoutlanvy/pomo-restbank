import { spawnSync } from 'node:child_process';

// Use only a tag on HEAD: the nearest older tag must never label newer code.
export function releaseVersion(root) {
  const result = spawnSync('git', ['tag', '--points-at', 'HEAD'], {
    cwd: root, encoding: 'utf8', windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Cannot read release tags: ${result.stderr.trim()}`);
  const tags = result.stdout.trim().split(/\r?\n/).filter(tag => /^v\d/.test(tag));
  if (tags.length !== 1) {
    throw new Error('Release requires exactly one version tag on HEAD (for example v0.2.0). Commit your changes, create the tag, then run release again.');
  }
  const tag = tags[0];
  if (!/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag)
      || tag.slice(1).split('.').some(part => Number(part) > 65535)) {
    throw new Error(`Unsupported release tag ${tag}. Use vMAJOR.MINOR.PATCH with each number between 0 and 65535 (no prerelease suffix).`);
  }
  return { tag, version: tag.slice(1) };
}
