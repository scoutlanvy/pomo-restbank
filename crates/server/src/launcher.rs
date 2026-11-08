#![cfg_attr(windows, windows_subsystem = "windows")]
use anyhow::{Context, Result};
use clap::Parser;
use std::{
    fs,
    io::{Read, Write},
    net::{SocketAddr, TcpStream},
    path::PathBuf,
    process::{Command, Stdio},
    time::{Duration, Instant},
};

#[derive(Parser)]
struct Args {
    #[arg(long)]
    preview: bool,
    #[arg(long, default_value = "default", value_parser = profile)]
    profile: String,
}
fn profile(value: &str) -> Result<String, String> {
    if value.is_empty()
        || value.len() > 48
        || !value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
    {
        return Err(
            "Profile must contain 1â€“48 ASCII letters, digits, underscores, or hyphens".into(),
        );
    }
    Ok(value.into())
}
fn ready(port: u16) -> bool {
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    (|| -> Result<bool> {
        let mut stream = TcpStream::connect_timeout(&address, Duration::from_millis(300))?;
        stream.set_read_timeout(Some(Duration::from_secs(1)))?;
        stream.set_write_timeout(Some(Duration::from_secs(1)))?;
        stream
            .write_all(b"GET /health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")?;
        let mut response = String::new();
        stream.take(4096).read_to_string(&mut response)?;
        Ok(response.starts_with("HTTP/1.1 200 ")
            && response
                .split_once("\r\n\r\n")
                .is_some_and(|(_, body)| body == "Pomo Restbank server: ready"))
    })()
    .unwrap_or(false)
}
fn hidden(path: PathBuf) -> Command {
    let mut command = Command::new(path);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    command
}
fn run(args: Args) -> Result<()> {
    let directory = std::env::current_exe()?
        .parent()
        .context("Missing executable directory")?
        .to_path_buf();
    let server = directory.join("pomo-restbank-server.exe");
    let client = directory.join("pomo-restbank.exe");
    anyhow::ensure!(
        server.is_file() && client.is_file(),
        "Keep the launcher beside the client and server executables"
    );
    let root =
        PathBuf::from(std::env::var_os("LOCALAPPDATA").context("LOCALAPPDATA is unavailable")?)
            .join("PomoRestbank");
    let port = if args.preview { 4318 } else { 4317 };
    if !ready(port) {
        let mut command = hidden(server);
        if args.preview {
            command.arg("--preview");
        }
        let mut child = command.spawn().context("Cannot start server")?;
        let deadline = Instant::now() + Duration::from_secs(12);
        while !ready(port) {
            if let Some(status) = child.try_wait()? {
                anyhow::bail!(
                    "Server exited ({status}); run the server directly to inspect the error"
                );
            }
            anyhow::ensure!(
                Instant::now() < deadline,
                "Server did not become ready; run the server directly to inspect the error"
            );
            std::thread::sleep(Duration::from_millis(150));
        }
    }
    let directory = root
        .join(if args.preview {
            "preview-clients"
        } else {
            "clients"
        })
        .join(&args.profile);
    fs::create_dir_all(&directory)?;
    let config = directory.join("connection.json");
    if !config.exists() {
        let token = fs::read_to_string(
            root.join(if args.preview {
                "preview-server"
            } else {
                "server"
            })
            .join("token.txt"),
        )?;
        let value = serde_json::json!({"endpoint": format!("ws://127.0.0.1:{port}/v1/ws"), "token": token.trim(), "client_id": uuid::Uuid::new_v4().to_string()});
        let mut temporary = tempfile::NamedTempFile::new_in(&directory)?;
        temporary.write_all(&serde_json::to_vec_pretty(&value)?)?;
        match temporary.persist_noclobber(&config) {
            Ok(_) => {}
            Err(error) if error.error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error.into()),
        }
    }
    let mut command = hidden(client);
    command.args(["--profile", &args.profile]);
    if args.preview {
        command.arg("--preview");
    }
    command.spawn().context("Cannot start client")?;
    Ok(())
}
fn main() {
    if let Err(error) = run(Args::parse()) {
        let message = format!("Pomo Restbank: {error:#}");
        eprintln!("{message}");
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
            let text: Vec<u16> = message.encode_utf16().chain(Some(0)).collect();
            let title: Vec<u16> = "Pomo Restbank".encode_utf16().chain(Some(0)).collect();
            unsafe {
                MessageBoxW(0, text.as_ptr(), title.as_ptr(), 0x10);
            }
        }
        std::process::exit(1);
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn health_requires_success_and_exact_service_body() {
        use std::net::TcpListener;
        for (status, body, expected) in [
            ("200 OK", "Pomo Restbank server: ready", true),
            ("500 Error", "Pomo Restbank server: ready", false),
            ("200 OK", "unrelated service", false),
        ] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let port = listener.local_addr().unwrap().port();
            let server = std::thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                let mut request = Vec::new();
                while !request.ends_with(b"\r\n\r\n") {
                    let mut byte = [0];
                    stream.read_exact(&mut byte).unwrap();
                    request.push(byte[0]);
                }
                write!(
                    stream,
                    "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                )
                .unwrap();
            });
            assert_eq!(ready(port), expected);
            server.join().unwrap();
        }
    }
    #[test]
    fn validates_profile_paths() {
        for name in ["default", "first-2_A", &"a".repeat(48)] {
            assert!(profile(name).is_ok());
        }
        for name in ["", "../server", "a/b", "a\\b", "a b", "Ã©", &"a".repeat(49)] {
            assert!(profile(name).is_err());
        }
    }
}
