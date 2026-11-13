// lsp:* (was src/main/lsp.ts). services/lsp owns the server processes.
// lsp:notify is a send (no answer): sync, so it runs in the page's order.

use crate::services::lsp;
use serde_json::Value;
use tauri::Webview;

#[tauri::command]
pub async fn lsp_servers(root_path: String) -> Vec<String> {
  tauri::async_runtime::spawn_blocking(move || lsp::servers(&root_path)).await.unwrap_or_default()
}

#[tauri::command]
pub async fn lsp_start(webview: Webview, server_key: String, root_path: String) -> Result<Value, String> {
  lsp::start(server_key, root_path, webview.label().to_string()).await
}

#[tauri::command]
pub async fn lsp_request(server_key: String, method: String, params: Option<Value>) -> Result<Value, String> {
  lsp::request(server_key, method, params.unwrap_or(Value::Null)).await
}

#[tauri::command]
pub fn lsp_notify(server_key: String, method: String, params: Option<Value>) {
  lsp::notify(server_key, method, params.unwrap_or(Value::Null))
}

#[tauri::command]
pub fn lsp_stop_root(root_path: String) -> usize {
  lsp::stop_root(&root_path)
}
