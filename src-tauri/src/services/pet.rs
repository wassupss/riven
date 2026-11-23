// The desk pet's own window and its 17 channels (src/main/pet.ts): a
// frameless, transparent pane that never takes the keyboard, can sit anywhere
// on the desktop, follows across spaces and floats above other apps only when
// the person asks (settings.petOnTop). It renders src/renderer/pet.html, the
// same device the app embeds; exactly one of the two is live.
//
// The window is Rust's (label "pet", allowed the app's commands like w*). Its
// page reaches only Rust channels (pet:*, config, chat events), so it needs
// nothing from Node.

use serde_json::{json, Value};
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager};

pub const LABEL: &str = "pet";
const BOUNDS_FILE: &str = "pet-window.json";
pub const WIDTH: f64 = 212.0;
pub const HEIGHT: f64 = 330.0;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct R {
  pub x: f64,
  pub y: f64,
  pub w: f64,
  pub h: f64,
}

/// onScreen(): a saved spot is kept only if it lands on a display that exists.
pub fn on_screen(x: f64, y: f64, w: f64, h: f64, areas: &[R]) -> bool {
  areas.iter().any(|a| x + w > a.x + 40.0 && x < a.x + a.w - 40.0 && y + h > a.y && y < a.y + a.h - 40.0)
}

/// screen.getDisplayMatching(): the display a rect overlaps most (the first if none).
pub fn matching(rect: R, displays: &[(R, R)]) -> Option<R> {
  let mut best: Option<(f64, R)> = None;
  for (bounds, work) in displays {
    let ix = (rect.x + rect.w).min(bounds.x + bounds.w) - rect.x.max(bounds.x);
    let iy = (rect.y + rect.h).min(bounds.y + bounds.h) - rect.y.max(bounds.y);
    let area = ix.max(0.0) * iy.max(0.0);
    if best.is_none_or(|(b, _)| area > b) {
      best = Some((area, *work));
    }
  }
  best.map(|(_, w)| w)
}

/// firstSpot(): beside riven, never on top of it. Right of the window, else
/// left, else the display's corner.
pub fn first_spot(app: Option<R>, area: R) -> (f64, f64) {
  let gap = 14.0;
  let bottom = |top: f64| (area.y + 8.0).max(top).min(area.y + area.h - HEIGHT - 8.0);
  if let Some(b) = app {
    let right = b.x + b.w + gap;
    if right + WIDTH <= area.x + area.w {
      return (right, bottom(b.y + b.h - HEIGHT));
    }
    let left = b.x - gap - WIDTH;
    if left >= area.x {
      return (left, bottom(b.y + b.h - HEIGHT));
    }
  }
  (area.x + area.w - WIDTH - 24.0, area.y + area.h - HEIGHT - 24.0)
}

fn js_round(v: f64) -> f64 {
  (v + 0.5).floor()
}

/// pet:resize: the new frame (grown from the bottom edge, left edge kept), or
/// None when it is already that size.
pub fn resized(b: R, height: f64, width: Option<f64>, zoom: f64) -> Option<R> {
  let z = if zoom > 0.0 { zoom } else { 1.0 };
  let h = js_round(height * z).clamp(120.0, 1000.0);
  let w = match width {
    Some(w) if w > 0.0 => js_round(w * z).clamp(100.0, 700.0),
    _ => b.w,
  };
  if b.h == h && b.w == w {
    return None;
  }
  Some(R { x: b.x, y: b.y + (b.h - h), w, h })
}

pub fn inside(c: (f64, f64), b: R) -> bool {
  c.0 >= b.x && c.0 < b.x + b.w && c.1 >= b.y && c.1 < b.y + b.h
}

// ---- runtime ----

static APP: OnceLock<AppHandle> = OnceLock::new();

#[derive(Default)]
struct State {
  // Set while riven closes the window itself: then its closing is not the
  // person putting the pet away (no 'pet:closed').
  self_close: bool,
  grab: Option<(f64, f64, f64, f64)>,
  // The app window the pet belongs to: when it goes, so does the pet.
  owner: Option<String>,
}

fn state() -> &'static Mutex<State> {
  static S: OnceLock<Mutex<State>> = OnceLock::new();
  S.get_or_init(Default::default)
}

pub fn init(app: &AppHandle) {
  let _ = APP.set(app.clone());
}

