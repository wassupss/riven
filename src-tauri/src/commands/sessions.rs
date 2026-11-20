// The multi-workspace session snapshot, userData/sessions.json.
// src/main/sessions.ts.

use super::{blocking, CmdResult};
use crate::services::{atomic, fsx, paths};
use serde_json::Value;
use std::path::PathBuf;

fn store_file() -> PathBuf {
  paths::user_data().join("sessions.json")
}

#[tauri::command]
pub async fn sessions_load() -> CmdResult<Value> {
  blocking(|| std::fs::read_to_string(store_file()).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(Value::Null)).await
}

#[tauri::command]
pub async fn sessions_save(data: Value) -> CmdResult<()> {
  let file = store_file();
  atomic::write(&file, atomic::json_pretty(&data)).await.map_err(|e| fsx::io_err(&e, "open", &file))
}

