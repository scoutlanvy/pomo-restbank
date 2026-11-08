use axum::{
    Router,
    extract::{
        State as AppState, WebSocketUpgrade,
        ws::{Message, WebSocket},
    },
    response::IntoResponse,
    routing::get,
};
use futures_util::StreamExt;
pub use restbank_engine::{Engine, Runtime};
use restbank_protocol::{ClientMessage, PROTOCOL_VERSION, ServerMessage};
use std::{path::Path, time::Duration};
use tokio::{sync::broadcast, time::Instant};
#[derive(Clone)]
pub struct Service {
    engine: Engine,
    token: String,
}
impl std::ops::Deref for Service {
    type Target = Engine;
    fn deref(&self) -> &Engine {
        &self.engine
    }
}
impl Service {
    pub async fn open(path: &Path, token: String, preview: bool) -> anyhow::Result<Self> {
        Ok(Self {
            engine: Engine::open(path, preview).await?,
            token,
        })
    }
    pub async fn run_clock(self) {
        self.engine.run_clock().await;
    }
    pub fn router(&self) -> Router {
        Router::new()
            .route("/health", get(|| async { "Pomo Restbank server: ready" }))
            .route("/v1/ws", get(upgrade))
            .with_state(self.clone())
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
