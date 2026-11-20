// Moving the page's localStorage to its new origin, once.
//
// WebKit keys localStorage by origin. Until phase 8 Node served the pages from
// http://127.0.0.1:47391; now they come from riven://localhost (page.rs), which
// starts empty. The old origin holds real data (chat logs, pipelines, agent
// groups, DB history, layout bits), so before the first window opens:
//
//   1. a hidden helper webview loads an empty document AS the old origin
//      (loadHTMLString with that base URL: nothing is fetched, nothing needs
//      to listen on the port) and reads every key,
//   2. the first app window opens riven://localhost/__riven/blank.html first
//      and, only if that origin is still empty, writes them all and reads them
//      back, then goes on to the app (lifecycle.rs open_main). The writes are
//      made by the window that stays: written from the short-lived helper
//      they never reached WebKit's storage (measured: 127 written and read
//      back there, 0 seen by the app page), as the helper's process went
//      before its storage messages were sent.
//   3. a marker per WebKit data store (the bundle id) means it never runs again.
//
// It never overwrites: a new origin that already has data is left alone.
//
// Coming from the Electron build (the released app shares its data folder,
// services/paths.rs), the entries are not in any WebKit store: the last
// Electron release wrote them to userData/electron-export/local-storage.json
// (src/main/chromiumExport.ts: the page's localStorage minus what moved to
// userData/store). When that file is there it is the source, and step 1 is
// skipped.

use serde_json::{json, Map, Value};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

pub const LABEL: &str = "riven-lsmigrate";
pub const OLD_ORIGIN: &str = "http://127.0.0.1:47391";
const ELECTRON_EXPORT: &str = "electron-export/local-storage.json";

fn source() -> &'static std::sync::Mutex<String> {
  static S: std::sync::OnceLock<std::sync::Mutex<String>> = std::sync::OnceLock::new();
  S.get_or_init(|| std::sync::Mutex::new(OLD_ORIGIN.to_string()))
}

/// The Electron export's entries ({ entries: { key: string } }); values that
/// are not strings are left out (localStorage holds strings only).
pub fn electron_export(text: &str) -> Option<Map<String, Value>> {
  let v: Value = serde_json::from_str(text).ok()?;
  Some(v.get("entries")?.as_object()?.iter().filter(|(_, v)| v.is_string()).map(|(k, v)| (k.clone(), v.clone())).collect())
}

const READ_ALL: &str = "(() => { const o = {}; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); o[k] = localStorage.getItem(k) } return JSON.stringify(o) })()";

/// The data store's name: WebKit keeps the page data under
/// ~/Library/WebKit/<bundle id> (the bare dev binary: its file name).
fn store_id() -> String {
  if let Some(id) = crate::services::paths::bundle_id() {
    return id;
  }
  std::env::current_exe().ok().and_then(|p| p.file_name().map(|n| n.to_string_lossy().into_owned())).unwrap_or_else(|| "riven-tauri".into())
}

pub fn marker() -> std::path::PathBuf {
  let id: String = store_id().chars().map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '-' { c } else { '_' }).collect();
  crate::services::paths::user_data().join(format!(".localstorage-moved-{id}"))
}

fn exec(app: &AppHandle, label: &str, code: &str) -> Result<Value, String> {
  let r = crate::browser::dispatch(app, "wv.exec", &json!({ "label": label, "code": code, "expr": true }))?;
  let text = r.as_str().unwrap_or("{}");
  let v: Value = serde_json::from_str(text).map_err(|e| e.to_string())?;
  Ok(v.get("v").cloned().unwrap_or(Value::Null))
}

/// Wait until the helper shows a document from `prefix` (a load is async).
fn wait_at(app: &AppHandle, label: &str, prefix: &str) -> Result<(), String> {
  let until = Instant::now() + Duration::from_secs(10);
  while Instant::now() < until {
    if let Ok(Value::String(href)) = exec(app, label, "document.readyState === 'complete' ? location.href : ''") {
      if href.starts_with(prefix) {
        return Ok(());
      }
    }
    std::thread::sleep(Duration::from_millis(50));
  }
  Err(format!("the helper page never reached {prefix}"))
}

fn read_all(app: &AppHandle, label: &str) -> Result<Map<String, Value>, String> {
  match exec(app, label, READ_ALL)? {
    Value::String(s) => match serde_json::from_str::<Value>(&s).map_err(|e| e.to_string())? {
      Value::Object(m) => Ok(m),
      _ => Err("not an object".into()),
    },
    _ => Err("no answer".into()),
  }
}

/// What happened, for the log and the marker.
#[derive(Debug)]
pub enum Outcome {
  Empty,
  Moved(usize),
  Kept(usize),
}

