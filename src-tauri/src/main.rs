// riven's Tauri shell. It owns the native side (windows, menus, the tray,
// dialogs, the screen) and nothing else: the app itself is the same main
// process code Electron ran, executed by Node (out-tauri/main/index.js) with
// `electron` shimmed to commands sent over a loopback line to this process.
//
// Wire format (see tauri/shim/rust.ts): newline-delimited JSON over TCP on
// 127.0.0.1. The first line on a connection is {hello: token, role}. Requests
// {id, cmd, args} -> replies {id, ok, val|err}. Events {ev, ...} go out on the
// async connection.
//
//   async - handled in order on the reader thread, except calls that wait on a
//           person or a page load (dialogs, navigate), which get a thread.
//   sync  - the Node worker blocks on each answer, so they are handled inline.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::hash::{BuildHasher, Hasher};
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::mpsc;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tauri::image::Image;
use tauri::menu::{
  CheckMenuItemBuilder, IsMenuItem, Menu, MenuItemBuilder, MenuItemKind, PredefinedMenuItem, SubmenuBuilder,
};
use tauri::tray::TrayIconBuilder;
use tauri::webview::PageLoadEvent;
use tauri::window::Color;
use tauri::{
  AppHandle, LogicalPosition, LogicalSize, Manager, RunEvent, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
  WindowEvent, Wry,
};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind, MessageDialogResult};

type Res = Result<Value, String>;

#[derive(Default)]
struct Shared {
  origin: Mutex<String>,
  // Windows given a URL outside our origin (the sign-in window): every load is
  // allowed there and reported.
  external: Mutex<HashSet<String>>,
  // The load win.navigate itself asked for: allowed without a 'navigate' event.
  expected: Mutex<HashMap<String, String>>,
  // win.navigate callers waiting for the page to finish loading.
  loading: Mutex<HashMap<String, Vec<mpsc::Sender<()>>>>,
  minimized: Mutex<HashSet<String>>,
  // Popouts whose page has been told it is closing; their next close goes through.
  closing: Mutex<HashSet<String>>,
  events: Mutex<Option<TcpStream>>,
}

static SHARED: OnceLock<Arc<Shared>> = OnceLock::new();
fn shared() -> &'static Arc<Shared> {
  SHARED.get_or_init(|| Arc::new(Shared::default()))
}

fn emit(v: Value) {
  let mut g = shared().events.lock().unwrap();
  if let Some(s) = g.as_mut() {
    let mut line = v.to_string();
    line.push('\n');
    if s.write_all(line.as_bytes()).is_err() {
      *g = None;
    }
  }
}