fn app() -> Option<&'static AppHandle> {
  APP.get()
}

fn win() -> Option<tauri::Window> {
  app()?.get_window(LABEL)
}

/// Every page that may host the device hears it (the app's windows and the pet's).
fn broadcast(ch: &str, args: Value) {
  let Some(app) = app() else { return };
  for label in app.webview_windows().into_keys() {
    if crate::commands::app_page(&label) {
      crate::commands::emit_ipc(app, &label, ch, args.clone());
    }
  }
}

fn bounds(w: &tauri::Window) -> Option<R> {
  let k = w.scale_factor().ok()?;
  let p = w.outer_position().ok()?.to_logical::<f64>(k);
  let s = w.outer_size().ok()?.to_logical::<f64>(k);
  Some(R { x: p.x, y: p.y, w: s.width, h: s.height })
}

fn displays(app: &AppHandle) -> Vec<(R, R)> {
  let r = |v: &Value| R {
    x: v["x"].as_f64().unwrap_or(0.0),
    y: v["y"].as_f64().unwrap_or(0.0),
    w: v["width"].as_f64().unwrap_or(0.0),
    h: v["height"].as_f64().unwrap_or(0.0),
  };
  crate::displays(app)
    .ok()
    .and_then(|v| v.as_array().cloned())
    .unwrap_or_default()
    .iter()
    .map(|d| (r(&d["bounds"]), r(&d["workArea"])))
    .collect()
}

fn read_bounds() -> Option<(f64, f64)> {
  let v: Value = serde_json::from_str(&std::fs::read_to_string(super::paths::user_file(BOUNDS_FILE)).ok()?).ok()?;
  Some((v.get("x")?.as_f64()?, v.get("y")?.as_f64()?))
}

fn save_position() {
  let Some(b) = win().and_then(|w| bounds(&w)) else { return };
  // getPosition() is whole DIP.
  let v = json!({ "x": js_round(b.x) as i64, "y": js_round(b.y) as i64 });
  std::thread::spawn(move || {
    let _ = super::atomic::write_blocking(&super::paths::user_file(BOUNDS_FILE), &super::atomic::json_pretty(&v));
  });
}

/// Shown without activating anything (showInactive), on the main thread.
fn show_inactive(w: tauri::Window) {
  let Some(app) = app() else { return };
  crate::lifecycle::note("pet: show");
  if crate::background() {
    crate::order_back(app, w);
    return;
  }
  #[cfg(target_os = "macos")]
  let _ = app.run_on_main_thread(move || {
    if let Ok(ns) = w.ns_window() {
      let ns = ns as *mut objc2::runtime::AnyObject;
      unsafe {
        let _: () = objc2::msg_send![&*ns, orderFront: std::ptr::null::<objc2::runtime::AnyObject>()];
      }
    }
  });
}

/// pet:open
pub fn open() -> Result<(), String> {
  let app = app().ok_or("no app")?;
  if let Some(w) = win() {
    // Only when it is actually hidden: ordering a visible window forward is
    // another way to drag the whole app forward.
    if !w.is_visible().unwrap_or(true) {
      show_inactive(w);
    }
    return Ok(());
  }
  let ds = displays(app);
  let owner = super::browser::app_window();
  let owner_bounds = owner.as_ref().and_then(|l| app.get_window(l)).and_then(|w| bounds(&w));
  let areas: Vec<R> = ds.iter().map(|(_, w)| *w).collect();
  let spot = match read_bounds() {
    Some((x, y)) if on_screen(x, y, WIDTH, HEIGHT, &areas) => (x, y),
    _ => {
      let area = owner_bounds
        .and_then(|b| matching(b, &ds))
        .or_else(|| areas.first().copied())
        .unwrap_or(R { x: 0.0, y: 0.0, w: 1440.0, h: 900.0 });
      first_spot(owner_bounds, area)
    }
  };
  state().lock().unwrap().owner = owner;
  crate::create_window(
    app,
    &json!({ "label": LABEL, "opts": {
      "width": WIDTH, "height": HEIGHT, "x": spot.0, "y": spot.1, "show": false, "frame": false,
      "transparent": true, "hasShadow": false, "resizable": false, "maximizable": false, "minimizable": false,
      "skipTaskbar": true, "alwaysOnTop": false, "focusable": false, "title": "riven"
    } }),
  )?;
  let w = win().ok_or("pet window did not open")?;
  let _ = w.set_visible_on_all_workspaces(true);
  let a = json!({ "label": LABEL, "url": crate::page::url("pet.html") });
  let app2 = app.clone();
  std::thread::spawn(move || {
    // ready-to-show: once the page has loaded, never stealing focus.
    let _ = crate::navigate(&app2, &a);
    if let Some(w) = app2.get_window(LABEL) {
      show_inactive(w);
    }
  });
  Ok(())
}

