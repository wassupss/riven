// Chat titles (services/chat). Everything else a chat pane does is the CLI chat
// (commands/clichat.rs); what any chat engine uses (past sessions, MCP, accounts,
// updates) is commands/agentcli.rs.

use crate::services::chat;

#[tauri::command]
pub async fn chat_title(message: String) -> String {
  chat::title(message).await
}