/// Step 1, before the first window: the old origin's entries, or None when
/// there is nothing to do (moved before, or nothing there).
pub fn pending(app: &AppHandle) -> Option<Map<String, Value>> {
  if marker().exists() {
    return None;
  }
  let export = crate::services::paths::user_data().join(ELECTRON_EXPORT);
  if let Ok(text) = std::fs::read_to_string(&export) {
    *source().lock().unwrap() = export.to_string_lossy().into_owned();
    return match electron_export(&text) {
      Some(m) if m.is_empty() => {
        done(&Outcome::Empty);
        None
      }
      Some(m) => Some(m),
      None => {
        eprintln!("[localStorage] {} does not parse; left alone", export.display());
        None
      }
    };
  }
  let w = match WebviewWindowBuilder::new(app, LABEL, WebviewUrl::External("about:blank".parse().unwrap()))
    .visible(false)
    .focused(false)
    .focusable(false)
    .skip_taskbar(true)
    .inner_size(200.0, 200.0)
    .build()
  {
    Ok(w) => w,
    Err(e) => {
      eprintln!("[localStorage] no helper page: {e}");
      return None;
    }
  };
  let r = (|| {
    crate::browser::dispatch(
      app,
      "wv.html",
      &json!({ "label": LABEL, "html": "<!doctype html><meta charset=utf-8><title>riven</title>", "base": format!("{OLD_ORIGIN}/") }),
    )?;
    wait_at(app, LABEL, OLD_ORIGIN)?;
    read_all(app, LABEL)
  })();
  let _ = w.destroy();
  match r {
    Ok(m) if m.is_empty() => {
      done(&Outcome::Empty);
      None
    }
    Ok(m) => Some(m),
    Err(e) => {
      eprintln!("[localStorage] reading {OLD_ORIGIN} failed: {e} (will retry next launch)");
      None
    }
  }
}

/// Step 2, in the first app window (`label`), before it loads the app.
pub fn write(app: &AppHandle, label: &str, old: Map<String, Value>) {
  let t = Instant::now();
  let r = (|| {
    let v = app.get_webview(label).ok_or("no window")?;
    let url: tauri::Url = crate::page::url("__riven/blank.html").parse().map_err(|e: url::ParseError| e.to_string())?;
    v.navigate(url).map_err(|e| e.to_string())?;
    wait_at(app, label, crate::page::ORIGIN)?;
    let payload = Value::String(Value::Object(old.clone()).to_string()).to_string();
    let wrote = exec(
      app,
      label,
      &format!("(() => {{ if (localStorage.length) return -localStorage.length; const o = JSON.parse({payload}); for (const k of Object.keys(o)) localStorage.setItem(k, o[k]); return localStorage.length }})()"),
    )?;
    let n = wrote.as_i64().unwrap_or(0);
    if n < 0 {
      return Ok(Outcome::Kept((-n) as usize));
    }
    let now = read_all(app, label)?;
    if now != old {
      return Err(format!("read back {} of {} entries, or different values", now.len(), old.len()));
    }
    Ok(Outcome::Moved(now.len()))
  })();
  match r {
    Ok(o) => {
      done(&o);
      eprintln!("[localStorage] ({}ms)", t.elapsed().as_millis());
    }
    Err(e) => eprintln!("[localStorage] moving from {} failed: {e} (will retry next launch)", source().lock().unwrap()),
  }
}

fn done(o: &Outcome) {
  let from = source().lock().unwrap().clone();
  let line = match o {
    Outcome::Empty => format!("nothing at {from}"),
    Outcome::Moved(n) => format!("moved {n} entries from {from} to {}", crate::page::ORIGIN),
    Outcome::Kept(n) => format!("{} already has {n} entries; left as is", crate::page::ORIGIN),
  };
  eprintln!("[localStorage] {line}");
  let _ = std::fs::create_dir_all(crate::services::paths::user_data());
  let _ = std::fs::write(marker(), format!("{line}\n"));
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn reads_the_electron_export() {
    let m = electron_export(r#"{"version":1,"page":"file:///x","entries":{"railCollapsed":"[\"a\"]","paneSeq:v1":"7","odd":5}}"#).unwrap();
    assert_eq!(serde_json::to_string(&m).unwrap(), r#"{"railCollapsed":"[\"a\"]","paneSeq:v1":"7"}"#);
    assert!(electron_export(r#"{"entries":{}}"#).unwrap().is_empty());
    assert!(electron_export("{").is_none());
    assert!(electron_export(r#"{"version":1}"#).is_none());
  }
}
