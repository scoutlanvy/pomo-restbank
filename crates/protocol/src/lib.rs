use restbank_domain::{Command, Session, State};
use serde::{Deserialize, Serialize};
use uuid::Uuid;
pub const PROTOCOL_VERSION: u8 = 1;
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CommandRequest {
    pub command_id: Uuid,
    pub client_id: Uuid,
    pub expected_revision: u64,
    pub command: Command,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientMessage {
    Hello {
        version: u8,
        token: String,
        client_id: Uuid,
    },
    Command {
        request: CommandRequest,
    },
    History,
    Ping,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Snapshot {
    pub state: State,
    pub server_time_ms: i64,
    pub storage_error: Option<String>,
    pub preview: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Summary {
    pub subject: String,
    pub duration_seconds: u64,
    pub count: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerMessage {
    Snapshot {
        snapshot: Snapshot,
        initial: bool,
    },
    Result {
        command_id: Uuid,
        ok: bool,
        error: Option<String>,
        snapshot: Snapshot,
    },
    History {
        sessions: Vec<Session>,
        summary: Vec<Summary>,
    },
    Error {
        message: String,
    },
    Pong,
}
