import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { developmentVersion } from './dev-version.mjs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const id = createHash('sha256').update(root.toLowerCase()).digest('hex').slice(0, 12);
const directory = join(tmpdir(), `pomo-restbank-dev-${id}`);
// Isolate the entire application root too: first-launch import discovery must
// never inspect the user's normal server data during development.
const appData = join(directory, 'appdata');
await mkdir(appData, { recursive: true });
const baseConfig = JSON.parse(await readFile(join(root, 'desktop/src-tauri/tauri.conf.json'), 'utf8'));
const devConfig = JSON.parse(await readFile(join(root, 'desktop/src-tauri/tauri.dev.conf.json'), 'utf8'));
const version = developmentVersion(root, baseConfig.version);
const configPath = join(directory, 'tauri.dev.version.json');
await writeFile(configPath, JSON.stringify({ ...devConfig, version }, null, 2));
const env = {
  ...process.env,
  LOCALAPPDATA: appData,
  CARGO_TARGET_DIR: join(directory, 'target'),
  POMO_RESTBANK_DEV: '1',
};
console.log(`Development version: ${version}`);
console.log(`Development data: ${join(directory, 'data')}`);
console.log(`Development build cache: ${env.CARGO_TARGET_DIR}`);
const result = spawnSync(process.execPath, [
  join(root, 'desktop/node_modules/@tauri-apps/cli/tauri.js'),
  'dev', '--config', configPath,
  '--', '--', '--backend', 'local', '--data-dir', join(directory, 'data'),
], { cwd: join(root, 'desktop'), env, stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
