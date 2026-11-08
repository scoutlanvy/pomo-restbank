pub mod migration;
pub mod preferences;
use chrono::Utc;
use restbank_domain::{Command, Session, State, Status};
use restbank_protocol::{CommandRequest, ServerMessage, Snapshot, Summary};
use sqlx::{
    Row, SqlitePool,
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions},
};
use std::{collections::BTreeMap, path::Path, sync::Arc, time::Duration};
use tokio::{
    sync::{Mutex, broadcast},
    time::Instant,
};

pub struct Runtime {
    pub state: State,
    pub storage_error: Option<String>,
    pub preview: bool,
    pool: SqlitePool,
    next_tick: Instant,
}
#[derive(Clone)]
pub struct Engine {
    pub runtime: Arc<Mutex<Runtime>>,
    pub events: broadcast::Sender<Snapshot>,
}
fn time_text() -> String {
    Utc::now().to_rfc3339()
}
/// Validate existing databases read-only before any schema or recovery writes.
pub async fn validate_database(path: &Path, preview: bool) -> anyhow::Result<()> {
    use sqlx::{Connection, SqliteConnection};
    let options = SqliteConnectOptions::new().filename(path).read_only(true);
    let mut db = SqliteConnection::connect_with(&options).await?;
    let result = async {
        let check: String = sqlx::query_scalar("PRAGMA quick_check")
            .fetch_one(&mut db)
            .await?;
        anyhow::ensure!(check == "ok", "Database integrity check failed");
        let row = sqlx::query("SELECT schema_version, state_json FROM workspace WHERE id=1")
            .fetch_one(&mut db)
            .await?;
        anyhow::ensure!(
            row.get::<i64, _>("schema_version") == 1,
            "Unsupported database schema; refusing to overwrite it"
        );
        let state: State = serde_json::from_str(row.get("state_json"))?;
        state.validate().map_err(anyhow::Error::msg)?;
        anyhow::ensure!(
            state.focus_seconds == if preview { 10 } else { 1500 },
            "Preview mode does not match this database"
        );
        let rows = sqlx::query("SELECT session_json FROM study_sessions")
            .fetch_all(&mut db)
            .await?;
        for row in rows {
            let _: Session = serde_json::from_str(row.get("session_json"))?;
        }
        // A missing receipt table is also a corrupt/incompatible database, not a new schema.
        sqlx::query("SELECT command_id, request_json FROM command_receipts LIMIT 1")
            .fetch_optional(&mut db)
            .await?;
        Ok(())
    }
    .await;
    db.close().await?;
    result
}
impl Runtime {
    fn snapshot(&self) -> Snapshot {
        Snapshot {
            state: self.state.clone(),
            server_time_ms: Utc::now().timestamp_millis(),
            storage_error: self.storage_error.clone(),
            preview: self.preview,
        }
    }
    async fn persist(
        &self,
        state: &State,
        sessions: &[Session],
        receipt: Option<&CommandRequest>,
    ) -> anyhow::Result<()> {
        let mut tx = self.pool.begin().await?;
        sqlx::query("UPDATE workspace SET state_json = ? WHERE id = 1")
            .bind(serde_json::to_string(state)?)
            .execute(&mut *tx)
            .await?;
        for session in sessions {
            sqlx::query("INSERT INTO study_sessions (session_id, session_json) VALUES (?, ?)")
                .bind(session.session_id.to_string())
                .bind(serde_json::to_string(session)?)
                .execute(&mut *tx)
                .await?;
        }
        if let Some(request) = receipt {
            sqlx::query("INSERT INTO command_receipts (command_id, request_json) VALUES (?, ?)")
                .bind(request.command_id.to_string())
                .bind(serde_json::to_string(request)?)
                .execute(&mut *tx)
                .await?;
        }
        tx.commit().await?;
        Ok(())
    }
    fn block_storage(&mut self) {
        self.storage_error =
            Some("Storage unavailable. Timer paused; fix storage and press Retry.".into());
        if self.state.status == Status::Running {
            self.state.status = Status::Paused;
        }
        self.state.revision += 1;
    }
}
impl Engine {
    /// Caller stops and joins its clock before closing. The runtime lock serializes shutdown.
    pub async fn close(&self) -> anyhow::Result<()> {
        let mut rt = self.runtime.lock().await;
        if rt.state.status == Status::Running {
            let mut paused = rt.state.clone();
            paused.status = Status::Paused;
            paused.revision += 1;
            rt.persist(&paused, &[], None).await?;
            rt.state = paused;
        }
        rt.pool.close().await;
        Ok(())
    }

