#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod audio;
use futures_util::{SinkExt, StreamExt};
use restbank_domain::Command;
use restbank_protocol::{ClientMessage, CommandRequest, ServerMessage, Snapshot};
use serde::{Deserialize, Serialize};
use std::{path::PathBuf, sync::Arc, time::Duration};
use tauri::{Emitter, Manager};
use tokio::sync::{Mutex, mpsc, watch};
use uuid::Uuid;

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
struct Config {
    endpoint: String,
    token: String,
    client_id: Uuid,
}
#[derive(Clone, Serialize)]
struct View {
    snapshot: Option<Snapshot>,
    connection: String,
    endpoint: String,
    has_token: bool,
    pending: Option<Uuid>,
    error: Option<String>,
    profile: String,
    preview: bool,
}
struct Inner {
    view: View,
    config: Config,
    pending: Option<CommandRequest>,
    audio: audio::Audio,
}
#[derive(Clone)]
struct Client {
    inner: Arc<Mutex<Inner>>,
    tx: mpsc::Sender<ClientMessage>,
    config: watch::Sender<Config>,
    pool: sqlx::SqlitePool,
    directory: PathBuf,
}
async fn publish(client: &Client, app: &tauri::AppHandle) {
    let view = client.inner.lock().await.view.clone();
    let _ = app.emit("restbank:view", view);
}
#[tauri::command]
async fn get_view(client: tauri::State<'_, Client>) -> Result<View, String> {
    Ok(client.inner.lock().await.view.clone())
}
#[tauri::command]
async fn connect_server(
    endpoint: String,
    token: String,
    client: tauri::State<'_, Client>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let parsed =
        url::Url::parse(&endpoint).map_err(|_| "Enter a valid ws:// or wss:// server URL.")?;
    if !matches!(parsed.scheme(), "ws" | "wss")
        || parsed.host_str().is_none()
        || parsed.path() != "/v1/ws"
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err("Use ws://HOST:PORT/v1/ws without credentials or query parameters.".into());
    }
    let mut inner = client.inner.lock().await;
    if inner.pending.is_some() {
        return Err("Resolve the pending command before changing server.".into());
    }
    let token = if token.trim().is_empty() {
        inner.config.token.clone()
    } else {
        token.trim().into()
    };
    if token.len() < 32 {
        return Err("Paste the server token (at least 32 characters).".into());
    }
    let config = Config {
        endpoint,
        token,
        client_id: inner.config.client_id,
    };
    let data = serde_json::to_vec(&config).map_err(|e| e.to_string())?;
    let mut file = tempfile::NamedTempFile::new_in(&client.directory).map_err(|e| e.to_string())?;
    std::io::Write::write_all(&mut file, &data).map_err(|e| e.to_string())?;
    file.persist(client.directory.join("connection.json"))
        .map_err(|e| e.to_string())?;
    inner.config = config.clone();
    inner.view.endpoint = config.endpoint.clone();
    inner.view.has_token = true;
    inner.view.snapshot = None;
    inner.view.connection = "connecting".into();
    inner.view.error = None;
    inner.audio.stop();
    drop(inner);
    sqlx::query("DELETE FROM cache")
        .execute(&client.pool)
        .await
        .map_err(|e| e.to_string())?;
    client.config.send_replace(config);
    publish(&client, &app).await;
    Ok(())
}
#[tauri::command]
async fn send_command(
    command: Command,
    client: tauri::State<'_, Client>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let mut inner = client.inner.lock().await;
    if inner.view.connection != "connected" {
        return Err("Connect to the server before changing the timer.".into());
    }
    if inner.pending.is_some() {
        return Err("A command is pending. Wait for its result or press Retry.".into());
    }
    if let Command::SaveSettings { tick_volume, .. } = &command {
        inner
            .audio
            .prepare(*tick_volume)
            .map_err(|e| format!("Could not prepare tick audio: {e}"))?;
    }
    let revision = inner
        .view
        .snapshot
        .as_ref()
        .ok_or("Waiting for server state.")?
        .state
        .revision;
    let request = CommandRequest {
        command_id: Uuid::new_v4(),
        client_id: inner.config.client_id,
        expected_revision: revision,
        command,
    };
    inner.pending = Some(request.clone());
    inner.view.pending = Some(request.command_id);
    inner.view.error = None;
    drop(inner);
    client
        .tx
        .send(ClientMessage::Command { request })
        .await
        .map_err(|_| "Connection worker stopped.".to_string())?;
    publish(&client, &app).await;
    Ok(())
}
#[tauri::command]
async fn retry_pending(client: tauri::State<'_, Client>) -> Result<(), String> {
    let inner = client.inner.lock().await;
    if inner.view.connection != "connected" {
        return Err("Wait for reconnection first.".into());
    }
    let request = inner.pending.clone().ok_or("No pending command.")?;
    drop(inner);
    client
        .tx
        .send(ClientMessage::Command { request })
        .await
        .map_err(|e| e.to_string())
}
#[tauri::command]
async fn request_history(client: tauri::State<'_, Client>) -> Result<(), String> {
    if client.inner.lock().await.view.connection != "connected" {
        return Err("History needs a server connection.".into());
    }
    client
        .tx
        .send(ClientMessage::History)
        .await
        .map_err(|e| e.to_string())
}
async fn receive(client: &Client, app: &tauri::AppHandle, message: ServerMessage) {
    let mut inner = client.inner.lock().await;
    let incoming = match &message {
        ServerMessage::Snapshot { snapshot, initial } => Some((snapshot.clone(), *initial)),
        ServerMessage::Result {
            command_id,
            ok,
            error,
            snapshot,
        } => {
            if inner
                .pending
                .as_ref()
                .is_some_and(|p| p.command_id == *command_id)
            {
                inner.pending = None;
                inner.view.pending = None;
            }
            inner.view.error = if *ok { None } else { error.clone() };
            Some((snapshot.clone(), false))
        }
        ServerMessage::Error { message } => {
            inner.view.error = Some(message.clone());
            None
        }
        ServerMessage::History { .. } => {
            let _ = app.emit("restbank:history", &message);
            None
        }
        _ => None,
    };
    let mut cached = None;
    if let Some((snapshot, initial)) = incoming {
        if snapshot.preview != inner.view.preview {
            inner.view.error = Some(
                "Normal and preview modes cannot share a server. Check the server address.".into(),
            );
            inner.view.connection = "disconnected".into();
            inner.audio.stop();
        } else {
            // Broadcasts queued before a result can contain older state; never regress.
            let newer = inner.view.snapshot.as_ref().is_none_or(|s| {
                (snapshot.state.revision, snapshot.state.tick_sequence)
                    >= (s.state.revision, s.state.tick_sequence)
            });
            if newer || initial {
                if let Err(error) = inner.audio.update(&snapshot, initial) {
                    inner.view.error = Some(format!("Audio unavailable: {error}"));
                }
                inner.view.snapshot = Some(snapshot.clone());
                cached = Some(snapshot);
            }
            inner.view.connection = "connected".into();
        }
    }
    drop(inner);
    if let Some(snapshot) = cached
        && let Ok(data) = serde_json::to_string(&snapshot)
            && sqlx::query("INSERT INTO cache VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET snapshot=excluded.snapshot")
                .bind(data).execute(&client.pool).await.is_err() {
                client.inner.lock().await.view.error = Some("Local cache unavailable; the server still holds your data.".into());
            }
    publish(client, app).await;
}
async fn worker(
    client: Client,
    app: tauri::AppHandle,
    mut commands: mpsc::Receiver<ClientMessage>,
    mut configs: watch::Receiver<Config>,
) {
    loop {
        let config = configs.borrow_and_update().clone();
        if config.token.is_empty() {
            if configs.changed().await.is_err() {
                return;
            }
            continue;
        }
        client.inner.lock().await.view.connection = "connecting".into();
        publish(&client, &app).await;
        let connecting = tokio::time::timeout(
            Duration::from_secs(8),
            tokio_tungstenite::connect_async(&config.endpoint),
        );
        let connected = tokio::select! {
            result = connecting => result,
            _ = configs.changed() => continue,
        };
        if let Ok(Ok((mut socket, _))) = connected {
            let hello = ClientMessage::Hello {
                version: 1,
                token: config.token.clone(),
                client_id: config.client_id,
            };
            if socket
                .send(serde_json::to_string(&hello).unwrap().into())
                .await
                .is_ok()
            {
                let mut ping = tokio::time::interval(Duration::from_secs(5));
                let mut last_seen = tokio::time::Instant::now();
                loop {
                    tokio::select! {
                        _ = configs.changed() => { break; }
                        message = socket.next() => {
                            let Some(Ok(message)) = message else { break; };
                            if client.inner.lock().await.config != config { break; }
                            last_seen = tokio::time::Instant::now();
                            if let Ok(text) = message.into_text()
                                && let Ok(message) = serde_json::from_str::<ServerMessage>(&text) {
                                    let rejected = matches!(&message, ServerMessage::Error { .. }) && client.inner.lock().await.view.connection != "connected";
                                    receive(&client, &app, message).await;
                                    if rejected { break; }
                                }
                        }
                        command = commands.recv() => {
                            let Some(command) = command else { return; };
                            if socket.send(serde_json::to_string(&command).unwrap().into()).await.is_err() { break; }
                        }
                        _ = ping.tick() => {
                            if last_seen.elapsed() > Duration::from_secs(12) { break; }
                            if socket.send(serde_json::to_string(&ClientMessage::Ping).unwrap().into()).await.is_err() { break; }
                        }
                    }
                }
            }
        }
        {
            let mut inner = client.inner.lock().await;
            inner.view.connection = "disconnected".into();
            inner.audio.stop();
        }
        publish(&client, &app).await;
        tokio::select! { _ = tokio::time::sleep(Duration::from_secs(2)) => {}, _ = configs.changed() => {} }
    }
}
fn main() {
    let args: Vec<_> = std::env::args().collect();
    let preview = args.iter().any(|a| a == "--preview");
    let data_override = args
        .windows(2)
        .find(|a| a[0] == "--data-dir")
        .map(|a| PathBuf::from(&a[1]));
    let profile = args
        .windows(2)
        .find(|a| a[0] == "--profile")
        .map(|a| a[1].clone())
        .unwrap_or_else(|| "default".into());
    if profile.is_empty()
        || profile.len() > 48
        || !profile
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
    {
        eprintln!("Profile must use 1–48 ASCII letters, digits, underscores or hyphens.");
        return;
    }
    tauri::Builder::default().setup(move |app| {
        use fs2::FileExt;
        let dir = data_override.clone().unwrap_or_else(|| PathBuf::from(std::env::var_os("LOCALAPPDATA").unwrap_or_else(|| ".".into())).join("PomoRestbank")
            .join(if preview { "preview-clients" } else { "clients" }).join(&profile));
        std::fs::create_dir_all(&dir)?;
        let lock = std::fs::OpenOptions::new().read(true).write(true).create(true).truncate(false).open(dir.join("client.lock"))?;
        lock.try_lock_exclusive().map_err(|_| anyhow::anyhow!("This client profile is already open. Use --profile another-name."))?;
        app.manage(lock);
        let port = if preview { 4318 } else { 4317 };
        let config: Config = if dir.join("connection.json").exists() {
            serde_json::from_slice(&std::fs::read(dir.join("connection.json"))?)?
        } else { Config { endpoint: format!("ws://127.0.0.1:{port}/v1/ws"), token: String::new(), client_id: Uuid::new_v4() } };
        let pool = tauri::async_runtime::block_on(async {
            let options = sqlx::sqlite::SqliteConnectOptions::new().filename(dir.join("cache.sqlite3")).create_if_missing(true);
            let pool = sqlx::SqlitePool::connect_with(options).await?;
            sqlx::query("CREATE TABLE IF NOT EXISTS cache (id INTEGER PRIMARY KEY CHECK(id=1), snapshot TEXT NOT NULL)").execute(&pool).await?;
            Ok::<_, sqlx::Error>(pool)
        })?;
        let snapshot: Option<Snapshot> = tauri::async_runtime::block_on(async {
            sqlx::query_scalar::<_, String>("SELECT snapshot FROM cache WHERE id=1").fetch_optional(&pool).await
                .ok().flatten().and_then(|s| serde_json::from_str(&s).ok())
        });
        let (tx, rx) = mpsc::channel(32); let (config_tx, config_rx) = watch::channel(config.clone());
        let client = Client { inner: Arc::new(Mutex::new(Inner {
            view: View { snapshot, connection: "disconnected".into(), endpoint: config.endpoint.clone(), has_token: !config.token.is_empty(),
                pending: None, error: None, profile: profile.clone(), preview },
            config, pending: None, audio: audio::Audio::new()?,
        })), tx, config: config_tx, pool, directory: dir };
        app.manage(client.clone());
        tauri::WebviewWindowBuilder::from_config(app, &app.config().app.windows[0])?
            .data_directory(client.directory.join("webview"))
            .title(if preview { "Pomo Restbank — TEST MODE" } else { "Pomo Restbank" }).build()?;
        tauri::async_runtime::spawn(worker(client, app.handle().clone(), rx, config_rx));
        Ok(())
    }).on_window_event(|window, event| {
        if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
            let client = window.state::<Client>();
            tauri::async_runtime::block_on(async { client.inner.lock().await.audio.cleanup(); });
        }
    }).invoke_handler(tauri::generate_handler![get_view, connect_server, send_command, retry_pending, request_history])
      .run(tauri::generate_context!()).expect("Could not start Pomo Restbank");
}
