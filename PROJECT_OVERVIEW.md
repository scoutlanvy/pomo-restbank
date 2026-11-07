# Pomo Restbank — technical overview

## Components and boundaries

Cargo workspace: `crates/domain` owns deterministic state transitions; `crates/protocol` owns versioned JSON messages; `crates/server` owns the clock, SQLite and WebSocket authority; `desktop/src-tauri` owns connection credentials, native audio, snapshot cache, and Tauri IPC. `desktop/src` renders the minimal English UI with TypeScript and CSS. No framework or Node runtime is shipped with the client.

Source is independent of the Python repository. Its MIT license, alarm.wav, tick.wav and multi-size icon are retained. The old StudyTimer directories, schemas, launchers, and commits are never touched. Rust data starts fresh; there is no import or automatic migration from Python.

## Domain rules

State has Idle, Running, Paused, Choice, and Alarm statuses, with Manual, Focus, or Break timer phases. Each segment has a UUID, original and remaining seconds, subject, return-to-choice flag, and optional suspended Focus timer. The domain returns history records; it performs no I/O and receives time strings from its caller.

Focus target: 1500 seconds (preview 10). Rewards: 300/300/300/900 (preview 5/5/5/15), cyclic. Reset records only new elapsed focus, including a focus suspended during a break. Prior partial segments stay counted exactly once. Completion clears the selected scope's progress and awards once. Manual completion records its full original duration; Manual Reset discards unfinished progress. Pause, offline time, and break time do not add focus progress. Break debits occur only on committed running seconds. Scope changes preserve independent shared/per-subject accumulations.

Stop Alarm moves completed focus to Choice, completed Manual to Idle, and completed breaks to their proper destination. A suspended focus always returns Paused. Skip Break returns a non-suspended break to Choice, even if the break started idle. Settings and subject changes require Idle. Deleting a subject preserves stored history and per-subject progress; Umum cannot be deleted.

## Server clock, transactions, and failure handling

One process-exclusive file lock per data directory; one runtime mutex serializes domain commands and clock checkpoints. SQLx uses a single-connection SQLite WAL pool with a three-second busy timeout. Schema version 1 stores the state aggregate in workspace, append-only history in study_sessions (unique session UUID), and durable command receipts in command_receipts (unique command UUID). JSON stores the domain state, not unbounded history, so a tick does not rewrite historical records.

For commands: check an existing receipt first and require the exact same request payload, then check revision, apply to a clone, persist the candidate, new records, and receipt in one transaction, then publish. Stale revisions and reused IDs with different payloads fail explicitly. Replayed successful requests return success with the current snapshot. A failing transaction leaves the old countdown and reward intact and blocks storage; RetryStorage saves its paused checkpoint before controls are restored.

Tick once per elapsed running second, durably saving before broadcasting. Ticks advance tick_sequence, while domain commands and automatic phase transitions advance revision. Thus a normal clock tick does not invalidate a Pause command. A fresh interval begins on a successful command. The clock sleeps until its monotonic deadline, preserving ordinary scheduler jitter rather than adding a fixed polling delay every second. It never replays multiple overdue ticks: a scheduler gap greater than three seconds pauses durably. This intentionally also pauses under long CPU/IO scheduling stalls, rather than counting uncertain time.

On restart, validate stored invariants and mode before touching saved state, acknowledge old alarms without replay, and restore running countdowns paused. A corrupt state or unknown schema fails startup, rather than replacing user data. The server continues with zero connected clients. Stop/restart and host suspension do not count as study time.

## Protocol and client

`GET /health` exposes a basic readiness response. `GET /v1/ws` upgrades to WebSocket; the first JSON message must authenticate within five seconds with type=hello, version=1, token, and client_id. Default bind is loopback, normal port 4317 and preview 4318. LAN is opt-in and assumes a trusted private network; TLS and public accounts are not implemented. Tokens are 64 hex characters generated at server startup if absent and written to token.txt, never logs. Clients retain credentials only in their local connection.json, not frontend state.

Client messages: hello, command(request), history, ping. Request fields: command_id, client_id, expected_revision, command. Commands are tagged snake_case domain variants. Server messages: snapshot(snapshot, initial), result(command_id, ok, error, snapshot), history(sessions, summary), error(message), pong. Snapshots contain state, server_time_ms, storage_error, preview. History includes latest 30 records plus lifetime summary by subject, sorted by total time then name. Dates persist in UTC and display in Asia/Jakarta.

Subscribe before reading the first snapshot to avoid missing concurrent changes. Broadcast capacity is 128; lagging clients receive an initial resnapshot, suppressing alarm replay. A five-second heartbeat with a twenty-second server idle cutoff and twelve-second client silent cutoff detects connection loss. Frame/message limit is 16 KiB for incoming requests. The client reconnects every two seconds with an eight-second connection timeout. Normal and preview must agree.

