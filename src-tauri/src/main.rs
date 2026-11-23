// riven's Tauri main process: Rust only (docs/tauri-rust-main.md).
//
// It owns the native side (windows, menus, the tray, dialogs, the screen), the
// app's pages (served on riven://localhost, page.rs), and every feature the
// page calls with Tauri invoke (commands/ over services/; the channel list is
// tauri/page/rust-owned.ts). lifecycle.rs is what src/main/index.ts did for
// Electron: the main window, the menu, quitting, flushing the page's saves.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(target_os = "macos")]
mod browser;
mod commands;
mod demo;
mod lifecycle;
mod lsmigrate;
mod page;
#[cfg(target_os = "macos")]
mod perm;
mod services;
mod testhook;

use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::hash::Hasher;
use std::sync::mpsc;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tauri::menu::{
  CheckMenuItemBuilder, IsMenuItem, Menu, MenuItemBuilder, MenuItemKind, PredefinedMenuItem, SubmenuBuilder,
};
use tauri::webview::PageLoadEvent;
use tauri::window::Color;
use tauri::{
  AppHandle, LogicalPosition, LogicalSize, Manager, RunEvent, Webview, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
  Window, WindowEvent, Wry,
};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind, MessageDialogResult};

type Res = Result<Value, String>;

#[derive(Default)]
struct Shared {
  // Windows given a URL outside our origin: every load is allowed there.
  external: Mutex<HashSet<String>>,
  // The load win.navigate itself asked for: allowed without a 'navigate' event.
  expected: Mutex<HashMap<String, String>>,
  // win.navigate callers waiting for the page to finish loading.
  loading: Mutex<HashMap<String, Vec<mpsc::Sender<()>>>>,
  minimized: Mutex<HashSet<String>>,
  // Popouts whose page has been told it is closing; their next close goes through.
  closing: Mutex<HashSet<String>>,
  // The opener's theme (background, light/dark), worn by popout title bars.
  pop_theme: Mutex<Option<(Color, Option<tauri::Theme>)>>,
}

static SHARED: OnceLock<Arc<Shared>> = OnceLock::new();
fn shared() -> &'static Arc<Shared> {
  SHARED.get_or_init(|| Arc::new(Shared::default()))
}

// ---- small helpers -----------------------------------------------------------

fn s<'a>(a: &'a Value, k: &str) -> Option<&'a str> {
  a.get(k).and_then(Value::as_str)
}
fn b(a: &Value, k: &str) -> Option<bool> {
  a.get(k).and_then(Value::as_bool)
}
fn f(a: &Value, k: &str) -> Option<f64> {
  a.get(k).and_then(Value::as_f64)
}

// A window and its own (full-size) webview. Not a WebviewWindow: once the
// browser panel adds child webviews to a window, Tauri no longer hands that
// window out as one (get_webview_window / webview_windows skip it).
struct Wv {
  w: Window<Wry>,
  v: Webview<Wry>,
}

fn win(app: &AppHandle, a: &Value) -> Result<Wv, String> {
  let label = s(a, "label").ok_or("no label")?;
  let w = app.get_window(label).ok_or_else(|| format!("no window {label}"))?;
  let v = app.get_webview(label).ok_or_else(|| format!("no webview {label}"))?;
  Ok(Wv { w, v })
}

fn base64_decode(input: &str) -> Vec<u8> {
  use base64::Engine;
  base64::engine::general_purpose::STANDARD.decode(input.trim()).unwrap_or_default()
}

fn base64_encode(data: &[u8]) -> String {
  const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
  for c in data.chunks(3) {
    let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
    for i in 0..4 {
      out.push(if i <= c.len() { T[(n >> (18 - 6 * i) & 63) as usize] as char } else { '=' });
    }
  }
  out
}

// #RGB, #ARGB, #RRGGBB, #AARRGGBB (Electron's forms).
fn color(hex: &str) -> Option<Color> {
  let h = hex.trim().trim_start_matches('#');
  let n = |i: usize, w: usize| u8::from_str_radix(&h[i..i + w], 16).ok();
  let d = |i: usize| n(i, 1).map(|v| v * 17);
  match h.len() {
    3 => Some(Color(d(0)?, d(1)?, d(2)?, 255)),
    4 => Some(Color(d(1)?, d(2)?, d(3)?, d(0)?)),
    6 => Some(Color(n(0, 2)?, n(2, 2)?, n(4, 2)?, 255)),
    8 => Some(Color(n(2, 2)?, n(4, 2)?, n(6, 2)?, n(0, 2)?)),
    _ => None,
  }
}

fn allowed_url(url: &str) -> bool {
  let origin = page::ORIGIN;
  url.starts_with("about:") || url.starts_with("data:") || url.starts_with("blob:") || url == origin || url.starts_with(&format!("{origin}/"))
}

// ---- windows -----------------------------------------------------------------

