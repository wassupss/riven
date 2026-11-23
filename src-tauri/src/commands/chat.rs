// The headless agent chat (was src/main/agentChat.ts + codexChat.ts).
// services/chat owns the CLI children; these route. The fire-and-forget ones
// (send, interrupt, setModel, setMode, stop) are sync, so they run in the
// page's order. What any chat engine uses (past sessions, MCP, accounts,
// updates) is commands/agentcli.rs.

use crate::services::chat::{self, StartOpts};
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
