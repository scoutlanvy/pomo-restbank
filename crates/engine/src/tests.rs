use crate::{
    Engine,
    migration::initialize_local,
    preferences::{Backend, Preferences},
};
use restbank_domain::{Command, Status};
use restbank_protocol::{CommandRequest, ServerMessage};
use sqlx::{Connection, SqliteConnection};
use std::path::Path;
use uuid::Uuid;
async fn command(engine: &Engine, command: Command) {
    let request = CommandRequest {
        command_id: Uuid::new_v4(),
        client_id: Uuid::new_v4(),
        expected_revision: engine.snapshot().await.state.revision,
        command,
    };
    assert!(matches!(
        engine.command(&request).await,
        ServerMessage::Result { ok: true, .. }
    ));
}
async fn source(path: &Path) -> Engine {
    std::fs::create_dir_all(path).unwrap();
    Engine::open(&path.join("restbank.sqlite3"), true)
        .await
        .unwrap()
}
#[tokio::test]
async fn import_copies_history_balance_progress_settings_and_recovers_paused_without_touching_source()
 {
    let temp = tempfile::tempdir().unwrap();
    let from = temp.path().join("server");
    let target = temp.path().join("local");
    let engine = source(&from).await;
    command(
        &engine,
        Command::AddSubject {
            name: "English".into(),
        },
    )
    .await;
    command(&engine, Command::Start { seconds: 0 }).await;
    for _ in 0..10 {
        engine.tick().await;
    }
    command(&engine, Command::StopAlarm).await;
    command(&engine, Command::ContinueFocus).await;
    engine.tick().await;
    // Keep a running checkpoint, like a server killed without graceful shutdown.
    let before = engine.snapshot().await;
    let history = serde_json::to_value(engine.history().await.unwrap()).unwrap();
    drop(engine);
    // The pool may retain its worker briefly after last owner is dropped.
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    let original = std::fs::read(from.join("restbank.sqlite3")).unwrap();
    let backup = initialize_local(&target, Some(&from), true)
        .await
        .unwrap()
        .unwrap();
    assert!(backup.is_file());
    assert_eq!(
        std::fs::read(from.join("restbank.sqlite3")).unwrap(),
        original
    );
    let local = Engine::open(&target.join("restbank.sqlite3"), true)
        .await
        .unwrap();
    let after = local.snapshot().await;
    assert_eq!(after.state.status, Status::Paused);
    assert_eq!(after.state.balance_seconds, before.state.balance_seconds);
    assert_eq!(after.state.shared_progress, before.state.shared_progress);
    assert_eq!(after.state.subjects, before.state.subjects);
    assert_eq!(
        serde_json::to_value(after.state.settings).unwrap(),
        serde_json::to_value(before.state.settings).unwrap()
    );
    assert_eq!(
        serde_json::to_value(after.state.timer).unwrap(),
        serde_json::to_value(before.state.timer).unwrap()
    );
    assert_eq!(
        serde_json::to_value(local.history().await.unwrap()).unwrap(),
        history
    );
    assert_eq!(after.state.balance_seconds, 5);
    assert!(initialize_local(&target, Some(&from), true).await.is_err());
    local.close().await.unwrap();
}
#[tokio::test]
async fn import_refuses_running_source_wrong_mode_and_existing_target() {
    use fs2::FileExt;
    let temp = tempfile::tempdir().unwrap();
    let from = temp.path().join("server");
    let target = temp.path().join("local");
    let engine = source(&from).await;
    engine.close().await.unwrap();
    let lock = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(from.join("server.lock"))
        .unwrap();
    lock.try_lock_exclusive().unwrap();
    assert!(
        initialize_local(&target, Some(&from), true)
            .await
            .unwrap_err()
            .to_string()
            .contains("running")
    );
    assert!(!target.join("restbank.sqlite3").exists());
    drop(lock);
    assert!(initialize_local(&target, Some(&from), false).await.is_err());
    assert!(!target.join("restbank.sqlite3").exists());
    initialize_local(&target, None, true).await.unwrap();
    assert!(initialize_local(&target, Some(&from), true).await.is_err());
}
#[tokio::test]
async fn corrupt_unknown_schema_and_bad_history_do_not_get_repaired_or_overwritten() {
    let temp = tempfile::tempdir().unwrap();
    let from = temp.path().join("server");
    let engine = source(&from).await;
    engine.close().await.unwrap();
    let url = format!("sqlite:{}", from.join("restbank.sqlite3").display());
    let mut db = SqliteConnection::connect(&url).await.unwrap();
    sqlx::query("UPDATE workspace SET schema_version=99")
        .execute(&mut db)
        .await
        .unwrap();
    db.close().await.unwrap();
    let before = std::fs::read(from.join("restbank.sqlite3")).unwrap();
    assert!(
        Engine::open(&from.join("restbank.sqlite3"), true)
            .await
            .is_err()
    );
    assert!(
        initialize_local(&temp.path().join("local"), Some(&from), true)
            .await
            .is_err()
    );
    assert_eq!(
        std::fs::read(from.join("restbank.sqlite3")).unwrap(),
        before
    );
    let corrupt = temp.path().join("corrupt.sqlite3");
    std::fs::write(&corrupt, b"bad database").unwrap();
    assert!(Engine::open(&corrupt, true).await.is_err());
    assert_eq!(std::fs::read(&corrupt).unwrap(), b"bad database");
    let mut db = SqliteConnection::connect(&url).await.unwrap();
    sqlx::query("UPDATE workspace SET schema_version=1")
        .execute(&mut db)
        .await
        .unwrap();
    sqlx::query("INSERT INTO study_sessions(session_id,session_json) VALUES('bad','{}')")
        .execute(&mut db)
        .await
        .unwrap();
    db.close().await.unwrap();
    assert!(
        initialize_local(&temp.path().join("local"), Some(&from), true)
            .await
            .is_err()
    );
    assert!(!temp.path().join("local/restbank.sqlite3").exists());
}
#[tokio::test]
async fn clean_shutdown_pauses_without_awarding_and_preferences_default_local() {
    let temp = tempfile::tempdir().unwrap();
    assert_eq!(
        Preferences::load(temp.path()).unwrap().backend,
        Backend::Local
    );
    let engine = source(temp.path()).await;
    command(&engine, Command::Start { seconds: 0 }).await;
    engine.tick().await;
    engine.close().await.unwrap();
    let reopened = Engine::open(&temp.path().join("restbank.sqlite3"), true)
        .await
        .unwrap();
    let snapshot = reopened.snapshot().await;
    assert_eq!(snapshot.state.status, Status::Paused);
    assert_eq!(snapshot.state.balance_seconds, 0);
    assert_eq!(snapshot.state.timer.unwrap().remaining_seconds, 9);
    reopened.close().await.unwrap();
}
#[tokio::test]
async fn failed_candidate_recovery_keeps_backup_and_never_creates_destination() {
    let temp = tempfile::tempdir().unwrap();
    let from = temp.path().join("server");
    let target = temp.path().join("local");
    let engine = source(&from).await;
    engine.close().await.unwrap();
    let mut db = SqliteConnection::connect(&format!(
        "sqlite:{}",
        from.join("restbank.sqlite3").display()
    ))
    .await
    .unwrap();
    sqlx::query("CREATE TRIGGER fail_recovery BEFORE UPDATE ON workspace BEGIN SELECT RAISE(ABORT,'test recovery failure'); END").execute(&mut db).await.unwrap();
    db.close().await.unwrap();
    let original = std::fs::read(from.join("restbank.sqlite3")).unwrap();
    assert!(initialize_local(&target, Some(&from), true).await.is_err());
    assert!(!target.join("restbank.sqlite3").exists());
    assert_eq!(
        std::fs::read(from.join("restbank.sqlite3")).unwrap(),
        original
    );
    assert!(
        std::fs::read_dir(&target)
            .unwrap()
            .filter_map(Result::ok)
            .any(|entry| entry
                .file_name()
                .to_string_lossy()
                .starts_with("server-backup-"))
    );
}
#[tokio::test]
async fn shutdown_refuses_to_acknowledge_an_unsaved_pause() {
    let temp = tempfile::tempdir().unwrap();
    let engine = source(temp.path()).await;
    command(&engine, Command::Start { seconds: 0 }).await;
    let mut db = SqliteConnection::connect(&format!(
        "sqlite:{}",
        temp.path().join("restbank.sqlite3").display()
    ))
    .await
    .unwrap();
    sqlx::query("CREATE TRIGGER fail_pause BEFORE UPDATE ON workspace BEGIN SELECT RAISE(ABORT,'test shutdown failure'); END").execute(&mut db).await.unwrap();
    assert!(engine.close().await.is_err());
    assert_eq!(engine.snapshot().await.state.status, Status::Running);
    sqlx::query("DROP TRIGGER fail_pause")
        .execute(&mut db)
        .await
        .unwrap();
    db.close().await.unwrap();
    engine.close().await.unwrap();
}

#[test]
fn a_profile_cannot_open_another_backend_before_quit() {
    let temp = tempfile::tempdir().unwrap();
    let first = crate::preferences::lock_profile(temp.path()).unwrap();
    assert!(crate::preferences::lock_profile(temp.path()).is_err());
    drop(first);
    assert!(crate::preferences::lock_profile(temp.path()).is_ok());
}
