// The last channels Node answered (src/main/index.ts env:defaults, bridge.ts
// capture:save / shell:openExternal / ui:setZoom) and the preload's own
// plumbing (dropped files' paths, closing and theming dockview popouts).

use super::{blocking, CmdResult};
use crate::services::{paths, tools};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, Webview};

// ---- env:defaults ----------------------------------------------------------------

/// The claude CLI the app offers by default: the login shell's (PATH from the
/// user's profile), else the copy cmux bundles. index.ts resolveClaude.
fn resolve_claude() -> Option<String> {
  if let Some(p) = tools::resolve_bin("claude") {
    return Some(p);
  }
  let cmux = "/Applications/cmux.app/Contents/Resources/bin/claude";
  std::path::Path::new(cmux).exists().then(|| cmux.to_string())
}

fn hostname() -> String {
  let mut buf = [0u8; 256];
  let n = unsafe { libc::gethostname(buf.as_mut_ptr() as *mut libc::c_char, buf.len()) };
  if n != 0 {
    return String::new();
  }
  let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
  let h = String::from_utf8_lossy(&buf[..end]).into_owned();
  h.strip_suffix(".local").map(String::from).unwrap_or(h)
}

#[tauri::command]
pub async fn env_defaults() -> CmdResult<Value> {
  blocking(|| {
    json!({
      "home": paths::home().to_string_lossy(),
      "shell": std::env::var("SHELL").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "/bin/zsh".into()),
      // Node's process.platform names.
      "platform": match std::env::consts::OS { "macos" => "darwin", "windows" => "win32", o => o },
      "claudePath": resolve_claude(),
      // What a paired phone calls this machine (remote control).
      "hostname": hostname(),
      // Where a pet assistant spanning several workspaces runs its CLI
      // (state/petAssistants): riven's own folder, not the home folder (it
      // would trust, and load the project files of, all of home).
      "petHome": pet_home(),
    })
  })
  .await
}

/// userData/pet-assistants, made on first ask (owner only).
fn pet_home() -> Option<String> {
  use std::os::unix::fs::DirBuilderExt;
  let dir = paths::user_data().join("pet-assistants");
  std::fs::DirBuilder::new().recursive(true).mode(0o700).create(&dir).ok()?;
  Some(dir.to_string_lossy().into_owned())
}

// ---- capture:save ----------------------------------------------------------------

/// Under userData, not the workspace (a `.riven/` in every repo would force a
/// .gitignore entry on people), one folder per workspace.
pub fn capture_dir_name(folder: &str) -> String {
  let mut out = String::new();
  let mut dash = false;
  for c in folder.chars() {
    if c.is_ascii_alphanumeric() {
      out.push(c);
      dash = false;
    } else if !dash {
      out.push('-');
      dash = true;
    }
  }
  let t = out.trim_matches('-');
  if t.is_empty() { "workspace".into() } else { t.to_string() }
}

const CAPTURE_CAP: usize = 40;

/// Keep the newest CAPTURE_CAP shots (shot-<ms>-<seq>.png: lexical order is
/// time order, as bridge.ts sorted them).
pub fn prune(names: &mut Vec<String>) -> Vec<String> {
  names.retain(|f| f.starts_with("shot-") && f.ends_with(".png"));
  names.sort();
  let n = names.len().saturating_sub(CAPTURE_CAP);
  names.drain(..n).collect()
}

#[tauri::command]
pub async fn capture_save(folder: String, data_url: String) -> CmdResult<String> {
  use base64::Engine;
  use std::sync::atomic::{AtomicU64, Ordering};
  static SEQ: AtomicU64 = AtomicU64::new(0);
  blocking(move || {
    let dir = paths::user_data().join("captures").join(capture_dir_name(&folder));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let b64 = data_url.strip_prefix("data:image/png;base64,").unwrap_or(&data_url);
    let bytes = base64::engine::general_purpose::STANDARD.decode(b64.trim()).map_err(|e| e.to_string())?;
    let ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    let file = dir.join(format!("shot-{ms}-{}.png", SEQ.fetch_add(1, Ordering::Relaxed) + 1));
    std::fs::write(&file, bytes).map_err(|e| e.to_string())?;
    if let Ok(rd) = std::fs::read_dir(&dir) {
      let mut names: Vec<String> = rd.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
      for old in prune(&mut names) {
        let _ = std::fs::remove_file(dir.join(old));
      }
    }
    Ok(file.to_string_lossy().into_owned())
  })
  .await?
}

