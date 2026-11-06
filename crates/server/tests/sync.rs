use futures_util::{SinkExt, StreamExt};
use pomo_restbank_server::Service;
use restbank_domain::{Command, Status};
use restbank_protocol::*;
use tokio_tungstenite::{connect_async, tungstenite::Message};
use uuid::Uuid;
type Socket =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;
async fn setup() -> (tempfile::TempDir, Service) {
    let temp = tempfile::tempdir().unwrap();
    let service = Service::open(
        &temp.path().join("test.sqlite3"),
        "test-secret".into(),
        true,
    )
    .await
    .unwrap();
    (temp, service)
}
async fn execute(s: &Service, command: Command) -> CommandRequest {
    let request = CommandRequest {
        command_id: Uuid::new_v4(),
        client_id: Uuid::new_v4(),
        expected_revision: s.snapshot().await.state.revision,
        command,
    };
    assert!(matches!(
        s.command(&request).await,
        ServerMessage::Result { ok: true, .. }
    ));
    request
}
async fn message(s: &mut Socket) -> ServerMessage {
    loop {
        let msg = tokio::time::timeout(std::time::Duration::from_secs(3), s.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        if let Message::Text(t) = msg {
            return serde_json::from_str(&t).unwrap();
        }
    }
}
async fn connect(address: &str, token: &str) -> (Socket, Uuid, Snapshot) {
    let (mut socket, _) = connect_async(address).await.unwrap();
    let id = Uuid::new_v4();
    socket
        .send(
            serde_json::to_string(&ClientMessage::Hello {
                version: 1,
                token: token.into(),
                client_id: id,
            })
            .unwrap()
            .into(),
        )
        .await
        .unwrap();
    let ServerMessage::Snapshot {
        snapshot,
        initial: true,
    } = message(&mut socket).await
    else {
        panic!("Expected authenticated initial snapshot")
    };
    (socket, id, snapshot)
}
#[tokio::test]
async fn duplicate_command_is_durable_and_conflicting_reuse_is_rejected() {
    let (dir, s) = setup().await;
    let request = execute(&s, Command::Start { seconds: 0 }).await;
    for _ in 0..10 {
        s.tick().await;
    }
    let history = s.history().await.unwrap();
    assert!(matches!(history,ServerMessage::History{sessions,..}if sessions.len()==1));
    assert!(matches!(
        s.command(&request).await,
        ServerMessage::Result { ok: true, .. }
    ));
    assert_eq!(s.snapshot().await.state.balance_seconds, 5);
    let restarted = Service::open(&dir.path().join("test.sqlite3"), "test-secret".into(), true)
        .await
        .unwrap();
    assert!(matches!(
        restarted.command(&request).await,
        ServerMessage::Result { ok: true, .. }
    ));
    assert_eq!(restarted.snapshot().await.state.status, Status::Choice);
    assert_eq!(restarted.snapshot().await.state.alarm_id, None);
    let mut reused = request;
    reused.command = Command::Reset;
    assert!(matches!(
        restarted.command(&reused).await,
        ServerMessage::Result { ok: false, .. }
    ));
}
#[tokio::test]
async fn optimistic_concurrent_commands_accept_exactly_one() {
    let (_dir, s) = setup().await;
    let revision = s.snapshot().await.state.revision;
    let a = CommandRequest {
        command_id: Uuid::new_v4(),
        client_id: Uuid::new_v4(),
        expected_revision: revision,
        command: Command::Start { seconds: 0 },
    };
    let mut b = a.clone();
    b.command_id = Uuid::new_v4();
    b.client_id = Uuid::new_v4();
    let (a, b) = tokio::join!(s.command(&a), s.command(&b));
    assert!(matches!(a, ServerMessage::Result { ok: true, .. }));
    assert!(matches!(b, ServerMessage::Result { ok: false, .. }));
}
#[tokio::test]
async fn failed_completion_rolls_back_reward_history_and_checkpoint_then_retries_once() {
    let (dir, s) = setup().await;
    execute(&s, Command::Start { seconds: 0 }).await;
    for _ in 0..9 {
        s.tick().await;
    }
    let pool = sqlx::SqlitePool::connect_with(
        sqlx::sqlite::SqliteConnectOptions::new().filename(dir.path().join("test.sqlite3")),
    )
    .await
    .unwrap();
    sqlx::query("CREATE TRIGGER fail_write BEFORE INSERT ON study_sessions BEGIN SELECT RAISE(ABORT, 'test failure'); END").execute(&pool).await.unwrap();
    s.tick().await;
    let failed = s.snapshot().await;
    assert_eq!(failed.state.status, Status::Paused);
    assert_eq!(failed.state.timer.unwrap().remaining_seconds, 1);
    assert_eq!(failed.state.balance_seconds, 0);
    assert!(failed.storage_error.is_some());
    assert!(
        matches!(s.history().await.unwrap(),ServerMessage::History{sessions,..}if sessions.is_empty())
    );
    sqlx::query("DROP TRIGGER fail_write")
        .execute(&pool)
        .await
        .unwrap();
    execute(&s, Command::RetryStorage).await;
    execute(&s, Command::Resume).await;
    s.tick().await;
    assert_eq!(s.snapshot().await.state.balance_seconds, 5);
    assert!(
        matches!(s.history().await.unwrap(),ServerMessage::History{sessions,..}if sessions.len()==1)
    );
}
#[tokio::test]
async fn two_real_websockets_share_state_alarm_and_reconnect_without_replay() {
    let (_dir, s) = setup().await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = format!("ws://{}/v1/ws", listener.local_addr().unwrap());
    let router = s.router();
    let task = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    let (mut a, id, initial) = connect(&address, "test-secret").await;
    let (mut b, _, _) = connect(&address, "test-secret").await;
    let request = CommandRequest {
        command_id: Uuid::new_v4(),
        client_id: id,
        expected_revision: initial.state.revision,
        command: Command::Start { seconds: 0 },
    };
    a.send(
        serde_json::to_string(&ClientMessage::Command {
            request: request.clone(),
        })
        .unwrap()
        .into(),
    )
    .await
    .unwrap();
    loop {
        if matches!(
            message(&mut a).await,
            ServerMessage::Result { ok: true, .. }
        ) {
            break;
        }
    }
    loop {
        if matches!(message(&mut b).await,ServerMessage::Snapshot{snapshot,..}if snapshot.state.status==Status::Running)
        {
            break;
        }
    }
    execute(&s, Command::Pause).await;
    assert_eq!(s.snapshot().await.state.status, Status::Paused);
    a.close(None).await.unwrap();
    b.close(None).await.unwrap();
    execute(&s, Command::Resume).await;
    for _ in 0..10 {
        s.tick().await;
    }
    assert_eq!(s.snapshot().await.state.status, Status::Alarm);
    let (mut c, _, initial) = connect(&address, "test-secret").await;
    assert_eq!(initial.state.status, Status::Alarm);
    assert!(initial.state.alarm_id.is_some());
    execute(&s, Command::StopAlarm).await;
    loop {
        if matches!(message(&mut c).await,ServerMessage::Snapshot{snapshot,..}if snapshot.state.status==Status::Choice)
        {
            break;
        }
    }
    task.abort();
}
#[tokio::test]
async fn invalid_token_and_protocol_are_rejected() {
    let (_dir, s) = setup().await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = format!("ws://{}/v1/ws", listener.local_addr().unwrap());
    let router = s.router();
    let task = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    for (version, token) in [(1, "wrong"), (2, "test-secret")] {
        let (mut socket, _) = connect_async(&address).await.unwrap();
        socket
            .send(
                serde_json::to_string(&ClientMessage::Hello {
                    version,
                    token: token.into(),
                    client_id: Uuid::new_v4(),
                })
                .unwrap()
                .into(),
            )
            .await
            .unwrap();
        assert!(matches!(
            message(&mut socket).await,
            ServerMessage::Error { .. }
        ));
    }
    task.abort();
}
#[tokio::test]
async fn preview_database_cannot_be_opened_as_normal() {
    let (dir, _s) = setup().await;
    assert!(
        Service::open(&dir.path().join("test.sqlite3"), "x".into(), false)
            .await
            .is_err()
    );
}
