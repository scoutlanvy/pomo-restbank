//! A per-data-directory activation pipe; no network listener or global singleton.
use fs2::FileExt;
use std::{fs::File, path::Path};

pub struct Instance {
    pub _lock: File,
    #[cfg(windows)]
    server: tokio::net::windows::named_pipe::NamedPipeServer,
    #[cfg(windows)]
    name: String,
}
impl Instance {
    pub async fn claim(directory: &Path) -> anyhow::Result<Option<Self>> {
        std::fs::create_dir_all(directory)?;
        let lock = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(directory.join("local.lock"))?;
        #[cfg(windows)]
        {
            use std::hash::{Hash, Hasher};
            use tokio::{
                io::AsyncWriteExt,
                net::windows::named_pipe::{ClientOptions, ServerOptions},
            };
            let mut hash = std::collections::hash_map::DefaultHasher::new();
            directory
                .canonicalize()?
                .to_string_lossy()
                .to_lowercase()
                .hash(&mut hash);
            let name = format!(r"\\.\pipe\PomoRestbank-{:016x}", hash.finish());
            if lock.try_lock_exclusive().is_err() {
                for _ in 0..40 {
                    if let Ok(mut pipe) = ClientOptions::new().open(&name) {
                        pipe.write_all(b"open").await?;
                        return Ok(None);
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                }
                anyhow::bail!(
                    "Local data is already in use; its activation pipe is unavailable. No second timer was started."
                );
            }
            let server = ServerOptions::new()
                .first_pipe_instance(true)
                .reject_remote_clients(true)
                .create(&name)?;
            Ok(Some(Self {
                _lock: lock,
                server,
                name,
            }))
        }
        #[cfg(not(windows))]
        {
            lock.try_lock_exclusive()?;
            Ok(Some(Self { _lock: lock }))
        }
    }
    pub async fn serve(self, app: tauri::AppHandle) {
        #[cfg(windows)]
        {
            use tokio::{io::AsyncReadExt, net::windows::named_pipe::ServerOptions};
            let mut server = self.server;
            loop {
                if server.connect().await.is_err() {
                    break;
                }
                let mut request = [0; 4];
                let read = tokio::time::timeout(
                    std::time::Duration::from_secs(2),
                    server.read_exact(&mut request),
                )
                .await;
                if matches!(read, Ok(Ok(_))) && &request == b"open" {
                    crate::show_window(&app);
                }
                let _ = server.disconnect();
                match ServerOptions::new()
                    .reject_remote_clients(true)
                    .create(&self.name)
                {
                    Ok(next) => server = next,
                    Err(_) => break,
                }
            }
            // _lock stays alive for the entire activation worker.
            std::future::pending::<()>().await;
            drop(self._lock);
        }
        #[cfg(not(windows))]
        {
            let _ = app;
            std::future::pending::<()>().await;
            drop(self);
        }
    }
}
