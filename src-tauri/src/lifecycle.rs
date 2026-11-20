// The app's life, formerly src/main/index.ts (with menu.ts, systemResume.ts,
// focusTrace.ts and appWindow.ts) run by Node: the main window, the menu,
// quitting (with the confirmation when agents are working), flushing the
// page's saves before a window or the app goes, waking from sleep, and the
// visibility the page cannot see for itself.

use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{mpsc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Manager};

use crate::commands::{app_page, emit_ipc};

static NEXT_WIN: AtomicU32 = AtomicU32::new(1);
static QUITTING: AtomicBool = AtomicBool::new(false);

fn main_label(label: &str) -> bool {
  label.starts_with('w') && label.len() > 1 && label[1..].chars().all(|c| c.is_ascii_digit())
}

/// The app's windows (w<n>), oldest first.
pub fn main_windows(app: &AppHandle) -> Vec<String> {
  let mut ws: Vec<(u64, String)> =
    app.windows().into_keys().filter(|l| main_label(l)).map(|l| (l[1..].parse().unwrap_or(u64::MAX), l)).collect();
  ws.sort();
  ws.into_iter().map(|(_, l)| l).collect()
}

// ---- the main window (index.ts createWindow) -------------------------------------

/// A new riven window with the app page in it. Shown once the page has loaded
/// (ready-to-show), or ordered behind everything in the background test mode.
/// The first one carries the old origin's localStorage over first (lsmigrate.rs).
pub fn open_main(app: &AppHandle, carry: Option<serde_json::Map<String, Value>>) -> Result<String, String> {
  let label = format!("w{}", NEXT_WIN.fetch_add(1, Ordering::Relaxed));
  crate::create_window(
    app,
    &json!({ "label": label, "opts": {
      "width": 1600, "height": 1000, "show": false, "titleBarStyle": "hiddenInset", "backgroundColor": "#1e1e1e", "title": "riven"
    } }),
  )?;
  if let Some(old) = carry {
    crate::lsmigrate::write(app, &label, old);
  }
  crate::navigate(app, &json!({ "label": label, "url": crate::page::url("index.html") }))?;
  if let Some(w) = app.get_window(&label) {
    note(&format!("show {label}"));
    if crate::background() {
      crate::order_back(app, w);
    } else {
      let _ = w.show();
      let _ = w.set_focus();
    }
  }
  visibility(app, &label);
  crate::demo::attach(app, &label);
  Ok(label)
}

/// win:visibility: WebKit keeps document.visibilityState 'visible' for a
/// minimized window, so every "stop when nobody is looking" rule in the page
/// needs to be told (Electron's main did the same).
pub fn visibility(app: &AppHandle, label: &str) {
  let Some(w) = app.get_window(label) else { return };
  let hidden = w.is_minimized().unwrap_or(false) || !w.is_visible().unwrap_or(true);
  emit_ipc(app, label, "win:visibility", json!([{ "hidden": hidden }]));
}

// ---- flushing the page's saves --------------------------------------------------

/// What a page runs before it goes: its beforeunload handlers (settings.ts and
/// session.ts flush their debounced saves there), then the wait for those
/// saves to land (the preload's __rivenSettle: the save invokes in flight).
/// WKWebView fires neither beforeunload nor pagehide when a window closes or
/// the app quits, so Rust runs this itself.
pub const FLUSH_JS: &str =
  "(async () => { if (!window.__rivenUnloading) dispatchEvent(new Event('beforeunload')); if (window.__rivenSettle) await window.__rivenSettle(); return 1 })()";

/// Run the page's beforeunload and wait for its saves (at most 3s).
pub fn flush_page(app: &AppHandle, label: &str) {
  let (tx, rx) = mpsc::channel();
  let (app, a) = (app.clone(), json!({ "label": label, "code": FLUSH_JS, "expr": true }));
  std::thread::spawn(move || {
    let _ = tx.send(crate::browser::dispatch(&app, "wv.exec", &a));
  });
  match rx.recv_timeout(Duration::from_secs(3)) {
    Ok(Err(e)) => eprintln!("[flush] {e}"),
    Err(_) => eprintln!("[flush] page did not answer in 3s"),
    Ok(Ok(_)) => {}
  }
}

/// The menu's Reload: the page's saves first, then the reload.
pub fn reload(app: &AppHandle, label: &str) {
  flush_page(app, label);
  if let Some(v) = app.get_webview(label) {
    let _ = v.eval("location.reload()");
  }
}

// ---- quitting (index.ts before-quit) ----------------------------------------------

/// The quit confirmation's text: (buttons [cancel, quit], message, detail).
pub fn quit_prompt(running: usize, korean: bool) -> (Vec<String>, String, String) {
  if korean {
    (
      vec!["취소".into(), "종료".into()],
      format!("에이전트 {running}개가 작업 중입니다"),
      "지금 종료하면 진행 중인 작업이 중단됩니다.".into(),
    )
  } else {
    (
      vec!["Cancel".into(), "Quit".into()],
      format!("{running} agent(s) are still working"),
      "Quitting now stops that work.".into(),
    )
  }
}