pub(crate) fn create_window(app: &AppHandle, a: &Value) -> Res {
  let label = s(a, "label").ok_or("no label")?.to_string();
  let o = a.get("opts").cloned().unwrap_or(Value::Null);
  let blank = WebviewUrl::External("about:blank".parse().unwrap());
  let nav_label = label.clone();
  let load_label = label.clone();
  let mut bld = WebviewWindowBuilder::new(app, &label, blank)
    .initialization_script(format!("window.__RIVEN_WIN__={};", Value::String(label.clone())))
    .disable_drag_drop_handler()
    .inner_size(f(&o, "width").unwrap_or(800.0), f(&o, "height").unwrap_or(600.0))
    .visible(b(&o, "show").unwrap_or(true) && !background())
    .focused(!background())
    .title(s(&o, "title").unwrap_or("riven"))
    .resizable(b(&o, "resizable").unwrap_or(true))
    .maximizable(b(&o, "maximizable").unwrap_or(true))
    .minimizable(b(&o, "minimizable").unwrap_or(true))
    .closable(b(&o, "closable").unwrap_or(true))
    .always_on_top(b(&o, "alwaysOnTop").unwrap_or(false))
    .focusable(b(&o, "focusable").unwrap_or(true))
    .skip_taskbar(b(&o, "skipTaskbar").unwrap_or(false))
    .on_navigation(move |url| {
      let url = url.as_str();
      let sh = shared();
      {
        let mut exp = sh.expected.lock().unwrap();
        if exp.get(&nav_label).map(|u| u == url).unwrap_or(false) {
          exp.remove(&nav_label);
          return true;
        }
      }
      if allowed_url(url) {
        return true;
      }
      if sh.external.lock().unwrap().contains(&nav_label) {
        return true;
      }
      // Keep the app's pages on the app's origin (a page that kept the
      // preload's reach on someone else's content would be handing it the
      // files, the shell and git). Real links go to the default browser.
      commands::app::open_external(url);
      false
    })
    .on_page_load(move |wv, p| {
      // A fresh page: tool calls waiting on the old one are told (services/mcp).
      if p.event() == PageLoadEvent::Started {
        services::mcp::page_started(&load_label);
      }
      if p.event() == PageLoadEvent::Finished {
        sync_frame(&wv);
        if let Some(waiters) = shared().loading.lock().unwrap().remove(&load_label) {
          for w in waiters {
            let _ = w.send(());
          }
        }
      }
    })
    .on_new_window({
      let app = app.clone();
      move |url, features| popout(&app, url, features)
    });
  if let (Some(x), Some(y)) = (f(&o, "x"), f(&o, "y")) {
    bld = bld.position(x, y);
  } else {
    bld = bld.center();
  }
  if let (Some(w), Some(h)) = (f(&o, "minWidth"), f(&o, "minHeight")) {
    bld = bld.min_inner_size(w, h);
  }
  if b(&o, "frame") == Some(false) {
    bld = bld.decorations(false);
  }
  if b(&o, "transparent") == Some(true) {
    bld = bld.transparent(true);
  }
  if let Some(sh) = b(&o, "hasShadow") {
    bld = bld.shadow(sh);
  }
  #[cfg(target_os = "macos")]
  {
    if matches!(s(&o, "titleBarStyle"), Some("hidden") | Some("hiddenInset")) {
      bld = bld.title_bar_style(tauri::TitleBarStyle::Overlay).hidden_title(true);
      if let Some(t) = o.get("trafficLightPosition") {
        bld = bld.traffic_light_position(LogicalPosition::new(f(t, "x").unwrap_or(0.0), f(t, "y").unwrap_or(0.0)));
      }
    }
  }
  if let Some(c) = s(&o, "backgroundColor").and_then(color) {
    bld = bld.background_color(c);
  }
  if let Some(p) = s(&o, "parent").and_then(|p| app.get_window(p)) {
    #[cfg(target_os = "macos")]
    {
      bld = bld.parent_raw(p.ns_window().map_err(|e| e.to_string())?);
    }
  }
  let built = bld.build().map_err(|e| e.to_string())?;
  if background() {
    no_occlusion(built.as_ref());
  }
  if background() && b(&o, "show").unwrap_or(true) {
    order_back(app, built.as_ref().window());
  }
  Ok(Value::Null)
}

// dockview pops a group out with window.open(popout.html) and then moves the
// group's live DOM into the returned Window, so the new webview has to be the
// opener's WebKit sibling (window_features shares its configuration and
// process) rather than an independent window. Only our own popout page gets
// one; anything else window.open asks for is refused (the preload already
// routes external links to the default browser).
const POPOUT_THEME: &str = r#"(() => { try {
  const o = window.opener && window.opener.document.documentElement
  if (!o) return
  document.documentElement.style.cssText = o.style.cssText
  const m = o.getAttribute('data-theme-mode')
  if (m) document.documentElement.setAttribute('data-theme-mode', m)
  document.documentElement.style.background = 'var(--bg)'
  document.body && (document.body.style.background = 'var(--bg)')
} catch {} })()"#;

fn popout(app: &AppHandle, url: url::Url, features: tauri::webview::NewWindowFeatures) -> tauri::webview::NewWindowResponse<Wry> {
  use tauri::webview::NewWindowResponse;
  if !allowed_url(url.as_str()) || !url.path().ends_with("/popout.html") {
    return NewWindowResponse::Deny;
  }
  // The preload tags the url with the id it will close the window by.
  let id = match url.fragment().and_then(|f| f.strip_prefix("riven-pop=")) {
    Some(id) if !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') => id,
    _ => return NewWindowResponse::Deny,
  };
  let label = format!("pop-{id}");
  if app.get_window(&label).is_some() {
    return NewWindowResponse::Deny;
  }
  let title = match url.query_pairs().find(|(k, _)| k == "ws") {
    Some((_, ws)) if !ws.is_empty() => format!("{ws} - riven"),
    _ => "riven".to_string(),
  };
  let blank = WebviewUrl::External("about:blank".parse().unwrap());
  let (bg, theme) = shared().pop_theme.lock().unwrap().unwrap_or((Color(0x1e, 0x1e, 0x1e, 0xff), None));
  let bld = WebviewWindowBuilder::new(app, &label, blank)
    .window_features(features)
    .focused(!background())
    .visible(!background())
    .title(title)
    .disable_drag_drop_handler()
    .theme(theme)
    .background_color(bg);
  // A transparent title bar shows the window's background, i.e. the theme.
  #[cfg(target_os = "macos")]
  let bld = bld.title_bar_style(tauri::TitleBarStyle::Transparent);
  let built = bld
    .on_page_load(|wv, p| {
      if p.event() == PageLoadEvent::Finished {
        let _ = wv.eval(POPOUT_THEME);
        sync_frame(&wv);
      }
    })
    .build();
  match built {
    Ok(window) => {
      if background() {
        no_occlusion(window.as_ref());
        order_back(app, window.as_ref().window());
      }
      keep_on_screen(app, &window, id.rsplit_once('-').map_or(id, |(o, _)| o));
      NewWindowResponse::Create { window }
    }
    Err(_) => NewWindowResponse::Deny,
  }
}

