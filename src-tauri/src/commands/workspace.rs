// workspace:*, plus image:saveTemp, font:import and scripts:list, which lived
// in src/main/workspace.ts too.

use super::{blocking, CmdResult};
use crate::services::workspace::{self as ws, DirEntry, ImportResult, Scripts};
use crate::services::fsx;
use serde_json::{Map, Value};
use tauri::Window;
use tauri_plugin_dialog::DialogExt;

#[tauri::command]
pub fn workspace_set_roots(roots: Vec<String>) {
  // The media route (page.rs) confines the files it serves to the same roots.
  ws::set_roots(roots);
}

#[tauri::command]
pub async fn workspace_pick_folder(window: Window) -> CmdResult<Option<String>> {
  let d = window.dialog().file().set_parent(&window).set_can_create_directories(true);
  blocking(move || d.blocking_pick_folder().and_then(|p| p.into_path().ok()).map(|p| p.to_string_lossy().into_owned())).await
}

#[tauri::command]
pub async fn workspace_read_dir(dir: String) -> CmdResult<Vec<DirEntry>> {
  blocking(move || ws::read_dir(&dir)).await?
}

#[tauri::command]
pub async fn workspace_list_files(folder: String) -> CmdResult<Vec<String>> {
  blocking(move || ws::list_files(&folder)).await
}

#[tauri::command]
pub async fn workspace_read_file(file: String) -> CmdResult<String> {
  blocking(move || ws::read_file(&file)).await?
}

#[tauri::command]
pub async fn workspace_write_file(file: String, content: String) -> CmdResult<()> {
  ws::assert_confined(&file)?;
  let p = std::path::PathBuf::from(&file);
  crate::services::atomic::write(&p, content.into_bytes()).await.map_err(|e| fsx::io_err(&e, "open", &p))
}

#[tauri::command]
pub async fn workspace_create_file(path: String) -> CmdResult<()> {
  blocking(move || ws::create_file(&path)).await?
}

#[tauri::command]
pub async fn workspace_create_folder(path: String) -> CmdResult<()> {
  blocking(move || ws::create_folder(&path)).await?
}

#[tauri::command]
pub async fn workspace_rename(old_path: String, new_path: String) -> CmdResult<()> {
  blocking(move || ws::rename(&old_path, &new_path)).await?
}

#[tauri::command]
pub async fn workspace_delete(path: String) -> CmdResult<()> {
  blocking(move || ws::delete(&path)).await?
}

#[tauri::command]
pub fn workspace_reveal(path: String) {
  fsx::reveal(std::path::Path::new(&path));
}

#[tauri::command]
pub async fn workspace_import_paths(dest_dir: String, sources: Vec<String>) -> CmdResult<ImportResult> {
  blocking(move || ws::import_paths(&dest_dir, sources)).await?
}

#[tauri::command]
pub async fn workspace_snapshot_contents(folder: String) -> CmdResult<Map<String, Value>> {
  blocking(move || ws::snapshot_contents(&folder)).await
}

#[tauri::command]
pub async fn image_save_temp(data_url: String) -> CmdResult<Option<String>> {
  blocking(move || ws::save_temp_image(&data_url)).await?
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FontFile {
  family: String,
  data_url: String,
}

/// Pick a local font file -> family name + data URL for @font-face.
#[tauri::command]
pub async fn font_import(window: Window) -> CmdResult<Option<FontFile>> {
  use base64::Engine;
  let d = window
    .dialog()
    .file()
    .set_parent(&window)
    .set_title("폰트 파일 가져오기")
    .add_filter("Fonts", &["ttf", "otf", "woff", "woff2"]);
  blocking(move || {
    let Some(file) = d.blocking_pick_file().and_then(|p| p.into_path().ok()) else { return Ok(None) };
    let ext = file.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    let mime = match ext.as_str() {
      "woff2" => "font/woff2",
      "woff" => "font/woff",
      "otf" => "font/otf",
      _ => "font/ttf",
    };
    let buf = std::fs::read(&file).map_err(|e| fsx::io_err(&e, "open", &file))?;
    let family = file.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let b64 = base64::engine::general_purpose::STANDARD.encode(buf);
    Ok(Some(FontFile { family, data_url: format!("data:{mime};base64,{b64}") }))
  })
  .await?
}

#[tauri::command]
pub async fn scripts_list(folder: String) -> CmdResult<Scripts> {
  blocking(move || ws::list_scripts(&folder)).await
}
