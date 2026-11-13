// Generic JSON config store in userData (settings.json, keybindings.json, ...).
// src/main/config.ts.

use super::{blocking, CmdResult};
use crate::services::{atomic, fsx, paths};
use serde_json::Value;

#[tauri::command]
pub async fn config_load(name: String) -> CmdResult<Value> {
  blocking(move || {
    std::fs::read_to_string(paths::user_file(&name)).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(Value::Null)
  })
  .await
}

#[tauri::command]
pub async fn config_save(name: String, data: Value) -> CmdResult<()> {
  let file = paths::user_file(&name);
  atomic::write(&file, atomic::json_pretty(&data)).await.map_err(|e| fsx::io_err(&e, "open", &file))
}

/// The blocking flush on unload (config:save-sync, relayed by Node).
pub fn save_sync(name: &str, data: &Value) -> bool {
  atomic::write_blocking(&paths::user_file(name), &atomic::json_pretty(data)).is_ok()
}

#[tauri::command]
pub fn config_reveal(name: String) {
  fsx::reveal(&paths::user_file(&name));
}