/// The app's own language, read from the settings the page saves (Korean
/// unless it says 'en', as the UI defaults).
pub fn korean(settings: Option<&str>) -> bool {
  settings
    .and_then(|s| serde_json::from_str::<Value>(s).ok())
    .and_then(|v| v.get("language").and_then(Value::as_str).map(|l| l != "en"))
    .unwrap_or(true)
}

/// What quitting would cut off: chat turns running + terminal agents working.
pub fn busy() -> (usize, usize) {
  (crate::services::chat::running_count(), crate::services::pty::working_count())
}

/// Cmd+Q, the tray's Quit, the Dock's Quit, logout. Asks first when agents
/// are working (a turn the user had forgotten is exactly the one they would
/// not want to lose), then flushes every app window and exits. Off the main
/// thread: the dialog and the flush wait.
pub fn request_quit(app: &AppHandle) {
  if QUITTING.swap(true, Ordering::SeqCst) {
    return;
  }
  let app = app.clone();
  std::thread::spawn(move || {
    let (chat, term) = busy();
    let running = chat + term;
    if running > 0 && !confirm_quit(&app, running) {
      QUITTING.store(false, Ordering::SeqCst);
      return;
    }
    quit_now(&app);
  });
}

/// Flush and exit, no questions (the test hook's quit, RIVEN_CAPTURE, the demo).
pub fn quit_now(app: &AppHandle) {
  QUITTING.store(true, Ordering::SeqCst);
  for label in main_windows(app) {
    flush_page(app, &label);
  }
  app.exit(0);
}

fn confirm_quit(app: &AppHandle, running: usize) -> bool {
  let settings = std::fs::read_to_string(crate::services::paths::user_file("settings.json")).ok();
  let (buttons, message, detail) = quit_prompt(running, korean(settings.as_deref()));
  let parent = main_windows(app).into_iter().next();
  let a = json!({ "label": parent, "opts": {
    "type": "warning", "buttons": buttons, "defaultId": 0, "cancelId": 0, "message": message, "detail": detail
  } });
  matches!(crate::dialog_message(app, &a), Ok(v) if v.as_u64() == Some(1))
}

// ---- the application menu (menu.ts) ------------------------------------------------

/// Cmd+W closes the active panel's tab (the page does it), not the window, so
/// people stop quitting the IDE by reflex. Cmd+Alt+W closes the panel and the
/// window moves to Cmd+Shift+W. Zoom changes the page's persisted uiScale
/// rather than WebKit's transient zoom. Quit is ours, to run the confirmation.
pub fn menu_template() -> Value {
  let item = |id: &str, label: &str, acc: &str| json!({ "kind": "item", "id": format!("app:{id}"), "label": label, "accelerator": acc });
  let pre = |role: &str| json!({ "kind": "predefined", "role": role });
  let sep = || json!({ "kind": "separator" });
  json!({ "items": [
    { "kind": "submenu", "label": "riven", "items": [
      pre("about"), sep(), pre("services"), sep(), pre("hide"), pre("hideOthers"), pre("unhide"), sep(),
      item("quit", "Quit riven", "CmdOrCtrl+Q"),
    ] },
    { "kind": "submenu", "label": "File", "items": [
      item("close-tab", "Close Tab", "CmdOrCtrl+W"),
      item("close-panel", "Close Panel", "CmdOrCtrl+Alt+W"),
      sep(),
      item("close-window", "Close Window", "CmdOrCtrl+Shift+W"),
    ] },
    { "kind": "submenu", "label": "Edit", "items": [
      pre("undo"), pre("redo"), sep(), pre("cut"), pre("copy"), pre("paste"), pre("selectAll"),
    ] },
    { "kind": "submenu", "label": "View", "items": [
      item("reload", "Reload", "CmdOrCtrl+R"),
      item("force-reload", "Force Reload", "CmdOrCtrl+Shift+R"),
      item("devtools", "Toggle Developer Tools", "CmdOrCtrl+Alt+I"),
      sep(),
      item("zoom-reset", "Actual Size", "CmdOrCtrl+0"),
      item("zoom-in", "Zoom In", "CmdOrCtrl+="),
      item("zoom-out", "Zoom Out", "CmdOrCtrl+-"),
      sep(),
      pre("togglefullscreen"),
    ] },
    { "kind": "submenu", "label": "Window", "items": [ pre("minimize"), pre("zoom") ] },
  ] })
}

pub fn set_menu(app: &AppHandle) {
  match crate::build_menu(app, &menu_template()) {
    Ok(m) => {
      let _ = app.set_menu(m);
    }
    Err(e) => eprintln!("[menu] {e}"),
  }
}

/// The focused app window (BrowserWindow.getFocusedWindow), else the first.
fn focused(app: &AppHandle) -> Option<String> {
  let ws = main_windows(app);
  ws.iter()
    .find(|l| app.get_window(l).and_then(|w| w.is_focused().ok()).unwrap_or(false))
    .cloned()
    .or_else(|| ws.into_iter().next())
}

