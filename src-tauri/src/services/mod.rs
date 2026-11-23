// What the app does, without knowing how it is called. commands/ wraps these
// as Tauri commands for the page; the Node relay (main.rs dispatch) may call
// them too while Node still runs the groups that are not moved yet.

pub mod agentcli;
pub mod atomic;
pub mod auth;
pub mod backgrounds;
pub mod browser;
pub mod chat;
pub mod clichat;
pub mod collate;
pub mod db;
pub mod debug;
pub mod fsx;
pub mod git;
pub mod http;
pub mod limits;
pub mod remote_key;
pub mod safe_storage;
pub mod lsp;
pub mod mcp;
pub mod notes;
pub mod notify;
pub mod parity;
pub mod paths;
pub mod pet;
pub mod petai;
pub mod power;
pub mod pty;
pub mod search;
pub mod shell_env;
pub mod tools;
pub mod tray;
pub mod update;
pub mod usage;
pub mod util;
pub mod watcher;
pub mod workspace;
