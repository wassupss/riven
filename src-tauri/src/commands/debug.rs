// debug:* (was src/main/debugger.ts). services/debug owns the session.

use crate::services::debug;
use serde_json::Value;
use tauri::Webview;

#[tauri::command]
pub async fn debug_start(webview: Webview, cfg: Value) -> Value {
  debug::start(cfg, webview.label().to_string()).await
}

#[tauri::command]
pub fn debug_stop(webview: Webview) -> Value {
  debug::stop(webview.label())
}

#[tauri::command]
pub async fn debug_continue() -> Value {
  debug::step("Debugger.resume").await
}

#[tauri::command]
pub async fn debug_step_over() -> Value {
  debug::step("Debugger.stepOver").await
}

#[tauri::command]
pub async fn debug_step_into() -> Value {
  debug::step("Debugger.stepInto").await
}

#[tauri::command]
pub async fn debug_step_out() -> Value {
  debug::step("Debugger.stepOut").await
}

#[tauri::command]
pub async fn debug_set_breakpoints(file: String, lines: Vec<i64>) -> Value {
  debug::set_breakpoints(file, lines).await
}

#[tauri::command]
pub async fn debug_get_properties(object_id: String) -> Value {
  debug::get_properties(object_id).await
}

#[tauri::command]
pub async fn debug_evaluate(call_frame_id: String, expression: String) -> Value {
  debug::evaluate(call_frame_id, expression).await
}
