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

#[tauri::command]
pub fn config_reveal(name: String) {
  fsx::reveal(&paths::user_file(&name));
}

// ---- background:import / background:remove ----------------------------------
// Panel background images (services/backgrounds.rs, src/main/backgrounds.ts).

#[tauri::command]
pub async fn background_import(data_url: String) -> CmdResult<String> {
  blocking(move || crate::services::backgrounds::import(&data_url)).await?
}

/// Delete every stored background not in `keep`, the names the page's settings
/// and saved panes still use; returns how many went.
#[tauri::command]
pub async fn background_gc(keep: Vec<String>) -> CmdResult<usize> {
  blocking(move || crate::services::backgrounds::collect(&keep)).await
}