Desktop invokes get_view, connect_server, send_command, retry_pending, and request_history. A single in-flight command prevents local accidental concurrency. Unacknowledged commands are retained in memory for explicit Retry with the same ID; none are automatically replayed offline. An app restart loads authoritative state rather than re-executing old requests. Snapshot cache never authorizes offline control. Settings validate and prepare tick audio before sending a change. Client snapshot processing ignores out-of-order revisions/tick sequences; reconnect initial state replaces the cache.

Each profile owns a SQLite snapshot cache, connection.json, file lock, and isolated WebView data directory. --data-dir permits tests to keep everything in OS temp. Profiles permit 1–48 ASCII letters, digits, underscores, and hyphens. Themes persist in local WebView storage; History visibility is intentionally not persisted.

## UI and audio

The main view centers a countdown ring with mode/subject selection, Pause/Resume/Reset, target and break cards, explicit break choices, and optional History. Settings uses a native HTML dialog with Escape/cancel semantics. Custom subject popover supports per-row right-click Remove, preserves selection while context menu is open, and returns to the list on Escape. Text from subject/history data is escaped before rendering. The CSP prevents arbitrary remote UI scripts; network access is in Rust.

The timer workspace keeps stable DOM controls across snapshots, ticks, and heartbeat notifications. Updates patch text, disabled states, subject selection, and ring offset instead of recreating the panel; manual input drafts, keyboard focus, and open subject menus survive unrelated updates. Subject rows rebuild only when the collection changes, and handlers read the latest snapshot. History controls remain stable and its list rerenders only when history, tab, or connection changes; visible history reloads on reconnection, revision, or endpoint changes. Date formatting reuses one Asia/Jakarta formatter.

Dialogs dismiss on Escape, close/cancel, or an actual click outside their bounds; interior padding clicks preserve the draft. Preference controls track current idle/connection/pending/storage state without replacing edited values, and submit rechecks editability. Local validation messages survive unrelated view updates and clear when the user edits an input. Manual zero-duration starts are rejected locally. Secondary light-theme text uses a darker token; subject triggers disclose the full name through their title. Dialog/popover entry effects use short opacity/translation animations; reduced motion disables animations, transitions, and the button press translation.

Command submission locks controls immediately, including the IPC handoff before a pending ID arrives. Pending-only locks retain normal opacity and hover styling and expose aria-busy; genuine state/connection/storage restrictions keep their disabled appearance. Pending feedback is keyed by endpoint, profile, and command ID, delayed 300 ms, and cancelled on resolution or replacement without heartbeat/tick resets. The fixed-height panel heading swaps its title for a polite Waiting status and Retry same command; Settings use a fixed-height description row for the same feedback. Pending no longer creates a flow banner, and transient preference locks do not reveal the unavailable-settings hint.

Client countdown animation uses monotonic receipt-relative time and the latest server remainder; it never awards rewards or finishes a session locally. Disconnection labels it estimated and disables commands. At zero without confirmation it displays Waiting for server. Client wall-clock changes cannot finish a session.

Rust uses PlaySoundW for Windows audio. PCM16 tick samples are scaled 0–400% with saturation; sample count and trailing silence are preserved. Scaled files are cached in a randomly named system TempDir. Tick occurs on confirmed Start/Resume and committed tick updates, not on speculative UI seconds. Initial reconnect snapshots do not replay sounds. All clients present at a new alarm ring; acknowledgement/Reset stops them. Disconnection and window close stop playback. Normal close removes only this client's generated audio directory.

## Verification and packaging

Domain tests cover arithmetic and transitions. Server integration tests use temporary SQLite databases and real WebSockets, including duplicate and concurrent commands, storage-trigger failures, authentication, reconnect, restart, and preview isolation. UI tests use Edge with mocked Tauri IPC. The native smoke script drives two real Tauri WebView2 windows and a real server with all data under one task-created OS temp directory. It reports actual check results separately from mocked tests.

Build.ps1 directs Cargo artifacts to OS temp and copies distributable client/server, NSIS installer and launcher into ignored dist/. Client/server copying compares SHA-256 first and skips identical destinations, including locked running executables. A failed replacement reports the exact destination and asks the user to close its client/server before retrying; packaging never terminates processes automatically. The frontend production bundle is embedded in the Tauri executable. Installer packages the client; the portable folder and launcher include the separate server. Installer-only use requires starting the server separately and configuring its token. No code signing, auto-update, Windows service, Android packaging, public hosting, or legacy import is claimed.
