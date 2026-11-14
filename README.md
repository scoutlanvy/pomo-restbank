# Pomo Restbank

**Build focus. Bank your breaks.**

A Windows study timer with built-in Local mode and an optional shared Rust sync server. Complete Pomodoro targets to earn a break balance, then use that balance when you choose. The native desktop client uses Tauri 2; timer rules, storage, network communication, and audio run in Rust. The UI uses TypeScript and CSS.

Pomo Restbank is a new implementation of FokusSaldo. This repository does not replace the Python application or access its existing databases. Android, public hosting/TLS, offline merging with a remote server, and legacy Python data import are not included in this first version.

[Panduan Bahasa Indonesia](README.id.md)

## Requirements

To run: Windows 10/11 and Microsoft Edge WebView2 Runtime. To build: stable Rust with the MSVC toolchain, Visual Studio C++ Build Tools (Desktop development with C++ and a Windows SDK), and Node.js 22.12 or newer. See [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).

## Build and run

From the repository root:

```powershell
npm.cmd --prefix desktop ci
npm.cmd --prefix desktop run release
.\dist\PomoRestbank-Launcher.exe
```

The build creates the desktop application, Rust launcher, optional server, NSIS installer, and portable ZIP in `dist/`. Open `pomo-restbank.exe` or `PomoRestbank-Launcher.exe`: **Local mode is the default**, including after upgrading an older installation. It runs the timer and SQLite in the desktop process without a separate server or network port. The client-only installer is sufficient for Local mode; Node.js is needed only for building.

Identical executables are left in place. If a changed executable is in use, choose **Quit** on the exact application and rerun the build; packaging never stops processes automatically. A server process must be stopped separately when replacing its executable.

### Local data, import, and closing

Local data lives in `%LOCALAPPDATA%\PomoRestbank\local\restbank.sqlite3`; preview uses `preview-local`. If this laptop already has a Pomo Restbank server database, the first Local launch offers **Import existing data**, **Start fresh**, or **Cancel and quit** before creating Local data. Stop the source server before importing. Import creates a dated `server-backup-*.sqlite3` in the Local directory, copies subjects, all history, balance, progress, settings, and the timer checkpoint, and opens unfinished timers paused. Existing server data and credentials remain unchanged. Import never overwrites an existing Local database. Local and Server data do not synchronize after copying; network import and legacy Python import are not supported.

One Local window runs per normal/preview data directory; reopening the application shows the existing window, even from the tray. Normal and preview remain separate. By default, **X minimizes to the system tray**: timer, tick sounds, and completion alarm remain active. The tray menu offers **Open** and **Quit**. Change **Settings → Application → When closing the window** to quit instead. Quit saves a paused Local checkpoint and stops sounds; reopening does not count time while stopped or replay old alarms. If tray creation fails, the application stays visible; use **Quit application** in Settings.

### Optional Server mode

Choose **Settings → Application → Connection mode → Server**, save, then **Quit application** and reopen. The choice persists; switching modes needs no pending commands and an Idle timer when connected. A disconnected Server client may switch without pending commands; this does not stop the remote timer. The launcher starts the sibling local server and configures a new profile when needed in Server mode. Opening the client directly allows connecting to another server through **Your sync connection**. Existing connection settings are retained when using Local mode.

For two clients on this computer:

```powershell
.\dist\PomoRestbank-Launcher.exe --backend server --profile first
.\dist\PomoRestbank-Launcher.exe --backend server --profile second
```

For two preview Server clients with separate data (use only `--preview` for one Local preview window):

```powershell
.\dist\PomoRestbank-Launcher.exe --backend server --preview --profile first
.\dist\PomoRestbank-Launcher.exe --backend server --preview --profile second
```

You can also start the executables yourself:

```powershell
.\dist\pomo-restbank-server.exe
.\dist\pomo-restbank.exe --backend server --profile first
```

Open **Settings → Your sync connection**, enter `ws://127.0.0.1:4317/v1/ws`, and paste the contents of `%LOCALAPPDATA%\PomoRestbank\server\token.txt`. Preview uses port 4318 and `preview-server\token.txt`. The server prints the token file location, never the token itself. The client stores the token in its profile's `connection.json`; treat that file as private.

To stop a server launched by the helper, identify its process by executable path/PID and stop that specific process in Task Manager. A server started directly in PowerShell can be stopped with Ctrl+C. Closing clients leaves the server running.

## Timer behavior

- **Manual:** choose 00:00:01–99:59:59, Start, Pause, Resume, or Reset. Only a completed timer records its original duration. Reset discards unfinished Manual progress.
- **Pomodoro:** 25-minute targets earn 5, 5, 5, then 15 minutes of break credit, repeating. Focus completion saves history and rewards atomically before sounding the alarm. Stop Alarm opens explicit Continue Focus / break choices; no next phase starts automatically.
- **Reset focus:** elapsed focus is saved once under its subject and carried toward the next target. Completing the remaining target earns one reward. Reset after a completion never repeats its record or reward.
- **Breaks:** use the balance or choose a shorter duration. Only running break seconds cost balance. Skip preserves unused credit. A break taken during paused focus restores that same focus paused after acknowledgement or Skip. An idle break normally returns to idle.
- **Progress scope:** Shared across subjects (default) and Per subject retain independent progress. Switching never copies or merges progress. Balance and reward cycle stay shared.
- **Subjects:** add via +; remove via trash or right-click any subject in the popup. Umum is protected. Confirmation is required; removing a subject preserves history and progress.
- **History:** Summary by subject and the 30 most recent sessions, displayed in Asia/Jakarta. Visibility starts hidden on each launch.
- **Sound:** tick On/Off and 0–400% tick volume, independent of the alarm. Timer preferences are shared in Server mode and stored on this laptop in Local mode; theme and UI state are local. The Windows title bar follows the selected light/dark theme, including on reopening. Space pauses/resumes countdowns, ignores inputs and dialogs, and never starts a timer or dismisses an alarm.

