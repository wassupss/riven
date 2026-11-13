// watch:start / watch:stop (src/main/bridge.ts). Changes go to the page that
// started the watch as 'fs:changed' batches.

use super::{emit_ipc, CmdResult};
use crate::services::watcher;
use tauri::{AppHandle, Webview};

#[tauri::command]
pub async fn watch_start(app: AppHandle, webview: Webview, folder: String) -> CmdResult<()> {
  let label = webview.label().to_string();
  watcher::start(
    &folder,
    Box::new(move |batch| emit_ipc(&app, &label, "fs:changed", serde_json::json!([batch]))),
  )
}

#[tauri::command]
pub fn watch_stop() {
  watcher::stop();
}
