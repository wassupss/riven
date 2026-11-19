// tray:feed / tray:diag (src/main/tray.ts): riven in the macOS menu bar, the
// agents that want you from anywhere. The page reports the whole list whenever
// it changes; this only draws: the count beside the icon (template image, so
// macOS colours it) and a menu that lands on each pane the way a notification
// click does. Never drawn in the background test mode (only `diag` is kept).
//
// One deliberate difference from Electron: a row reads "title · workspace" and
// the tooltip "riven · N" (Electron joins them with an em dash).

use serde_json::{json, Value};
use std::sync::{Mutex, OnceLock};
use tauri::image::Image;
use tauri::menu::{IsMenuItem, Menu, MenuItem, MenuItemKind, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager};

const TRAY_ID: &str = "riven-feed";
const ICON_2X: &str = "iVBORw0KGgoAAAANSUhEUgAAACQAAAAkCAYAAADhAJiYAAACE0lEQVR4AeyXzy4EQRDG8QpuPARXJ9y5iXgFR39OSJDgxpl4AREncecReAhuTl7A99tNzVbXTma7LbMr2U3V1tfVVf1927M9mZmZGrPPRNCgC1K3Qwdqes30M9VFI5fbD1fSHwVRcK6KhUw/VN2l3AxMLrcfLjitfyoK2qxm8sGWK/XYpRthwhkFNXa2MfnvBZ1ql6JfKWcGZv7FEqWxZIcgORFBdP7ISncMzPyqRtNyehTyrURQ/qq9SoQViRpG0Ip48SVFM48txyU0PDAOK+hZDA9yMzA5GxNb2yHI6pxdw/1ctqhhdsgTRhwFxXGsr8ZR0FM1kw8eXanHLt0IE84o6Eit3Es+FKN/KuftS4Nr+bbcDLyuAUdfoWN7+o5r2RguOFXStSiILAvMC0TfUM4b9xwE+Bw4+cVKUBfXsjFcKulZnaDe7AhQnSB+0bu0ROdIK11scR0/hitZMAri4WpXFXM1PqucN/4n3HN2XHJNmLxCZbdCdeuRgwtOlXQtCmLB7kzeN8d535XeCB/LSyzhjIJKFvqT2omgQds62aHf3iGOtPlyw+JWQ2yq61si55JZE0ecI23O2OZitBpiU13s63sv6ytoO1GyQ61oi4Luf8B653o8dulGmHBGQRdq5d38TTHHeTf3jxBgcjm91MAFp+i6FgWRpWBRIMeThyv1YORyeqmBi57K6wRVk6MAYyfoGwAA//9HAhfmAAAABklEQVQDAL8Xf0lNvRxaAAAAAElFTkSuQmCC";

#[derive(Clone, Debug, PartialEq)]
pub enum Row {
  Off(String),
  Sep,
  Pane(String, String),
  Open(String),
  Quit(String),
}

