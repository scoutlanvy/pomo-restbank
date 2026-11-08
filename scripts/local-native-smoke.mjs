// Real Windows Local-mode integration. All databases, credentials and windows belong to this task.
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
const require = createRequire(new URL('../desktop/package.json', import.meta.url));
const { chromium } = require('@playwright/test');
const index = process.argv.indexOf('--build-dir');
assert(index >= 0, 'Pass --build-dir PATH');
const build = resolve(process.argv[index + 1]);
const root = await mkdtemp(join(tmpdir(), 'pomo-local-native-'));
const applicationData = join(root, 'appdata');
const source = join(applicationData, 'PomoRestbank', 'preview-server');
const data = join(root, 'client');
await mkdir(data, { recursive: true });
const children = [], browsers = [];
const report = { checks: [], build, artifacts: root };
const delay = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, label, timeout = 25000) { const end = Date.now() + timeout; let last; while (Date.now() < end) {
    try {
        const v = await fn();
        if (v)
            return v;
    }
    catch (e) {
        last = e;
    }
    await delay(100);
} throw Error(`${label}: ${last?.message ?? 'timeout'}`); }
async function port() { const server = createServer(); await new Promise(r => server.listen(0, '127.0.0.1', r)); const p = server.address().port; await new Promise(r => server.close(r)); return p; }
function launch(name, args, env = {}) { const child = spawn(join(build, name), args, { env: { ...process.env, LOCALAPPDATA: applicationData, ...env }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); children.push(child); child.stderr.on('data', d => process.stderr.write(d)); return child; }
async function state(page) { return page.evaluate(() => window.__TAURI_INTERNALS__.invoke('get_view')); }
async function ipc(page, cmd, args = {}) { return page.evaluate(({ cmd, args }) => window.__TAURI_INTERNALS__.invoke(cmd, args), { cmd, args }); }
async function command(page, command) { await ipc(page, 'send_command', { command }); return until(async () => { const v = await state(page); if (v.error)
    throw Error(v.error); return !v.pending ? v : null; }, command.type); }
async function launchApp() { const debug = await port(); const child = launch('pomo-restbank.exe', ['--preview', '--data-dir', data], { WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${debug}` }); await until(async () => { const r = await fetch(`http://127.0.0.1:${debug}/json/version`); return r.ok; }, 'CDP'); const browser = await chromium.connectOverCDP(`http://127.0.0.1:${debug}`); browsers.push(browser); const page = await until(() => browser.contexts()[0]?.pages()[0], 'page'); await page.waitForSelector('.brand'); return { child, page, browser }; }
async function quitApp(item) { await ipc(item.page, 'quit_application').catch(e => { if (!String(e).includes('closed'))
    throw e; }); await until(() => item.child.exitCode !== null || item.child.signalCode !== null, 'Quit exits'); }
async function serverStart(p) { const child = launch('pomo-restbank-server.exe', ['--preview', '--listen', `127.0.0.1:${p}`, '--data-dir', source]); await until(async () => (await fetch(`http://127.0.0.1:${p}/health`)).ok, 'server'); return child; }
async function stop(child) { child.kill(); await until(() => child.exitCode !== null || child.signalCode !== null, 'child stopped'); await delay(350); }
try {
    const serverPort = await port();
    let server = await serverStart(serverPort);
    const token = (await readFile(join(source, 'token.txt'), 'utf8')).trim();
    const clientId = randomUUID();
    const socket = new WebSocket(`ws://127.0.0.1:${serverPort}/v1/ws`);
    let snapshot;
    const results = new Map();
    socket.addEventListener('message', event => { const m = JSON.parse(event.data); if (m.snapshot)
        snapshot = m.snapshot; if (m.command_id)
        results.set(m.command_id, m); });
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
    socket.send(JSON.stringify({ type: 'hello', version: 1, token, client_id: clientId }));
    await until(() => snapshot, 'snapshot');
    async function remote(command) { const id = randomUUID(); socket.send(JSON.stringify({ type: 'command', request: { command_id: id, client_id: clientId, expected_revision: snapshot.state.revision, command } })); const result = await until(() => results.get(id), 'remote command'); assert(result.ok, result.error); return result; }
    await remote({ type: 'add_subject', name: 'Imported English' });
    await remote({ type: 'start', seconds: 0 });
    await until(() => snapshot.state.status === 'alarm', 'preview completes');
    await remote({ type: 'stop_alarm' });
    await remote({ type: 'continue_focus' });
    await writeFile(join(data, 'connection.json'), JSON.stringify({ endpoint: `ws://127.0.0.1:${serverPort}/v1/ws`, token, client_id: randomUUID() }));
    const oldConfig = await readFile(join(data, 'connection.json'), 'utf8');
    let app = await launchApp();
    assert.equal((await state(app.page)).backend, 'local');
    await app.page.getByRole('button', { name: 'Import existing data', exact: true }).click();
    await until(async () => (await app.page.locator('#dialog-error').textContent()).includes('running'), 'busy import error');
    assert.equal((await state(app.page)).initializing, true);
    socket.close();
    await stop(server);
    const sourceBytes = await readFile(join(source, 'restbank.sqlite3'));
    await app.page.getByRole('button', { name: 'Retry import', exact: true }).click();
    const imported = await until(async () => { const v = await state(app.page); return v.snapshot && !v.initializing ? v : null; }, 'imported');
    assert.equal(imported.snapshot.state.status, 'paused');
    assert.equal(imported.snapshot.state.balance_seconds, 5);
    assert(imported.snapshot.state.subjects.includes('Imported English'));
    assert.deepEqual(await readFile(join(source, 'restbank.sqlite3')), sourceBytes);
    assert.equal(await readFile(join(data, 'connection.json'), 'utf8'), oldConfig);
    assert(imported.backup_path);
    await readFile(imported.backup_path);
    report.checks.push('Default Local, busy-source refusal, one-time backup/import, preserved source/config, paused timer and reward');
    await ipc(app.page, 'request_history');
    await command(app.page, { type: 'resume' });
    await ipc(app.page, 'plugin:window|close', { label: 'main' });
    await until(async () => !(await ipc(app.page, 'plugin:window|is_visible', { label: 'main' })), 'hidden in tray');
    await until(async () => (await state(app.page)).snapshot.state.status === 'alarm', 'completion while hidden');
    assert.equal((await state(app.page)).snapshot.state.balance_seconds, 10);
    report.checks.push('Tray close keeps process/timer alive and completion awards once through native audio path');
    const duplicate = launch('pomo-restbank.exe', ['--preview', '--data-dir', data]);
    await until(() => duplicate.exitCode !== null, 'second instance exits');
    assert.equal(duplicate.exitCode, 0);
    await until(async () => ipc(app.page, 'plugin:window|is_visible', { label: 'main' }), 'existing window activated');
    await app.page.getByRole('button', { name: 'Enter compact mode' }).click();
    await app.page.getByRole('button', { name: 'Return to full view' }).click();
    await app.page.screenshot({ path: join(root, 'local.png') });
    report.checks.push('Second launch reactivates the same window; compact/full mode works locally');
    await command(app.page, { type: 'stop_alarm' });
    await command(app.page, { type: 'reset' });
    await command(app.page, { type: 'start', seconds: 0 });
    await assert.rejects(ipc(app.page, 'save_application_preferences', { backend: 'server', closeBehavior: 'tray' }));
    await command(app.page, { type: 'reset' });
    await app.page.locator('#settings').click();
    assert((await app.page.locator('#backend-mode option[value="local"]').textContent()).includes('Local - this laptop only'));
    await app.page.locator('#backend-mode').selectOption('server');
    await app.page.locator('#close-behavior').selectOption('quit');
    await app.page.getByRole('button', { name: 'Save application settings', exact: true }).click();
    await until(async () => (await state(app.page)).next_backend === 'server', 'native settings save');
    await app.page.screenshot({ path: join(root, 'local-settings.png') });
    await app.page.keyboard.press('Escape');
    assert.equal((await state(app.page)).backend, 'local');
    assert.equal((await state(app.page)).next_backend, 'server');
    await quitApp(app);
    server = await serverStart(serverPort);
    app = await launchApp();
    await until(async () => (await state(app.page)).connection === 'connected', 'server connection');
    assert.equal((await state(app.page)).backend, 'server');
    await command(app.page, { type: 'reset' });
    await ipc(app.page, 'save_application_preferences', { backend: 'local', closeBehavior: 'quit' });
    await quitApp(app);
    await stop(server);
    app = await launchApp();
    const restored = await state(app.page);
    assert.equal(restored.backend, 'local');
    assert.equal(restored.snapshot.state.balance_seconds, 10);
    await assert.rejects(ipc(app.page, 'initialize_local', { import: true }));
    await command(app.page, { type: 'start', seconds: 0 });
    await delay(1200);
    await quitApp(app);
    app = await launchApp();
    assert.equal((await state(app.page)).snapshot.state.status, 'paused');
    await ipc(app.page, 'plugin:window|close', { label: 'main' }).catch(() => { });
    await until(() => app.child.exitCode !== null, 'X Quit preference exits');
    report.checks.push('Mode switches apply after Quit/reopen, block active timer, preserve both databases; clean Quit/X restart paused');
    // Fresh normal-mode installation: no source and no server executable required by the client.
    const fresh = join(root, 'fresh');
    const debug = await port();
    const normal = launch('pomo-restbank.exe', ['--data-dir', fresh], { WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${debug}` });
    await until(async () => (await fetch(`http://127.0.0.1:${debug}/json/version`)).ok, 'fresh normal CDP');
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${debug}`);
    browsers.push(browser);
    const page = await until(() => browser.contexts()[0]?.pages()[0], 'fresh normal page');
    await page.waitForSelector('#primary');
    const normalView = await state(page);
    assert.equal(normalView.backend, 'local');
    assert.equal(normalView.snapshot.state.focus_seconds, 1500);
    assert.equal(normalView.snapshot.state.balance_seconds, 0);
    await quitApp({ page, child: normal });
    report.checks.push('Fresh normal Local startup needs no server; normal/preview databases stay isolated');
    report.ok = true;
}
catch (error) {
    report.error = String(error.stack ?? error);
    throw error;
}
finally {
    for (const browser of browsers) {
        for (const context of browser.contexts())
            for (const page of context.pages())
                await ipc(page, 'quit_application').catch(() => { });
        await browser.close().catch(() => { });
    }
    for (const child of children)
        if (child.exitCode === null && child.signalCode === null)
            child.kill();
    await delay(800);
    for (const name of ['client', 'appdata', 'fresh'])
        await rm(join(root, name), { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2));
    await writeFile(join(build, 'local-native-smoke-report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
}
