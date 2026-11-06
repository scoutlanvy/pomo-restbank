use axum::{
    Router,
    extract::{
        State as AppState, WebSocketUpgrade,
        ws::{Message, WebSocket},
    },
    response::IntoResponse,
    routing::get,
};
use chrono::Utc;
use futures_util::StreamExt;
use restbank_domain::{Command, Session, State, Status};
use restbank_protocol::{
    ClientMessage, CommandRequest, PROTOCOL_VERSION, ServerMessage, Snapshot, Summary,
};
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
pub struct Service {
    pub runtime: Arc<Mutex<Runtime>>,
    pub events: broadcast::Sender<Snapshot>,
    token: String,
}
fn time_text() -> String {
    Utc::now().to_rfc3339()
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
impl Service {
    pub async fn open(path: &Path, token: String, preview: bool) -> anyhow::Result<Self> {
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
            token,
        })
    }
    pub fn router(&self) -> Router {
        Router::new()
            .route("/health", get(|| async { "Pomo Restbank server: ready" }))
            .route("/v1/ws", get(upgrade))
            .with_state(self.clone())
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
            .map_err(|_| "History unavailable. Check server storage.".to_string())?;
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
async fn upgrade(AppState(service): AppState<Service>, ws: WebSocketUpgrade) -> impl IntoResponse {
    ws.max_message_size(16384)
        .max_frame_size(16384)
        .on_upgrade(move |socket| connection(socket, service))
}
async fn send(socket: &mut WebSocket, message: &ServerMessage) -> bool {
    socket
        .send(Message::Text(
            serde_json::to_string(message).unwrap().into(),
        ))
        .await
        .is_ok()
}
async fn connection(mut socket: WebSocket, service: Service) {
    let hello = tokio::time::timeout(Duration::from_secs(5), socket.recv()).await;
    let Some(ClientMessage::Hello {
        version,
        token,
        client_id,
    }) = hello
        .ok()
        .flatten()
        .and_then(Result::ok)
        .and_then(|m| m.into_text().ok())
        .and_then(|s| serde_json::from_str(&s).ok())
    else {
        return;
    };
    if version != PROTOCOL_VERSION || token != service.token {
        send(
            &mut socket,
            &ServerMessage::Error {
                message: "Invalid token or protocol version.".into(),
            },
        )
        .await;
        return;
    }
    // Subscribe before initial read so a concurrent command cannot be missed.
    let mut events = service.events.subscribe();
    let initial = service.snapshot().await;
    if !send(
        &mut socket,
        &ServerMessage::Snapshot {
            snapshot: initial,
            initial: true,
        },
    )
    .await
    {
        return;
    }
    let mut heartbeat = tokio::time::interval(Duration::from_secs(5));
    let mut last_seen = Instant::now();
    loop {
        tokio::select! {
            incoming = socket.next() => {
                let Some(Ok(message)) = incoming else { break; };
                last_seen = Instant::now();
                let Message::Text(text) = message else {
                    if matches!(message, Message::Close(_)) { break; }
                    continue;
                };
                let response = match serde_json::from_str::<ClientMessage>(&text) {
                    Ok(ClientMessage::Command { request }) if request.client_id == client_id => service.command(&request).await,
                    Ok(ClientMessage::History) => service.history().await.unwrap_or_else(|message| ServerMessage::Error { message }),
                    Ok(ClientMessage::Ping) => ServerMessage::Pong,
                    _ => ServerMessage::Error { message: "Invalid message or client identity.".into() },
                };
                if !send(&mut socket, &response).await { break; }
            }
            event = events.recv() => {
                let response = match event {
                    Ok(snapshot) => ServerMessage::Snapshot { snapshot, initial: false },
                    Err(broadcast::error::RecvError::Lagged(_)) => ServerMessage::Snapshot { snapshot: service.snapshot().await, initial: true },
                    Err(_) => break,
                };
                if !send(&mut socket, &response).await { break; }
            }
            _ = heartbeat.tick() => {
                if last_seen.elapsed() > Duration::from_secs(20) { break; }
                if !send(&mut socket, &ServerMessage::Pong).await { break; }
            }
        }
    }
}
