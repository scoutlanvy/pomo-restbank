// Repeatable loopback measurements, never opens the user's normal server database.
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { performance } from "node:perf_hooks";
const argument = process.argv.indexOf("--build-dir");
const build = resolve(
  argument < 0
    ? join(tmpdir(), "pomo-restbank-build-20261107", "release")
    : process.argv[argument + 1],
);
const root = await mkdtemp(join(tmpdir(), "pomo-restbank-benchmark-"));
const listener = createServer();
await new Promise((r) => listener.listen(0, "127.0.0.1", r));
const port = listener.address().port;
await new Promise((r) => listener.close(r));
const child = spawn(
  join(build, "pomo-restbank-server.exe"),
  ["--preview", "--listen", `127.0.0.1:${port}`, "--data-dir", root],
  { windowsHide: true, stdio: "ignore" },
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sockets = [];
async function connect(token) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/ws`);
  sockets.push(ws);
  const id = randomUUID();
  let snapshot;
  const listeners = new Set();
  ws.onmessage = (event) => {
    const m = JSON.parse(event.data);
    if (m.snapshot) snapshot = m.snapshot;
    for (const listener of listeners) listener(m);
  };
  const next = (predicate, timeoutMs = 5000) =>
    new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        listeners.delete(cb);
        reject(new Error("WebSocket response timeout"));
      }, timeoutMs);
      const cb = (m) => {
        if (predicate(m)) {
          clearTimeout(timeout);
          listeners.delete(cb);
          resolve(m);
        }
      };
      listeners.add(cb);
    });
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  const ready = next((m) => m.type === "snapshot");
  ws.send(JSON.stringify({ type: "hello", version: 1, token, client_id: id }));
  await ready;
  return {
    ws,
    id,
    next,
    get snapshot() {
      return snapshot;
    },
  };
}
let report;
try {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break;
    } catch {}
    await sleep(100);
  }
  const token = await readFile(join(root, "token.txt"), "utf8");
  const a = await connect(token),
    b = await connect(token);
  const ack = [],
    observer = [];
  for (let i = 0; i < 60; i++) {
    const revision = a.snapshot.state.revision;
    const id = randomUUID();
    const result = a.next((m) => m.type === "result" && m.command_id === id);
    const observed = b.next(
      (m) =>
        m.type === "snapshot" && m.snapshot.state.revision === revision + 1,
    );
    const before = performance.now();
    a.ws.send(
      JSON.stringify({
        type: "command",
        request: {
          command_id: id,
          client_id: a.id,
          expected_revision: revision,
          command: {
            type: "select",
            mode: "pomodoro",
            subject: i % 2 ? "Umum" : "English",
          },
        },
      }),
    );
    const p = result.then((m) => {
      if (!m.ok) throw new Error(m.error);
      ack.push(performance.now() - before);
    });
    const q = observed.then(() => observer.push(performance.now() - before));
    await Promise.all([p, q]);
  }
  const id = randomUUID();
  const result = a.next((m) => m.type === "result" && m.command_id === id);
  a.ws.send(
    JSON.stringify({
      type: "command",
      request: {
        command_id: id,
        client_id: a.id,
        expected_revision: a.snapshot.state.revision,
        command: { type: "start", seconds: 0 },
      },
    }),
  );
  await result;
  const start = performance.now();
  await a.next((m) => m.snapshot?.state.status === "alarm", 20000);
  const elapsed = performance.now() - start;
  const stats = (values) => {
    const sorted = values.slice(10).sort((a, b) => a - b);
    return {
      samples: sorted.length,
      median_ms: sorted[Math.floor(sorted.length * 0.5)],
      p95_ms: sorted[Math.floor(sorted.length * 0.95)],
      max_ms: sorted.at(-1),
    };
  };
  let serverRam;
  try {
    serverRam =
      Number(
        execFileSync(
          "powershell.exe",
          [
            "-NoProfile",
            "-Command",
            `(Get-Process -Id ${child.pid}).WorkingSet64`,
          ],
          { windowsHide: true, encoding: "utf8" },
        ).trim(),
      ) / 1048576;
  } catch {}
  report = {
    environment:
      "Windows, release build, loopback, two WebSocket clients, fresh preview database",
    warmup_commands: 10,
    ack: stats(ack),
    second_client: stats(observer),
    preview_focus_expected_ms: 10000,
    preview_focus_actual_ms: elapsed,
    preview_drift_ms: elapsed - 10000,
    server_working_set_mib: serverRam,
  };
} catch (error) {
  report = { error: String(error) };
  process.exitCode = 1;
} finally {
  for (const s of sockets) s.close();
  child.kill();
  await sleep(500);
  await rm(root, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 200,
  });
}
await writeFile(
  join(tmpdir(), "pomo-restbank-benchmark-result.json"),
  JSON.stringify(report, null, 2),
);
console.log(JSON.stringify(report, null, 2));
