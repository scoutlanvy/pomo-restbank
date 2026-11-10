# Working on Pomo Restbank

- Read the relevant sections of PROJECT_OVERVIEW.md before editing; understand existing rules first.
- Preserve unrelated behavior. Ask about genuinely ambiguous requirements, destructive data changes, or architecture changes outside the requested scope.
- Never open or modify the legacy StudyTimer/StudyTimerPreview databases. Use explicitly isolated test databases in the system temporary directory.
- Explain names and purposes before adding project directories.
- Keep README.md and README.id.md aligned with installation and usage changes, and update PROJECT_OVERVIEW.md for technical changes.
- Build the frontend first with `npm --prefix desktop run build` (Tauri embeds its output), then run `cargo test --workspace`, `cargo fmt --all -- --check`, and `cargo clippy --workspace --all-targets -- -D warnings` for relevant changes. Run `npm --prefix desktop test` for UI changes.
- For native smoke tests: `node scripts/native-smoke.mjs --build-dir PATH_TO_BUILD_OUTPUT`. These tests open temporary Windows application windows and play short completion alarms.
- Set CARGO_TARGET_DIR to a task-owned directory under the system temp directory for temporary builds. Keep distributed release files in ignored dist/.
- Temporary build caches for this Pomo Restbank repository may be cleaned, including caches created by earlier tasks, without asking again. Before deletion, verify each resolved absolute path is an explicitly identified project build directory under the system temp directory or this repository's target/; confirm its build-cache purpose from contents or project records, and confirm no active build or application uses it. A name prefix alone is not sufficient evidence. Delete only verified directories using literal paths, never a broad temp-directory wildcard. If use or ownership is uncertain, leave the directory and report it.
- This cache-cleanup authorization excludes databases (including test databases), study history, settings, credentials, backups, source files, distributed release files in dist/, shared Cargo/npm caches, and artifacts belonging to other projects. Clean other temporary artifacts only when created by the current task. Never bypass an environment policy rejection; report the blocked action. Report cleaned space, remaining artifacts, checks, and limitations.
- This is a new repository. The Python reference remains at D:\01_Project\04-timer-notion-clean; do not change it or its Git history.
