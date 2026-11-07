# Validation — Pomo Restbank 0.1.0

Verified on Windows, 7 November 2026 (Asia/Jakarta).

## Compact mode verification

The compact-mode update was checked separately on 7 November 2026. The frontend production build, 35 Edge/Playwright tests with mocked Tauri IPC, all 21 Rust behavior/integration/audio tests, rustfmt check, and workspace/all-target Clippy with warnings denied passed. UI coverage includes both themes, reduced motion, pending feedback, command restrictions, draft preservation, resize failures, fractional DPI, work-area clamping, Details and History transitions.

The isolated debug run and the final dist release native smoke run each passed 11 scenarios with two real clients and a real server, including compact resizing, Details, restoration from maximize, and compact/full command synchronization. Native measurements at 200% display scale were 780x1120 physical pixels closed and 780x1480 expanded (390x560 and 390x740 logical pixels). The original full window exceeded the available work area, so restoration correctly reduced its height to keep its frame on screen. Small work areas, negative monitor coordinates and 125%/150% DPI were additionally simulated in UI tests; multiple physical monitors and display hot-plug were not tested. No performance improvement is claimed from these checks.

Release packaging completed with the unchanged running server executable retained by its matching SHA-256 in the existing release cache. The client, NSIS installer, portable ZIP and five-entry checksum manifest were updated; no user server was stopped. The task-owned Cargo build directory was cleaned (6.5 GiB). UI screenshots remain in OS-temp `pomo-compact-evidence-c94a`; passing native reports/screenshots remain in `pomo-restbank-native-CjLafm` (debug) and `pomo-restbank-native-Qe02G4` (dist release). Native test databases and credentials were removed by the smoke script.

Automatic approval review rejected cleanup of the initial failed geometry-assertion run (`pomo-restbank-native-x4vOUQ`), its two audio folders (`pomo-restbank-audio-9aCQO7`, `pomo-restbank-audio-pNqUmV`) and eight obsolete `pomo-compact-*.png` files at the OS-temp root with "blocked by policy". These were retained without an alternative deletion mechanism. The initial assertion expected an off-screen original height; the test now verifies restoration with the required work-area clamping. Existing unrelated temporary artifacts and release caches were preserved.

The measurements and Python-reference results below are historical baseline results; the Python reference was not opened or retested for this update.

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

Native smoke scripts removed their own client/server database and token subdirectories. Final recursive cleanup of the remaining task artifacts was rejected by the environment's automatic review with “blocked by policy”, including a second attempt using verified absolute literal paths. No alternative deletion mechanism was used.

Remaining task artifacts: OS-temp directories named `pomo-restbank-build-20261107`, `pomo-restbank-python-reference-20261107`, `pomo-restbank-ui-tests-20261107`, four `pomo-restbank-native-*` report/screenshot directories, and four generated `pomo-restbank-audio-*` directories from interrupted test clients. Preview PNGs and a benchmark JSON also remain in OS temp. Inside the new repository, ignored `target/`, `desktop/dist/`, and `desktop/src-tauri/gen/` remain. The release folder `dist/` is intentionally retained for use. Rust, C++ Build Tools, Cargo's dependency cache, and local npm dependencies remain available for development.