/// closePetWindow(): riven closing the window itself.
pub fn close() {
  if let Some(w) = win() {
    state().lock().unwrap().self_close = true;
    let _ = w.close();
  }
}

pub fn hide() {
  close();
  broadcast("pet:hidden", json!([]));
}

pub fn dock() {
  close();
  broadcast("pet:closed", json!([]));
}

pub fn is_open() -> bool {
  win().is_some()
}

pub fn resize(height: f64, width: Option<f64>) {
  let Some(w) = win() else { return };
  let Some(b) = bounds(&w) else { return };
  // The pet page runs at zoom 1 here (no per-origin zoom in WebKit), as under the shim.
  if let Some(n) = resized(b, height, width, 1.0) {
    let _ = w.set_position(LogicalPosition::new(n.x, n.y));
    let _ = w.set_size(LogicalSize::new(n.w, n.h));
  }
}

fn cursor() -> Option<(f64, f64)> {
  let v = crate::cursor(app()?).ok()?;
  Some((v["x"].as_f64()?, v["y"].as_f64()?))
}

pub fn cursor_inside() -> bool {
  let (Some(w), Some(c)) = (win(), cursor()) else { return false };
  bounds(&w).is_some_and(|b| inside(c, b))
}

pub fn drag_start() {
  let (Some(w), Some(c)) = (win(), cursor()) else { return };
  let Some(b) = bounds(&w) else { return };
  state().lock().unwrap().grab = Some((c.0, c.1, js_round(b.x), js_round(b.y)));
}

pub fn drag_move() {
  let Some((cx, cy, wx, wy)) = state().lock().unwrap().grab else { return };
  let (Some(w), Some(c)) = (win(), cursor()) else { return };
  let _ = w.set_position(LogicalPosition::new(wx + c.0 - cx, wy + c.1 - cy));
}

pub fn drag_end() {
  if state().lock().unwrap().grab.take().is_some() {
    save_position();
  }
}

pub fn press(key: &Value) {
  broadcast("pet:press", json!([key]));
}

/// Number(min) || 0
pub fn set_break(min: &Value) {
  let n = match min {
    Value::Number(n) => n.as_f64().unwrap_or(0.0),
    Value::String(s) => s.trim().parse::<f64>().unwrap_or(if s.trim().is_empty() { 0.0 } else { f64::NAN }),
    Value::Bool(b) => *b as i64 as f64,
    _ => 0.0,
  };
  let n = if n.is_nan() { 0.0 } else { n };
  broadcast("pet:break", json!([n]));
}

pub fn set_on_top(on: bool) {
  // Tauri's always-on-top is NSFloatingWindowLevel: Electron's 'floating'.
  if let Some(w) = win() {
    let _ = w.set_always_on_top(on);
  }
  broadcast("pet:onTop", json!([on]));
}

pub fn is_on_top() -> bool {
  win().and_then(|w| w.is_always_on_top().ok()).unwrap_or(false)
}

/// Settings asked for from the pet (its own window has no settings of its
/// own): riven's window comes up and opens them at `tab`.
pub fn open_settings(tab: &str) {
  let Some(app) = app() else { return };
  let Some(label) = super::browser::app_window() else { return };
  if let Some(w) = app.get_window(&label) {
    if !crate::background() {
      if w.is_minimized().unwrap_or(false) {
        let _ = w.unminimize();
      }
      let _ = w.show();
      let _ = w.set_focus();
    }
  }
  crate::commands::emit_ipc(app, &label, "pet:openSettings", json!([tab]));
}

/// Renaming needs a keyboard: focusable for that moment, then given back.
pub fn focusable(on: bool) {
  let Some(w) = win() else { return };
  let _ = w.set_focusable(on);
  if on && !crate::background() {
    let _ = w.set_focus();
  }
}