pub fn rows(feed: &Value) -> Vec<Row> {
  let ko = feed.get("ko").and_then(Value::as_bool).unwrap_or(false);
  let l = |k: &str, e: &str| if ko { k.to_string() } else { e.to_string() };
  let items: Vec<&Value> = feed.get("items").and_then(Value::as_array).map(|v| v.iter().collect()).unwrap_or_default();
  let row = |i: &Value| {
    let g = |k: &str| i.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    Row::Pane(format!("{} \u{00b7} {}", g("title"), g("workspace")), g("paneId"))
  };
  let kind = |i: &&Value, k: &str| i.get("kind").and_then(Value::as_str) == Some(k);
  let waiting: Vec<&Value> = items.iter().copied().filter(|i| kind(i, "waiting")).collect();
  let done: Vec<&Value> = items.iter().copied().filter(|i| kind(i, "done")).collect();
  let mut out = Vec::new();
  if !waiting.is_empty() {
    out.push(Row::Off(l("입력을 기다리는 중", "Waiting for you")));
    out.extend(waiting.iter().map(|i| row(i)));
  }
  if !done.is_empty() {
    if !out.is_empty() {
      out.push(Row::Sep);
    }
    out.push(Row::Off(l("끝남 \u{00b7} 아직 안 봄", "Finished \u{00b7} not seen yet")));
    out.extend(done.iter().map(|i| row(i)));
  }
  if out.is_empty() {
    out.push(Row::Off(l("새 알림 없음", "Nothing new")));
  }
  let busy = feed.get("busy").and_then(Value::as_f64).unwrap_or(0.0);
  if busy > 0.0 {
    let n = if busy.fract() == 0.0 { format!("{}", busy as i64) } else { busy.to_string() };
    out.push(Row::Sep);
    out.push(Row::Off(if ko { format!("작업 중인 에이전트 {n}개") } else { format!("{n} agent{} working", if busy == 1.0 { "" } else { "s" }) }));
  }
  out.push(Row::Sep);
  out.push(Row::Open(l("riven 열기", "Open riven")));
  out.push(Row::Quit(l("riven 종료", "Quit riven")));
  out
}

/// tray:diag: what was last drawn {title, labels}.
pub fn diag_of(feed: &Value) -> Value {
  let enabled = feed.get("enabled").and_then(Value::as_bool).unwrap_or(false);
  let count = feed.get("items").and_then(Value::as_array).map(Vec::len).unwrap_or(0);
  let labels: Vec<String> = if enabled {
    rows(feed)
      .into_iter()
      .filter_map(|r| match r {
        Row::Off(s) | Row::Pane(s, _) | Row::Open(s) | Row::Quit(s) => Some(s),
        Row::Sep => None,
      })
      .collect()
  } else {
    vec![]
  };
  json!({ "title": if enabled && count > 0 { count.to_string() } else { String::new() }, "labels": labels })
}

struct State {
  drawn: Value,
  panes: Vec<String>,
}

fn state() -> &'static Mutex<State> {
  static S: OnceLock<Mutex<State>> = OnceLock::new();
  S.get_or_init(|| Mutex::new(State { drawn: json!({ "title": "", "labels": [] }), panes: vec![] }))
}

pub fn diag() -> Value {
  state().lock().unwrap().drawn.clone()
}

pub fn feed(app: &AppHandle, feed: &Value) {
  let rs = rows(feed);
  {
    let mut s = state().lock().unwrap();
    s.drawn = diag_of(feed);
    s.panes = rs.iter().filter_map(|r| if let Row::Pane(_, p) = r { Some(p.clone()) } else { None }).collect();
  }
  if !cfg!(target_os = "macos") || crate::background() {
    return;
  }
  let enabled = feed.get("enabled").and_then(Value::as_bool).unwrap_or(false);
  if !enabled {
    app.remove_tray_by_id(TRAY_ID);
    return;
  }
  let count = feed.get("items").and_then(Value::as_array).map(Vec::len).unwrap_or(0);
  let Ok(menu) = build(app, &rs) else { return };
  let tray = match app.tray_by_id(TRAY_ID) {
    Some(t) => t,
    None => {
      let png = crate::base64_decode(ICON_2X);
      let Ok(icon) = Image::from_bytes(&png) else { return };
      match TrayIconBuilder::with_id(TRAY_ID).icon(icon).icon_as_template(true).show_menu_on_left_click(true).build(app) {
        Ok(t) => t,
        Err(_) => return,
      }
    }
  };
  let _ = tray.set_title(Some(if count > 0 { count.to_string() } else { String::new() }));
  let _ = tray.set_tooltip(Some(if count > 0 { format!("riven \u{00b7} {count}") } else { "riven".into() }));
  let _ = tray.set_menu(Some(menu));
}