fn win_event(label: &str, kind: &str, extra: Value) {
  let mut v = json!({ "ev": "win", "label": label, "kind": kind });
  if let (Some(o), Value::Object(e)) = (v.as_object_mut(), extra) {
    o.extend(e);
  }
  emit(v);
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

// Tray ids arrive as numbers; Tauri wants a string.
fn tray_id(a: &Value) -> String {
  match a.get("id") {
    Some(Value::String(v)) => v.clone(),
    Some(v) => v.to_string(),
    None => String::new(),
  }
}

fn win(app: &AppHandle, a: &Value) -> Result<WebviewWindow, String> {
  let label = s(a, "label").ok_or("no label")?;
  app.get_webview_window(label).ok_or_else(|| format!("no window {label}"))
}

fn base64_decode(input: &str) -> Vec<u8> {
  let mut out = Vec::with_capacity(input.len() * 3 / 4);
  let (mut acc, mut bits) = (0u32, 0u32);
  for c in input.bytes() {
    let v = match c {
      b'A'..=b'Z' => c - b'A',
      b'a'..=b'z' => c - b'a' + 26,
      b'0'..=b'9' => c - b'0' + 52,
      b'+' | b'-' => 62,
      b'/' | b'_' => 63,
      _ => continue,
    } as u32;
    acc = (acc << 6) | v;
    bits += 6;
    if bits >= 8 {
      bits -= 8;
      out.push((acc >> bits) as u8);
      acc &= (1 << bits) - 1;
    }
  }
  out
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

fn image(a: &Value) -> Result<Image<'static>, String> {
  let png = base64_decode(s(a, "png").unwrap_or(""));
  Image::from_bytes(&png).map(|i| i.to_owned()).map_err(|e| e.to_string())
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

fn bounds(w: &WebviewWindow) -> Result<Value, String> {
  let sf = w.scale_factor().map_err(|e| e.to_string())?;
  let p = w.outer_position().map_err(|e| e.to_string())?.to_logical::<f64>(sf);
  let z = w.outer_size().map_err(|e| e.to_string())?.to_logical::<f64>(sf);
  Ok(json!({ "x": p.x.round(), "y": p.y.round(), "width": z.width.round(), "height": z.height.round() }))
}

fn allowed_url(url: &str) -> bool {
  let origin = shared().origin.lock().unwrap().clone();
  url.starts_with("about:")
    || url.starts_with("data:")
    || url.starts_with("blob:")
    || (!origin.is_empty() && (url == origin || url.starts_with(&format!("{origin}/"))))
}

// ---- windows -----------------------------------------------------------------

fn create_window(app: &AppHandle, a: &Value) -> Res {
  let label = s(a, "label").ok_or("no label")?.to_string();
  let o = a.get("opts").cloned().unwrap_or(Value::Null);
  let blank = WebviewUrl::External("about:blank".parse().unwrap());
  let nav_label = label.clone();
  let load_label = label.clone();
  let mut bld = WebviewWindowBuilder::new(app, &label, blank)
    .initialization_script(format!("window.__RIVEN_WIN__={};", Value::String(label.clone())))
    .disable_drag_drop_handler()
    .inner_size(f(&o, "width").unwrap_or(800.0), f(&o, "height").unwrap_or(600.0))
    .visible(b(&o, "show").unwrap_or(true))
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
      let external = sh.external.lock().unwrap().contains(&nav_label);
      win_event(&nav_label, "navigate", json!({ "url": url }));
      external
    })
    .on_page_load(move |wv, p| {
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
  if let Some(p) = s(&o, "parent").and_then(|p| app.get_webview_window(p)) {
    bld = bld.parent(&p).map_err(|e| e.to_string())?;
  }
  bld.build().map_err(|e| e.to_string())?;
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
  if app.get_webview_window(&label).is_some() {
    return NewWindowResponse::Deny;
  }
  let title = match url.query_pairs().find(|(k, _)| k == "ws") {
    Some((_, ws)) if !ws.is_empty() => format!("{ws} - riven"),
    _ => "riven".to_string(),
  };
  let blank = WebviewUrl::External("about:blank".parse().unwrap());
  let built = WebviewWindowBuilder::new(app, &label, blank)
    .window_features(features)
    .title(title)
    .disable_drag_drop_handler()
    .background_color(Color(0x1e, 0x1e, 0x1e, 0xff))
    .on_page_load(|wv, p| {
      if p.event() == PageLoadEvent::Finished {
        let _ = wv.eval(POPOUT_THEME);
        sync_frame(&wv);
      }
    })
    .build();
  match built {
    Ok(window) => {
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
  let main = app.get_webview_window(opener).and_then(|m| m.current_monitor().ok().flatten());
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
  let (Ok(p), Ok(sz), Ok(k)) = (wv.outer_position(), wv.outer_size(), wv.scale_factor()) else { return };
  let (p, sz) = (p.to_logical::<f64>(k), sz.to_logical::<f64>(k));
  let _ = wv.eval(format!(
    "(f=>{{if(!window.__rivenFrame)for(const[k,v]of[['screenX','x'],['screenLeft','x'],['screenY','y'],['screenTop','y'],['outerWidth','w'],['outerHeight','h']])Object.defineProperty(window,k,{{get:()=>window.__rivenFrame[v],configurable:true}});window.__rivenFrame=f}})({{x:{},y:{},w:{},h:{}}})",
    p.x, p.y, sz.width, sz.height
  ));
}

fn frame_changed(w: &tauri::Window<Wry>) {
  if let Some(wv) = w.app_handle().get_webview_window(w.label()) {
    sync_frame(&wv);
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

fn navigate(app: &AppHandle, a: &Value) -> Res {
  let w = win(app, a)?;
  let label = w.label().to_string();
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
  w.navigate(parsed).map_err(|e| e.to_string())?;
  // Electron's loadURL resolves when the page has loaded; a page that never
  // finishes should not hold the caller forever.
  let _ = rx.recv_timeout(Duration::from_secs(30));
  Ok(Value::Null)
}

// webContents.capturePage: WKWebView draws the page into an image itself, so
// no screen-recording permission is involved (as with Electron's).
#[cfg(target_os = "macos")]
fn capture(app: &AppHandle, a: &Value) -> Res {
  use block2::RcBlock;
  use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSImage};
  use objc2_foundation::{NSDictionary, NSError};
  use objc2_web_kit::WKWebView;
  let w = win(app, a)?;
  let (tx, rx) = mpsc::channel::<Option<Vec<u8>>>();
  w.with_webview(move |pv| {
    let tx = tx.clone();
    let done = RcBlock::new(move |img: *mut NSImage, _err: *mut NSError| {
      // Runs on the main thread, once.
      let png = unsafe { img.as_ref() }.and_then(|img| {
        let tiff = img.TIFFRepresentation()?;
        let rep = NSBitmapImageRep::imageRepWithData(&tiff)?;
        unsafe { rep.representationUsingType_properties(NSBitmapImageFileType::PNG, &NSDictionary::new()) }
      });
      let _ = tx.send(png.map(|d| d.to_vec()));
    });
    unsafe {
      let wk = &*(pv.inner() as *const WKWebView);
      wk.takeSnapshotWithConfiguration_completionHandler(None, &done);
    }
  })
  .map_err(|e| e.to_string())?;
  match rx.recv_timeout(Duration::from_secs(10)) {
    Ok(Some(png)) => Ok(Value::String(base64_encode(&png))),
    Ok(None) => Err("snapshot failed".into()),
    Err(_) => Err("snapshot timed out".into()),
  }
}

// app.dock.setIcon.
#[cfg(target_os = "macos")]
fn dock_icon(app: &AppHandle, a: &Value) -> Res {
  let png = base64_decode(s(a, "png").unwrap_or(""));
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
// the drag pasteboard still holds them while the drop event runs.
#[cfg(target_os = "macos")]
fn drag_paths(app: &AppHandle) -> Res {
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
  rx.recv_timeout(Duration::from_secs(2)).map(|v| json!(v)).map_err(|_| "drag.paths timed out".into())
}

// powerMonitor / screen events. Observers live for the whole process.
#[cfg(target_os = "macos")]
fn observe_system() {
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
  let power = |kind: &'static str| move || emit(json!({ "ev": "power", "kind": kind }));
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
  on(&NSNotificationCenter::defaultCenter(), unsafe { NSApplicationDidChangeScreenParametersNotification }, move || {
    let n = NSScreen::screens(mtm).count();
    let prev = SCREENS.swap(n, Ordering::Relaxed);
    let kind = match n.cmp(&prev) {
      std::cmp::Ordering::Greater => "display-added",
      std::cmp::Ordering::Less => "display-removed",
      std::cmp::Ordering::Equal => "display-metrics-changed",
    };
    emit(json!({ "ev": "display", "kind": kind }));
  });
}

fn win_cmd(app: &AppHandle, cmd: &str, a: &Value) -> Res {
  let w = win(app, a)?;
  let e = |r: tauri::Result<()>| r.map(|_| Value::Null).map_err(|e| e.to_string());
  match cmd {
    "win.show" => {
      e(w.show())?;
      if b(a, "focus").unwrap_or(true) {
        let _ = w.set_focus();
      }
      Ok(Value::Null)
    }
    "win.hide" => e(w.hide()),
    "win.close" => e(w.close()),
    "win.destroy" => e(w.destroy()),
    "win.focus" => e(w.set_focus()),
    "win.minimize" => e(w.minimize()),
    "win.restore" => e(w.unminimize()),
    "win.maximize" => e(w.maximize()),
    "win.center" => e(w.center()),
    "win.setTitle" => e(w.set_title(s(a, "title").unwrap_or(""))),
    "win.isMinimized" => w.is_minimized().map(Value::Bool).map_err(|e| e.to_string()),
    "win.isVisible" => w.is_visible().map(Value::Bool).map_err(|e| e.to_string()),
    "win.isAlwaysOnTop" => w.is_always_on_top().map(Value::Bool).map_err(|e| e.to_string()),
    "win.setFocusable" => e(w.set_focusable(b(a, "on").unwrap_or(true))),
    "win.setAlwaysOnTop" => e(w.set_always_on_top(b(a, "on").unwrap_or(false))),
    "win.setVisibleOnAllWorkspaces" => e(w.set_visible_on_all_workspaces(b(a, "on").unwrap_or(false))),
    "win.setIgnoreCursorEvents" => e(w.set_ignore_cursor_events(b(a, "on").unwrap_or(false))),
    "win.setShadow" => e(w.set_shadow(b(a, "on").unwrap_or(true))),
    "win.setBackgroundColor" => e(w.set_background_color(s(a, "color").and_then(color))),
    "win.getBounds" => bounds(&w),
    "win.setBounds" => {
      let cur = bounds(&w)?;
      let nb = a.get("bounds").cloned().unwrap_or(Value::Null);
      let pick = |k: &str| f(&nb, k).or_else(|| f(&cur, k)).unwrap_or(0.0);
      if f(&nb, "x").is_some() || f(&nb, "y").is_some() {
        e(w.set_position(LogicalPosition::new(pick("x"), pick("y"))))?;
      }
      if f(&nb, "width").is_some() || f(&nb, "height").is_some() {
        e(w.set_size(LogicalSize::new(pick("width"), pick("height"))))?;
      }
      Ok(Value::Null)
    }
    "win.zoom" => e(w.set_zoom(f(a, "factor").unwrap_or(1.0))),
    "win.reload" => e(w.eval("location.reload()")),
    "win.devtools" => {
      w.open_devtools();
      Ok(Value::Null)
    }
    _ => Err(format!("unknown command {cmd}")),
  }
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

fn build_menu(app: &AppHandle, a: &Value) -> Result<Menu<Wry>, String> {
  let items = a.get("items").and_then(Value::as_array).cloned().unwrap_or_default();
  let kids = menu_items(app, &items).map_err(|e| e.to_string())?;
  let refs: Vec<&dyn IsMenuItem<Wry>> = kids.iter().map(|k| k as &dyn IsMenuItem<Wry>).collect();
  Menu::with_items(app, &refs).map_err(|e| e.to_string())
}

// ---- dialogs -----------------------------------------------------------------

fn parent_of(app: &AppHandle, a: &Value) -> Option<WebviewWindow> {
  s(a, "label").and_then(|l| app.get_webview_window(l))
}

fn file_dialog(app: &AppHandle, a: &Value) -> tauri_plugin_dialog::FileDialogBuilder<Wry> {
  let o = a.get("opts").cloned().unwrap_or(Value::Null);
  let mut d = app.dialog().file();
  if let Some(t) = s(&o, "title").or_else(|| s(&o, "message")) {
    d = d.set_title(t);
  }
  if let Some(fs) = o.get("filters").and_then(Value::as_array) {
    for flt in fs {
      let exts: Vec<String> = flt
        .get("extensions")
        .and_then(Value::as_array)
        .map(|v| v.iter().filter_map(|x| x.as_str().map(String::from)).collect())
        .unwrap_or_default();
      if exts.iter().any(|e| e == "*") {
        continue;
      }
      let refs: Vec<&str> = exts.iter().map(String::as_str).collect();
      d = d.add_filter(s(flt, "name").unwrap_or(""), &refs);
    }
  }
  if let Some(p) = parent_of(app, a) {
    d = d.set_parent(&p);
  }
  d
}

fn path_str(p: tauri_plugin_dialog::FilePath) -> Option<String> {
  p.into_path().ok().map(|p| p.to_string_lossy().into_owned())
}

fn dialog_open(app: &AppHandle, a: &Value) -> Res {
  let o = a.get("opts").cloned().unwrap_or(Value::Null);
  let props: Vec<String> = o
    .get("properties")
    .and_then(Value::as_array)
    .map(|v| v.iter().filter_map(|x| x.as_str().map(String::from)).collect())
    .unwrap_or_default();
  let has = |p: &str| props.iter().any(|x| x == p);
  let mut d = file_dialog(app, a).set_can_create_directories(has("createDirectory") || has("openDirectory"));
  if let Some(dp) = s(&o, "defaultPath") {
    d = d.set_directory(dp);
  }
  let multi = has("multiSelections");
  let picked: Option<Vec<tauri_plugin_dialog::FilePath>> = match (has("openDirectory"), multi) {
    (true, true) => d.blocking_pick_folders(),
    (true, false) => d.blocking_pick_folder().map(|p| vec![p]),
    (false, true) => d.blocking_pick_files(),
    (false, false) => d.blocking_pick_file().map(|p| vec![p]),
  };
  Ok(match picked {
    Some(v) => json!(v.into_iter().filter_map(path_str).collect::<Vec<_>>()),
    None => Value::Null,
  })
}

fn dialog_save(app: &AppHandle, a: &Value) -> Res {
  let o = a.get("opts").cloned().unwrap_or(Value::Null);
  let mut d = file_dialog(app, a).set_can_create_directories(true);
  if let Some(dp) = s(&o, "defaultPath") {
    let p = PathBuf::from(dp);
    if p.is_dir() {
      d = d.set_directory(&p);
    } else {
      if let Some(dir) = p.parent().filter(|d| d.is_dir()) {
        d = d.set_directory(dir);
      }
      if let Some(name) = p.file_name() {
        d = d.set_file_name(name.to_string_lossy());
      }
    }
  }
  Ok(d.blocking_save_file().and_then(path_str).map(Value::String).unwrap_or(Value::Null))
}

fn dialog_message(app: &AppHandle, a: &Value) -> Res {
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

fn displays(app: &AppHandle) -> Res {
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

// ---- dispatch ----------------------------------------------------------------

fn dispatch(app: &AppHandle, cmd: &str, a: &Value) -> Res {
  match cmd {
    "app.ready" => Ok(Value::Null),
    "app.setOrigin" => {
      *shared().origin.lock().unwrap() = s(a, "origin").unwrap_or("").trim_end_matches('/').to_string();
      Ok(Value::Null)
    }
    #[cfg(target_os = "macos")]
    "app.dockIcon" => dock_icon(app, a),
    "app.activationPolicy" => {
      #[cfg(target_os = "macos")]
      {
        let p = match s(a, "policy") {
          Some("accessory") => tauri::ActivationPolicy::Accessory,
          Some("prohibited") => tauri::ActivationPolicy::Prohibited,
          _ => tauri::ActivationPolicy::Regular,
        };
        app.set_activation_policy(p).map_err(|e| e.to_string())?;
      }
      Ok(Value::Null)
    }
    "app.focus" => {
      #[cfg(target_os = "macos")]
      let _ = app.show();
      if let Some(w) = app.webview_windows().values().find(|w| w.is_visible().unwrap_or(false)) {
        let _ = w.set_focus();
      }
      Ok(Value::Null)
    }
    "app.hide" => {
      #[cfg(target_os = "macos")]
      app.hide().map_err(|e| e.to_string())?;
      Ok(Value::Null)
    }
    "dialog.open" => dialog_open(app, a),
    "dialog.save" => dialog_save(app, a),
    "dialog.message" => dialog_message(app, a),
    "screen.displays" => displays(app),
    "screen.cursor" => cursor(app),
    "menu.setApp" => {
      let m = build_menu(app, a)?;
      app.set_menu(m).map(|_| Value::Null).map_err(|e| e.to_string())
    }
    "tray.create" => {
      TrayIconBuilder::with_id(tray_id(a))
        .icon(image(a)?)
        .icon_as_template(b(a, "template").unwrap_or(false))
        .build(app)
        .map(|_| Value::Null)
        .map_err(|e| e.to_string())
    }
    "tray.setTitle" | "tray.setTooltip" | "tray.setIcon" | "tray.setMenu" => {
      let t = app.tray_by_id(&tray_id(a)).ok_or("no tray")?;
      let r = match cmd {
        "tray.setTitle" => t.set_title(s(a, "title")),
        "tray.setTooltip" => t.set_tooltip(s(a, "tooltip")),
        "tray.setIcon" => t
          .set_icon(Some(image(a)?))
          .and_then(|_| t.set_icon_as_template(b(a, "template").unwrap_or(false))),
        _ => t.set_menu(Some(build_menu(app, a)?)),
      };
      r.map(|_| Value::Null).map_err(|e| e.to_string())
    }
    "tray.destroy" => {
      app.remove_tray_by_id(&tray_id(a));
      Ok(Value::Null)
    }
    "win.create" => create_window(app, a),
    "win.navigate" => navigate(app, a),
    #[cfg(target_os = "macos")]
    "win.capture" => capture(app, a),
    #[cfg(target_os = "macos")]
    "drag.paths" => drag_paths(app),
    c if c.starts_with("win.") => win_cmd(app, c, a),
    _ => Err(format!("unknown command {cmd}")),
  }
}

// Calls that wait on a person or a page load: off the async reader thread so
// they do not hold up the commands behind them.
fn is_slow(cmd: &str) -> bool {
  matches!(cmd, "dialog.open" | "dialog.save" | "dialog.message" | "win.navigate" | "win.capture")
}

fn reply(out: &Arc<Mutex<TcpStream>>, id: &Value, r: Res) {
  let v = match r {
    Ok(val) => json!({ "id": id, "ok": true, "val": val }),
    Err(err) => json!({ "id": id, "ok": false, "err": err }),
  };
  let mut line = v.to_string();
  line.push('\n');
  let _ = out.lock().unwrap().write_all(line.as_bytes());
}

fn serve(app: AppHandle, stream: TcpStream, token: String) {
  let _ = stream.set_nodelay(true);
  let Ok(write_half) = stream.try_clone() else { return };
  let out = Arc::new(Mutex::new(write_half));
  let mut lines = BufReader::new(stream).lines();
  let Some(Ok(hello)) = lines.next() else { return };
  let hello: Value = serde_json::from_str(&hello).unwrap_or(Value::Null);
  if s(&hello, "hello") != Some(token.as_str()) {
    return;
  }
  let is_async = s(&hello, "role") == Some("async");
  if is_async {
    if let Ok(ev) = out.lock().unwrap().try_clone() {
      *shared().events.lock().unwrap() = Some(ev);
    }
  }
  for line in lines {
    let Ok(line) = line else { break };
    let Ok(m) = serde_json::from_str::<Value>(&line) else { continue };
    let id = m.get("id").cloned().unwrap_or(Value::Null);
    let cmd = s(&m, "cmd").unwrap_or("").to_string();
    let args = m.get("args").cloned().unwrap_or(Value::Null);
    if is_async && is_slow(&cmd) {
      let (app, out) = (app.clone(), out.clone());
      std::thread::spawn(move || reply(&out, &id, dispatch(&app, &cmd, &args)));
    } else {
      reply(&out, &id, dispatch(&app, &cmd, &args));
    }
  }
}

fn random_token() -> String {
  let mut parts = String::new();
  for _ in 0..2 {
    let mut h = std::collections::hash_map::RandomState::new().build_hasher();
    h.write_u128(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos());
    h.write_u32(std::process::id());
    parts.push_str(&format!("{:016x}", h.finish()));
  }
  parts
}

// ---- Node --------------------------------------------------------------------

fn repo_root() -> PathBuf {
  PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..")
}

fn node_bin() -> PathBuf {
  if let Ok(p) = std::env::var("RIVEN_NODE") {
    return PathBuf::from(p);
  }
  if let Ok(home) = std::env::var("HOME") {
    let nvm = PathBuf::from(home).join(".nvm/versions/node");
    if let Ok(rd) = std::fs::read_dir(&nvm) {
      let mut vs: Vec<PathBuf> = rd.filter_map(|e| e.ok().map(|e| e.path().join("bin/node"))).filter(|p| p.exists()).collect();
      vs.sort();
      if let Some(last) = vs.pop() {
        return last;
      }
    }
  }
  PathBuf::from("node")
}

fn start_node(app: &AppHandle) -> Result<(), String> {
  let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
  let port = listener.local_addr().map_err(|e| e.to_string())?.port();
  let token = random_token();
  {
    let (app, token) = (app.clone(), token.clone());
    std::thread::spawn(move || {
      for stream in listener.incoming().flatten() {
        let (app, token) = (app.clone(), token.clone());
        std::thread::spawn(move || serve(app, stream, token));
      }
    });
  }
  let script = std::env::var("RIVEN_TAURI_MAIN")
    .map(PathBuf::from)
    .unwrap_or_else(|_| repo_root().join("out-tauri/main/index.js"));
  let mut child = std::process::Command::new(node_bin())
    .arg(&script)
    .current_dir(repo_root())
    .env("RIVEN_TAURI_CTL_PORT", port.to_string())
    .env("RIVEN_TAURI_CTL_TOKEN", &token)
    .spawn()
    .map_err(|e| format!("node: {e}"))?;
  // Node is the app: when it exits (app.quit -> process.exit) so does the shell.
  // The other way round needs nothing: Node exits when this line closes.
  let app = app.clone();
  std::thread::spawn(move || {
    let code = child.wait().ok().and_then(|s| s.code()).unwrap_or(0);
    app.exit(code);
  });
  Ok(())
}

fn main() {
  let app = tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .on_menu_event(|_app, ev| emit(json!({ "ev": "menu", "id": ev.id().0 })))
    .on_window_event(|w, ev| {
      let label = w.label();
      // Popouts are dockview's, owned by the opener's page; node never made them.
      if label.starts_with("pop-") {
        popout_event(w, ev);
        return;
      }
      match ev {
        WindowEvent::Focused(true) => win_event(label, "focus", Value::Null),
        WindowEvent::Focused(false) => win_event(label, "blur", Value::Null),
        WindowEvent::Moved(_) => {
          frame_changed(w);
          win_event(label, "moved", Value::Null)
        }
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
          match (was, now) {
            (false, true) => win_event(label, "minimize", Value::Null),
            (true, false) => win_event(label, "restore", Value::Null),
            _ => win_event(label, "resized", Value::Null),
          }
        }
        WindowEvent::Destroyed => {
          let sh = shared();
          sh.external.lock().unwrap().remove(label);
          sh.expected.lock().unwrap().remove(label);
          sh.minimized.lock().unwrap().remove(label);
          sh.loading.lock().unwrap().remove(label);
          win_event(label, "closed", Value::Null);
        }
        _ => {}
      }
    })
    .setup(|app| {
      #[cfg(target_os = "macos")]
      observe_system();
      start_node(app.handle()).map_err(|e| Box::<dyn std::error::Error>::from(e))?;
      Ok(())
    })
    .build(tauri::generate_context!())
    .expect("riven-tauri: failed to build the app");

  app.run(|app, ev| match ev {
    // The last window closing, or Cmd+Q / the Dock's Quit. Only Node may
    // decide to quit (before-quit runs there); app.exit from the Node watcher
    // carries a code and is let through.
    RunEvent::ExitRequested { code: None, api, .. } => {
      api.prevent_exit();
      if !app.webview_windows().is_empty() {
        emit(json!({ "ev": "quit-requested" }));
      }
    }
    #[cfg(target_os = "macos")]
    RunEvent::Reopen { has_visible_windows, .. } => {
      emit(json!({ "ev": "activate", "hasVisibleWindows": has_visible_windows }))
    }
    _ => {}
  });
}
