// Keep the machine awake while an agent works (src/main/keepAwake.ts), and the
// per-process CPU sample (src/main/perf.ts).
//
// power:busy (count, enabled) / power:remote (on): the system may not sleep
// while (enabled && count > 0) || remote. Held with `caffeinate -i -w <our pid>`
// (prevent idle system sleep; the display may still turn off), the same tool
// the Node shim used for Electron's powerSaveBlocker 'prevent-app-suspension'.
// -w ties it to this process: it ends by itself if riven dies.

use serde_json::{json, Value};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

struct Power {
  busy: i64,
  enabled: bool,
  remote: bool,
  hold: Option<Child>,
}

static POWER: Mutex<Power> = Mutex::new(Power { busy: 0, enabled: true, remote: false, hold: None });

fn sync(p: &mut Power) {
  let want = (p.enabled && p.busy > 0) || p.remote;
  if want && p.hold.is_none() {
    match Command::new("/usr/bin/caffeinate")
      .args(["-i", "-w", &std::process::id().to_string()])
      .stdin(Stdio::null())
      .stdout(Stdio::null())
      .stderr(Stdio::null())
      .spawn()
    {
      Ok(c) => {
        p.hold = Some(c);
        // "Why didn't my machine sleep last night" has one answer here.
        if p.remote {
          eprintln!("[power] holding sleep off - remote control is on");
        } else {
          eprintln!("[power] holding sleep off - {} pane(s) working", p.busy);
        }
      }
      Err(e) => eprintln!("[power] caffeinate failed: {e}"),
    }
    return;
  }
  if !want {
    if let Some(mut c) = p.hold.take() {
      let _ = c.kill();
      let _ = c.wait();
      eprintln!("[power] released");
    }
  }
}

pub fn busy(count: f64, on: bool) {
  let mut p = POWER.lock().unwrap();
  // Math.max(0, Math.floor(count))
  p.busy = if count.is_finite() { count.floor().max(0.0) as i64 } else { 0 };
  p.enabled = on;
  sync(&mut p);
}

pub fn remote(on: bool) {
  let mut p = POWER.lock().unwrap();
  p.remote = on;
  sync(&mut p);
}

/// Shutdown: let the machine sleep again.
pub fn release() {
  let mut p = POWER.lock().unwrap();
  p.busy = 0;
  p.remote = false;
  sync(&mut p);
}

// ---- perf:metrics -----------------------------------------------------------------------

static LAST: Mutex<Option<(f64, f64)>> = Mutex::new(None);

fn cpu_seconds() -> f64 {
  let mut u: libc::rusage = unsafe { std::mem::zeroed() };
  unsafe { libc::getrusage(libc::RUSAGE_SELF, &mut u) };
  let t = |v: libc::timeval| v.tv_sec as f64 + v.tv_usec as f64 / 1e6;
  t(u.ru_utime) + t(u.ru_stime)
}

/// This process's CPU (percent of one core) since the last sample. The
/// renderer's WebKit processes are not ours to list (they are the system's
/// XPC services), so this is the main process only.
pub fn metrics() -> Value {
  let now = crate::services::util::now_ms();
  let cpu = cpu_seconds();
  let pct = {
    let mut last = LAST.lock().unwrap();
    let (at, c) = last.unwrap_or((now, cpu));
    *last = Some((now, cpu));
    (cpu - c) * 1000.0 / (now - at).max(1.0) * 100.0
  };
  json!([{ "pid": std::process::id(), "type": "Browser", "name": "riven-tauri", "cpu": pct }])
}
