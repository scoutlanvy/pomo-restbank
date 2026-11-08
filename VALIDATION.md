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

## Rust launcher migration ? 8 November 2026 (Asia/Jakarta)

The launcher is now `PomoRestbank-Launcher.exe`; release packaging runs with `npm --prefix desktop run release`. The source PowerShell build/launcher scripts were removed. Users need neither Node.js nor PowerShell scripts to launch the portable application. The installer still installs only the client.

Verified for this change: frontend production build; Cargo workspace tests (including two launcher tests for profile validation and service-health recognition); rustfmt; Clippy for all workspace targets with warnings denied; release client/server/launcher and NSIS packaging; all nine native smoke scenarios; launcher integration checks on both normal and preview modes. Launcher checks exercised server startup/reuse, token setup, separate profiles, client process startup, and unchanged existing configuration. All test databases were isolated under OS temp. No UI source changed, so mocked browser UI tests were not rerun.

`node scripts/launcher-smoke.mjs dist` reproduces the launcher checks; ports 4317 and 4318 must be free. This Windows-only test uses PowerShell for process discovery, limited to executables copied into its own temporary directory. Build packaging and the distributed launcher do not use PowerShell. Native error-dialog appearance and interactive installer installation were not manually inspected.

The new portable ZIP contains the three executables and documentation, with no `.ps1` files. An obsolete `dist/Start-PomoRestbank.ps1` from the previous task remains outside the ZIP; this task does not remove earlier artifacts. Release output and smoke reports remain in ignored `dist/`; the three new source files are `crates/server/src/launcher.rs`, `scripts/build.mjs`, and `scripts/launcher-smoke.mjs`. Task-owned smoke data is removed after testing.


## Local-mode feature verification - 8 November 2026 (Asia/Jakarta)

Branch: feat/local-mode. Version and existing tags are unchanged. Local is the first-launch default; Server remains optional. The engine was extracted without changing the network protocol or timer rules.

Checks completed for this change:

- Frontend TypeScript/Vite production build and all 39 Edge/Playwright tests passed (35 regressions plus four Local settings/setup scenarios).
- Cargo workspace tests passed: 12 domain, 7 Server/clock integration, 2 audio, 2 launcher, and 7 engine/import/shutdown/profile-lock tests (30 total). Workspace rustfmt and Clippy across all targets with warnings denied passed.
- Native debug Local checks passed: default startup, busy-source refusal and retry, backup/import with unchanged source and connection config, paused imported timer, tray timer completion/reward/audio path, second-instance activation, compact mode, switching Local to Server to Local after Quit/reopen, refusing imports over existing data, clean Quit/X recovery, and separate fresh normal/preview data.
- Native debug Server checks passed all 11 scenarios, including two-client synchronization, compact geometry at 200% DPI, command/history/preferences, countdown with no open clients, alarm acknowledgement, break debit, disconnect and paused restart.
- Launcher debug checks passed default Local startup without a server executable/token/process, and preview Server startup/reuse/profile preservation. Normal Server launcher checks were safely skipped because port 4317 belongs to an existing process; that process and its data were not accessed or stopped. Explicit Server clients were tested on isolated random ports instead.
- Import failure tests preserve the original source byte-for-byte, keep the backup when candidate recovery fails, refuse wrong-mode/unknown-schema/corrupt-history data, refuse active source locks and existing destinations, and reject failed shutdown persistence.

All application data, credentials, source databases, and test windows used unique task-owned OS-temp directories. No legacy database, Python repository, or existing user server was opened or changed. UI error-dialog layout and subjective audio loudness, actual machine sleep, a second physical LAN computer, interactive installer installation, and a forced native tray-creation failure were not manually validated. Native runs exercised real Rust IPC, WebView2, tray creation/window hiding, and audio processing/playback paths. Memory samples are diagnostic only and do not establish a performance improvement.

The initial release cache under pomo-local-mode-20261108 lost generated dependency files and was abandoned for packaging. A fresh task-owned release target is used instead. Feature release output is isolated in ignored dist/local-mode/ so existing dist/ executables in use remain intact. Reproduce native checks with node scripts/local-native-smoke.mjs --build-dir PATH and node scripts/native-smoke.mjs --build-dir PATH; launcher checks use node scripts/launcher-smoke.mjs PATH. Test scripts clean their own databases/tokens and retain reports/screenshots. Build/cache and retained report directories, plus the source additions crates/engine/, desktop/src-tauri/src/instance.rs, and scripts/local-native-smoke.mjs, are reported at delivery. No merge, push, version change, or new tag is performed.


Final release checks also passed against dist/local-mode/: the client/server/launcher and NSIS installer were built, the Local native suite exercised saving mode/close preferences through the real Settings UI, all 11 Server native scenarios passed, and default Local plus preview Server launcher checks passed. Normal Server launcher remains skipped for the occupied 4317 port. The final Cargo workspace suite, rustfmt and Clippy passed in the fresh build target. Reports and Local screenshots are retained alongside the feature distribution.

Task cleanup of verified build/report directories was rejected by automatic approval review with "blocked by policy". No alternate deletion method was attempted. Remaining task-owned Temp directories: pomo-local-mode-20261108, pomo-local-release-10fa33b8, pomo-local-native-GcATKi, pomo-local-native-mjQZK9, pomo-local-native-SqY9Hd, pomo-local-native-nNJZVt, pomo-restbank-native-4WkiHE, pomo-restbank-native-3ltXQS, and pomo-restbank-native-Ec4Goj. Test databases/tokens within native roots were already removed by normal test teardown; remaining native roots contain reports/screenshots. Earlier tasks' Temp artifacts were left untouched.