// A layout saved while screenY was wrong (or on a display since unplugged)
// asks for a spot no screen shows. If no screen's work area shows the top of
// it, center the window on its opener's screen.
fn keep_on_screen(app: &AppHandle, w: &WebviewWindow, opener: &str) {
  let (Ok(p), Ok(sz)) = (w.outer_position(), w.outer_size()) else { return };
  let Ok(mons) = w.available_monitors() else { return };
  // Enough of it to read and grab, not just a sliver of title bar.
  let k = w.scale_factor().unwrap_or(1.0);
  let (x, y, wd) = (p.x as f64, p.y as f64, sz.width as f64);
  let (side, bar) = ((wd / 2.0).min(200.0 * k), (sz.height as f64 / 2.0).min(200.0 * k));
  let seen = mons.iter().any(|m| {
    let a = m.work_area();
    let (ax, ay) = (a.position.x as f64, a.position.y as f64);
    let (aw, ah) = (a.size.width as f64, a.size.height as f64);
    x + wd >= ax + side && x + side <= ax + aw && y >= ay - 1.0 && y + bar <= ay + ah
  });
  if seen {
    return;
  }
  let main = app.get_window(opener).and_then(|m| m.current_monitor().ok().flatten());
  let Some(m) = main.or_else(|| w.primary_monitor().ok().flatten()) else { return };
  let a = m.work_area();
  let nw = sz.width.min(a.size.width);
  let nh = sz.height.min(a.size.height);
  let _ = w.set_size(tauri::PhysicalSize::new(nw, nh));
  let _ = w.set_position(tauri::PhysicalPosition::new(
    a.position.x + (a.size.width - nw) as i32 / 2,
    a.position.y + (a.size.height - nh) as i32 / 2,
  ));
}

// WKWebView answers screenX 0, screenY the screen's height and outerWidth 0,
// and dockview places a popout (and saves where it was) from those, which put
// it off the bottom of the screen. Keep them true for every page we show.
fn sync_frame(wv: &WebviewWindow) {
  sync_frame_of(&wv.as_ref().window(), wv.as_ref());
}

fn sync_frame_of(w: &Window<Wry>, v: &Webview<Wry>) {
  let (Ok(p), Ok(sz), Ok(k)) = (w.outer_position(), w.outer_size(), w.scale_factor()) else { return };
  let (p, sz) = (p.to_logical::<f64>(k), sz.to_logical::<f64>(k));
  let _ = v.eval(format!(
    "(f=>{{if(!window.__rivenFrame)for(const[k,v]of[['screenX','x'],['screenLeft','x'],['screenY','y'],['screenTop','y'],['outerWidth','w'],['outerHeight','h']])Object.defineProperty(window,k,{{get:()=>window.__rivenFrame[v],configurable:true}});window.__rivenFrame=f}})({{x:{},y:{},w:{},h:{}}})",
    p.x, p.y, sz.width, sz.height
  ));
}

fn frame_changed(w: &tauri::Window<Wry>) {
  if let Some(v) = w.app_handle().get_webview(w.label()) {
    sync_frame_of(w, &v);
  }
}

// dockview docks the group back on the popout's beforeunload, which WebKit
// never fires when the window is simply torn down. So the first close (the red
// button) is held and the page gets the event; dockview then closes the window
// itself (the preload sends that to win.destroy). If the page doesn't answer,
// the window goes anyway.
fn popout_event(w: &tauri::Window<Wry>, ev: &WindowEvent) {
  let label = w.label().to_string();
  match ev {
    WindowEvent::CloseRequested { api, .. } => {
      // The browser views it carries go home before the window goes.
      #[cfg(target_os = "macos")]
      services::browser::on_host_closing(&label);
      if !shared().closing.lock().unwrap().insert(label.clone()) {
        return;
      }
      let Some(wv) = w.app_handle().get_webview_window(&label) else { return };
      api.prevent_close();
      let _ = wv.eval("dispatchEvent(new Event('beforeunload'))");
      std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(1500));
        let _ = wv.destroy();
      });
    }
    WindowEvent::Moved(_) | WindowEvent::Resized(_) => frame_changed(w),
    WindowEvent::Destroyed => {
      shared().closing.lock().unwrap().remove(&label);
    }
    _ => {}
  }
}

pub(crate) fn navigate(app: &AppHandle, a: &Value) -> Res {
  let w = win(app, a)?;
  let label = w.w.label().to_string();
  let url = s(a, "url").ok_or("no url")?.to_string();
  let parsed: url::Url = url.parse().map_err(|e: url::ParseError| e.to_string())?;
  let sh = shared();
  if allowed_url(&url) {
    sh.external.lock().unwrap().remove(&label);
  } else {
    sh.external.lock().unwrap().insert(label.clone());
  }
  sh.expected.lock().unwrap().insert(label.clone(), parsed.to_string());
  let (tx, rx) = mpsc::channel();
  sh.loading.lock().unwrap().entry(label).or_default().push(tx);
  w.v.navigate(parsed).map_err(|e| e.to_string())?;
  // Electron's loadURL resolves when the page has loaded; a page that never
  // finishes should not hold the caller forever.
  let _ = rx.recv_timeout(Duration::from_secs(30));
  Ok(Value::Null)
}

// Dev builds run as a bare binary too (RIVEN_TAURI_NO_APP=1), where the Dock
// would show a generic icon: give it riven's (index.ts did the same for dev).
#[cfg(all(target_os = "macos", debug_assertions))]
fn dev_dock_icon(app: &AppHandle) -> Res {
  if std::env::current_exe().map(|p| p.to_string_lossy().contains(".app/Contents/MacOS/")).unwrap_or(true) {
    return Ok(Value::Null);
  }
  let png = include_bytes!("../../build/icon.png").to_vec();
  app
    .run_on_main_thread(move || {
      use objc2::{AllocAnyThread, MainThreadMarker};
      use objc2_app_kit::{NSApplication, NSImage};
      use objc2_foundation::NSData;
      let Some(mtm) = MainThreadMarker::new() else { return };
      let img = NSImage::initWithData(NSImage::alloc(), &NSData::with_bytes(&png));
      unsafe { NSApplication::sharedApplication(mtm).setApplicationIconImage(img.as_deref()) };
    })
    .map(|_| Value::Null)
    .map_err(|e| e.to_string())
}