/// A battle code onto the clipboard (the page's own clipboard refuses an
/// unfocused page). At most 4096 UTF-16 units, as text.slice(0, 4096).
pub fn copy(text: &Value) {
  let Value::String(t) = text else { return };
  let t = super::chat::util::utf16_prefix(t, 4096).to_string();
  use std::io::Write;
  if let Ok(mut c) = std::process::Command::new("/usr/bin/pbcopy").env("LANG", "en_US.UTF-8").stdin(std::process::Stdio::piped()).spawn() {
    if let Some(mut i) = c.stdin.take() {
      let _ = i.write_all(t.as_bytes());
    }
    let _ = c.wait();
  }
}

/// Window events (main thread: no waiting here).
pub fn on_window(label: &str, ev: &tauri::WindowEvent) {
  match ev {
    tauri::WindowEvent::Moved(_) if label == LABEL => save_position(),
    tauri::WindowEvent::Destroyed if label == LABEL => {
      let mut s = state().lock().unwrap();
      s.grab = None;
      s.owner = None;
      if std::mem::take(&mut s.self_close) {
        return;
      }
      drop(s);
      broadcast("pet:closed", json!([]));
    }
    // The pet is riven's, not its own app: when the workbench goes, so does it.
    tauri::WindowEvent::Destroyed => {
      let owner = state().lock().unwrap().owner.clone();
      if owner.as_deref() == Some(label) {
        std::thread::spawn(close);
      }
    }
    _ => {}
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  const AREA: R = R { x: 0.0, y: 25.0, w: 1440.0, h: 875.0 };

  #[test]
  fn spots_like_pet_ts() {
    assert_eq!(first_spot(Some(R { x: 100.0, y: 100.0, w: 800.0, h: 600.0 }), AREA), (914.0, 370.0));
    assert_eq!(first_spot(Some(R { x: 400.0, y: 50.0, w: 1000.0, h: 900.0 }), AREA), (174.0, 562.0));
    assert_eq!(first_spot(Some(R { x: 0.0, y: 25.0, w: 1440.0, h: 875.0 }), AREA), (1204.0, 546.0));
    assert_eq!(first_spot(None, AREA), (1204.0, 546.0));
    assert_eq!(first_spot(Some(R { x: 100.0, y: 30.0, w: 300.0, h: 200.0 }), AREA), (414.0, 33.0));
    assert!(on_screen(100.0, 100.0, WIDTH, HEIGHT, &[AREA]));
    assert!(!on_screen(1420.0, 100.0, WIDTH, HEIGHT, &[AREA]));
    assert!(!on_screen(100.0, 880.0, WIDTH, HEIGHT, &[AREA]));
    assert!(on_screen(2000.0, 100.0, WIDTH, HEIGHT, &[AREA, R { x: 1440.0, y: 0.0, w: 1920.0, h: 1080.0 }]));
    let ds = [(R { x: 0.0, y: 0.0, w: 1440.0, h: 900.0 }, AREA), (R { x: 1440.0, y: 0.0, w: 1920.0, h: 1080.0 }, R { x: 1440.0, y: 0.0, w: 1920.0, h: 1050.0 })];
    assert_eq!(matching(R { x: 1300.0, y: 0.0, w: 600.0, h: 400.0 }, &ds), Some(ds[1].1));
    assert_eq!(matching(R { x: 5000.0, y: 0.0, w: 10.0, h: 10.0 }, &ds), Some(ds[0].1));
  }

  #[test]
  fn resize_like_pet_ts() {
    let b = R { x: 10.0, y: 500.0, w: 212.0, h: 330.0 };
    assert_eq!(resized(b, 400.0, None, 1.0), Some(R { x: 10.0, y: 430.0, w: 212.0, h: 400.0 }));
    assert_eq!(resized(b, 50.0, Some(90.0), 1.0), Some(R { x: 10.0, y: 710.0, w: 100.0, h: 120.0 }));
    assert_eq!(resized(b, 330.0, None, 1.0), None);
    assert_eq!(resized(b, 2000.0, Some(900.0), 1.2), Some(R { x: 10.0, y: -170.0, w: 700.0, h: 1000.0 }));
    assert_eq!(resized(b, 300.4, Some(0.0), 1.0), Some(R { x: 10.0, y: 530.0, w: 212.0, h: 300.0 }));
    assert!(inside((10.0, 500.0), b));
    assert!(!inside((222.0, 500.0), b));
  }
}
