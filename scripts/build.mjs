import { spawnSync } from 'node:child_process';
import { readFile, writeFile, mkdir, readdir, copyFile, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { releaseVersion } from './release-version.mjs';
import { releasePaths } from './release-paths.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { tag, version } = releaseVersion(root);
console.log(`Release version: ${version} (Git tag ${tag})`);
const { output, target } = releasePaths(root, tag, process.argv[2], process.env.CARGO_TARGET_DIR);
console.log(`Release destination: ${output}\nReusable build cache: ${target}`);
const env = { ...process.env, CARGO_TARGET_DIR: target };
const npmCli = process.env.npm_execpath ?? join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
function run(program, args, cwd = root) {
  const result = program === 'npm'
    ? spawnSync(process.execPath, [npmCli, ...args], { cwd, env, stdio: 'inherit' })
    : spawnSync(program, args, { cwd, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${program} failed (${result.status})`);
}
const hash = data => createHash('sha256').update(data).digest('hex');
async function copy(source, name, directory = output) {
  const destination = join(directory, name);
  const data = await readFile(source);
  const existing = await readFile(destination).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (existing && hash(existing) === hash(data)) return;
  try { await copyFile(source, destination); }
  catch (error) { throw new Error(`Cannot replace ${destination}. Close the application using this exact file and retry. No process was stopped.`, { cause: error }); }
}
// ZIP with stored entries: no external archiver or runtime dependency.
function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
async function zip(names, sourceDirectory, destination) {
  const entries = [], directory = []; let offset = 0;
  for (const name of names) {
    const data = await readFile(join(sourceDirectory, name)), filename = Buffer.from(name), crc = crc32(data);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(33, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(filename.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(33, 14);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(filename.length, 28); central.writeUInt32LE(offset, 42);
    entries.push(local, filename, data); directory.push(central, filename); offset += local.length + filename.length + data.length;
  }
  const central = Buffer.concat(directory), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(names.length, 8); end.writeUInt16LE(names.length, 10); end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
  await writeFile(destination, Buffer.concat([...entries, central, end]));
}
run('npm', ['--prefix', 'desktop', 'run', 'build']);
run('cargo', ['build', '--release', '-p', 'pomo-restbank-server', '--bins']);
// Tauri merges this overlay without changing tracked development manifests.
const versionConfig = join(target, 'restbank-release-version.json');
await mkdir(target, { recursive: true });
await writeFile(versionConfig, JSON.stringify({ version }));
run('npm', ['run', 'tauri', '--', 'build', '--config', resolve(versionConfig)], join(root, 'desktop'));
await mkdir(output, { recursive: true });
const staging = join(target, 'portable-staging', tag);
await mkdir(staging, { recursive: true });
const executables = ['pomo-restbank.exe', 'pomo-restbank-server.exe', 'PomoRestbank-Launcher.exe'];
for (const name of executables) await copy(join(target, 'release', name), name, staging);
const installers = (await readdir(join(target, 'release', 'bundle', 'nsis'))).filter(name => name === `Pomo Restbank_${version}_x64-setup.exe`);
if (installers.length !== 1) throw new Error(`Expected NSIS installer for release ${version}; refusing to package a stale installer.`);
const installer = `Pomo-Restbank-${version}-setup.exe`;
await copy(join(target, 'release', 'bundle', 'nsis', installers[0]), installer);
const documents = [
  ['README.id.md', 'PETUNJUK.md'],
  ['LICENSE', 'LICENSE'],
  ['VALIDATION.md', 'VALIDATION.md'],
];
for (const [source, name] of documents) {
  await copy(join(root, source), name, staging);
}
const archive = `Pomo-Restbank-${version}-portable.zip`;
await zip([...executables, ...documents.map(([, name]) => name)], staging, join(output, archive));
const checksums = [];
for (const name of [installer, archive]) {
  checksums.push(`${hash(await readFile(join(output, name)))}  ${name}`);
}
await writeFile(join(output, 'SHA256SUMS.txt'), checksums.join('\n') + '\n');
// Remove only files produced by the previous packaging layout for this version.
const legacyFiles = [
  ...executables,
  ...documents.map(([, name]) => name),
  ...installers,
  `Pomo-Restbank-${version}-windows-x64.zip`,
];
for (const name of legacyFiles) {
  await unlink(join(output, name)).catch(error => {
    if (error.code !== 'ENOENT') throw error;
  });
}
console.log(`Release files: ${output}\nBuild artifacts: ${target}`);
