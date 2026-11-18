import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export function releasePaths(root, tag, outputOverride, targetOverride) {
  const id = createHash('sha256').update(resolve(root).toLowerCase()).digest('hex').slice(0, 12);
  return {
    output: resolve(outputOverride ?? join(root, 'dist', tag)),
    target: targetOverride
      ? resolve(targetOverride)
      : join(tmpdir(), `pomo-restbank-release-cache-${id}`),
  };
}
