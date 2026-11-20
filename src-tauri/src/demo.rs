// Dev affordances gated by environment variables (src/main/index.ts and
// demo.ts). None of them runs in normal use.
//
//   RIVEN_CAPTURE=<path> [RIVEN_CAPTURE_DELAY=ms]  the window as a PNG once
//       loaded (default 7s later), then quit. For authentic screenshots.
//   RIVEN_CAP_LIVE=1   the window to /tmp/riven_cap.png every 2s. Does not quit.
//   RIVEN_DEMO=<dir>   a scripted tour of the real UI, ~10 frames/s into <dir>
//       (f-0000.png ...), 1280 wide, then quit. Encoded to video elsewhere.
//
// WebKit draws the page into an image itself (no screen-recording permission),
// as Electron's capturePage did. The demo's wheel ticks are DOM wheel events
// at a point (Monaco scrolls on them like on Electron's synthetic input).

use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::AppHandle;

fn shot(app: &AppHandle, label: &str, width: Option<f64>) -> Result<Vec<u8>, String> {
  use base64::Engine;
  let mut a = json!({ "label": label });
  if let Some(w) = width {
    a["snapshotWidth"] = json!(w);
  }
  match crate::browser::capture(app, &a)? {
    Value::String(b64) => base64::engine::general_purpose::STANDARD.decode(b64).map_err(|e| e.to_string()),
    _ => Err("no image".into()),
  }
}

fn js(app: &AppHandle, label: &str, code: &str) {
  let _ = crate::browser::dispatch(app, "wv.exec", &json!({ "label": label, "code": format!("(0, eval)({})", Value::String(code.into())), "expr": true }));
}

/// After the main window's page has loaded (open_main), start whatever the
/// environment asks for.
pub fn attach(app: &AppHandle, label: &str) {
  let (app, label) = (app.clone(), label.to_string());
  if let Ok(out) = std::env::var("RIVEN_CAPTURE") {
    let delay = std::env::var("RIVEN_CAPTURE_DELAY").ok().and_then(|d| d.parse().ok()).filter(|d| *d > 0).unwrap_or(7000);
    let (app, label) = (app.clone(), label.clone());
    std::thread::spawn(move || {
      std::thread::sleep(Duration::from_millis(delay));
      match shot(&app, &label, None).and_then(|png| std::fs::write(&out, png).map_err(|e| e.to_string())) {
        Ok(()) => eprintln!("[riven] captured {out}"),
        Err(e) => eprintln!("[riven] capture failed {e}"),
      }
      crate::lifecycle::quit_now(&app);
    });
  }
  if std::env::var_os("RIVEN_CAP_LIVE").is_some() {
    let (app, label) = (app.clone(), label.clone());
    std::thread::spawn(move || loop {
      std::thread::sleep(Duration::from_secs(2));
      if let Ok(png) = shot(&app, &label, None) {
        let _ = std::fs::write("/tmp/riven_cap.png", png);
      }
    });
  }
  if let Ok(dir) = std::env::var("RIVEN_DEMO") {
    std::thread::spawn(move || run_demo(&app, &label, Path::new(&dir)));
  }
}

fn wheel(app: &AppHandle, label: &str, x: f64, y: f64, dy: f64) {
  js(
    app,
    label,
    &format!("(() => {{ const el = document.elementFromPoint({x}, {y}); el && el.dispatchEvent(new WheelEvent('wheel', {{ deltaX: 0, deltaY: {dy}, deltaMode: 0, clientX: {x}, clientY: {y}, bubbles: true, cancelable: true }})) }})()"),
  );
}

fn scroll_editor(app: &AppHandle, label: &str, dir: f64, ticks: u32) {
  for _ in 0..ticks {
    wheel(app, label, 660.0, 300.0, 34.0 * dir);
    std::thread::sleep(Duration::from_millis(55));
  }
}

fn run_demo(app: &AppHandle, label: &str, out: &Path) {
  let _ = std::fs::create_dir_all(out);
  let capturing = Arc::new(AtomicBool::new(false));
  let done = Arc::new(AtomicBool::new(false));
  let grabber = {
    let (app, label, out, capturing, done) = (app.clone(), label.to_string(), PathBuf::from(out), capturing.clone(), done.clone());
    std::thread::spawn(move || {
      let mut frame = 0u32;
      while !done.load(Ordering::SeqCst) {
        let t = Instant::now();
        if capturing.load(Ordering::SeqCst) {
          if let Ok(png) = shot(&app, &label, Some(1280.0)) {
            let _ = std::fs::write(out.join(format!("f-{frame:04}.png")), png);
            frame += 1;
          }
        }
        std::thread::sleep(Duration::from_millis(100).saturating_sub(t.elapsed()));
      }
      frame
    })
  };
  let sleep = |ms: u64| std::thread::sleep(Duration::from_millis(ms));
  // Warm-up (not captured): the workspace restores, the dev server boots.
  sleep(6500);
  js(app, label, "document.querySelector('.preview-webview')?.reload?.()");
  sleep(2600);
  js(app, label, "document.querySelectorAll('.file-tab')[0]?.click()");
  sleep(600);
  wheel(app, label, 660.0, 300.0, -1600.0);
  sleep(500);
  capturing.store(true, Ordering::SeqCst);
  sleep(700);
  scroll_editor(app, label, 1.0, 22);
  sleep(900);
  js(app, label, "document.querySelectorAll('.file-tab')[1]?.click()");
  sleep(1300);
  scroll_editor(app, label, 1.0, 8);
  sleep(700);
  js(app, label, "document.querySelectorAll('.file-tab')[2]?.click()");
  sleep(1400);
  js(app, label, "document.querySelectorAll('.file-tab')[0]?.click()");
  sleep(700);
  scroll_editor(app, label, -1.0, 20);
  sleep(1600);
  capturing.store(false, Ordering::SeqCst);
  done.store(true, Ordering::SeqCst);
  let frames = grabber.join().unwrap_or(0);
  eprintln!("[riven] demo captured {frames} frames -> {}", out.display());
  crate::lifecycle::quit_now(app);
}
