use pomo_restbank_server::Service;
use restbank_domain::{Command, Status};
use restbank_protocol::{CommandRequest, ServerMessage};
use std::time::Duration;
use uuid::Uuid;

#[tokio::test]
async fn deadline_clock_finishes_ten_seconds_without_polling_drift() {
    let directory = tempfile::tempdir().unwrap();
    let service = Service::open(&directory.path().join("clock.sqlite3"), "test".into(), true)
        .await
        .unwrap();
    let request = CommandRequest {
        command_id: Uuid::new_v4(),
        client_id: Uuid::new_v4(),
        expected_revision: service.snapshot().await.state.revision,
        command: Command::Start { seconds: 0 },
    };
    let mut events = service.events.subscribe();
    let started = tokio::time::Instant::now();
    assert!(matches!(
        service.command(&request).await,
        ServerMessage::Result { ok: true, .. }
    ));
    let clock = tokio::spawn(service.clone().run_clock());
    tokio::time::timeout(Duration::from_millis(10300), async {
        loop {
            if events.recv().await.unwrap().state.status == Status::Alarm {
                break;
            }
        }
    })
    .await
    .expect("10-second timer drift exceeded 300 ms");
    assert!(started.elapsed() >= Duration::from_millis(9950));
    clock.abort();
}
