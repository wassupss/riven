// app:version and update:* (src/main/update.ts), with the status the page shows
// ('update:status' to every app page): idle, checking, available, downloading,
// downloaded, upToDate, error.
//
// Electron's autoUpdater read GitHub Releases. The Tauri app will use
// tauri-plugin-updater's feed (phase 8): a latest.json manifest
// {version, notes, pub_date, platforms: {"darwin-aarch64": {url, signature}}}.
// What is here is that flow's check: fetch the manifest, pick this platform,
// compare versions. Downloading and installing (the signed bundle swap) are the
// plugin's and are not done here: an available update is reported as such and
// stops there. A dev build has no feed and is always up to date, as before.
//
// The "update ready" notification (formerly the Node shim's Notification) is
// posted through services/notify and a click installs (notify::post_update).

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

fn feed() -> Option<String> {
  std::env::var("RIVEN_UPDATE_FEED").ok().filter(|u| u.starts_with("https://"))
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

/// (major, minor, patch, pre-release or None): enough of semver to order releases.
pub fn parse_version(v: &str) -> Option<(u64, u64, u64, Option<String>)> {
  let v = v.trim().trim_start_matches('v');
  let v = v.split('+').next()?;
  let (core, pre) = match v.split_once('-') {
    Some((c, p)) => (c, Some(p.to_string())),
    None => (v, None),
  };
  let mut it = core.split('.').map(|n| n.parse::<u64>().ok());
  let (a, b, c) = (it.next()??, it.next().flatten().unwrap_or(0), it.next().flatten().unwrap_or(0));
  Some((a, b, c, pre))
}

/// Whether `remote` is a newer release than `local` (a pre-release sorts below its release).
pub fn newer(remote: &str, local: &str) -> bool {
  let (Some(r), Some(l)) = (parse_version(remote), parse_version(local)) else { return false };
  match (r.0, r.1, r.2).cmp(&(l.0, l.1, l.2)) {
    std::cmp::Ordering::Greater => true,
    std::cmp::Ordering::Less => false,
    std::cmp::Ordering::Equal => match (&r.3, &l.3) {
      (None, Some(_)) => true,
      (Some(a), Some(b)) => a > b,
      _ => false,
    },
  }
}

/// tauri-plugin-updater's platform key for this build.
pub fn platform_key() -> String {
  let os = if cfg!(target_os = "macos") { "darwin" } else if cfg!(windows) { "windows" } else { "linux" };
  let arch = if cfg!(target_arch = "aarch64") { "aarch64" } else { "x86_64" };
  format!("{os}-{arch}")
}

/// The manifest's answer for this platform: Some(version) when it offers a
/// newer build with a download, None when we are current.
pub fn offer(manifest: &Value, local: &str, platform: &str) -> Result<Option<String>, String> {
  let v = manifest.get("version").and_then(Value::as_str).ok_or("update feed: no version")?;
  if !newer(v, local) {
    return Ok(None);
  }
  let p = manifest.get("platforms").and_then(|p| p.get(platform)).ok_or_else(|| format!("update feed: nothing for {platform}"))?;
  if p.get("url").and_then(Value::as_str).is_none_or(str::is_empty) || p.get("signature").and_then(Value::as_str).is_none_or(str::is_empty) {
    return Err(format!("update feed: {platform} has no signed download"));
  }
  Ok(Some(v.trim_start_matches('v').to_string()))
}

/// update:check
pub fn check() {
  if !packaged() {
    send(json!({ "state": "upToDate" }));
    return;
  }
  let Some(url) = feed() else {
    // No feed configured yet (phase 8 sets it): nothing to look at.
    send(json!({ "state": "upToDate" }));
    return;
  };
  send(json!({ "state": "checking" }));
  let r = super::http::fetch(&url, "GET", &[], None).and_then(|res| {
    if !(200..300).contains(&res.status) {
      return Err(format!("update feed: HTTP {}", res.status));
    }
    let m: Value = serde_json::from_str(&res.body).map_err(|e| format!("update feed: {e}"))?;
    offer(&m, &app_version(), &platform_key())
  });
  match r {
    Ok(None) => send(json!({ "state": "upToDate" })),
    Ok(Some(v)) => send(json!({ "state": "available", "version": v })),
    Err(e) => send(json!({ "state": "error", "message": e })),
  }
}

/// A downloaded update is ready: say so, and install on a click. Called by
/// the updater's download once it is wired (phase 8).
#[allow(dead_code)]
pub fn downloaded(version: &str) {
  send(json!({ "state": "downloaded", "version": version }));
  let title = format!("riven {version} 업데이트 준비됨 / update ready");
  let _ = super::notify::post_update(&title, "클릭하면 재시작하여 설치합니다. / Click to restart and install.");
}

/// update:install (and a click on the "update ready" notification).
pub fn install() {
  // Only a downloaded update can be installed, and nothing downloads yet.
  if latest().lock().unwrap().get("state").and_then(Value::as_str) != Some("downloaded") {
    return;
  }
  if let Some(app) = APP.get() {
    app.restart();
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn versions() {
    assert!(newer("0.3.3", "0.3.2"));
    assert!(newer("v1.0.0", "0.9.9"));
    assert!(!newer("0.3.2", "0.3.2"));
    assert!(!newer("0.3.1", "0.3.2"));
    assert!(newer("0.3.2", "0.3.2-rc.1"));
    assert!(!newer("0.3.2-rc.1", "0.3.2"));
    assert!(newer("0.3.2-rc.2", "0.3.2-rc.1"));
    assert!(newer("0.4", "0.3.9"));
    assert!(!newer("garbage", "0.3.2"));
    assert_eq!(app_version(), serde_json::from_str::<Value>(include_str!("../../../package.json")).unwrap()["version"]);
  }

  #[test]
  fn manifests() {
    let m = json!({ "version": "0.4.0", "platforms": { "darwin-aarch64": { "url": "https://x/riven.tar.gz", "signature": "sig" } } });
    assert_eq!(offer(&m, "0.3.2", "darwin-aarch64"), Ok(Some("0.4.0".into())));
    assert_eq!(offer(&m, "0.4.0", "darwin-aarch64"), Ok(None));
    assert!(offer(&m, "0.3.2", "darwin-x86_64").is_err());
    let unsigned = json!({ "version": "0.4.0", "platforms": { "darwin-aarch64": { "url": "https://x", "signature": "" } } });
    assert!(offer(&unsigned, "0.3.2", "darwin-aarch64").is_err());
    assert!(offer(&json!({}), "0.3.2", "darwin-aarch64").is_err());
  }
}
