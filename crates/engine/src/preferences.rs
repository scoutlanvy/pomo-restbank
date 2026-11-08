use serde::{Deserialize, Serialize};
use std::{
    io::Write,
    path::{Path, PathBuf},
};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Backend {
    #[default]
    Local,
    Server,
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CloseBehavior {
    #[default]
    Tray,
    Quit,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Preferences {
    pub backend: Backend,
    pub close_behavior: CloseBehavior,
}
impl Preferences {
    pub fn load(directory: &Path) -> anyhow::Result<Self> {
        let path = directory.join("application.json");
        match std::fs::read(path) {
            Ok(data) => Ok(serde_json::from_slice(&data)?),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Self::default()),
            Err(e) => Err(e.into()),
        }
    }
    pub fn save(&self, directory: &Path) -> anyhow::Result<()> {
        std::fs::create_dir_all(directory)?;
        let mut file = tempfile::NamedTempFile::new_in(directory)?;
        file.write_all(&serde_json::to_vec_pretty(self)?)?;
        file.as_file().sync_all()?;
        file.persist(directory.join("application.json"))?;
        Ok(())
    }
}
pub fn app_root() -> anyhow::Result<PathBuf> {
    Ok(PathBuf::from(
        std::env::var_os("LOCALAPPDATA")
            .ok_or_else(|| anyhow::anyhow!("LOCALAPPDATA is unavailable"))?,
    )
    .join("PomoRestbank"))
}
pub fn client_directory(root: &Path, preview: bool, profile: &str) -> PathBuf {
    root.join(if preview {
        "preview-clients"
    } else {
        "clients"
    })
    .join(profile)
}
pub fn local_directory(root: &Path, preview: bool) -> PathBuf {
    root.join(if preview { "preview-local" } else { "local" })
}
pub fn server_directory(root: &Path, preview: bool) -> PathBuf {
    root.join(if preview { "preview-server" } else { "server" })
}

/// Held by either backend for the lifetime of a client profile.
/// A launcher may briefly acquire/drop it before starting an optional server.
pub fn lock_profile(directory: &Path) -> anyhow::Result<std::fs::File> {
    std::fs::create_dir_all(directory)?;
    let lock = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(directory.join("client.lock"))?;
    fs2::FileExt::try_lock_exclusive(&lock).map_err(|_| anyhow::anyhow!("This client profile is already open. Choose Quit before changing mode, or use a different Server profile."))?;
    Ok(lock)
}
