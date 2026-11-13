// What the app does, without knowing how it is called. commands/ wraps these
// as Tauri commands for the page; the Node relay (main.rs dispatch) may call
// them too while Node still runs the groups that are not moved yet.

pub mod atomic;
pub mod chat;
pub mod collate;
pub mod fsx;
pub mod git;
pub mod mcp;
pub mod notes;
pub mod paths;
pub mod pty;
pub mod search;
pub mod shell_env;
pub mod watcher;
pub mod workspace;