    pub async fn open(path: &Path, preview: bool) -> anyhow::Result<Self> {
        if path.exists() {
            validate_database(path, preview).await?;
        }
        let options = SqliteConnectOptions::new()
            .filename(path)
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Wal)
            .busy_timeout(Duration::from_secs(3));
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await?;
        sqlx::query("CREATE TABLE IF NOT EXISTS workspace (id INTEGER PRIMARY KEY CHECK(id=1), schema_version INTEGER NOT NULL, state_json TEXT NOT NULL)").execute(&pool).await?;
        sqlx::query("CREATE TABLE IF NOT EXISTS study_sessions (position INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT UNIQUE NOT NULL, session_json TEXT NOT NULL)").execute(&pool).await?;
        sqlx::query("CREATE TABLE IF NOT EXISTS command_receipts (command_id TEXT PRIMARY KEY, request_json TEXT NOT NULL)").execute(&pool).await?;
        let row = sqlx::query("SELECT schema_version, state_json FROM workspace WHERE id=1")
            .fetch_optional(&pool)
            .await?;
        let mut state = if let Some(row) = row {
            anyhow::ensure!(
                row.get::<i64, _>("schema_version") == 1,
                "Unsupported database schema; refusing to overwrite it"
            );
            let mut saved: State = serde_json::from_str(row.get("state_json"))?;
            saved.validate().map_err(anyhow::Error::msg)?;
            anyhow::ensure!(
                saved.focus_seconds == if preview { 10 } else { 1500 },
                "Preview mode does not match this database"
            );
            saved.recover();
            saved
        } else {
            State::new(preview)
        };
        // A restart must invalidate every previous optimistic revision.
        state.revision += 1;
        sqlx::query("INSERT INTO workspace VALUES(1, 1, ?) ON CONFLICT(id) DO UPDATE SET state_json=excluded.state_json")
            .bind(serde_json::to_string(&state)?).execute(&pool).await?;
        let (events, _) = broadcast::channel(128);
        Ok(Self {
            runtime: Arc::new(Mutex::new(Runtime {
                state,
                pool,
                storage_error: None,
                preview,
                next_tick: Instant::now() + Duration::from_secs(1),
            })),
            events,
        })
    }
    pub async fn snapshot(&self) -> Snapshot {
        self.runtime.lock().await.snapshot()
    }
    pub async fn command(&self, request: &CommandRequest) -> ServerMessage {
        let mut rt = self.runtime.lock().await;
        let outcome: Result<(), String> = async {
            let prior = sqlx::query("SELECT request_json FROM command_receipts WHERE command_id=?")
                .bind(request.command_id.to_string()).fetch_optional(&rt.pool).await.map_err(|_| "Storage unavailable.".to_string())?;
            if let Some(row) = prior {
                if row.get::<String, _>("request_json") != serde_json::to_string(request).unwrap() {
                    return Err("Command ID was already used for a different request.".into());
                }
                return Ok(());
            }
            if request.expected_revision != rt.state.revision { return Err("State changed on another client. Review the latest state and try again.".into()); }
            if rt.storage_error.is_some() && !matches!(request.command, Command::RetryStorage) { return Err("Storage is blocked. Press Retry first.".into()); }
            let mut candidate = rt.state.clone();
            let sessions = if matches!(request.command, Command::RetryStorage) {
                if rt.storage_error.is_none() { return Err("Storage is already available.".into()); }
                candidate.revision += 1; Vec::new()
            } else { candidate.apply(&request.command, &time_text())? };
            if rt.persist(&candidate, &sessions, Some(request)).await.is_err() {
                rt.block_storage(); return Err("Could not save the command. No success was acknowledged; press Retry after fixing storage.".into());
            }
            rt.state = candidate; rt.storage_error = None;
            // Every command starts a fresh running-second interval (no paused fraction is counted).
            rt.next_tick = Instant::now() + Duration::from_secs(1);
            Ok(())
        }.await;
        let snapshot = rt.snapshot();
        let _ = self.events.send(snapshot.clone());
        ServerMessage::Result {
            command_id: request.command_id,
            ok: outcome.is_ok(),
            error: outcome.err(),
            snapshot,
        }
    }
    /// One durable timer second. Exposed for deterministic integration tests.
    pub async fn tick(&self) {
        let mut rt = self.runtime.lock().await;
        if rt.state.status != Status::Running || rt.storage_error.is_some() {
            return;
        }
        let mut candidate = rt.state.clone();
        let sessions = candidate.tick(&time_text());
        if rt.persist(&candidate, &sessions, None).await.is_ok() {
            rt.state = candidate;
        } else {
            rt.block_storage();
        }
        let _ = self.events.send(rt.snapshot());
    }
    pub async fn run_clock(self) {
        let mut previous = Instant::now();
        loop {
            let deadline = self.runtime.lock().await.next_tick;
            tokio::time::sleep_until(deadline).await;
            let now = Instant::now();
            let gap = now.duration_since(previous);
            previous = now;
            let mut rt = self.runtime.lock().await;
            if gap > Duration::from_secs(3) && rt.state.status == Status::Running {
                let mut candidate = rt.state.clone();
                candidate.status = Status::Paused;
                candidate.revision += 1;
                if rt.persist(&candidate, &[], None).await.is_ok() {
                    rt.state = candidate;
                } else {
                    rt.block_storage();
                }
                let _ = self.events.send(rt.snapshot());
            }
            let due = now >= rt.next_tick;
            if due {
                // Preserve the deadline for ordinary scheduler jitter, without
                // replaying multiple ticks after slow I/O or a suspended host.
                let next = rt.next_tick + Duration::from_secs(1);
                rt.next_tick = if next > now {
                    next
                } else {
                    now + Duration::from_secs(1)
                };
            }
            drop(rt);
            if due {
                self.tick().await;
            }
        }
    }
    pub async fn history(&self) -> Result<ServerMessage, String> {
        let rt = self.runtime.lock().await;
        let rows = sqlx::query("SELECT session_json FROM study_sessions ORDER BY position DESC")
            .fetch_all(&rt.pool)
            .await
            .map_err(|_| "History unavailable. Check storage.".to_string())?;
        let mut all = Vec::new();
        let mut totals: BTreeMap<String, (u64, u64)> = BTreeMap::new();
        for row in rows {
            let s: Session = serde_json::from_str(row.get("session_json"))
                .map_err(|_| "Invalid history record.".to_string())?;
            let entry = totals.entry(s.subject.clone()).or_default();
            entry.0 += u64::from(s.duration_seconds);
            entry.1 += 1;
            if all.len() < 30 {
                all.push(s);
            }
        }
        let mut summary: Vec<_> = totals
            .into_iter()
            .map(|(subject, (duration_seconds, count))| Summary {
                subject,
                duration_seconds,
                count,
            })
            .collect();
        summary.sort_by(|a, b| {
            b.duration_seconds
                .cmp(&a.duration_seconds)
                .then(a.subject.cmp(&b.subject))
        });
        Ok(ServerMessage::History {
            sessions: all,
            summary,
        })
    }
}
#[cfg(test)]
mod tests;