// webUtils.getPathForFile: WKWebView hides the paths of dropped files, but
// the drag pasteboard holds them for as long as the drag runs.
#[cfg(target_os = "macos")]
pub(crate) fn drag_paths(app: &AppHandle) -> Result<Vec<String>, String> {
  let (tx, rx) = mpsc::channel::<Vec<String>>();
  app
    .run_on_main_thread(move || {
      use objc2_app_kit::{NSPasteboard, NSPasteboardNameDrag, NSPasteboardTypeFileURL};
      use objc2_foundation::NSURL;
      let mut out = Vec::new();
      unsafe {
        let pb = NSPasteboard::pasteboardWithName(NSPasteboardNameDrag);
        for item in pb.pasteboardItems().map(|a| a.to_vec()).unwrap_or_default() {
          let Some(s) = item.stringForType(NSPasteboardTypeFileURL) else { continue };
          let Some(url) = NSURL::URLWithString(&s) else { continue };
          // Finder hands out file reference URLs (file:///.file/id=...).
          let url = url.filePathURL().unwrap_or(url);
          if let Some(p) = url.path() {
            out.push(p.to_string());
          }
        }
      }
      let _ = tx.send(out);
    })
    .map_err(|e| e.to_string())?;
  rx.recv_timeout(Duration::from_secs(2)).map_err(|_| "drag.paths timed out".into())
}

// powerMonitor / screen events. Observers live for the whole process.
#[cfg(target_os = "macos")]
fn observe_system(app: &AppHandle) {
  use block2::RcBlock;
  use objc2::MainThreadMarker;
  use objc2_app_kit::{
    NSApplicationDidChangeScreenParametersNotification, NSScreen, NSWorkspace, NSWorkspaceDidWakeNotification,
    NSWorkspaceWillSleepNotification,
  };
  use objc2_foundation::{NSDistributedNotificationCenter, NSNotification, NSNotificationCenter, NSString};
  use std::ptr::NonNull;
  use std::sync::atomic::{AtomicUsize, Ordering};
  let Some(mtm) = MainThreadMarker::new() else { return };
  fn on(center: &NSNotificationCenter, name: &NSString, f: impl Fn() + 'static) {
    let block = RcBlock::new(move |_n: NonNull<NSNotification>| f());
    let token = unsafe { center.addObserverForName_object_queue_usingBlock(Some(name), None, None, &block) };
    std::mem::forget(token);
  }
  let power = |kind: &'static str| {
    let app = app.clone();
    move || lifecycle::on_power(&app, kind)
  };
  let ws = NSWorkspace::sharedWorkspace().notificationCenter();
  unsafe {
    on(&ws, NSWorkspaceDidWakeNotification, power("resume"));
    on(&ws, NSWorkspaceWillSleepNotification, power("suspend"));
  }
  let dist = NSDistributedNotificationCenter::defaultCenter();
  on(&dist, &NSString::from_str("com.apple.screenIsUnlocked"), power("unlock-screen"));
  on(&dist, &NSString::from_str("com.apple.screenIsLocked"), power("lock-screen"));
  static SCREENS: AtomicUsize = AtomicUsize::new(0);
  SCREENS.store(NSScreen::screens(mtm).count(), Ordering::Relaxed);
  let app = app.clone();
  on(&NSNotificationCenter::defaultCenter(), unsafe { NSApplicationDidChangeScreenParametersNotification }, move || {
    SCREENS.store(NSScreen::screens(mtm).count(), Ordering::Relaxed);
    lifecycle::on_display(&app);
  });
}

// ---- menus -------------------------------------------------------------------

fn predefined(app: &AppHandle, role: &str, label: Option<&str>) -> tauri::Result<Option<PredefinedMenuItem<Wry>>> {
  let r = role.to_ascii_lowercase();
  Ok(Some(match r.as_str() {
    "about" => PredefinedMenuItem::about(app, label, None)?,
    "services" => PredefinedMenuItem::services(app, label)?,
    "hide" => PredefinedMenuItem::hide(app, label)?,
    "hideothers" => PredefinedMenuItem::hide_others(app, label)?,
    "unhide" => PredefinedMenuItem::show_all(app, label)?,
    "undo" => PredefinedMenuItem::undo(app, label)?,
    "redo" => PredefinedMenuItem::redo(app, label)?,
    "cut" => PredefinedMenuItem::cut(app, label)?,
    "copy" => PredefinedMenuItem::copy(app, label)?,
    "paste" | "pasteandmatchstyle" => PredefinedMenuItem::paste(app, label)?,
    "selectall" => PredefinedMenuItem::select_all(app, label)?,
    "minimize" => PredefinedMenuItem::minimize(app, label)?,
    "zoom" => PredefinedMenuItem::maximize(app, label)?,
    "close" => PredefinedMenuItem::close_window(app, label)?,
    "togglefullscreen" => PredefinedMenuItem::fullscreen(app, label)?,
    "front" => PredefinedMenuItem::bring_all_to_front(app, label)?,
    _ => return Ok(None),
  }))
}

fn menu_items(app: &AppHandle, items: &[Value]) -> tauri::Result<Vec<MenuItemKind<Wry>>> {
  let mut out: Vec<MenuItemKind<Wry>> = Vec::new();
  for it in items {
    let label = s(it, "label").unwrap_or("");
    let enabled = b(it, "enabled").unwrap_or(true);
    let acc = s(it, "accelerator");
    match s(it, "kind").unwrap_or("item") {
      "separator" => out.push(MenuItemKind::Predefined(PredefinedMenuItem::separator(app)?)),
      "submenu" => {
        let kids = menu_items(app, it.get("items").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]))?;
        let refs: Vec<&dyn IsMenuItem<Wry>> = kids.iter().map(|k| k as &dyn IsMenuItem<Wry>).collect();
        let sub = SubmenuBuilder::new(app, label).items(&refs).enabled(enabled).build()?;
        out.push(MenuItemKind::Submenu(sub));
      }
      "predefined" => {
        if let Some(p) = predefined(app, s(it, "role").unwrap_or(""), s(it, "label"))? {
          out.push(MenuItemKind::Predefined(p));
        }
      }
      "check" => {
        let id = s(it, "id").unwrap_or("");
        let mk = |acc: Option<&str>| {
          let mut c = CheckMenuItemBuilder::with_id(id, label).enabled(enabled).checked(b(it, "checked").unwrap_or(false));
          if let Some(a) = acc {
            c = c.accelerator(a);
          }
          c.build(app)
        };
        out.push(MenuItemKind::Check(mk(acc).or_else(|_| mk(None))?));
      }
      _ => {
        let id = s(it, "id").unwrap_or("");
        let mk = |acc: Option<&str>| {
          let mut m = MenuItemBuilder::with_id(id, label).enabled(enabled);
          if let Some(a) = acc {
            m = m.accelerator(a);
          }
          m.build(app)
        };
        // An accelerator muda cannot parse should cost the shortcut, not the item.
        out.push(MenuItemKind::MenuItem(mk(acc).or_else(|_| mk(None))?));
      }
    }
  }
  Ok(out)
}

