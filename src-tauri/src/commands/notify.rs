// notify:show, notify:presence (sends) and notify:diag (services/notify).
// The sender's window label stands in for Electron's webContents id.

use crate::services::notify;
use serde_json::Value;
use tauri::Webview;

#[tauri::command]
pub fn notify_show(webview: Webview, req: Option<Value>) {
  notify::show(webview.label(), &req.unwrap_or(Value::Null))
}

#[tauri::command]
pub fn notify_presence(webview: Webview, p: Option<Value>) {
  notify::presence(webview.label(), &p.unwrap_or(Value::Null))
}

#[tauri::command]
pub fn notify_diag() -> Value {
  notify::diag()
}
