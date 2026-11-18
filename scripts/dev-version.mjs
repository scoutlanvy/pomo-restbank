import { spawnSync } from 'node:child_process';

export function developmentVersion(root, fallback) {
  const result = spawnSync('git', ['tag', '--merged', 'HEAD', '--sort=-version:refname'], {
    cwd: root, encoding: 'utf8', windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Cannot read development tags: ${result.stderr.trim()}`);
  const tag = result.stdout.trim().split(/\r?\n/).find((value) =>
    /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)
    && value.slice(1).split('.').every((part) => Number(part) <= 65535),
  );
  return `${tag ? tag.slice(1) : fallback}-dev`;
}
