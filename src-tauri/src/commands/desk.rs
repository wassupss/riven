// The rest of the desktop channels (phase 7's leftovers): usage:limits,
// remoteKey:*, auth:oauth, app:version, update:*, perm:*, tray:*, pet:*.
// Same names and payloads as their src/main modules (usage.ts, remoteKey.ts,
// auth.ts, update.ts, permissions.ts, tray.ts, pet.ts).

use super::{blocking, CmdResult};
use crate::services::{auth, limits, pet, remote_key, tray, update};
use serde_json::{json, Value};
use tauri::AppHandle;

#[tauri::command]
pub async fn usage_limits(config_dir: Option<String>) -> CmdResult<Value> {
  blocking(move || limits::usage_limits(config_dir.as_deref())).await
}

#[tauri::command]
pub async fn remote_key_available() -> CmdResult<bool> {
  blocking(remote_key::available).await
}

#[tauri::command]
pub async fn remote_key_load() -> CmdResult<Value> {
  blocking(remote_key::load).await
}

#[tauri::command]
pub async fn remote_key_save(k: Option<Value>) -> CmdResult<bool> {
  blocking(move || remote_key::save(&k.unwrap_or(Value::Null))).await?
}

#[tauri::command]
pub async fn auth_oauth(app: AppHandle, authorize_url: String, redirect_to: String) -> CmdResult<String> {
  auth::oauth(app, authorize_url, redirect_to).await
}

#[tauri::command]
pub fn app_version() -> String {
  update::app_version()
}

#[tauri::command]
pub fn update_current() -> Value {
  update::current()
}

#[tauri::command]
pub async fn update_check() -> CmdResult<()> {
  blocking(update::check).await
}

#[tauri::command]
pub async fn update_install() -> CmdResult<()> {
  blocking(update::install).await
}

// ---- permissions (permissions.ts) ----

#[tauri::command]
pub async fn perm_report() -> CmdResult<Value> {
  blocking(|| {
    let mac = cfg!(target_os = "macos");
    #[cfg(target_os = "macos")]
    let media = |k: &str| crate::perm::status(k).unwrap_or_else(|_| json!("unknown"));
    #[cfg(not(target_os = "macos"))]
    let media = |_k: &str| json!("unknown");
    json!({
      // macOS has no query for notification authorisation that does not ask;
      // "unknown" is what permissions.ts reported too.
      "notifications": "unknown",
      "screen": media("screen"),
      "microphone": media("microphone"),
      "camera": media("camera"),
      "supported": mac,
    })
  })
  .await
}

#[tauri::command]
pub async fn perm_ask(kind: Option<String>) -> CmdResult<bool> {
  if !cfg!(target_os = "macos") {
    return Ok(true);
  }
  let kind = kind.unwrap_or_default();
  blocking(move || {
    #[cfg(target_os = "macos")]
    {
      crate::perm::ask(&kind).ok().and_then(|v| v.as_bool()).unwrap_or(false)
    }
    #[cfg(not(target_os = "macos"))]
    {
      let _ = kind;
      true
    }
  })
  .await
}

/// The exact pane of System Settings for each permission.
pub fn pane_url(kind: &str) -> Option<&'static str> {
  Some(match kind {
    "screen" => "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
    "microphone" => "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
    "camera" => "x-apple.systempreferences:com.apple.preference.security?Privacy_Camera",
    "notifications" => "x-apple.systempreferences:com.apple.preference.notifications",
    _ => return None,
  })
}

#[tauri::command]
pub async fn perm_open(kind: Option<String>) -> CmdResult<()> {
  if let Some(url) = pane_url(kind.as_deref().unwrap_or("")) {
    let _ = tokio::process::Command::new("/usr/bin/open").arg(url).status().await;
  }
  Ok(())
}

// ---- tray (tray.ts) ----

#[tauri::command]
pub async fn tray_feed(app: AppHandle, feed: Value) -> CmdResult<()> {
  blocking(move || tray::feed(&app, &feed)).await
}

#[tauri::command]
pub fn tray_diag() -> Value {
  tray::diag()
}

// ---- pet (pet.ts). Window calls wait on the main thread: never run there. ----

#[tauri::command]
pub async fn pet_close() -> CmdResult<()> {
  blocking(move || pet::close()).await
}

#[tauri::command]
pub async fn pet_hide() -> CmdResult<()> {
  blocking(move || pet::hide()).await
}

#[tauri::command]
pub async fn pet_dock() -> CmdResult<()> {
  blocking(move || pet::dock()).await
}

#[tauri::command]
pub async fn pet_is_open() -> CmdResult<bool> {
  blocking(move || pet::is_open()).await
}

#[tauri::command]
pub async fn pet_cursor_inside() -> CmdResult<bool> {
  blocking(move || pet::cursor_inside()).await
}

#[tauri::command]
pub async fn pet_drag_start() -> CmdResult<()> {
  blocking(move || pet::drag_start()).await
}

#[tauri::command]
pub async fn pet_drag_move() -> CmdResult<()> {
  blocking(move || pet::drag_move()).await
}

#[tauri::command]
pub async fn pet_drag_end() -> CmdResult<()> {
  blocking(move || pet::drag_end()).await
}

#[tauri::command]
pub async fn pet_is_on_top() -> CmdResult<bool> {
  blocking(move || pet::is_on_top()).await
}


#[tauri::command]
pub async fn pet_open() -> CmdResult<()> {
  blocking(pet::open).await?
}

#[tauri::command]
pub async fn pet_resize(height: Option<f64>, width: Option<f64>) -> CmdResult<()> {
  let Some(h) = height else { return Ok(()) };
  blocking(move || pet::resize(h, width)).await
}

#[tauri::command]
pub async fn pet_press(key: Option<Value>) -> CmdResult<()> {
  blocking(move || pet::press(&key.unwrap_or(Value::Null))).await
}

#[tauri::command]
pub async fn pet_set_break(min: Option<Value>) -> CmdResult<()> {
  blocking(move || pet::set_break(&min.unwrap_or(Value::Null))).await
}

#[tauri::command]
pub async fn pet_set_on_top(on: Option<Value>) -> CmdResult<()> {
  let on = crate::services::chat::util::truthy(on.as_ref());
  blocking(move || pet::set_on_top(on)).await
}

#[tauri::command]
pub async fn pet_ask_on_top(on: Option<Value>) -> CmdResult<()> {
  let on = crate::services::chat::util::truthy(on.as_ref());
  blocking(move || pet::set_on_top(on)).await
}

#[tauri::command]
pub async fn pet_focusable(on: Option<Value>) -> CmdResult<()> {
  let on = crate::services::chat::util::truthy(on.as_ref());
  blocking(move || pet::focusable(on)).await
}

/// The pet's "Settings" button: bring riven's window up on that settings tab.
#[tauri::command]
pub async fn pet_open_settings(tab: Option<Value>) -> CmdResult<()> {
  let tab = match tab {
    Some(Value::String(t)) => t,
    _ => "pet".to_string(),
  };
  blocking(move || pet::open_settings(&tab)).await
}

#[tauri::command]
pub async fn pet_copy(text: Option<Value>) -> CmdResult<()> {
  blocking(move || pet::copy(&text.unwrap_or(Value::Null))).await
}
