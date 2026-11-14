// Windows integration test: real server, real Rust IPC, and two isolated WebView2 clients.
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import assert from "node:assert/strict";
const require = createRequire(
  new URL("../desktop/package.json", import.meta.url),
);
const { chromium } = require("@playwright/test");
const argument = process.argv.indexOf("--build-dir");
const build = resolve(
  argument < 0
    ? join(tmpdir(), "pomo-restbank-build-20261107", "release")
    : process.argv[argument + 1],
);
const root = await mkdtemp(join(tmpdir(), "pomo-restbank-native-"));
const children = [];
const browsers = [];
const report = { checks: [], build, artifacts: root };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, label, timeout = 20000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (e) {
      last = e;
    }
    await wait(100);
  }
  throw new Error(`${label}: ${last?.message ?? "timeout"}`);
}
async function port() {
  const s = createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const p = s.address().port;
  await new Promise((r) => s.close(r));
  return p;
}
function launch(exe, args, env = {}) {
  const child = spawn(join(build, exe), args, {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });
  children.push(child);
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));
  return child;
}
async function view(page) {
  return page.evaluate(() => window.__TAURI_INTERNALS__.invoke("get_view"));
}
async function invoke(page, command) {
  return page.evaluate(
    (command) => window.__TAURI_INTERNALS__.invoke("send_command", { command }),
    command,
  );
}
async function idleCommand(page, command) {
  const before = (await view(page)).snapshot.state.revision;
  await invoke(page, command);
  return until(async () => {
    const v = await view(page);
    if (v.error) throw new Error(v.error);
    return !v.pending && v.snapshot.state.revision > before ? v : null;
  }, command.type);
}
async function status(page, status) {
  return until(async () => {
    const v = await view(page);
    return v.snapshot?.state.status === status && !v.pending ? v : null;
  }, `status ${status}`);
}
async function closeClient(item) {
  try {
    await item.page.evaluate(() =>
      window.__TAURI_INTERNALS__.invoke("plugin:window|close", {
        label: "main",
      }),
    );
  } catch (error) {
    if (!String(error).includes("has been closed")) throw error;
  }
  await until(
    () => item.process.exitCode !== null || item.process.signalCode !== null,
    "client closes",
    5000,
  );
}
async function launchClient(name, endpoint, token, configureInUi = false, local = false) {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "application.json"), JSON.stringify({backend:local ? "local" : "server",close_behavior:"quit"}));
  const configPath = join(dir, "connection.json");
  let config;
  try {
    config = JSON.parse(await readFile(configPath, "utf8"));
  } catch {
    config = { endpoint, token, client_id: randomUUID() };
  }
  if (!configureInUi) await writeFile(configPath, JSON.stringify(config));
  const debugPort = await port();
  const child = launch(
    "pomo-restbank.exe",
    ["--backend", local ? "local" : "server", ...(local ? [] : ["--preview"]), "--profile", name, "--data-dir", dir],
    {
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${debugPort}`,
      ...(local ? { LOCALAPPDATA: join(root, "isolated-appdata") } : {}),
    },
  );
  await until(async () => {
    const r = await fetch(`http://127.0.0.1:${debugPort}/json/version`);
    return r.ok;
  }, "WebView debug endpoint");
  const browser = await chromium.connectOverCDP(
    `http://127.0.0.1:${debugPort}`,
  );
  browsers.push(browser);
  const page = await until(
    () => browser.contexts()[0]?.pages()[0],
    "WebView page",
  );
  if (configureInUi) {
    await page.getByRole("button", { name: "Connect your timer" }).click();
    await page.getByRole("textbox", { name: "Server address" }).fill(endpoint);
    await page.getByLabel("Access token").fill(token);
    await page.getByRole("button", { name: "Save and connect" }).click();
  }
  await until(async () => {
    const v = await view(page);
    return v.connection === "connected";
  }, "native connection");
  await page.locator("#primary").waitFor();
  return { page, process: child };
}
let server;
try {
  const serverPort = await port();
  const address = `127.0.0.1:${serverPort}`;
  const endpoint = `ws://${address}/v1/ws`;
  const startServer = () =>
    launch("pomo-restbank-server.exe", [
      "--preview",
      "--listen",
      address,
      "--data-dir",
      join(root, "server"),
    ]);
  server = startServer();
  await until(async () => {
    const r = await fetch(`http://${address}/health`);
    return r.ok;
  }, "server ready");
  const token = await readFile(join(root, "server", "token.txt"), "utf8");
  let a = await launchClient("first", endpoint, token, true),
    b = await launchClient("second", endpoint, token);
  const processes = JSON.parse(
    execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize,PrivatePageCount,Name | ConvertTo-Json -Compress",
      ],
      { windowsHide: true, encoding: "utf8" },
    ),
  );
  const memory = (pid) => {
    const ids = new Set([pid]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const p of processes)
        if (ids.has(p.ParentProcessId) && !ids.has(p.ProcessId)) {
          ids.add(p.ProcessId);
          changed = true;
        }
    }
    const matched = processes.filter((p) => ids.has(p.ProcessId));
    return {
      processes: matched.length,
      working_set_mib:
        matched.reduce((sum, p) => sum + Number(p.WorkingSetSize), 0) / 1048576,
      private_commit_mib:
        matched.reduce((sum, p) => sum + Number(p.PrivatePageCount), 0) /
        1048576,
    };
  };
  report.memory = {
    first_client_including_webview2: memory(a.process.pid),
    second_client_including_webview2: memory(b.process.pid),
    server: memory(server.pid),
  };
  report.checks.push(
    "native Settings saves connection/token; two clients authenticate and render",
  );
  const verifyWindowTheme = async (page) => {
    await until(() => page.evaluate(async () => {
      const native = await window.__TAURI_INTERNALS__.invoke("plugin:window|theme", { label: "main" });
      return native === document.documentElement.dataset.theme;
    }), "native window theme matches UI");
  };
  await verifyWindowTheme(a.page);
  const geometry = (page) =>
    page.evaluate(async () => {
      const api = window.__TAURI_INTERNALS__;
      const invoke = (name) =>
        api.invoke(`plugin:window|${name}`, { label: "main" });
      return {
        size: await invoke("inner_size"),
        position: await invoke("outer_position"),
        maximized: await invoke("is_maximized"),
        scale: await invoke("scale_factor"),
        outer: await invoke("outer_size"),
        monitor: await invoke("current_monitor"),
      };
    });
  const layout = async (page, selector, mode, details) => {
    await page.locator(selector).click();
    await until(
      () =>
        page.evaluate(
          ({ mode, details }) =>
            document.documentElement.dataset.layout === mode &&
            (details === undefined ||
              document
                .querySelector("#compact-detail-toggle")
                .getAttribute("aria-expanded") === String(details)) &&
            !document.querySelector("#compact-toggle").disabled,
          { mode, details },
        ),
      "native layout commits",
    );
  };
  const originalBounds = await geometry(a.page);
  const originalRevision = (await view(a.page)).snapshot.state.revision;
  // A normal Local window reproduces the user's layout without preview's
  // deliberately visible TEST MODE notice, which legitimately needs extra space.
  const normal = await launchClient("normal-compact", endpoint, token, false, true);
  assert.equal(await normal.page.locator('.stat-grid').isVisible(), false);
  assert.equal(await normal.page.locator('#timer-settings').count(), 0);
  assert.ok(await normal.page.evaluate(() => document.documentElement.scrollHeight <= innerHeight), 'normal full view fits');
  await layout(normal.page, "#compact-toggle", "compact", false);
  const compactContent = await normal.page.evaluate(() => ({
    viewport: innerHeight, content: document.documentElement.scrollHeight,
  }));
  assert.ok(compactContent.content <= compactContent.viewport,
    `normal compact view must fit without a vertical scrollbar: ${JSON.stringify(compactContent)}`);
  report.checks.push("normal Local compact window fits without a vertical scrollbar");
  await closeClient(normal);
  await layout(a.page, "#compact-toggle", "compact", false);
  const compactBounds = await geometry(a.page);
  report.compact = { originalBounds, compactBounds };
  assert.ok(
    Math.abs(compactBounds.size.width / compactBounds.scale - 390) <= 2,
  );
  assert.ok(
    Math.abs(compactBounds.size.height / compactBounds.scale - 480) <= 2,
  );
  await a.page.screenshot({
    path: join(root, "native-compact-light.png"),
    fullPage: true,
  });
  await layout(a.page, "#compact-detail-toggle", "compact", true);
  await a.page.locator("#compact-history-list").getByText("No sessions yet.", { exact: true }).waitFor();
  await until(async () => a.page.evaluate(() => Math.abs(innerHeight - document.querySelector("#compact-details").getBoundingClientRect().bottom - 16) <= 2), "Details fits empty history with 16px bottom margin");
  assert.equal(await a.page.locator(".compact-target-progress").count(), 0);
  report.checks.push("native compact Details fits empty history without Focus target or unused bottom space");
  report.compact.expandedBounds = await geometry(a.page);
  await a.page.evaluate(() => document.querySelector("#theme").click());
  await verifyWindowTheme(a.page);
  report.checks.push("native window theme follows UI at startup and after toggle");
  await a.page.screenshot({
    path: join(root, "native-compact-details-dark.png"),
    fullPage: true,
  });
  assert.equal(await a.page.locator("#break-all").isEnabled(), false); // initial balance is zero
  assert.equal(
    await a.page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  await layout(a.page, "#compact-toggle", "full");
  const restoredBounds = await geometry(a.page);
  report.compact.restoredBounds = restoredBounds;
  const area = restoredBounds.monitor.workArea;
  const availableWidth =
    area.size.width - (restoredBounds.outer.width - restoredBounds.size.width);
  const availableHeight =
    area.size.height -
    (restoredBounds.outer.height - restoredBounds.size.height);
  const expectedSize = {
    width: Math.min(originalBounds.size.width, availableWidth),
    height: Math.min(originalBounds.size.height, availableHeight),
  };
  assert.deepEqual(restoredBounds.size, expectedSize);
  assert.deepEqual(restoredBounds.position, {
    x: Math.max(
      area.position.x,
      Math.min(
        originalBounds.position.x,
        area.position.x + availableWidth - expectedSize.width,
      ),
    ),
    y: Math.max(
      area.position.y,
      Math.min(
        originalBounds.position.y,
        area.position.y + availableHeight - expectedSize.height,
      ),
    ),
  });
  await a.page.getByRole("button", { name: "Toggle color theme" }).click();
  await a.page.evaluate(() =>
    window.__TAURI_INTERNALS__.invoke("plugin:window|maximize", {
      label: "main",
    }),
  );
  await until(
    async () => (await geometry(a.page)).maximized,
    "native maximize",
  );
  await layout(a.page, "#compact-toggle", "compact", false);
  assert.equal((await geometry(a.page)).maximized, false);
  await layout(a.page, "#compact-toggle", "full");
  assert.equal((await geometry(a.page)).maximized, true);
  await a.page.evaluate(() =>
    window.__TAURI_INTERNALS__.invoke("plugin:window|unmaximize", {
      label: "main",
    }),
  );
  await until(
    async () => !(await geometry(a.page)).maximized,
    "native unmaximize",
  );
  assert.deepEqual((await geometry(a.page)).size, restoredBounds.size);
  assert.equal((await view(a.page)).snapshot.state.revision, originalRevision);
  await layout(a.page, "#compact-toggle", "compact", false);
  report.checks.push(
    "compact native size/detail/restore/maximize works without changing timer revision",
  );
  await a.page.getByRole("button", { name: "Start focus" }).click();
  await status(a.page, "running");
  await status(b.page, "running");
  await until(
    async () =>
      (await view(b.page)).snapshot.state.timer.remaining_seconds <= 8,
    "two committed focus seconds",
  );
  await b.page.getByRole("button", { name: "Pause", exact: true }).click();
  const paused = await status(a.page, "paused");
  await status(b.page, "paused");
  const remainder = paused.snapshot.state.timer.remaining_seconds;
  await wait(1200);
  assert.equal(
    (await view(a.page)).snapshot.state.timer.remaining_seconds,
    remainder,
  );
  report.checks.push(
    "Start on first / Pause on second sync; pause does not consume time",
  );
  await a.page.getByRole("button", { name: "Resume", exact: true }).click();
  await status(b.page, "running");
  await b.page.getByRole("button", { name: "Reset", exact: true }).click();
  await status(a.page, "idle");
  await status(b.page, "idle");
  assert.ok((await view(a.page)).snapshot.state.shared_progress >= 2);
  await layout(a.page, "#compact-detail-toggle", "compact", true);
  await a.page.screenshot({
    path: join(root, "native-compact-details-after-reset.png"),
    fullPage: true,
  });
  await a.page.locator("#compact-history-list .history-row").first().waitFor();
  assert.ok(await a.page.locator("#compact-history-list .history-row").count() <= 3);
  await until(async () => a.page.evaluate(() => Math.abs(innerHeight - document.querySelector("#compact-details").getBoundingClientRect().bottom - 16) <= 2), "Details fits recent history");
  report.checks.push("native compact History refreshes after Reset and fits recent rows");
  await layout(a.page, "#compact-history", "full");
  assert.equal(await a.page.locator("#history-panel").isVisible(), true);
  report.checks.push(
    "compact Start/Resume/Reset sync with full client; compact History opens full view",
  );

  await a.page.locator("#history-list .history-row").first().waitFor();
  report.checks.push(
    "Reset records partial focus and refreshes native history",
  );
  await a.page.getByRole("button", { name: "Add subject" }).click();
  await a.page.getByRole("textbox", { name: "Subject name" }).fill("Algebra");
  await a.page
    .getByRole("button", { name: "Add subject", exact: true })
    .last()
    .click();
  await until(
    async () => (await view(b.page)).snapshot.state.subject === "Algebra",
    "new subject sync",
  );
  await idleCommand(a.page, {
    type: "save_settings",
    focus_scope: "per_subject",
    tick_sound: false,
    tick_volume: 120,
  });
  await until(
    async () =>
      (await view(b.page)).snapshot.state.settings.tick_volume === 120,
    "settings sync",
  );
  report.checks.push(
    "subject and preferences synchronize across native clients",
  );
  await idleCommand(a.page, {
    type: "select",
    mode: "manual",
    subject: "Algebra",
  });
  await idleCommand(a.page, { type: "start", seconds: 60 });
  await status(b.page, "running");
  await closeClient(a);
  await closeClient(b);
  await wait(2200);
  a = await launchClient("first", endpoint, token);
  const continued = await status(a.page, "running");
  assert.ok(continued.snapshot.state.timer.remaining_seconds < 60);
  b = await launchClient("second", endpoint, token);
  report.checks.push("timer continues with every client window closed");
  await idleCommand(a.page, { type: "reset" });
  await idleCommand(a.page, {
    type: "select",
    mode: "pomodoro",
    subject: "Algebra",
  });
  await idleCommand(a.page, { type: "start", seconds: 0 });
  await status(a.page, "alarm");
  await status(b.page, "alarm");
  assert.equal((await view(a.page)).snapshot.state.balance_seconds, 5);
  await b.page.getByRole("button", { name: "Stop Alarm", exact: true }).click();
  await status(a.page, "choice");
  await status(b.page, "choice");
  await b.page.locator('#balance-toggle').click();
  assert.ok(await b.page.locator('#break-choose').isVisible());
  const triggerBox = await b.page.locator('#balance-toggle').boundingBox();
  const menuBox = await b.page.locator('#balance-menu').boundingBox();
  assert.ok(Math.abs(triggerBox.width-menuBox.width) <= 1, 'native menu matches trigger width');
  assert.ok(menuBox.height <= 96, 'native menu uses compact rows');
  assert.ok((await b.page.locator('#break-all').textContent()).includes('\u00b7'), 'correct separator');
  await b.page.keyboard.press('Escape');
  assert.equal(await b.page.locator('#break-choose').isVisible(), false);
  report.checks.push(
    "completion grants one reward and Stop Alarm syncs across windows",
  );
  await idleCommand(a.page, { type: "start_break", seconds: 2 });
  await status(b.page, "running");
  await status(a.page, "alarm");
  await status(b.page, "alarm");
  await b.page.getByRole("button", { name: "Stop Alarm", exact: true }).click();
  await status(a.page, "choice");
  assert.equal((await view(a.page)).snapshot.state.balance_seconds, 3);
  await idleCommand(a.page, { type: "reset" });
  await a.page.screenshot({
    path: join(root, "native-light.png"),
    fullPage: true,
  });
  await a.page.getByRole("button", { name: "Toggle color theme" }).click();
  await a.page.screenshot({
    path: join(root, "native-dark.png"),
    fullPage: true,
  });
  report.checks.push(
    "break debit and alarm acknowledgement preserve exact remaining balance",
  );
  await idleCommand(a.page, { type: "start", seconds: 0 });
  await status(b.page, "running");
  server.kill();
  await until(
    () => server.exitCode !== null || server.signalCode !== null,
    "server stopped",
  );
  await until(
    async () => (await view(a.page)).connection !== "connected",
    "disconnect detected",
    20000,
  );
  assert.equal(await a.page.locator("#primary").isDisabled(), true);
  report.checks.push("server loss disables native controls");
  server = startServer();
  await until(async () => {
    const r = await fetch(`http://${address}/health`);
    return r.ok;
  }, "server restart");
  await until(
    async () => (await view(a.page)).connection === "connected",
    "reconnect",
  );
  await status(a.page, "paused");
  await status(b.page, "paused");
  report.checks.push(
    "server restart restores paused and both native clients reconnect",
  );
  await closeClient(a);
  await closeClient(b);
  report.ok = true;
} catch (error) {
  report.ok = false;
  report.error = error.stack;
  process.exitCode = 1;
} finally {
  for (const browser of browsers)
    try {
      // Close only our isolated test windows normally, including on assertion failures,
      // so their native audio TempDirs are cleaned before any process fallback.
      for (const context of browser.contexts())
        for (const page of context.pages())
          await page
            .evaluate(() =>
              window.__TAURI_INTERNALS__?.invoke("plugin:window|close", {
                label: "main",
              }),
            )
            .catch(() => {});
      await browser.close();
    } catch {}
  for (const child of children) if (child.exitCode === null) child.kill();
  await wait(500);
  // Retain screenshots/report, but remove our own temporary databases and tokens.
  for (const name of ["first", "second", "server", "normal-compact"])
    await rm(join(root, name), {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 300,
    }).catch(() => {});
  await writeFile(join(root, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
