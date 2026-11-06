# Working on Pomo Restbank

- Read the relevant sections of PROJECT_OVERVIEW.md before editing; understand existing rules first.
- Preserve unrelated behavior. Ask about genuinely ambiguous requirements, destructive data changes, or architecture changes outside the requested scope.
- Never open or modify the legacy StudyTimer/StudyTimerPreview databases. Use explicitly isolated test databases in the system temporary directory.
- Explain names and purposes before adding project directories.
- Keep README.md and README.id.md aligned with installation and usage changes, and update PROJECT_OVERVIEW.md for technical changes.
- Build the frontend first with `npm --prefix desktop run build` (Tauri embeds its output), then run `cargo test --workspace`, `cargo fmt --all -- --check`, and `cargo clippy --workspace --all-targets -- -D warnings` for relevant changes. Run `npm --prefix desktop test` for UI changes.
- For native smoke tests: `node scripts/native-smoke.mjs --build-dir PATH_TO_BUILD_OUTPUT`. These tests open temporary Windows application windows and play short completion alarms.
- Set CARGO_TARGET_DIR to a task-owned directory under the system temp directory for temporary builds. Keep distributed release files in ignored dist/.
- Clean only temporary artifacts created by your task. Report new remaining files, checks, and limitations.
- This is a new repository. The Python reference remains at D:\01_Project\04-timer-notion-clean; do not change it or its Git history.
