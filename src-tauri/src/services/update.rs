// app:version and update:* (src/main/update.ts), with the status the page shows
// ('update:status' to every app page): idle, checking, available, downloading,
// downloaded, upToDate, error.
//
// Electron's autoUpdater read GitHub Releases. This app uses
// tauri-plugin-updater: a latest.json manifest {version, notes, pub_date,
// platforms: {"darwin-aarch64": {url, signature}}} at the feed, the bundle
// (riven-tauri.app.tar.gz) signed with the updater key (minisign), checked
// against the public key built in. Like Electron's: check on launch,
// download in the background, then "update ready" (a notification whose
// click, or update:install, swaps the bundle and restarts).
//
// The feed and the public key come from the build (CI sets them; see
// docs/tauri-rust-main.md, 8단계 배포): RIVEN_UPDATE_FEED and
// RIVEN_UPDATER_PUBKEY at compile time, or tauri.conf.json plugins.updater
// (endpoints, pubkey). RIVEN_UPDATE_FEED in the environment overrides the
// feed at run time (https only). Without both, a packaged app is always up to
// date; so is a dev build, as before.

use serde_json::{json, Value};
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Manager};

static APP: OnceLock<AppHandle> = OnceLock::new();

fn latest() -> &'static Mutex<Value> {
  static L: OnceLock<Mutex<Value>> = OnceLock::new();
  L.get_or_init(|| Mutex::new(json!({ "state": "idle" })))
}

/// package.json's version: what app.getVersion() answered (the shim read it there too).
pub fn app_version() -> String {
  static V: OnceLock<String> = OnceLock::new();
  V.get_or_init(|| {
    serde_json::from_str::<Value>(include_str!("../../../package.json"))
      .ok()
      .and_then(|v| v.get("version").and_then(Value::as_str).map(String::from))
      .unwrap_or_else(|| "0.0.0".into())
  })
  .clone()
}

/// A packaged app (not `cargo build`'s dev binary) checks for updates.
fn packaged() -> bool {
  !tauri::is_dev()
}

/// The feed: the environment (https only), else the build's, else tauri.conf.json's.
fn feed() -> Option<String> {
  let https = |u: &str| u.starts_with("https://");
  if let Some(u) = std::env::var("RIVEN_UPDATE_FEED").ok().filter(|u| https(u)) {
    return Some(u);
  }
  if let Some(u) = option_env!("RIVEN_UPDATE_FEED").filter(|u| https(u)) {
    return Some(u.to_string());
  }
  let app = APP.get()?;
  let cfg = app.config().plugins.0.get("updater")?;
  cfg.get("endpoints")?.as_array()?.iter().filter_map(Value::as_str).find(|u| https(u)).map(String::from)
}

/// The minisign public key updates are verified with (never a private key).
fn pubkey() -> Option<String> {
  if let Some(k) = option_env!("RIVEN_UPDATER_PUBKEY").filter(|k| !k.trim().is_empty()) {
    return Some(k.trim().to_string());
  }
  let app = APP.get()?;
  let k = app.config().plugins.0.get("updater")?.get("pubkey")?.as_str()?.trim().to_string();
  (!k.is_empty()).then_some(k)
}

/// The plugin, registered on the builder (main.rs). Its own JS commands are
/// not granted to any page; Rust drives it.
pub fn plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R, tauri_plugin_updater::Config> {
  tauri_plugin_updater::Builder::new().build()
}

pub fn init(app: &AppHandle) {
  let _ = APP.set(app.clone());
  // Once on launch (packaged only; dev has no feed).
  if packaged() && !crate::background() {
    std::thread::spawn(check);
  }
}

fn send(s: Value) {
  *latest().lock().unwrap() = s.clone();
  let Some(app) = APP.get() else { return };
  for label in app.webview_windows().into_keys() {
    if crate::commands::app_page(&label) {
      crate::commands::emit_ipc(app, &label, "update:status", json!([s]));
    }
  }
}

pub fn current() -> Value {
  latest().lock().unwrap().clone()
}

/// A downloaded update, kept until it is installed.
fn ready() -> &'static Mutex<Option<(tauri_plugin_updater::Update, Vec<u8>)>> {
  static R: OnceLock<Mutex<Option<(tauri_plugin_updater::Update, Vec<u8>)>>> = OnceLock::new();
  R.get_or_init(Default::default)
}

/// update:check (and once on launch): check, then download in the background.
pub fn check() {
  if !packaged() {
    send(json!({ "state": "upToDate" }));
    return;
  }
  let (Some(app), Some(url), Some(key)) = (APP.get(), feed(), pubkey()) else {
    // No feed or key in this build: nothing to look at.
    send(json!({ "state": "upToDate" }));
    return;
  };
  if let Some(v) = ready().lock().unwrap().as_ref().map(|(u, _)| u.version.clone()) {
    send(json!({ "state": "downloaded", "version": v }));
    return;
  }
  send(json!({ "state": "checking" }));
  let r: Result<Option<String>, String> = tauri::async_runtime::block_on(async {
    use tauri_plugin_updater::UpdaterExt;
    let url = url.parse().map_err(|e: url::ParseError| e.to_string())?;
    let up = app.updater_builder().endpoints(vec![url]).map_err(|e| e.to_string())?.pubkey(key).build().map_err(|e| e.to_string())?;
    let Some(update) = up.check().await.map_err(|e| e.to_string())? else { return Ok(None) };
    let v = update.version.clone();
    send(json!({ "state": "available", "version": v }));
    send(json!({ "state": "downloading", "version": v, "percent": 0 }));
    // Progress as the page shows it (whole percents, sent only on change).
    let (mut got, mut last) = (0u64, 0u64);
    let pv = v.clone();
    let on_chunk = move |n: usize, total: Option<u64>| {
      got += n as u64;
      if let Some(t) = total.filter(|t| *t > 0) {
        let p = (got * 100 / t).min(100);
        if p != last {
          last = p;
          send(json!({ "state": "downloading", "version": pv, "percent": p }));
        }
      }
    };
    // The plugin verifies the signature against the key before it hands the bytes over.
    let bytes = update.download(on_chunk, || {}).await.map_err(|e| e.to_string())?;
    *ready().lock().unwrap() = Some((update, bytes));
    Ok(Some(v))
  });
  match r {
    Ok(None) => send(json!({ "state": "upToDate" })),
    Ok(Some(v)) => downloaded(&v),
    Err(e) => send(json!({ "state": "error", "message": e })),
  }
}

/// A downloaded update is ready: say so, and install on a click.
fn downloaded(version: &str) {
  send(json!({ "state": "downloaded", "version": version }));
  let title = format!("riven {version} 업데이트 준비됨 / update ready");
  let _ = super::notify::post_update(&title, "클릭하면 재시작하여 설치합니다. / Click to restart and install.");
}

/// update:install (and a click on the "update ready" notification): swap the
/// bundle, then restart (the quit runs the page flush first).
pub fn install() {
  let Some(app) = APP.get() else { return };
  let Some((update, bytes)) = ready().lock().unwrap().take() else { return };
  match update.install(bytes) {
    Ok(()) => {
      for label in crate::lifecycle::main_windows(app) {
        crate::lifecycle::flush_page(app, &label);
      }
      app.restart();
    }
    Err(e) => send(json!({ "state": "error", "message": e.to_string() })),
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn version_is_package_json() {
    assert_eq!(app_version(), serde_json::from_str::<Value>(include_str!("../../../package.json")).unwrap()["version"]);
  }
}
