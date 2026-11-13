// Commands the page calls with Tauri invoke. One per ipcMain channel a group
// had: 'workspace:readFile' -> workspace_read_file (tauri/shim/rust-owned.ts
// holds the channel list the preload routes here, with the argument names).
//
// Every #[tauri::command] in this directory is allowed for the app's own
// pages by the generated permission set `rust-main` (build.rs scans these
// files), and the handler below refuses any other webview, so the browser
// panel's pages (bv-*) reach nothing.
//
// Main -> page events: emit_ipc() sends {ch, args} as the Tauri event
// 'riven:ipc' to one window; the preload shim hands it to ipcRenderer.on
// listeners exactly like a webContents.send from Node.

pub mod chat;
pub mod config;
pub mod mcp;
pub mod notes;
pub mod pty;
pub mod search;
pub mod sessions;
pub mod watch;
pub mod workspace;

use tauri::ipc::Invoke;
use tauri::{AppHandle, Emitter, EventTarget, Wry};

pub type CmdResult<T> = Result<T, String>;

/// Runs blocking file-system work off the async runtime's worker threads.
pub async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> CmdResult<T> {
  tokio::task::spawn_blocking(f).await.map_err(|e| e.to_string())
}

pub fn emit_ipc(app: &AppHandle, label: &str, ch: &str, args: serde_json::Value) {
  let _ = app.emit_to(
    EventTarget::AnyLabel { label: label.to_string() },
    "riven:ipc",
    serde_json::json!({ "ch": ch, "args": args }),
  );
}

pub(crate) fn app_page(label: &str) -> bool {
  (label.starts_with('w') && label[1..].chars().all(|c| c.is_ascii_digit())) || label.starts_with("pop-")
}

pub fn handler() -> impl Fn(Invoke<Wry>) -> bool + Send + Sync + 'static {
  let inner: Box<dyn Fn(Invoke<Wry>) -> bool + Send + Sync> = Box::new(tauri::generate_handler![
    config::config_load,
    config::config_save,
    config::config_reveal,
    sessions::sessions_load,
    sessions::sessions_save,
    workspace::workspace_set_roots,
    workspace::workspace_pick_folder,
    workspace::workspace_read_dir,
    workspace::workspace_list_files,
    workspace::workspace_read_file,
    workspace::workspace_write_file,
    workspace::workspace_create_file,
    workspace::workspace_create_folder,
    workspace::workspace_rename,
    workspace::workspace_delete,
    workspace::workspace_reveal,
    workspace::workspace_import_paths,
    workspace::workspace_snapshot_contents,
    workspace::image_save_temp,
    workspace::font_import,
    workspace::scripts_list,
    search::search_in_files,
    search::search_replace_in_files,
    notes::notes_list,
    notes::notes_read,
    notes::notes_write,
    notes::notes_append,
    notes::notes_delete,
    notes::notes_write_file,
    notes::notes_save_to_file,
    watch::watch_start,
    watch::watch_stop,
    pty::pty_open,
    pty::pty_stream,
    pty::pty_write,
    pty::pty_ack,
    pty::pty_visible,
    pty::pty_seen,
    pty::pty_resize,
    pty::pty_kill,
    pty::pty_codex_session_title,
    chat::chat_start,
    chat::chat_send,
    chat::chat_alive,
    chat::chat_interrupt,
    chat::chat_restart,
    chat::chat_set_model,
    chat::chat_set_mode,
    chat::chat_stop,
    chat::chat_title,
    chat::chat_detect_clis,
    chat::chat_session_info,
    chat::chat_sessions,
    chat::chat_session_rename,
    chat::chat_session_delete,
    chat::chat_agents,
    chat::chat_session_transcript,
    chat::chat_session_title,
    chat::chat_mcp_list,
    chat::chat_mcp_session,
    chat::chat_mcp_logout,
    chat::chat_mcp_approve,
    chat::cli_update,
    chat::cli_update_status,
    chat::cli_apply_update,
    chat::cli_defer_update,
    chat::accounts_profile_dir,
    chat::accounts_logout,
    chat::accounts_list,
    mcp::mcp_attach,
    mcp::mcp_result,
  ]);
  move |invoke: Invoke<Wry>| {
    let label = invoke.message.webview_ref().label().to_string();
    if !app_page(&label) {
      invoke.resolver.reject(format!("riven: '{}' is not allowed from {label}", invoke.message.command()));
      return true;
    }
    inner(invoke)
  }
}

/// sendSync relayed by Node (tauri/shim/server.ts): the page's blocking flush
/// on unload. Runs on the relay's plain thread, so it may block.
pub fn sync_relay(ch: &str, args: &[serde_json::Value]) -> CmdResult<serde_json::Value> {
  match ch {
    "config:save-sync" => {
      let name = args.first().and_then(|v| v.as_str()).unwrap_or("");
      let data = args.get(1).cloned().unwrap_or(serde_json::Value::Null);
      Ok(config::save_sync(name, &data).into())
    }
    "sessions:save-sync" => {
      let data = args.first().cloned().unwrap_or(serde_json::Value::Null);
      Ok(sessions::save_sync(&data).into())
    }
    _ => Err(format!("no Rust sync handler for '{ch}'")),
  }
}