fn build(app: &AppHandle, rs: &[Row]) -> tauri::Result<Menu<tauri::Wry>> {
  let mut items: Vec<MenuItemKind<tauri::Wry>> = Vec::new();
  let mut pane = 0;
  for r in rs {
    items.push(match r {
      Row::Sep => MenuItemKind::Predefined(PredefinedMenuItem::separator(app)?),
      Row::Off(t) => MenuItemKind::MenuItem(MenuItem::with_id(app, "riven-tray:off", t, false, None::<&str>)?),
      Row::Pane(t, _) => {
        pane += 1;
        MenuItemKind::MenuItem(MenuItem::with_id(app, format!("riven-tray:pane:{}", pane - 1), t, true, None::<&str>)?)
      }
      Row::Open(t) => MenuItemKind::MenuItem(MenuItem::with_id(app, "riven-tray:open", t, true, None::<&str>)?),
      Row::Quit(t) => MenuItemKind::MenuItem(MenuItem::with_id(app, "riven-tray:quit", t, true, None::<&str>)?),
    });
  }
  let refs: Vec<&dyn IsMenuItem<tauri::Wry>> = items.iter().map(|k| k as &dyn IsMenuItem<tauri::Wry>).collect();
  Menu::with_items(app, &refs)
}

/// A tray menu item was chosen (main thread). True if it was ours.
pub fn on_menu(app: &AppHandle, id: &str) -> bool {
  let Some(rest) = id.strip_prefix("riven-tray:") else { return false };
  let app = app.clone();
  let rest = rest.to_string();
  std::thread::spawn(move || match rest.as_str() {
    "open" => bring_up(&app, None),
    // Quitting goes through before-quit (Node, for now), like Cmd+Q.
    "quit" => crate::emit(json!({ "ev": "quit-requested" })),
    r => {
      if let Some(i) = r.strip_prefix("pane:").and_then(|n| n.parse::<usize>().ok()) {
        let p = state().lock().unwrap().panes.get(i).cloned();
        bring_up(&app, p);
      }
    }
  });
  true
}

// tray.ts bringUp(): restore, show and focus riven's window, then the same
// message a notification click sends.
fn bring_up(app: &AppHandle, pane: Option<String>) {
  let Some(label) = super::browser::app_window() else { return };
  let Some(w) = app.get_window(&label) else { return };
  if crate::background() {
    return;
  }
  if w.is_minimized().unwrap_or(false) {
    let _ = w.unminimize();
  }
  let _ = w.show();
  let _ = w.set_focus();
  if let Some(p) = pane {
    crate::commands::emit_ipc(app, &label, "notify:click", json!([p]));
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn menus_like_tray_ts() {
    let it = |p: &str, t: &str, w: &str, k: &str| json!({ "paneId": p, "title": t, "workspace": w, "kind": k });
    let f = json!({ "enabled": true, "ko": false, "busy": 1, "items": [it("a", "Chat", "riven", "waiting"), it("b", "Term", "ws2", "done")] });
    assert_eq!(
      diag_of(&f),
      json!({ "title": "2", "labels": ["Waiting for you", "Chat \u{00b7} riven", "Finished \u{00b7} not seen yet", "Term \u{00b7} ws2", "1 agent working", "Open riven", "Quit riven"] })
    );
    let f = json!({ "enabled": true, "ko": true, "busy": 3, "items": [] });
    assert_eq!(diag_of(&f), json!({ "title": "", "labels": ["새 알림 없음", "작업 중인 에이전트 3개", "riven 열기", "riven 종료"] }));
    let f = json!({ "enabled": false, "ko": true, "busy": 0, "items": [it("a", "x", "y", "done")] });
    assert_eq!(diag_of(&f), json!({ "title": "", "labels": [] }));
    let f = json!({ "enabled": true, "ko": false, "busy": 0, "items": [it("a", "x", "y", "done")] });
    let r = rows(&f);
    assert_eq!(r[0], Row::Off("Finished \u{00b7} not seen yet".into()));
    assert_eq!(r[1], Row::Pane("x \u{00b7} y".into(), "a".into()));
    assert!(Image::from_bytes(&crate::base64_decode(ICON_2X)).is_ok());
  }
}
