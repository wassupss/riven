// Terminals (was src/main/pty.ts + the terminal worker). services/pty has
// the sessions; these only route. Everything but open just enqueues to the
// pty control thread, so these sync commands cost the main thread nothing and
// keep the page's order (a keystroke never overtakes the one before it).

use crate::services::pty::{self, OpenOpts, Opened};
use tauri::Webview;

// The terminal's output goes to the page that opened (or reattached) it.
#[tauri::command]
pub async fn pty_open(webview: Webview, opts: OpenOpts) -> Opened {
  pty::open(webview.label().to_string(), opts).await
}

// Where the page's terminal stream connects (services/pty/stream.rs).
#[derive(serde::Serialize)]
pub struct Stream {
  port: u16,
  token: String,
}

#[tauri::command]
pub fn pty_stream() -> Result<Stream, String> {
  pty::stream::endpoint().map(|(port, token)| Stream { port, token }).ok_or_else(|| "terminal stream unavailable".into())
}

#[tauri::command]
pub fn pty_write(id: String, data: String) {
  pty::write(id, data)
}

#[tauri::command]
pub fn pty_ack(id: String, epoch: f64, processed: f64) {
  pty::ack(id, epoch, processed)
}

#[tauri::command]
pub fn pty_visible(id: String, visible: bool) {
  pty::visible(id, visible)
}

#[tauri::command]
pub fn pty_seen(id: String) {
  pty::seen(id)
}

#[tauri::command]
pub fn pty_resize(id: String, cols: f64, rows: f64) {
  pty::resize(id, cols, rows)
}

#[tauri::command]
pub fn pty_kill(id: String) {
  pty::kill(id)
}

// The name of the Codex conversation a terminal is in (its rollout's first
// user message).
#[tauri::command]
pub async fn pty_codex_session_title(id: serde_json::Value) -> Option<String> {
  let id = id.as_str()?.to_string();
  tokio::task::spawn_blocking(move || crate::services::chat::read_codex_session_title(&id)).await.ok().flatten()
}