// ---- shell:openExternal ------------------------------------------------------------

/// Only real web links leave the app (port chips, links in chat or docs).
pub fn external_ok(url: &str) -> bool {
  let l = url.trim_start().to_ascii_lowercase();
  (l.starts_with("http://") || l.starts_with("https://")) && url::Url::parse(url.trim()).is_ok()
}

pub fn open_external(url: &str) {
  if !external_ok(url) {
    return;
  }
  crate::lifecycle::note("open external link");
  let _ = std::process::Command::new("/usr/bin/open").arg(url.trim()).spawn().map(|mut c| {
    std::thread::spawn(move || c.wait());
  });
}

#[tauri::command]
pub fn shell_open_external(url: String) {
  open_external(&url)
}

// ---- ui:setZoom ------------------------------------------------------------------

/// Whole-UI zoom on the page's own webview (WebKit's pageZoom survives loads,
/// so there is no re-apply after did-finish-load as Electron needed).
#[tauri::command]
pub fn ui_set_zoom(webview: Webview, factor: f64) {
  if factor.is_finite() && factor > 0.0 {
    let _ = webview.set_zoom(factor);
  }
}

// ---- the preload's plumbing ---------------------------------------------------------

/// The paths of the files being dragged (WebKit hides them from the page). The
/// preload asks when a drag with files enters, so they are there by the drop.
#[tauri::command]
pub async fn riven_drag_paths(app: AppHandle) -> Vec<String> {
  #[cfg(target_os = "macos")]
  {
    blocking(move || crate::drag_paths(&app)).await.ok().and_then(|r| r.ok()).unwrap_or_default()
  }
  #[cfg(not(target_os = "macos"))]
  {
    let _ = app;
    Vec::new()
  }
}

/// A dockview popout's window.close() (WKWebView ignores it from script).
#[tauri::command]
pub fn riven_close_popout(app: AppHandle, id: String) {
  if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
    return;
  }
  let label = format!("pop-{id}");
  if let Some(w) = app.get_window(&label) {
    #[cfg(target_os = "macos")]
    crate::services::browser::host_closing(&label);
    let _ = w.destroy();
  }
}

/// The opener's theme, worn by popout title bars.
#[tauri::command]
pub fn riven_pop_theme(app: AppHandle, color: String, mode: String) {
  crate::pop_theme(&app, &color, &mode);
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn capture_names() {
    assert_eq!(capture_dir_name("/Users/me/my repo"), "Users-me-my-repo");
    assert_eq!(capture_dir_name("///"), "workspace");
    assert_eq!(capture_dir_name(""), "workspace");
    assert_eq!(capture_dir_name("한글/abc"), "abc");
  }

  #[test]
  fn keeps_the_newest_40() {
    let mut names: Vec<String> = (0..45).map(|i| format!("shot-{}-{}.png", 1000 + i, 1)).collect();
    names.push("other.txt".into());
    let gone = prune(&mut names);
    assert_eq!(gone.len(), 5);
    assert_eq!(gone[0], "shot-1000-1.png");
    assert_eq!(names.len(), 40);
  }

  #[test]
  fn only_web_links_leave() {
    assert!(external_ok("https://example.com/a"));
    assert!(external_ok("HTTP://localhost:3000"));
    assert!(!external_ok("file:///etc/passwd"));
    assert!(!external_ok("javascript:alert(1)"));
    assert!(!external_ok("riven://localhost/index.html"));
    assert!(!external_ok("http://"));
  }
}
