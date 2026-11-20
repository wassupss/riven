// Small read-the-machine features (services/tools, services/usage):
// cli:list, ports:list, ports:kill, models:claude, diagnostics:run,
// usage:today, usage:codex.

use super::blocking;
use crate::services::{tools, usage};
use serde_json::Value;

#[tauri::command]
pub async fn cli_list() -> Value {
  blocking(tools::cli_list).await.unwrap_or(Value::Array(vec![]))
}

#[tauri::command]
pub async fn ports_list(folder: String) -> Value {
  tools::ports_list(&folder).await
}

#[tauri::command]
pub async fn ports_kill(folder: String, port: f64, pid: f64) -> Value {
  tools::ports_kill(&folder, port, pid).await
}

#[tauri::command]
pub async fn models_claude(config_dir: Option<String>) -> Value {
  tools::claude_models(config_dir).await
}

#[tauri::command]
pub async fn diagnostics_run(root: Option<String>, kind: Option<String>) -> Value {
  tools::diagnostics_run(&root.unwrap_or_default(), kind.as_deref().unwrap_or("")).await
}

#[tauri::command]
pub async fn usage_today(config_dir: Option<String>) -> Value {
  blocking(move || usage::usage_today(config_dir.as_deref().filter(|d| !d.is_empty()))).await.unwrap_or(Value::Null)
}

#[tauri::command]
pub async fn api_request(opts: Value) -> Value {
  blocking(move || crate::services::http::api_request(&opts)).await.unwrap_or(Value::Null)
}

#[tauri::command]
pub async fn usage_codex() -> Value {
  blocking(usage::usage_codex).await.unwrap_or(Value::Null)
}
