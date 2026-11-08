use crate::{Engine, validate_database};
use fs2::FileExt;
use sqlx::{Connection, SqliteConnection, sqlite::SqliteConnectOptions};
use std::{
    fs::OpenOptions,
    path::{Path, PathBuf},
};

/// Only call with the application's own server directory, never an arbitrary file picker.
/// The caller owns the Local directory lock for the entire operation.
pub async fn initialize_local(
    target: &Path,
    source: Option<&Path>,
    preview: bool,
) -> anyhow::Result<Option<PathBuf>> {
    let destination = target.join("restbank.sqlite3");
    anyhow::ensure!(
        !destination.exists(),
        "Local data already exists. Import cannot overwrite it."
    );
    std::fs::create_dir_all(target)?;
    let staging = tempfile::tempdir_in(target)?;
    let candidate = staging.path().join("restbank.sqlite3");
    let mut backup = None;
    // Keep the source lock alive through validation and final activation.
    let _source_lock = if let Some(source) = source {
        anyhow::ensure!(
            source.join("restbank.sqlite3").is_file(),
            "No Pomo Restbank server database was found on this laptop."
        );
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(source.join("server.lock"))?;
        lock.try_lock_exclusive().map_err(|_| anyhow::anyhow!("The source server is running. Stop that Pomo Restbank server, then Retry. No process was stopped."))?;
        validate_database(&source.join("restbank.sqlite3"), preview).await?;
        let backup_path = target.join(format!(
            "server-backup-{}-{}.sqlite3",
            chrono::Utc::now().format("%Y%m%dT%H%M%SZ"),
            uuid::Uuid::new_v4().simple()
        ));
        let options = SqliteConnectOptions::new()
            .filename(source.join("restbank.sqlite3"))
            .read_only(true);
        let mut db = SqliteConnection::connect_with(&options).await?;
        let snapshot = sqlx::query("VACUUM INTO ?")
            .bind(backup_path.to_string_lossy().as_ref())
            .execute(&mut db)
            .await;
        db.close().await?;
        snapshot?;
        backup = Some(backup_path.clone());
        std::fs::copy(&backup_path, &candidate)?;
        Some(lock)
    } else {
        None
    };
    let engine = Engine::open(&candidate, preview).await?;
    engine.history().await.map_err(anyhow::Error::msg)?;
    engine.close().await?;
    validate_database(&candidate, preview).await?;
    // Same-volume atomic, non-clobbering activation. Windows and Unix both support hard links.
    std::fs::hard_link(&candidate, &destination)?;
    Ok(backup)
}
