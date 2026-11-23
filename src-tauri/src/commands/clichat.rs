// CLI chat (experimental, services/clichat): the interactive `claude` in a
// hidden pty, drawn as a chat. Events come back as 'clichat:event'.

use crate::services::clichat::{self, StartOpts};
use serde_json::{Map, Value};
use tauri::Webview;

#[tauri::command]
pub async fn clichat_start(webview: Webview, key: String, opts: StartOpts) -> Result<Value, String> {
  clichat::start(webview.label().to_string(), key, opts).await
}

/// Another conversation (resume, fork, new) or the same one again, in a new
/// process for the pane.
#[tauri::command]
pub async fn clichat_restart(webview: Webview, key: String, opts: StartOpts) -> Result<Value, String> {
  clichat::restart(webview.label().to_string(), key, opts, Vec::new()).await
}

#[tauri::command]
pub fn clichat_send(key: String, text: String, images: Option<Vec<String>>) {
  clichat::send(&key, text, images.unwrap_or_default())
}

#[tauri::command]
pub fn clichat_keys(key: String, data: String) {
  clichat::keys(&key, data)
}

#[tauri::command]
pub fn clichat_menu(key: String, index: usize, text: Option<String>) {
  clichat::menu_pick(&key, index, text)
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

#[tauri::command]
pub fn clichat_question(key: String, id: String, answers: Option<Map<String, Value>>) {
  clichat::answer_question(&key, &id, answers)
}

#[tauri::command]
pub fn clichat_reconfigure(key: String, model: Option<String>, mode: Option<String>) {
  clichat::reconfigure(&key, model, mode)
}

#[tauri::command]
pub fn clichat_rename(key: String, title: String) -> bool {
  clichat::rename(&key, &title)
}

/// Save a pasted/dropped attachment that has no file of its own; returns its
/// path (removed with the pane).
#[tauri::command]
pub async fn clichat_attach(key: String, name: String, data_url: String) -> Result<String, String> {
  tauri::async_runtime::spawn_blocking(move || clichat::attach::save(&key, &name, &data_url)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn clichat_image(key: String, uuid: String, index: usize) -> Option<String> {
  tauri::async_runtime::spawn_blocking(move || clichat::image(&key, &uuid, index)).await.ok().flatten()
}