pub(crate) fn build_menu(app: &AppHandle, a: &Value) -> Result<Menu<Wry>, String> {
  let items = a.get("items").and_then(Value::as_array).cloned().unwrap_or_default();
  let kids = menu_items(app, &items).map_err(|e| e.to_string())?;
  let refs: Vec<&dyn IsMenuItem<Wry>> = kids.iter().map(|k| k as &dyn IsMenuItem<Wry>).collect();
  Menu::with_items(app, &refs).map_err(|e| e.to_string())
}

// ---- dialogs -----------------------------------------------------------------

fn parent_of(app: &AppHandle, a: &Value) -> Option<Window<Wry>> {
  s(a, "label").and_then(|l| app.get_window(l))
}

pub(crate) fn dialog_message(app: &AppHandle, a: &Value) -> Res {
  let o = a.get("opts").cloned().unwrap_or(Value::Null);
  let mut text = s(&o, "message").unwrap_or("").to_string();
  if let Some(d) = s(&o, "detail").filter(|d| !d.is_empty()) {
    text = if text.is_empty() { d.to_string() } else { format!("{text}\n\n{d}") };
  }
  let buttons: Vec<String> = o
    .get("buttons")
    .and_then(Value::as_array)
    .map(|v| v.iter().filter_map(|x| x.as_str().map(String::from)).collect())
    .unwrap_or_default();
  let kind = match s(&o, "type") {
    Some("warning") => MessageDialogKind::Warning,
    Some("error") => MessageDialogKind::Error,
    _ => MessageDialogKind::Info,
  };
  let mut d = app.dialog().message(text).kind(kind);
  if let Some(t) = s(&o, "title") {
    d = d.title(t);
  }
  d = d.buttons(match buttons.len() {
    0 => MessageDialogButtons::Ok,
    1 => MessageDialogButtons::OkCustom(buttons[0].clone()),
    2 => MessageDialogButtons::OkCancelCustom(buttons[0].clone(), buttons[1].clone()),
    _ => MessageDialogButtons::YesNoCancelCustom(buttons[0].clone(), buttons[1].clone(), buttons[2].clone()),
  });
  if let Some(p) = parent_of(app, a) {
    d = d.parent(&p);
  }
  let n = buttons.len();
  let cancel = o
    .get("cancelId")
    .and_then(Value::as_u64)
    .map(|c| c as usize)
    .unwrap_or(if n >= 2 { n.min(3) - 1 } else { 0 });
  let idx = match d.blocking_show_with_result() {
    MessageDialogResult::Custom(label) => buttons.iter().position(|x| *x == label).unwrap_or(cancel),
    MessageDialogResult::Ok | MessageDialogResult::Yes => 0,
    MessageDialogResult::No => 1,
    MessageDialogResult::Cancel => cancel,
  };
  Ok(json!(idx))
}

// ---- screen ------------------------------------------------------------------

// Electron's screen always has a display; callers (the pet's placement, the
// window restore) read .workArea of the first without checking. macOS can
// report none for a moment (displays asleep, lid closed, a display being
// reconfigured), and then that read threw. Answer with the last list seen,
// else the main window's monitor, else a 1440x900 display at 0,0.
fn displays(app: &AppHandle) -> Res {
  static LAST: Mutex<Option<Value>> = Mutex::new(None);
  let got = if std::env::var("RIVEN_DEV_NO_DISPLAYS").as_deref() == Ok("1") { Ok(json!([])) } else { monitors(app) };
  match got {
    Ok(v) if v.as_array().is_some_and(|a| !a.is_empty()) => {
      *LAST.lock().unwrap() = Some(v.clone());
      Ok(v)
    }
    _ => {
      if let Some(v) = LAST.lock().unwrap().clone() {
        return Ok(v);
      }
      let fallback = app.get_window("w1").and_then(|w| w.current_monitor().ok().flatten()).map(|m| {
        let sf = m.scale_factor();
        let p = m.position().to_logical::<f64>(sf);
        let z = m.size().to_logical::<f64>(sf);
        json!({ "x": p.x, "y": p.y, "width": z.width, "height": z.height, "sf": sf })
      });
      let r = fallback.unwrap_or(json!({ "x": 0.0, "y": 0.0, "width": 1440.0, "height": 900.0, "sf": 2.0 }));
      let rect = json!({ "x": r["x"], "y": r["y"], "width": r["width"], "height": r["height"] });
      Ok(json!([{ "id": 0, "bounds": rect, "workArea": rect, "scaleFactor": r["sf"] }]))
    }
  }
}

