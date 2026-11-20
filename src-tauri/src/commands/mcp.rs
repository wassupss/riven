// riven's MCP tools (services/mcp): the app page that performs tool calls
// says it is listening, and answers each 'mcp:invoke'.

use serde_json::Value;
use tauri::Webview;

// The preload sends this when App.tsx starts listening for 'mcp:invoke'.
#[tauri::command]
pub fn mcp_attach(webview: Webview) {
  crate::services::mcp::attach(webview.label());
}

#[tauri::command]
pub fn mcp_result(payload: Value) {
  crate::services::mcp::page_result(&payload);
}
