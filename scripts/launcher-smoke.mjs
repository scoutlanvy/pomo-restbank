import { mkdtemp, mkdir, copyFile, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { createConnection, createServer } from 'node:net';
import {createRequire} from 'node:module';
const require=createRequire(new URL('../desktop/package.json',import.meta.url));
const {chromium}=require('@playwright/test');
const build = resolve(process.argv[2]);
const root = await mkdtemp(join(tmpdir(), 'pomo-launcher-smoke-'));
const bin = join(root, 'bin'); await mkdir(bin);
const env = { ...process.env, LOCALAPPDATA: join(root, 'data'), POMO_SMOKE_BIN: bin };
const checks = [], skipped = [];
const pause = ms => new Promise(r => setTimeout(r, ms));
async function until(fn) { const end=Date.now()+20000; while(Date.now()<end) { if(await fn()) return; await pause(200); } throw Error('Timeout'); }
function processes() {
  const output = execFileSync('powershell.exe', ['-NoProfile','-Command', "@(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and (Split-Path -Parent $_.ExecutablePath) -eq $env:POMO_SMOKE_BIN } | Select-Object ProcessId,Name,CommandLine) | ConvertTo-Json -Compress"], { env, encoding:'utf8', windowsHide:true }).trim();
  return output ? [JSON.parse(output)].flat() : [];
}
async function launch(args, extraEnv={}) {
  const child=spawn(join(bin,'PomoRestbank-Launcher.exe'),args,{env:{...env,...extraEnv},windowsHide:true,stdio:'ignore'});
  const timer=setTimeout(()=>child.kill(),20000);
  const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',resolve)}).finally(()=>clearTimeout(timer));
  assert.equal(code,0);
}
try {
  for(const name of ['PomoRestbank-Launcher.exe','pomo-restbank.exe']) await copyFile(join(build,name),join(bin,name));
  const debugServer=createServer();await new Promise(r=>debugServer.listen(0,'127.0.0.1',r));const debug=debugServer.address().port;await new Promise(r=>debugServer.close(r));
  await launch([], {WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:`--remote-debugging-port=${debug}`});
  await until(async()=>{try{return (await fetch(`http://127.0.0.1:${debug}/json/version`)).ok}catch{return false}});
  const browser=await chromium.connectOverCDP(`http://127.0.0.1:${debug}`);
  const page=browser.contexts()[0].pages()[0];await page.waitForSelector('#primary');
  const local=await page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('get_view'));
  assert.equal(local.backend,'local');assert.equal(local.connection,'connected');
  assert.equal(processes().filter(p=>p.Name==='pomo-restbank-server.exe').length,0);
  await page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('quit_application')).catch(()=>{});
  await until(async()=>!processes().some(p=>p.Name==='pomo-restbank.exe'));
  await browser.close();checks.push('Default Local launcher works without any server executable, token, or server process');
  await copyFile(join(build,'pomo-restbank-server.exe'),join(bin,'pomo-restbank-server.exe'));

  for(const preview of [false,true]) {
    const serverPort=preview?4318:4317;
    const occupied=await new Promise((resolve,reject)=>{const socket=createConnection({host:'127.0.0.1',port:serverPort});socket.setTimeout(1000);socket.once('connect',()=>{socket.destroy();resolve(true)});socket.once('error',error=>{socket.destroy();if(error.code==='ECONNREFUSED')resolve(false);else reject(error)});socket.once('timeout',()=>{socket.destroy();reject(Error('Cannot verify server port'))});});
    if(occupied){skipped.push(`Server launcher port ${serverPort} is occupied; no existing process or data was used`);continue;}

    const options=preview?['--backend','server','--preview']:['--backend','server'];
    const parent=join(env.LOCALAPPDATA,'PomoRestbank');
    for(const profile of ['first','second']) {
      const directory=join(parent,preview?'preview-clients':'clients',profile);await mkdir(directory,{recursive:true});
      await writeFile(join(directory,'application.json'),JSON.stringify({backend:'server',close_behavior:'quit'}));
    }
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
    execFileSync('powershell.exe',['-NoProfile','-Command',"Get-Process | Where-Object { $_.Path -and (Split-Path -Parent $_.Path) -eq $env:POMO_SMOKE_BIN -and $_.ProcessName -eq 'pomo-restbank' } | ForEach-Object { $_.CloseMainWindow() | Out-Null }"],{env,windowsHide:true});
    await until(async()=>!processes().some(p=>p.Name==='pomo-restbank.exe'));
    await pause(1200);
    await launch([...options,'--profile','first']);
    assert.equal(await readFile(config,'utf8'),original);
    checks.push(`${preview?'Preview':'Normal'}: server start/reuse, token, profile isolation, preserved configuration, client spawn`);
    execFileSync('powershell.exe',['-NoProfile','-Command',"Get-Process | Where-Object { $_.Path -and (Split-Path -Parent $_.Path) -eq $env:POMO_SMOKE_BIN -and $_.ProcessName -eq 'pomo-restbank' } | ForEach-Object { $_.CloseMainWindow() | Out-Null }"],{env,windowsHide:true});
    await until(async()=>!processes().some(p=>p.Name==='pomo-restbank.exe'));
    await pause(1000);
  }
  await writeFile(join(build,'launcher-smoke-report.json'),JSON.stringify({checks,skipped},null,2));
  console.log(JSON.stringify({checks,skipped},null,2));
} finally {
  for(const p of processes()) { try {process.kill(p.ProcessId)} catch {} }
  await pause(1500);
  await rm(root,{recursive:true,force:true});
}