fn monitors(app: &AppHandle) -> Res {
  let primary = app.primary_monitor().map_err(|e| e.to_string())?;
  let mut all = app.available_monitors().map_err(|e| e.to_string())?;
  let pname = primary.as_ref().and_then(|m| m.name().cloned());
  all.sort_by_key(|m| if m.name().cloned() == pname { 0 } else { 1 });
  let out: Vec<Value> = all
    .iter()
    .enumerate()
    .map(|(i, m)| {
      let sf = m.scale_factor();
      let p = m.position().to_logical::<f64>(sf);
      let z = m.size().to_logical::<f64>(sf);
      let wa = m.work_area();
      let wp = wa.position.to_logical::<f64>(sf);
      let wz = wa.size.to_logical::<f64>(sf);
      let id = m.name().map(|n| {
        let mut h = std::collections::hash_map::DefaultHasher::new();
        h.write(n.as_bytes());
        (h.finish() & 0xffff_ffff) as u64
      });
      json!({
        "id": id.unwrap_or(i as u64),
        "bounds": { "x": p.x, "y": p.y, "width": z.width, "height": z.height },
        "workArea": { "x": wp.x, "y": wp.y, "width": wz.width, "height": wz.height },
        "scaleFactor": sf,
      })
    })
    .collect();
  Ok(json!(out))
}

fn cursor(app: &AppHandle) -> Res {
  let c = app.cursor_position().map_err(|e| e.to_string())?;
  // Physical pixels in the coordinate space of whichever display it is on.
  let sf = app
    .available_monitors()
    .ok()
    .and_then(|ms| {
      ms.into_iter().find(|m| {
        let p = m.position();
        let z = m.size();
        c.x >= p.x as f64 && c.y >= p.y as f64 && c.x < p.x as f64 + z.width as f64 && c.y < p.y as f64 + z.height as f64
      })
    })
    .map(|m| m.scale_factor())
    .unwrap_or(1.0);
  Ok(json!({ "x": (c.x / sf).round(), "y": (c.y / sf).round() }))
}


// ---- allocator ------------------------------------------------------------------
//
// The system allocator, except that a large realloc is a fresh allocation +
// copy + free. macOS libmalloc grows a large block by remapping its pages
// (vm_copy, copy-on-write) into the new one; the old block then sits in
// malloc's large-free cache with pages it can neither reuse nor hand back
// while they are COW-shared, and they stay in this process's footprint for
// minutes. Every growing buffer (a JSON result written into a Vec, a file read
// into a String) did that: one 12MB result left about 13MB behind each time
// (63MB -> 308MB after 12 file reads, the same with a pure Rust Vec grown to
// 12MB and dropped; 63MB -> 87MB flat when the copy is made by hand).
struct Alloc;

const REMAP_MIN: usize = 512 * 1024;

unsafe impl std::alloc::GlobalAlloc for Alloc {
  unsafe fn alloc(&self, l: std::alloc::Layout) -> *mut u8 {
    std::alloc::System.alloc(l)
  }
  unsafe fn alloc_zeroed(&self, l: std::alloc::Layout) -> *mut u8 {
    std::alloc::System.alloc_zeroed(l)
  }
  unsafe fn dealloc(&self, p: *mut u8, l: std::alloc::Layout) {
    std::alloc::System.dealloc(p, l)
  }
  unsafe fn realloc(&self, p: *mut u8, l: std::alloc::Layout, new_size: usize) -> *mut u8 {
    if l.size().max(new_size) < REMAP_MIN {
      return std::alloc::System.realloc(p, l, new_size);
    }
    let nl = std::alloc::Layout::from_size_align_unchecked(new_size, l.align());
    let n = std::alloc::System.alloc(nl);
    if !n.is_null() {
      std::ptr::copy_nonoverlapping(p, n, l.size().min(new_size));
      std::alloc::System.dealloc(p, l);
    }
    n
  }
}

#[global_allocator]
static GLOBAL: Alloc = Alloc;

// ---- background test mode ---------------------------------------------------
//
// RIVEN_TAURI_BACKGROUND=1 (set by test launches, never by tauri/run.sh):
// the app never takes focus or comes in front of the user's work. It runs as
// an Accessory app (no Dock icon, never activated), windows are created
// unfocused and ordered BEHIND every other window instead of in front, and
// focus/activation requests are ignored. The windows are still on screen as
// far as WebKit is concerned, so the page keeps running.
pub(crate) fn background() -> bool {
  static BG: OnceLock<bool> = OnceLock::new();
  *BG.get_or_init(|| std::env::var("RIVEN_TAURI_BACKGROUND").as_deref() == Ok("1"))
}

/// A test window sits behind everything, so WebKit sees it as occluded and
/// treats the page as hidden: timers and socket messages slow to a crawl and
/// the page is not what a person would see. Turn WebKit's occlusion check off
/// for it (the private `_windowOcclusionDetectionEnabled`, as Safari's own
/// tests do), so the page runs as a visible one would.
fn no_occlusion(wv: &tauri::Webview<Wry>) {
  #[cfg(target_os = "macos")]
  {
    let _ = wv.with_webview(|pv| unsafe {
      let v = pv.inner() as *mut objc2::runtime::AnyObject;
      let sel = objc2::sel!(_setWindowOcclusionDetectionEnabled:);
      let ok: bool = objc2::msg_send![&*v, respondsToSelector: sel];
      if ok {
        let _: () = objc2::msg_send![&*v, _setWindowOcclusionDetectionEnabled: false];
      }
    });
  }
  #[cfg(not(target_os = "macos"))]
  let _ = wv;
}

/// WebKit's tracking prevention (ITP) on the app pages' data store: off.
/// It deletes the script-written storage of a site with no recorded user
/// interaction, and the app's origin riven://localhost counts as the site
/// "localhost". Measured: the localStorage carried over from the old origin
/// (127 entries) was on disk at quit, then deleted by WebKit about 5s into the
/// next launch, before anyone could click (the old http://127.0.0.1 origin, an
/// IP address, was never a candidate). The app's own pages are not a tracker,
/// and losing chat logs, pipelines and layouts to it is data loss. The browser
/// panel's pages live in their own stores (browser.rs store_id) and keep it.
/// Main thread, before the first webview.
#[cfg(target_os = "macos")]
fn no_tracking_prevention() {
  use objc2::MainThreadMarker;
  use objc2_web_kit::WKWebsiteDataStore;
  let Some(mtm) = MainThreadMarker::new() else { return };
  unsafe {
    let store = WKWebsiteDataStore::defaultDataStore(mtm);
    let sel = objc2::sel!(_setResourceLoadStatisticsEnabled:);
    let ok: bool = objc2::msg_send![&*store, respondsToSelector: sel];
    if ok {
      let _: () = objc2::msg_send![&*store, _setResourceLoadStatisticsEnabled: false];
    } else {
      eprintln!("[webkit] cannot turn tracking prevention off for the app pages (no _setResourceLoadStatisticsEnabled:)");
    }
  }
}