/// A menu item was chosen (main thread). True if it was one of these.
pub fn on_menu(app: &AppHandle, id: &str) -> bool {
  let Some(what) = id.strip_prefix("app:") else { return false };
  let app = app.clone();
  let what = what.to_string();
  std::thread::spawn(move || {
    if what == "quit" {
      return request_quit(&app);
    }
    // Only the focused window hears the page-level ones (Electron's sendToFocused).
    let only_focused = || main_windows(&app).into_iter().find(|l| app.get_window(l).and_then(|w| w.is_focused().ok()).unwrap_or(false));
    match what.as_str() {
      "close-tab" | "close-panel" => {
        if let Some(l) = only_focused() {
          emit_ipc(&app, &l, &format!("menu:{what}"), json!([]));
        }
      }
      "zoom-reset" | "zoom-in" | "zoom-out" => {
        if let Some(l) = only_focused() {
          emit_ipc(&app, &l, "ui:zoom", json!([what.trim_start_matches("zoom-")]));
        }
      }
      "close-window" => {
        if let Some(w) = only_focused().and_then(|l| app.get_window(&l)) {
          let _ = w.close();
        }
      }
      "reload" | "force-reload" => {
        if let Some(l) = focused(&app) {
          reload(&app, &l);
        }
      }
      "devtools" => {
        if let Some(v) = focused(&app).and_then(|l| app.get_webview(&l)) {
          v.open_devtools();
        }
      }
      _ => {}
    }
  });
  true
}

// ---- waking from sleep (systemResume.ts) --------------------------------------------

/// Waking can leave a page's canvases stale (and, with displays rearranging,
/// its layout sized for the arrangement in between): every app page hears
/// 'system:resumed' and redraws its terminals and relays out. Display changes
/// come in bursts and are coalesced (400ms).
pub fn on_power(app: &AppHandle, kind: &str) {
  if matches!(kind, "resume" | "unlock-screen") {
    resumed(app, kind);
  }
}

pub fn on_display(app: &AppHandle) {
  static GEN: AtomicU32 = AtomicU32::new(0);
  let g = GEN.fetch_add(1, Ordering::SeqCst) + 1;
  let app = app.clone();
  std::thread::spawn(move || {
    std::thread::sleep(Duration::from_millis(400));
    if GEN.load(Ordering::SeqCst) == g {
      resumed(&app, "display");
    }
  });
}

/// Every app page (windows that carry browser views are missing from
/// webview_windows, so by window label).
pub fn app_pages(app: &AppHandle) -> Vec<String> {
  app.windows().into_keys().filter(|l| app_page(l)).collect()
}

fn resumed(app: &AppHandle, reason: &str) {
  for label in app_pages(app) {
    emit_ipc(app, &label, "system:resumed", json!([reason]));
  }
}

// ---- focus trace (focusTrace.ts, dev builds only) ----------------------------------

static TRAIL: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// Why did riven just jump in front? The few things that can raise it leave a
/// breadcrumb, printed when a window takes focus. Debug builds only.
pub fn note(what: &str) {
  if !cfg!(debug_assertions) {
    return;
  }
  let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
  let mut t = TRAIL.lock().unwrap();
  t.push(format!("{}.{:03} {what}", (secs / 1000) % 86400, secs % 1000));
  if t.len() > 12 {
    t.remove(0);
  }
}

pub fn on_focus(app: &AppHandle, label: &str) {
  if !cfg!(debug_assertions) || !main_label(label) {
    return;
  }
  let title = app.get_window(label).and_then(|w| w.title().ok()).unwrap_or_else(|| label.to_string());
  let t = TRAIL.lock().unwrap();
  let trail = if t.is_empty() { "(none)".to_string() } else { t.join("\n  ") };
  eprintln!("[focus] \"{title}\" came forward - last actions:\n  {trail}");
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn quit_prompt_text() {
    let (b, m, d) = quit_prompt(2, true);
    assert_eq!(b, vec!["취소", "종료"]);
    assert_eq!(m, "에이전트 2개가 작업 중입니다");
    assert_eq!(d, "지금 종료하면 진행 중인 작업이 중단됩니다.");
    let (b, m, d) = quit_prompt(1, false);
    assert_eq!(b, vec!["Cancel", "Quit"]);
    assert_eq!(m, "1 agent(s) are still working");
    assert_eq!(d, "Quitting now stops that work.");
  }

  #[test]
  fn language_from_settings() {
    assert!(korean(None));
    assert!(korean(Some("not json")));
    assert!(korean(Some(r#"{"language":"ko"}"#)));
    assert!(korean(Some(r#"{"fontSize":13}"#)));
    assert!(!korean(Some(r#"{"language":"en"}"#)));
  }

  #[test]
  fn menu_has_the_shortcuts() {
    let t = menu_template().to_string();
    for acc in ["CmdOrCtrl+W", "CmdOrCtrl+Alt+W", "CmdOrCtrl+Shift+W", "CmdOrCtrl+Q", "CmdOrCtrl+0", "CmdOrCtrl+=", "CmdOrCtrl+-", "CmdOrCtrl+Alt+I"] {
      assert!(t.contains(&format!("\"{acc}\"")), "{acc}");
    }
    assert!(t.contains("\"app:close-tab\"") && t.contains("\"app:quit\""));
  }
}