Timer updates preserve the field you are editing, keyboard focus, and open subject menus when controls remain available. Manual mode requires a positive duration before Start. Settings retain your draft while controls follow the current timer and connection state. Validation errors remain until you edit the field or retry. Click outside a dialog, use Cancel/Close, or press Escape to dismiss it. Short dialog/menu animations respect your system's reduced-motion preference. Visible History refreshes after reconnection. Commands lock controls immediately without dimming controls that are only waiting for confirmation. A compact Waiting indicator and Retry same command appear in the existing panel header after 300 ms, so quick commands do not flash a banner or move the timer. Settings use the same delayed feedback without replacing your draft.

### Compact mode

Use **Compact mode** in the header to switch this window to a small timer view. This is an explicit toggle; resizing the normal window does not activate it. Compact mode keeps the current subject, mode/session, countdown, primary action, Reset and break balance visible. **Details** expands break controls and a preview of up to three recent sessions (subject, duration and Asia/Jakarta time). Focus target details are omitted; focus and reward calculations are unchanged. Skip break stays visible when applicable. The expand icon at the top restores the previous window bounds and maximized state. **View all** beside History returns to full view and opens Recent sessions. Empty history shows `No sessions yet`. Mode, subject and Manual duration edits remain in full view; a compact Manual start uses the current draft duration.

Compact mode disables manual edge/corner resizing and native maximize; Details can still adjust its height automatically. Full view restores resizing and maximize. Compact mode starts at 390x480 logical pixels, with Details height fitted to its content and up to three history rows, constrained to the monitor work area. The default collapsed content fits without a scrollbar; smaller available areas allow vertical scrolling. Theme, server rules, sounds and the running timer are shared with full view. Settings and error/retry feedback remain accessible. Every launch starts in full view, and Details starts closed on each entry. Always-on-top is not included.

## Server sync, disconnection, and recovery

One server hosts one private shared timer. Every client can control it while connected. Commands use unique IDs and optimistic revisions; a stale command is rejected with the latest state. Retrying an unacknowledged command uses the same ID and cannot duplicate history, reward, or debit.

Disconnected clients show an estimate and disable changes. There are no offline command queues. After reconnection, they load authoritative state; **Retry same command** resolves an unacknowledged operation. All clients connected at completion ring; Stop Alarm stops all of them. New connections do not replay old alarms.

The timer runs while the server runs, even with zero clients. On server restart, saved countdowns restore paused. Time while the server is stopped or its computer is suspended is not counted. A detected scheduling interruption over three seconds pauses the timer instead of catching up. Storage failure pauses progress until Retry; a failed transaction does not advance the durable countdown.

For LAN, run the server with `--listen 0.0.0.0:4317` and connect the other computer to `ws://SERVER_LAN_IP:4317/v1/ws` using the same token. Bind defaults to loopback. LAN mode is for a trusted private network; public exposure and TLS deployment are outside this release. A firewall rule may be needed on the server computer. Do not expose the port to the internet.

## Data and development

Normal server: `%LOCALAPPDATA%\PomoRestbank\server\restbank.sqlite3`.
Preview server: `%LOCALAPPDATA%\PomoRestbank\preview-server\restbank.sqlite3`.
Clients: `%LOCALAPPDATA%\PomoRestbank\clients\PROFILE\`, or `preview-clients\PROFILE\`.
Each profile holds connection configuration, a snapshot cache, and its own WebView storage. Use different profiles for simultaneous clients. Back up the server directory with the server stopped. Client cache is not the authoritative database.

The server and desktop executables accept `--data-dir PATH` for isolated testing; client `--backend local|server` overrides the saved mode for that invocation. The launcher accepts the same backend override. Preview uses `--preview`. Client profiles accept letters, digits, `_`, and `-`. A file lock prevents two servers from using one data directory or two clients from using one profile.

```powershell
$env:CARGO_TARGET_DIR = Join-Path $env:TEMP 'pomo-restbank-dev-build'
npm.cmd --prefix desktop run build
cargo test --workspace
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
npm.cmd --prefix desktop test
```

Set `CARGO_TARGET_DIR` to a task-owned OS-temp directory to reuse an isolated packaging cache. Set a separate release destination with `npm.cmd --prefix desktop run release -- ABSOLUTE_OUTPUT_PATH`. This feature build is available under `dist/local-mode/`.

UI tests use Microsoft Edge and mocked Tauri IPC. Native smoke tests use real WebView2 windows, Rust IPC, two clients, and a real server. See PROJECT_OVERVIEW.md and VALIDATION.md for architecture and measured verification. Source is MIT licensed; audio and icon are retained from the Python reference.


Full view uses a centered timer, one Break balance dropdown (Use all / Choose duration), and a single Settings icon in the header. Focus target cards are omitted from full view; progress and reward rules are unchanged. Compact Details shows break controls and the recent History preview.

The Break balance menu follows the button width and shows compact Use all / Choose duration options with icons. Opening it does not start a break.
