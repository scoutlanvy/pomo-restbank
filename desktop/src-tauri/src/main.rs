#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod audio;
mod instance;
use futures_util::{SinkExt, StreamExt};
use restbank_domain::Command;
use restbank_engine::{
    Engine,
    preferences::{
        Backend, CloseBehavior, Preferences, app_root, client_directory, local_directory,
        server_directory,
    },
};
use restbank_protocol::{ClientMessage, CommandRequest, ServerMessage, Snapshot};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
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
    backend: Backend,
    next_backend: Backend,
    close_behavior: CloseBehavior,
    import_available: bool,
    initializing: bool,
    tray_available: bool,
    backup_path: Option<String>,
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
    preferences_directory: PathBuf,
    local: Option<Arc<LocalControl>>,
    quitting: Arc<AtomicBool>,
}
struct LocalControl {
    directory: PathBuf,
    source: PathBuf,
    engine: watch::Sender<Option<Engine>>,
    clock: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
    gate: Mutex<()>,
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
    if client.inner.lock().await.view.backend != Backend::Server {
        return Err("Select Server mode, Quit, and reopen before connecting.".into());
    }
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
    if client.quitting.load(Ordering::SeqCst) {
        return Err("Application is closing.".into());
    }
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
    if client.quitting.load(Ordering::SeqCst) {
        return;
    }
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
    if client.local.is_none() && let Some(snapshot) = cached
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
async fn local_worker(
    client: Client,
    app: tauri::AppHandle,
    mut commands: mpsc::Receiver<ClientMessage>,
) {
    let local = client.local.as_ref().unwrap();
    let mut services = local.engine.subscribe();
    let engine = loop {
        let current = services.borrow_and_update().clone();
        if let Some(engine) = current {
            break engine;
        }
        if services.changed().await.is_err() {
            return;
        }
    };
    let mut events = engine.events.subscribe();
    receive(
        &client,
        &app,
        ServerMessage::Snapshot {
            snapshot: engine.snapshot().await,
            initial: true,
        },
    )
    .await;
    loop {
        tokio::select! {
            command = commands.recv() => {
                let Some(command) = command else { break; };
                let _guard = local.gate.lock().await;
                let response = match command {
                    ClientMessage::Command { request } => engine.command(&request).await,
                    ClientMessage::History => engine.history().await.unwrap_or_else(|message| ServerMessage::Error { message }),
                    _ => continue,
                };
                receive(&client, &app, response).await;
            }
            event = events.recv() => {
                let (snapshot, initial) = match event {
                    Ok(snapshot) => (snapshot, false),
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => (engine.snapshot().await, true),
                    Err(_) => break,
                };
                receive(&client, &app, ServerMessage::Snapshot { snapshot, initial }).await;
            }
        }
    }
}
#[tauri::command]
async fn initialize_local(
    import: bool,
    client: tauri::State<'_, Client>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let local = client
        .local
        .as_ref()
        .ok_or("Import is only available in Local mode.")?;
    let _guard = local.gate.lock().await;
    if local.engine.borrow().is_some() {
        return Err("Local data already exists. It cannot be overwritten.".into());
    }
    let preview = client.inner.lock().await.view.preview;
    let backup = restbank_engine::migration::initialize_local(
        &local.directory,
        import.then_some(local.source.as_path()),
        preview,
    )
    .await
    .map_err(|e| e.to_string())?;
    let engine = Engine::open(&local.directory.join("restbank.sqlite3"), preview)
        .await
        .map_err(|e| e.to_string())?;
    {
        let mut inner = client.inner.lock().await;
        inner.view.initializing = false;
        inner.view.import_available = false;
        inner.view.backup_path = backup.map(|p| p.to_string_lossy().into_owned());
        inner.view.snapshot = Some(engine.snapshot().await);
        inner.view.connection = "connected".into();
    }
    *local.clock.lock().await = Some(tauri::async_runtime::spawn(engine.clone().run_clock()));
    local.engine.send_replace(Some(engine));
    publish(&client, &app).await;
    Ok(())
}
#[tauri::command]
async fn save_application_preferences(
    backend: Backend,
    close_behavior: CloseBehavior,
    client: tauri::State<'_, Client>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let mut inner = client.inner.lock().await;
    if client.quitting.load(Ordering::SeqCst) {
        return Err("Application is closing.".into());
    }
    if backend != inner.view.next_backend
        && (inner.pending.is_some()
            || (inner.view.connection == "connected"
                && inner
                    .view
                    .snapshot
                    .as_ref()
                    .is_some_and(|s| s.state.status != restbank_domain::Status::Idle)))
    {
        return Err(
            "Resolve pending commands and finish or Reset the timer before changing mode.".into(),
        );
    }
    Preferences {
        backend,
        close_behavior,
    }
    .save(&client.preferences_directory)
    .map_err(|e| e.to_string())?;
    inner.view.next_backend = backend;
    inner.view.close_behavior = close_behavior;
    drop(inner);
    publish(&client, &app).await;
    Ok(())
}
pub(crate) fn show_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}
async fn quit(client: &Client, app: &tauri::AppHandle) -> Result<(), String> {
    if client.quitting.swap(true, Ordering::SeqCst) {
        return Ok(());
    }
    if let Some(local) = &client.local {
        let _guard = local.gate.lock().await;
        let engine = local.engine.borrow().clone();
        // Let an in-flight durable tick finish before cancellation. Never abort a SQLite transaction.
        let runtime_guard = if let Some(engine) = &engine {
            Some(engine.runtime.lock().await)
        } else {
            None
        };
        if let Some(clock) = local.clock.lock().await.take() {
            clock.abort();
            let _ = clock.await;
        }
        drop(runtime_guard);
        if let Some(engine) = engine
            && let Err(error) = engine.close().await
        {
            client.quitting.store(false, Ordering::SeqCst);
            *local.clock.lock().await = Some(tauri::async_runtime::spawn(engine.run_clock()));
            client.inner.lock().await.view.error = Some(format!(
                "Could not save before quitting: {error}. Fix storage and try again."
            ));
            show_window(app);
            publish(client, app).await;
            return Err(error.to_string());
        }
    }
    client.inner.lock().await.audio.cleanup();
    client.pool.close().await;
    app.exit(0);
    Ok(())
}
#[tauri::command]
async fn quit_application(
    client: tauri::State<'_, Client>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    quit(&client, &app).await
}
fn create_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    use tauri::{
        menu::{Menu, MenuItem},
        tray::TrayIconBuilder,
    };
    let open = MenuItem::with_id(app, "open", "Open", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &quit_item])?;
    let mut builder = TrayIconBuilder::with_id("restbank")
        .menu(&menu)
        .tooltip("Pomo Restbank")
        .show_menu_on_left_click(true);
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show_window(app),
            "quit" => {
                let client = app.state::<Client>().inner().clone();
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = quit(&client, &app).await;
                });
            }
            _ => {}
        })
        .build(app)?;
    Ok(())
}
fn run() -> anyhow::Result<()> {
    let args: Vec<_> = std::env::args().collect();
    let preview = args.iter().any(|a| a == "--preview");
    let argument = |name: &str| args.windows(2).find(|a| a[0] == name).map(|a| a[1].clone());
    let data_override = argument("--data-dir").map(PathBuf::from);
    let profile = argument("--profile").unwrap_or_else(|| "default".into());
    anyhow::ensure!(
        !profile.is_empty()
            && profile.len() <= 48
            && profile
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_'),
        "Profile must use 1–48 ASCII letters, digits, underscores or hyphens."
    );
    let root = app_root()?;
    let preferences_directory = data_override
        .clone()
        .unwrap_or_else(|| client_directory(&root, preview, &profile));
    let prefs = Preferences::load(&preferences_directory)?;
    let backend = match argument("--backend").as_deref() {
        None => prefs.backend,
        Some("local") => Backend::Local,
        Some("server") => Backend::Server,
        _ => anyhow::bail!("Use --backend local or --backend server"),
    };
    let local_dir = data_override
        .clone()
        .unwrap_or_else(|| local_directory(&root, preview));
    let instance = if backend == Backend::Local {
        match tauri::async_runtime::block_on(instance::Instance::claim(&local_dir))? {
            Some(owner) => Some(owner),
            None => return Ok(()),
        }
    } else {
        None
    };
    // This also blocks reopening the same profile in its pending next mode before Quit.
    let profile_lock = restbank_engine::preferences::lock_profile(&preferences_directory)?;
    let application = tauri::Builder::default().setup(move |app| {
        let dir = if backend == Backend::Local { local_dir.clone() } else { preferences_directory.clone() };
        std::fs::create_dir_all(&dir)?;
        app.manage(profile_lock);
        let config_path = preferences_directory.join("connection.json");
        let port = if preview { 4318 } else { 4317 };
        let config: Config = if config_path.exists() { serde_json::from_slice(&std::fs::read(config_path)?)? }
            else { Config { endpoint: format!("ws://127.0.0.1:{port}/v1/ws"), token: String::new(), client_id: Uuid::new_v4() } };
        let source = server_directory(&root, preview);
        let import_available = backend == Backend::Local && !dir.join("restbank.sqlite3").exists() && source.join("restbank.sqlite3").is_file();
        let local = if backend == Backend::Local {
            let engine = tauri::async_runtime::block_on(async {
                if !dir.join("restbank.sqlite3").exists() && !import_available {
                    restbank_engine::migration::initialize_local(&dir, None, preview).await?;
                }
                if import_available { Ok::<_, anyhow::Error>(None) } else { Ok(Some(Engine::open(&dir.join("restbank.sqlite3"), preview).await?)) }
            })?;
            let (engine_tx, _) = watch::channel(engine);
            Some(Arc::new(LocalControl { directory: dir.clone(), source, engine: engine_tx, clock: Mutex::new(None), gate: Mutex::new(()) }))
        } else { None };
        let pool = tauri::async_runtime::block_on(async {
            let options = sqlx::sqlite::SqliteConnectOptions::new().filename(if backend == Backend::Local { PathBuf::from(":memory:") } else { dir.join("cache.sqlite3") }).create_if_missing(true);
            let pool = sqlx::sqlite::SqlitePoolOptions::new().max_connections(1).connect_with(options).await?;
            sqlx::query("CREATE TABLE IF NOT EXISTS cache (id INTEGER PRIMARY KEY CHECK(id=1), snapshot TEXT NOT NULL)").execute(&pool).await?;
            Ok::<_, sqlx::Error>(pool)
        })?;
        let snapshot = tauri::async_runtime::block_on(async {
            if let Some(local) = &local { let engine = local.engine.borrow().clone(); if let Some(engine) = engine { return Some(engine.snapshot().await); } return None; }
            sqlx::query_scalar::<_, String>("SELECT snapshot FROM cache WHERE id=1").fetch_optional(&pool).await.ok().flatten().and_then(|s| serde_json::from_str(&s).ok())
        });
        let (tx, rx) = mpsc::channel(32); let (config_tx, config_rx) = watch::channel(config.clone());
        let client = Client { inner: Arc::new(Mutex::new(Inner {
            view: View { snapshot, connection: if backend == Backend::Local && !import_available { "connected".into() } else { "disconnected".into() }, endpoint: config.endpoint.clone(), has_token: !config.token.is_empty(),
                pending: None, error: None, profile, preview, backend, next_backend: prefs.backend, close_behavior: prefs.close_behavior, import_available, initializing: import_available, tray_available: false, backup_path: None },
            config, pending: None, audio: audio::Audio::new()?,
        })), tx, config: config_tx, pool, directory: preferences_directory.clone(), preferences_directory, local, quitting: Arc::new(AtomicBool::new(false)) };
        app.manage(client.clone());
        tauri::WebviewWindowBuilder::from_config(app, &app.config().app.windows[0])?.data_directory(dir.join("webview"))
            .title(if preview { "Pomo Restbank — TEST MODE" } else { "Pomo Restbank" }).build()?;
        let tray_result = create_tray(app.handle());
        tauri::async_runtime::block_on(async {
            let mut inner = client.inner.lock().await;
            inner.view.tray_available = tray_result.is_ok();
            if let Err(error) = tray_result { inner.view.error = Some(format!("Tray unavailable: {error}. The window will stay open when closed; use Quit application to exit.")); }
        });
        if let Some(instance) = instance { tauri::async_runtime::spawn(instance.serve(app.handle().clone())); }
        if let Some(local) = &client.local {
            let engine = local.engine.borrow().clone();
            if let Some(engine) = engine { tauri::async_runtime::block_on(async { *local.clock.lock().await = Some(tauri::async_runtime::spawn(engine.run_clock())); }); }
            tauri::async_runtime::spawn(local_worker(client, app.handle().clone(), rx));
        } else { tauri::async_runtime::spawn(worker(client, app.handle().clone(), rx, config_rx)); }
        Ok(())
    }).on_window_event(|window, event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            let client = window.state::<Client>().inner().clone(); let app = window.app_handle().clone();
            tauri::async_runtime::spawn(async move {
                let (behavior, tray) = { let inner = client.inner.lock().await; (inner.view.close_behavior, inner.view.tray_available) };
                if behavior == CloseBehavior::Quit { let _ = quit(&client, &app).await; }
                else if tray { if let Some(window) = app.get_webview_window("main") { let _ = window.hide(); } }
                else { show_window(&app); publish(&client, &app).await; }
            });
        }
    }).invoke_handler(tauri::generate_handler![get_view, connect_server, send_command, retry_pending, request_history, initialize_local, save_application_preferences, quit_application])
        .build(tauri::generate_context!())?;
    application.run(|app, event| {
        if let tauri::RunEvent::ExitRequested { api, .. } = event
            && !app.state::<Client>().quitting.load(Ordering::SeqCst)
        {
            api.prevent_exit();
            let client = app.state::<Client>().inner().clone();
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                let _ = quit(&client, &app).await;
            });
        }
    });
    Ok(())
}
fn main() {
    if let Err(error) = run() {
        eprintln!("Pomo Restbank: {error:#}");
        #[cfg(windows)]
        {
            #[link(name = "user32")]
            unsafe extern "system" {
                fn MessageBoxW(
                    window: isize,
                    text: *const u16,
                    title: *const u16,
                    flags: u32,
                ) -> i32;
            }
            let text: Vec<u16> = format!("Pomo Restbank: {error:#}")
                .encode_utf16()
                .chain(Some(0))
                .collect();
            let title: Vec<u16> = "Pomo Restbank".encode_utf16().chain(Some(0)).collect();
            unsafe {
                MessageBoxW(0, text.as_ptr(), title.as_ptr(), 0x10);
            }
        }
        std::process::exit(1);
    }
}