/// Show a window without bringing it forward: orderBack, on the main thread.
fn order_back(app: &AppHandle, w: Window<Wry>) {
  #[cfg(target_os = "macos")]
  {
    let _ = app.run_on_main_thread(move || {
      if let Ok(ns) = w.ns_window() {
        let ns = ns as *mut objc2::runtime::AnyObject;
        unsafe {
          let _: () = objc2::msg_send![&*ns, orderBack: std::ptr::null::<objc2::runtime::AnyObject>()];
        }
      }
    });
  }
  #[cfg(not(target_os = "macos"))]
  {
    let _ = (app, w.show());
  }
}

// ---- the browser panel's native bits (services/browser.rs) ----------------------

/// A menu from a JSON template, popped up at the cursor over a window.
pub(crate) fn popup_menu(app: &AppHandle, label: &str, a: &Value) -> Res {
  let m = build_menu(app, a)?;
  let w = app.get_window(label).ok_or("no window")?;
  w.popup_menu(&m).map(|_| Value::Null).map_err(|e| e.to_string())
}

const SUGGEST: &str = "bv-suggest";

/// The address bar's suggestion list: its own window, which by construction
/// can never take the keyboard (focusable false), over the page, which does
/// not move. Shown without activating anything once its rows are drawn and it
/// is as tall as they are. Never shown in the background test mode.
#[cfg(target_os = "macos")]
pub(crate) fn suggest_window(app: &AppHandle, parent: &str, frame: services::browser::Rect, html: &str, zoom: f64) -> Res {
  let pw = app.get_window(parent).ok_or("no parent")?;
  let w = match app.get_window(SUGGEST) {
    Some(w) => w,
    None => {
      let blank = WebviewUrl::External("about:blank".parse().unwrap());
      let built = WebviewWindowBuilder::new(app, SUGGEST, blank)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .focusable(false)
        .focused(false)
        .skip_taskbar(true)
        .visible(false)
        .disable_drag_drop_handler()
        .parent_raw(pw.ns_window().map_err(|e| e.to_string())?)
        .on_document_title_changed(|_w, t| services::browser::on_suggest_title(&t))
        .on_page_load(move |wv, p| {
          if p.event() != PageLoadEvent::Finished {
            return;
          }
          let app = wv.app_handle().clone();
          std::thread::spawn(move || {
            let h = browser::dispatch(&app, "wv.exec", &json!({ "label": SUGGEST, "code": "document.getElementById('l').getBoundingClientRect().height", "expr": true }))
              .ok()
              .and_then(|v| v.as_str().and_then(|t| serde_json::from_str::<Value>(t).ok()))
              .and_then(|v| v.get("v").and_then(Value::as_f64));
            let Some(w) = app.get_window(SUGGEST) else { return };
            let k = w.scale_factor().unwrap_or(1.0);
            if let (Some(h), Ok(sz)) = (h.filter(|h| *h > 0.0), w.inner_size()) {
              let width = sz.to_logical::<f64>(k).width;
              let _ = w.set_size(LogicalSize::new(width, h.ceil().max(24.0)));
            }
            if background() {
              return;
            }
            let _ = app.run_on_main_thread(move || {
              if let Ok(ns) = w.ns_window() {
                let ns = ns as *mut objc2::runtime::AnyObject;
                unsafe {
                  let _: () = objc2::msg_send![&*ns, orderFront: std::ptr::null::<objc2::runtime::AnyObject>()];
                }
              }
            });
          });
        })
        .build()
        .map_err(|e| e.to_string())?;
      built.as_ref().window()
    }
  };
  let _ = zoom;
  w.set_position(LogicalPosition::new(frame.x, frame.y)).map_err(|e| e.to_string())?;
  w.set_size(LogicalSize::new(frame.width, frame.height)).map_err(|e| e.to_string())?;
  browser::dispatch(app, "wv.html", &json!({ "label": SUGGEST, "html": html }))
}

#[cfg(target_os = "macos")]
pub(crate) fn suggest_hide(app: &AppHandle) {
  if let Some(w) = app.get_window(SUGGEST) {
    let _ = w.hide();
  }
}

// ---- popouts' theme -------------------------------------------------------------

/// The opener's theme (background, light/dark), worn by popout title bars:
/// kept for the next popout and applied to the open ones.
pub(crate) fn pop_theme(app: &AppHandle, color_hex: &str, mode: &str) {
  let Some(bg) = color(color_hex) else { return };
  let theme = match mode {
    "light" => Some(tauri::Theme::Light),
    "dark" => Some(tauri::Theme::Dark),
    _ => None,
  };
  *shared().pop_theme.lock().unwrap() = Some((bg, theme));
  for (label, w) in app.webview_windows() {
    if label.starts_with("pop-") {
      let _ = w.set_theme(theme);
      let _ = w.set_background_color(Some(bg));
    }
  }
}

