// notes:* (src/main/notes.ts). The note_* MCP tools reach these through the
// renderer, like the Notes panel.

use super::{blocking, CmdResult};
use crate::services::notes::{self, NoteMeta, WriteFileResult};

#[tauri::command]
pub async fn notes_list(ws: String) -> CmdResult<Vec<NoteMeta>> {
  blocking(move || notes::list(&ws)).await
}

#[tauri::command]
pub async fn notes_read(ws: String, note: String) -> CmdResult<Option<String>> {
  blocking(move || notes::read(&ws, &note)).await
}

#[tauri::command]
pub async fn notes_write(ws: String, note: Option<String>, title: String, body: String) -> CmdResult<String> {
  blocking(move || notes::write(&ws, note.as_deref(), &title, &body)).await?
}

#[tauri::command]
pub async fn notes_append(ws: String, note: String, body: String) -> CmdResult<Option<String>> {
  blocking(move || notes::append(&ws, &note, &body)).await?
}

#[tauri::command]
pub async fn notes_delete(ws: String, note: String) -> CmdResult<bool> {
  blocking(move || notes::delete(&ws, &note)).await?
}

#[tauri::command]
pub async fn notes_write_file(ws: String, rel_path: String, body: String, overwrite: Option<bool>) -> CmdResult<WriteFileResult> {
  blocking(move || notes::write_workspace_file(&ws, &rel_path, &body, overwrite.unwrap_or(false))).await?
}

#[tauri::command]
pub async fn notes_save_to_file(ws: String, note: String, rel_path: String, overwrite: Option<bool>) -> CmdResult<WriteFileResult> {
  blocking(move || notes::save_to_file(&ws, &note, &rel_path, overwrite.unwrap_or(false))).await?
}
