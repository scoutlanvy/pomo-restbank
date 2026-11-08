import { mkdtemp, mkdir, copyFile, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { createConnection } from 'node:net';
const build = resolve(process.argv[2]);
const root = await mkdtemp(join(tmpdir(), 'pomo-launcher-smoke-'));
const bin = join(root, 'bin'); await mkdir(bin);
const env = { ...process.env, LOCALAPPDATA: join(root, 'data'), POMO_SMOKE_BIN: bin };
const checks = [];
const pause = ms => new Promise(r => setTimeout(r, ms));
async function until(fn) { const end=Date.now()+20000; while(Date.now()<end) { if(await fn()) return; await pause(200); } throw Error('Timeout'); }
function processes() {
  const output = execFileSync('powershell.exe', ['-NoProfile','-Command', "@(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and (Split-Path -Parent $_.ExecutablePath) -eq $env:POMO_SMOKE_BIN } | Select-Object ProcessId,Name,CommandLine) | ConvertTo-Json -Compress"], { env, encoding:'utf8', windowsHide:true }).trim();
  return output ? [JSON.parse(output)].flat() : [];
}
async function launch(args) {
  const child=spawn(join(bin,'PomoRestbank-Launcher.exe'),args,{env,windowsHide:true,stdio:'ignore'});
  const timer=setTimeout(()=>child.kill(),20000);
  const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',resolve)}).finally(()=>clearTimeout(timer));
  assert.equal(code,0);
}
try {
  for(const port of [4317,4318]) {
    const live=await new Promise((resolve, reject) => {
      const socket=createConnection({host:'127.0.0.1',port});
      socket.setTimeout(1000);
      socket.once('connect',()=>{socket.destroy();resolve(true)});
      socket.once('timeout',()=>{socket.destroy();reject(Error(`Cannot establish whether port ${port} is free`))});
      socket.once('error',error=>{socket.destroy();if(error.code==='ECONNREFUSED')resolve(false);else reject(error)});
    });
    assert.equal(live,false,`Port ${port} already occupied; refusing to use existing server`);
  }
  for(const name of ['PomoRestbank-Launcher.exe','pomo-restbank.exe','pomo-restbank-server.exe']) await copyFile(join(build,name),join(bin,name));
  for(const preview of [false,true]) {
    const options=preview?['--preview']:[];
    const parent=join(env.LOCALAPPDATA,'PomoRestbank');
    const config=join(parent,preview?'preview-clients':'clients','first','connection.json');
    await launch([...options,'--profile','first']);
    const original=await readFile(config,'utf8'); const parsed=JSON.parse(original);
    const token=await readFile(join(parent,preview?'preview-server':'server','token.txt'),'utf8');
    assert.equal(parsed.token,token.trim());
    assert.equal(parsed.endpoint,`ws://127.0.0.1:${preview?4318:4317}/v1/ws`);
    await until(async()=>processes().some(p=>p.Name==='pomo-restbank.exe'));
    const serversBefore=processes().filter(p=>p.Name==='pomo-restbank-server.exe').length;
    await launch([...options,'--profile','second']);
    assert.equal(processes().filter(p=>p.Name==='pomo-restbank-server.exe').length,serversBefore);
    // Stop only clients launched from the task's copied executable directory.
    for(const p of processes().filter(p=>p.Name==='pomo-restbank.exe')) process.kill(p.ProcessId);
    await pause(1200);
    await launch([...options,'--profile','first']);
    assert.equal(await readFile(config,'utf8'),original);
    checks.push(`${preview?'Preview':'Normal'}: server start/reuse, token, profile isolation, preserved configuration, client spawn`);
    for(const p of processes().filter(p=>p.Name==='pomo-restbank.exe')) process.kill(p.ProcessId);
    await pause(1000);
  }
  await writeFile(join(build,'launcher-smoke-report.json'),JSON.stringify({checks},null,2));
  console.log(JSON.stringify({checks},null,2));
} finally {
  for(const p of processes()) { try {process.kill(p.ProcessId)} catch {} }
  await pause(1500);
  await rm(root,{recursive:true,force:true});
}
