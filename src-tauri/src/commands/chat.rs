// Agent chat (was src/main/agentChat.ts + codexChat.ts). services/chat owns
// the CLI children; these route. The fire-and-forget ones (send, interrupt,
// setModel, setMode, stop) are sync, so they run in the page's order.

use crate::services::chat::{self, SessionInfo, SessionSummary, StartOpts, UpdateState};
use serde_json::Value;
use tauri::Webview;

// Events for the pane go to the page that started (or reattached) it.
#[tauri::command]
pub async fn chat_start(webview: Webview, key: String, opts: StartOpts) -> Value {
  chat::start(key, opts, webview.label().to_string()).await
}

#[tauri::command]
pub fn chat_send(webview: Webview, key: String, text: Option<String>, images: Option<Vec<Value>>, turn: Option<String>) {
  chat::send(webview.label().to_string(), key, text.unwrap_or_default(), images, turn)
}

#[tauri::command]
pub fn chat_alive(key: String) -> Value {
  chat::alive(&key)
}

#[tauri::command]
pub fn chat_interrupt(key: String) {
  chat::interrupt(&key)
}

#[tauri::command]
pub async fn chat_restart(key: Option<String>) -> Value {
  chat::restart(key).await
}

#[tauri::command]
pub fn chat_set_model(key: String, model: String) {
  chat::set_model(&key, &model)
}

#[tauri::command]
pub fn chat_set_mode(key: String, mode: String) {
  chat::set_mode(&key, &mode)
}

#[tauri::command]
pub fn chat_stop(key: String) {
  chat::stop(&key)
}

#[tauri::command]
pub async fn chat_title(message: String) -> String {
  chat::title(message).await
}

#[tauri::command]
pub async fn chat_detect_clis() -> Vec<Value> {
  chat::detect_clis().await
}

#[tauri::command]
pub async fn chat_session_info(cwd: String, config_dir: Option<String>) -> SessionInfo {
  chat::session_info(cwd, config_dir, false).await
}

#[tauri::command]
pub async fn chat_sessions(cwd: String, config_dir: Option<String>) -> Vec<SessionSummary> {
  chat::sessions(cwd, config_dir).await
}

#[tauri::command]
pub async fn chat_session_rename(cwd: String, id: String, title: String, config_dir: Option<String>) -> bool {
  chat::session_rename(cwd, id, title, config_dir).await
}

#[tauri::command]
pub async fn chat_session_delete(cwd: String, id: String, config_dir: Option<String>) -> bool {
  chat::session_delete(cwd, id, config_dir).await
}

#[tauri::command]
pub async fn chat_agents(cwd: String) -> Vec<Value> {
  chat::agents(cwd).await
}

#[tauri::command]
pub async fn chat_session_transcript(cwd: String, id: String, config_dir: Option<String>) -> Vec<Value> {
  chat::transcript(cwd, id, config_dir).await
}

#[tauri::command]
pub async fn chat_session_title(cwd: String, id: String, config_dir: Option<String>) -> Option<String> {
  chat::session_title(cwd, id, config_dir).await
}

#[tauri::command]
pub async fn chat_mcp_list(cwd: String, config_dir: Option<String>) -> Vec<Value> {
  chat::mcp_list(cwd, config_dir).await
}

#[tauri::command]
pub async fn chat_mcp_session(cwd: String, config_dir: Option<String>, fresh: Option<bool>) -> Vec<Value> {
  chat::session_info(cwd, config_dir, fresh.unwrap_or(false)).await.mcp_servers
}

#[tauri::command]
pub async fn chat_mcp_logout(cwd: String, name: String, config_dir: Option<String>) -> Value {
  chat::mcp_logout(cwd, name, config_dir).await
}

#[tauri::command]
pub async fn chat_mcp_approve(cwd: String, name: String, config_dir: Option<String>) -> Value {
  chat::mcp_approve(cwd, name, config_dir).await
}

#[tauri::command]
pub async fn cli_update(cmd: String) -> Option<UpdateState> {
  chat::cli_update(cmd).await
}

#[tauri::command]
pub fn cli_update_status() -> Vec<UpdateState> {
  chat::cli_update_status()
}

#[tauri::command]
pub async fn cli_apply_update(cmd: String) -> Option<UpdateState> {
  chat::cli_apply_update(cmd).await
}

#[tauri::command]
pub fn cli_defer_update(cmd: String) {
  chat::cli_defer_update(&cmd)
}

#[tauri::command]
pub fn accounts_profile_dir(id: String) -> String {
  chat::profile_dir(&id)
}

#[tauri::command]
pub async fn accounts_logout(config_dir: Option<String>) -> Value {
  chat::logout(config_dir).await
}

#[tauri::command]
pub async fn accounts_list(config_dir: Option<String>) -> Vec<Value> {
  chat::accounts(config_dir).await
}