fn main() {
  // Debug builds: the DB engine on stdin/stdout, no window (services/db/harness.rs).
  #[cfg(debug_assertions)]
  if std::env::var_os("RIVEN_DB_HARNESS").is_some() {
    services::db::harness::run();
    return;
  }
  let mut builder = tauri::Builder::default();
  // tao activates the app when it finishes launching (activateIgnoringOtherApps
  // YES), which can bring a background test run in front of the user's work
  // even as an Accessory app. NO only activates when no other app is active.
  #[cfg(target_os = "macos")]
  if background() {
    builder = builder.activate_ignoring_other_apps(false);
  }
  #[allow(unused_mut)]
  let mut app = builder
    .plugin(tauri_plugin_dialog::init())
    .plugin(services::update::plugin())
    // The app's pages (page.rs). Answered off the main thread: an asset read
    // or a media range must not hold up the event loop.
    .register_asynchronous_uri_scheme_protocol(page::SCHEME, |ctx, req, responder| {
      let (app, label) = (ctx.app_handle().clone(), ctx.webview_label().to_string());
      tauri::async_runtime::spawn_blocking(move || responder.respond(page::handle(&app, &label, &req)));
    })
    .invoke_handler(commands::handler())
    .on_menu_event(|app, ev| {
      #[cfg(target_os = "macos")]
      if services::browser::on_menu(&ev.id().0) {
        return;
      }
      if services::tray::on_menu(app, &ev.id().0) {
        return;
      }
      lifecycle::on_menu(app, &ev.id().0);
    })
    .on_window_event(|w, ev| {
      let label = w.label();
      services::pet::on_window(label, ev);
      if let WindowEvent::Destroyed = ev {
        if label == "auth" {
          services::auth::closed();
        }
        services::notify::forget(label);
        #[cfg(target_os = "macos")]
        services::browser::on_host_destroyed(label);
      }
      // The address bar's list closes when its window moves, resizes, hides or loses focus.
      #[cfg(target_os = "macos")]
      if matches!(ev, WindowEvent::Moved(_) | WindowEvent::Resized(_) | WindowEvent::Focused(false) | WindowEvent::Destroyed) {
        services::browser::on_parent_changed(label);
      }
      if label == SUGGEST {
        return;
      }
      // Popouts are dockview's, owned by the opener's page.
      if label.starts_with("pop-") {
        popout_event(w, ev);
        return;
      }
      match ev {
        // WKWebView sends no beforeunload when a window closes, so the page's
        // debounced saves (settings, sessions: 300ms) were lost if the window
        // closed inside that window of time. Hold the close, run the page's
        // beforeunload and wait for its saves, then close for real. Bounded:
        // a stuck page closes anyway.
        WindowEvent::CloseRequested { api, .. } if commands::app_page(label) => {
          if shared().closing.lock().unwrap().insert(label.to_string()) {
            api.prevent_close();
            let (app, label) = (w.app_handle().clone(), label.to_string());
            std::thread::spawn(move || {
              lifecycle::flush_page(&app, &label);
              match app.get_window(&label) {
                Some(win) => {
                  let _ = win.close();
                }
                None => {
                  shared().closing.lock().unwrap().remove(&label);
                }
              }
            });
          }
        }
        WindowEvent::Focused(true) => lifecycle::on_focus(w.app_handle(), label),
        WindowEvent::Moved(_) => frame_changed(w),
        WindowEvent::Resized(_) => {
          frame_changed(w);
          let now = w.is_minimized().unwrap_or(false);
          let was = {
            let mut m = shared().minimized.lock().unwrap();
            let was = m.contains(label);
            if now {
              m.insert(label.to_string());
            } else {
              m.remove(label);
            }
            was
          };
          if was != now {
            lifecycle::visibility(w.app_handle(), label);
          }
        }
        WindowEvent::Destroyed => {
          let sh = shared();
          sh.closing.lock().unwrap().remove(label);
          sh.external.lock().unwrap().remove(label);
          sh.expected.lock().unwrap().remove(label);
          sh.minimized.lock().unwrap().remove(label);
          sh.loading.lock().unwrap().remove(label);
        }
        _ => {}
      }
    })
    .setup(|app| {
      #[cfg(target_os = "macos")]
      if background() {
        app.set_activation_policy(tauri::ActivationPolicy::Accessory);
      }
      #[cfg(target_os = "macos")]
      no_tracking_prevention();
      services::shell_env::start();
      services::mcp::init(app.handle());
      services::pty::init(app.handle());
      services::clichat::init(app.handle());
      services::chat::init(app.handle());
      services::lsp::init(app.handle());
      services::debug::init(app.handle());
      // Click routing, and the notification permission request (not in the
      // background test mode, which asks for nothing).
      services::notify::init(app.handle(), background());
      #[cfg(target_os = "macos")]
      services::browser::init(app.handle());
      services::pet::init(app.handle());
      services::update::init(app.handle());
      #[cfg(target_os = "macos")]
      observe_system(app.handle());
      #[cfg(all(target_os = "macos", debug_assertions))]
      let _ = dev_dock_icon(app.handle());
      lifecycle::set_menu(app.handle());
      testhook::start(app.handle());
      // The first window, once the page data has its new origin (lsmigrate.rs).
      // Off the main thread: both wait on page loads the event loop delivers.
      let handle = app.handle().clone();
      std::thread::spawn(move || {
        let carry = lsmigrate::pending(&handle);
        if let Err(e) = lifecycle::open_main(&handle, carry) {
          eprintln!("[riven] the main window did not open: {e}");
        }
      });
      Ok(())
    })
    .build(tauri::generate_context!())
    .expect("riven-tauri: failed to build the app");
  // Accessory from the start (setup runs after the launch activation).
  #[cfg(target_os = "macos")]
  if background() {
    app.set_activation_policy(tauri::ActivationPolicy::Accessory);
  }

  app.run(|app, ev| match ev {
    // app.exit(code) (the quit flow's own) goes through. Without a code: the
    // last window closed (macOS keeps the app; the Dock brings a window back)
    // or the system asked (the Dock's Quit, logout), which goes through the
    // same quit as Cmd+Q.
    RunEvent::ExitRequested { code: None, api, .. } => {
      api.prevent_exit();
      if !app.windows().is_empty() {
        lifecycle::request_quit(app);
      }
    }
    RunEvent::Exit => {
      services::mcp::shutdown();
      services::clichat::shutdown();
      services::pty::shutdown();
      services::chat::shutdown();
      services::lsp::shutdown();
      services::debug::shutdown();
      services::power::release();
      // Say goodbye to the database servers (bounded: quitting never waits on a network).
      tauri::async_runtime::block_on(async {
        let _ = tokio::time::timeout(std::time::Duration::from_millis(1000), services::db::close_all()).await;
      });
    }
    // The Dock icon with no window left: a new one (Electron's 'activate').
    #[cfg(target_os = "macos")]
    RunEvent::Reopen { .. } => {
      if lifecycle::main_windows(app).is_empty() {
        let app = app.clone();
        std::thread::spawn(move || {
          let _ = lifecycle::open_main(&app, None);
        });
      }
    }
    _ => {}
  });
}
