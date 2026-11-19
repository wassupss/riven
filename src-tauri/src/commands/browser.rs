// The browser panel's channels (src/main/browser.ts), run by services/browser.rs.
// Each takes the one object (or value) the preload sends. All are async and
// run off the main thread: they wait on WKWebView calls that run there.

use super::{blocking, CmdResult};
use serde_json::Value;
use tauri::Webview;

#[cfg(target_os = "macos")]
use crate::services::browser as b;

fn st<'a>(a: &'a Value, k: &str) -> &'a str {
  a.get(k).and_then(Value::as_str).unwrap_or("")
}

macro_rules! off_main {
  ($body:expr) => {{
    #[cfg(target_os = "macos")]
    {
      blocking(move || $body).await
    }
    #[cfg(not(target_os = "macos"))]
    {
      Ok(Default::default())
    }
  }};
}

#[tauri::command]
pub async fn browser_bookmarks() -> CmdResult<Value> {
  off_main!(b::bookmarks())
}

#[tauri::command]
pub async fn browser_history() -> CmdResult<Value> {
  off_main!(b::history())
}

#[tauri::command]
pub async fn browser_add_bookmark(b: Value) -> CmdResult<()> {
  let bm = b;
  off_main!(b::add_bookmark(bm))
}

#[tauri::command]
pub async fn browser_remove_bookmark(url: Value) -> CmdResult<()> {
  off_main!(b::remove_bookmark(url))
}

#[tauri::command]
pub async fn browser_clear_history() -> CmdResult<()> {
  off_main!(b::clear_history())
}

#[tauri::command]
pub async fn browser_create(a: Value) -> CmdResult<()> {
  off_main!(b::create(st(&a, "id"), st(&a, "url"), a.get("partition").and_then(Value::as_str)))
}

#[tauri::command]
pub async fn browser_navigate(a: Value) -> CmdResult<()> {
  off_main!(b::navigate(st(&a, "id"), st(&a, "url")))
}

#[tauri::command]
pub async fn browser_go(a: Value) -> CmdResult<()> {
  off_main!(b::go(st(&a, "id"), st(&a, "action")))
}

#[tauri::command]
pub async fn browser_destroy(a: Value) -> CmdResult<()> {
  off_main!(b::destroy(st(&a, "id")))
}

#[tauri::command]
pub async fn browser_sync(webview: Webview, a: Value) -> CmdResult<()> {
  let sender = webview.label().to_string();
  off_main!(b::sync(&sender, &a))
}

#[tauri::command]
pub async fn browser_hide_all(hidden: Option<bool>) -> CmdResult<()> {
  off_main!(b::hide_all(hidden.unwrap_or(false)))
}

#[tauri::command]
pub async fn browser_exec_js(a: Value) -> CmdResult<Value> {
  off_main!(b::exec_js(st(&a, "id"), st(&a, "code")))
}

#[tauri::command]
pub async fn browser_capture(a: Value) -> CmdResult<Value> {
  off_main!(b::capture(st(&a, "id")))
}

#[tauri::command]
pub async fn browser_state(a: Value) -> CmdResult<Value> {
  off_main!(b::tab_state(st(&a, "id")))
}

#[tauri::command]
pub async fn browser_set_zoom(a: Value) -> CmdResult<()> {
  let f = a.get("factor").and_then(Value::as_f64).unwrap_or(1.0);
  off_main!(b::set_zoom(st(&a, "id"), f))
}

#[tauri::command]
pub async fn browser_find(a: Value) -> CmdResult<()> {
  off_main!(b::find(st(&a, "id"), st(&a, "text")))
}

#[tauri::command]
pub async fn browser_open_devtools(a: Value) -> CmdResult<()> {
  off_main!(b::open_devtools(st(&a, "id")))
}

#[tauri::command]
pub async fn browser_set_lang(l: Option<String>) -> CmdResult<()> {
  off_main!(b::set_lang(l.as_deref().unwrap_or("ko")))
}

#[tauri::command]
pub async fn browser_suggest(webview: Webview, payload: Value) -> CmdResult<()> {
  let sender = webview.label().to_string();
  off_main!(b::suggest(&sender, &payload))
}

#[tauri::command]
pub async fn browser_bar_menu(a: Value) -> CmdResult<()> {
  off_main!(b::bar_menu_open(st(&a, "id")))
}

#[tauri::command]
pub async fn browser_pick_element(a: Value) -> CmdResult<Value> {
  off_main!(b::pick_element(st(&a, "id")))
}
