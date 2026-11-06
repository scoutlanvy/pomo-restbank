# Validation — Pomo Restbank 0.1.0

Verified on Windows, 7 November 2026 (Asia/Jakarta).

## Checks completed

| Check | Result |
|---|---|
| Rust domain | 12 behavior tests passed |
| Rust server | 6 SQLite/WebSocket integration tests and 1 real-time clock test passed |
| Rust audio | 2 PCM scaling/cache cleanup tests passed |
| Frontend | TypeScript check and Vite production build passed |
| Browser UI | 7 Edge/Playwright tests passed |
| Rust static checks | rustfmt check and Clippy across workspace/all targets with warnings denied passed |
| Python reference | 154 tests passed on an isolated copy in OS temp |
| Windows release | Native client and server compiled; NSIS installer generated |

The Python reference copy came from commit `8d96218`. Its tests ran from that copy's project root with `.\.venv\Scripts\python.exe -m pytest -q`. The original repository remained clean on its original branch and commit.

## Native Windows smoke test

The real release client was driven through WebView2 CDP with a real Rust server. No Tauri IPC mocks were used. Each client and server used task-created temporary directories. Nine scenarios passed:

1. Settings accepts an address/token and persists the native connection; two clients authenticate and render.
2. Start on the first client and Pause on the second synchronize; paused time is not consumed.
3. Reset records partial focus and refreshes History.
4. New subjects and shared preferences propagate to the other client.
5. Timer continues after every client window closes, and reopened clients load current state.
6. Focus completion grants one reward, both clients show Alarm, and one Stop Alarm updates both.
7. A two-second break debits exactly two seconds and retains the remaining balance.
8. Server loss disables native controls.
9. Server restart restores the timer paused and both clients reconnect.

Audio sample conversion and playback paths were exercised. Audio hardware output and subjective loudness were not instrumented. Real machine sleep and a second physical LAN computer were not used in this test.

## Measurements

Release server, loopback connection, two WebSocket clients, fresh preview database. Ten warm-up commands were excluded; fifty command samples were measured.

| Measurement | Observed |
|---|---:|
| Command acknowledgement median | 1.47 ms |
| Command acknowledgement p95 | 2.20 ms |
| Update at second client median | 1.54 ms |
| Update at second client p95 | 2.30 ms |
| Ten-second preview focus | 10,014.37 ms |
| Drift in that sample | +14.37 ms |
| Standalone server working set | 8.81 MiB |

The original polling clock measured approximately +442 ms over ten seconds. It was replaced with monotonic deadline scheduling. A real-time regression test now requires a ten-second focus to finish within 10.3 seconds. This is a short local measurement, not a long-duration accuracy or LAN latency guarantee.

During the native test, the first client plus its WebView2 process tree used approximately 473 MiB summed working set / 292 MiB private commit; the second used 397 MiB / 215 MiB. These samples include remote debugging and automation. Summed working sets may count shared pages more than once. A production comparison with the Python application requires equivalent measurement without debugging; no RAM reduction is claimed.

Portable client executable: approximately 13.2 MiB. Server executable: approximately 5.4 MiB. Client NSIS installer: approximately 3.3 MiB. Exact file sizes and SHA-256 values are supplied with the release folder. WebView2 is a system prerequisite and is outside these executable sizes.

## Reproduction and limitations

Run the frontend build before Cargo workspace checks, as documented in README.md. Then use `node scripts/native-smoke.mjs --build-dir dist` and `node scripts/benchmark.mjs --build-dir dist`. Both scripts create their own temporary data; they do not access normal user databases. The native script retains a report/screenshots for inspection after removing its database/token directories.

This release targets Windows with local/private-LAN sync. Android, public TLS hosting, offline editing, user-account management, legacy import, signing, and auto-update remain outside this version. The NSIS installer installs the client; the portable release folder includes the separate server and local launcher.

Temporary build output, Python test copy, test databases, generated test audio and test reports were cleaned after release artifacts and verification evidence were collected. Rust, C++ Build Tools, Cargo's dependency cache, and local npm dependencies remain available for development.
