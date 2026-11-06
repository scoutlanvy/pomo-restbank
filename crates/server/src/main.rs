use clap::Parser;
use fs2::FileExt;
use pomo_restbank_server::Service;
use std::{net::SocketAddr, path::PathBuf};
#[derive(Parser)]
#[command(about = "Pomo Restbank — private timer sync server")]
struct Args {
    #[arg(long)]
    preview: bool,
    #[arg(long)]
    listen: Option<SocketAddr>,
    #[arg(long)]
    data_dir: Option<PathBuf>,
}
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args = Args::parse();
    let root = args.data_dir.unwrap_or_else(|| {
        PathBuf::from(std::env::var_os("LOCALAPPDATA").unwrap_or_else(|| ".".into()))
            .join("PomoRestbank")
            .join(if args.preview {
                "preview-server"
            } else {
                "server"
            })
    });
    std::fs::create_dir_all(&root)?;
    let lock = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(root.join("server.lock"))?;
    lock.try_lock_exclusive()
        .map_err(|_| anyhow::anyhow!("Another server is using this data directory"))?;
    let token_path = root.join("token.txt");
    let token = if token_path.exists() {
        std::fs::read_to_string(&token_path)?.trim().to_string()
    } else {
        let value = format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        );
        std::fs::write(&token_path, &value)?;
        value
    };
    anyhow::ensure!(
        token.len() >= 32,
        "Token must contain at least 32 characters"
    );
    let service = Service::open(&root.join("restbank.sqlite3"), token, args.preview).await?;
    let address = args.listen.unwrap_or_else(|| {
        format!("127.0.0.1:{}", if args.preview { 4318 } else { 4317 })
            .parse()
            .unwrap()
    });
    let listener = tokio::net::TcpListener::bind(address).await?;
    println!("Pomo Restbank listening at {}", listener.local_addr()?);
    println!("Token file: {}", token_path.display());
    println!("Data: {} | Preview: {}", root.display(), args.preview);
    let clock = tokio::spawn(service.clone().run_clock());
    axum::serve(listener, service.router())
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    clock.abort();
    drop(lock);
    Ok(())
}
