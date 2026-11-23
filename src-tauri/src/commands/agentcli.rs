// What every chat engine uses, whichever runs the pane (services/agentcli):
// past conversations, custom agents, MCP servers, the CLIs, their accounts
// and updates. The channels keep their old names (chat:sessions, ...), so
// the page's window.api.chat.* calls are unchanged.

use crate::services::agentcli::{self, SessionInfo, SessionSummary, UpdateState};
use serde_json::Value;

#[tauri::command]
pub async fn chat_restart(key: Option<String>) -> Value {
  agentcli::restart(key).await
}

#[tauri::command]
pub async fn chat_detect_clis() -> Vec<Value> {
  agentcli::detect_clis().await
}

#[tauri::command]
pub async fn chat_session_info(cwd: String, config_dir: Option<String>) -> SessionInfo {
  agentcli::session_info(cwd, config_dir, false).await
}

#[tauri::command]
pub async fn chat_sessions(cwd: String, config_dir: Option<String>) -> Vec<SessionSummary> {
  agentcli::sessions(cwd, config_dir).await
}

#[tauri::command]
pub async fn chat_session_rename(cwd: String, id: String, title: String, config_dir: Option<String>) -> bool {
  agentcli::session_rename(cwd, id, title, config_dir).await
}

#[tauri::command]
pub async fn chat_session_delete(cwd: String, id: String, config_dir: Option<String>) -> bool {
  agentcli::session_delete(cwd, id, config_dir).await
}

#[tauri::command]
pub async fn chat_agents(cwd: String) -> Vec<Value> {
  agentcli::agents(cwd).await
}

#[tauri::command]
pub async fn chat_session_transcript(cwd: String, id: String, config_dir: Option<String>) -> Vec<Value> {
  agentcli::transcript(cwd, id, config_dir).await
}

#[tauri::command]
pub async fn chat_session_title(cwd: String, id: String, config_dir: Option<String>) -> Option<String> {
  agentcli::session_title(cwd, id, config_dir).await
}

#[tauri::command]
pub async fn chat_mcp_list(cwd: String, config_dir: Option<String>) -> Vec<Value> {
  agentcli::mcp_list(cwd, config_dir).await
}

#[tauri::command]
pub async fn chat_mcp_session(cwd: String, config_dir: Option<String>, fresh: Option<bool>) -> Vec<Value> {
  agentcli::session_info(cwd, config_dir, fresh.unwrap_or(false)).await.mcp_servers
}

#[tauri::command]
pub async fn chat_mcp_logout(cwd: String, name: String, config_dir: Option<String>) -> Value {
  agentcli::mcp_logout(cwd, name, config_dir).await
}

#[tauri::command]
pub async fn chat_mcp_approve(cwd: String, name: String, config_dir: Option<String>) -> Value {
  agentcli::mcp_approve(cwd, name, config_dir).await
}

#[tauri::command]
pub async fn cli_update(cmd: String) -> Option<UpdateState> {
  agentcli::cli_update(cmd).await
}

#[tauri::command]
pub fn cli_update_status() -> Vec<UpdateState> {
  agentcli::cli_update_status()
}

#[tauri::command]
pub async fn cli_apply_update(cmd: String) -> Option<UpdateState> {
  agentcli::cli_apply_update(cmd).await
}

#[tauri::command]
pub fn cli_defer_update(cmd: String) {
  agentcli::cli_defer_update(&cmd)
}

#[tauri::command]
pub fn accounts_profile_dir(id: String) -> String {
  agentcli::profile_dir(&id)
}

#[tauri::command]
pub async fn accounts_logout(config_dir: Option<String>) -> Value {
  agentcli::logout(config_dir).await
}

#[tauri::command]
pub async fn accounts_list(config_dir: Option<String>) -> Vec<Value> {
  agentcli::accounts(config_dir).await
}

#[tauri::command]
pub async fn chat_codex_sessions(cwd: String) -> Vec<SessionSummary> {
  agentcli::codex_sessions(cwd).await
}

#[tauri::command]
pub async fn chat_codex_session_delete(id: String) -> bool {
  agentcli::codex_session_delete(id).await
}
