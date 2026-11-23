// CLI chat (experimental, services/clichat): the interactive `claude` in a
// hidden pty, drawn as a chat. Events come back as 'clichat:event'.

use crate::services::clichat::{self, StartOpts};
use tauri::Webview;

#[tauri::command]
pub async fn clichat_start(webview: Webview, key: String, opts: StartOpts) -> Result<serde_json::Value, String> {
  clichat::start(webview.label().to_string(), key, opts).await
}

#[tauri::command]
pub fn clichat_send(key: String, text: String) {
  clichat::send(&key, text)
}

#[tauri::command]
pub fn clichat_keys(key: String, data: String) {
  clichat::keys(&key, data)
}

#[tauri::command]
pub fn clichat_interrupt(key: String) {
  clichat::interrupt(&key)
}

#[tauri::command]
pub fn clichat_stop(key: String) {
  clichat::stop(&key)
}

#[tauri::command]
pub fn clichat_terminal(key: String, on: bool) {
  clichat::set_terminal(&key, on)
}

#[tauri::command]
pub fn clichat_answer(key: String, id: String, decision: String) {
  clichat::answer(&key, &id, &decision)
}
