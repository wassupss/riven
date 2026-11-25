// Small helpers the chat modules share: finding and running the CLIs, JS-like
// value reads (the stream's JSON is loosely typed and the Node code leaned on
// `??`, `||` and `String(x)`), and string clamps in UTF-16 units, which is what
// a JS `slice` counts.

use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tokio::io::AsyncReadExt;

pub use crate::services::fsx::{utf16_len, utf16_prefix};

// ---- values -------------------------------------------------------------------

/// JS truthiness of a JSON value.
/// String.prototype.trim: whitespace and the BOM.
pub fn js_trim(s: &str) -> &str {
  s.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
}

pub fn truthy(v: Option<&Value>) -> bool {
  match v {
    None | Some(Value::Null) => false,
    Some(Value::Bool(b)) => *b,
    Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
    Some(Value::String(s)) => !s.is_empty(),
    Some(_) => true,
  }
}

/// `String(v)` for the shapes the stream carries.
pub fn js_string(v: &Value) -> String {
  match v {
    Value::Null => "null".into(),
    Value::String(s) => s.clone(),
    Value::Bool(b) => b.to_string(),
    Value::Number(n) => num_string(n),
    Value::Array(a) => a.iter().map(|x| if x.is_null() { String::new() } else { js_string(x) }).collect::<Vec<_>>().join(","),
    Value::Object(_) => "[object Object]".into(),
  }
}

fn num_string(n: &serde_json::Number) -> String {
  if let Some(i) = n.as_i64() {
    return i.to_string();
  }
  let f = n.as_f64().unwrap_or(0.0);
  if f.fract() == 0.0 && f.abs() < 1e21 {
    format!("{}", f as i64)
  } else {
    f.to_string()
  }
}

/// A JSON number for an f64 that is usually an integer (no trailing ".0").
pub fn jnum(f: f64) -> Value {
  if f.fract() == 0.0 && f.abs() < 9.0e15 {
    Value::from(f as i64)
  } else {
    serde_json::Number::from_f64(f).map(Value::Number).unwrap_or(Value::from(0))
  }
}

/// `s.length > n ? s.slice(0, n) + '…' : s`
pub fn clamp(s: &str, n: usize) -> String {
  if utf16_len(s) > n {
    format!("{}…", utf16_prefix(s, n))
  } else {
    s.to_string()
  }
}

/// `s.slice(0, n)`
pub fn slice(s: &str, n: usize) -> String {
  utf16_prefix(s, n).to_string()
}

pub fn home() -> PathBuf {
  crate::services::paths::home()
}

pub fn uuid() -> String {
  let mut b = [0u8; 16];
  if std::fs::File::open("/dev/urandom").and_then(|mut f| std::io::Read::read_exact(&mut f, &mut b)).is_err() {
    let n = crate::services::fsx::now_ms();
    b.copy_from_slice(&(n ^ (std::process::id() as u128) << 64).to_le_bytes());
  }
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  let h: String = b.iter().map(|x| format!("{x:02x}")).collect();
  format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32])
}

pub fn now_ms() -> f64 {
  std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs_f64() * 1000.0).unwrap_or(0.0)
}

pub fn mtime_ms(meta: &std::fs::Metadata) -> f64 {
  meta
    .modified()
    .ok()
    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
    .map(|d| d.as_secs() as f64 * 1000.0 + f64::from(d.subsec_nanos()) / 1e6)
    .unwrap_or(0.0)
}

// ---- finding the CLIs ------------------------------------------------------------

// Agent CLIs cost money every time one starts a turn; under RIVEN_E2E they
// resolve to nothing (shellPath.ts).
const BILLED: [&str; 2] = ["claude", "codex"];

fn executable(p: &Path) -> bool {
  use std::os::unix::ffi::OsStrExt;
  let Ok(c) = std::ffi::CString::new(p.as_os_str().as_bytes()) else { return false };
  // fs.access(p, X_OK)
  unsafe { libc::access(c.as_ptr(), libc::X_OK) == 0 }
}

/// resolveBin: the first executable `cmd` on the login PATH.
pub async fn resolve_bin(cmd: &str) -> Option<String> {
  if std::env::var_os("RIVEN_E2E").is_some_and(|v| !v.is_empty()) && BILLED.contains(&cmd) {
    return None;
  }
  let cmd = cmd.to_string();
  tauri::async_runtime::spawn_blocking(move || {
    let path = crate::services::shell_env::login_path();
    path.split(':').filter(|d| !d.is_empty()).map(|d| Path::new(d).join(&cmd)).find(|p| executable(p)).map(|p| p.to_string_lossy().into_owned())
  })
  .await
  .ok()
  .flatten()
}

/// loginEnv(): this process's environment with the login PATH (only PATH
/// differs, so it is applied as an override on top of the inherited env).
pub fn login_path() -> String {
  crate::services::shell_env::login_path()
}

pub fn sigterm(pid: u32) {
  if pid > 0 {
    unsafe {
      libc::kill(pid as i32, libc::SIGTERM);
    }
  }
}

// ---- running a CLI to completion ------------------------------------------------

pub struct Run<'a> {
  pub bin: &'a str,
  pub args: Vec<String>,
  pub cwd: Option<&'a str>,
  /// Login PATH (loginEnv) instead of the inherited one (process.env).
  pub login: bool,
  pub env: HashMap<String, String>,
  pub stderr: bool,
  pub timeout: Duration,
}

pub struct Ran {
  /// Exit code; None for a signal, a spawn failure or the timeout.
  pub code: Option<i32>,
  pub spawned: bool,
  pub timed_out: bool,
  pub out: String,
}

/// spawn + collect stdout (and stderr when asked) + kill at the timeout, the
/// pattern every one-shot CLI call in agentChat.ts used. On timeout the child
/// gets SIGTERM (proc.kill()) and what it printed so far is returned.
pub async fn run(r: Run<'_>) -> Ran {
  let mut c = tokio::process::Command::new(r.bin);
  c.args(&r.args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(if r.stderr { Stdio::piped() } else { Stdio::null() });
  if let Some(d) = r.cwd {
    c.current_dir(d);
  }
  if r.login {
    c.env("PATH", login_path());
  }
  for (k, v) in &r.env {
    c.env(k, v);
  }
  let Ok(mut child) = c.spawn() else {
    return Ran { code: None, spawned: false, timed_out: false, out: String::new() };
  };
  let pid = child.id().unwrap_or(0);
  let buf = std::sync::Arc::new(std::sync::Mutex::new(Vec::<u8>::new()));
  let mut readers = Vec::new();
  if let Some(mut o) = child.stdout.take() {
    let b = buf.clone();
    readers.push(tokio::spawn(async move {
      let mut chunk = [0u8; 8192];
      while let Ok(n) = o.read(&mut chunk).await {
        if n == 0 {
          break;
        }
        b.lock().unwrap().extend_from_slice(&chunk[..n]);
      }
    }));
  }
  if let Some(mut e) = child.stderr.take() {
    let b = buf.clone();
    readers.push(tokio::spawn(async move {
      let mut chunk = [0u8; 8192];
      while let Ok(n) = e.read(&mut chunk).await {
        if n == 0 {
          break;
        }
        b.lock().unwrap().extend_from_slice(&chunk[..n]);
      }
    }));
  }
  // 'close': the process exited AND its pipes are drained.
  let done = async {
    let status = child.wait().await;
    for h in readers {
      let _ = h.await;
    }
    status.ok().and_then(|s| s.code())
  };
  let (code, timed_out) = match tokio::time::timeout(r.timeout, done).await {
    Ok(code) => (code, false),
    Err(_) => {
      sigterm(pid);
      (None, true)
    }
  };
  let out = String::from_utf8_lossy(&buf.lock().unwrap()).into_owned();
  Ran { code, spawned: true, timed_out, out }
}

/// `<cli> --version`, as a bare version number.
pub async fn cli_version(bin: &str) -> Option<String> {
  let r = run(Run { bin, args: vec!["--version".into()], cwd: None, login: false, env: HashMap::new(), stderr: false, timeout: Duration::from_secs(4) }).await;
  let re = regex::Regex::new(r"\d+\.\d+(\.\d+)?").unwrap();
  re.find(&r.out).map(|m| m.as_str().to_string())
}

/// JSON.parse for the CLIs' output. JS writes a lone UTF-16 surrogate (a
/// string cut mid-emoji) as `\ud83d`, which JSON.parse takes and serde
/// rejects; such a line is retried with those escapes as U+FFFD instead of
/// being dropped (a dropped transcript line miscounts the session).
pub fn parse(line: &str) -> Option<Value> {
  match serde_json::from_str(line) {
    Ok(v) => Some(v),
    Err(_) if line.contains("\\u") => serde_json::from_str(&fix_surrogates(line)).ok(),
    Err(_) => None,
  }
}

fn hex4(b: &[u8]) -> Option<u16> {
  std::str::from_utf8(b.get(..4)?).ok().and_then(|h| u16::from_str_radix(h, 16).ok())
}

fn fix_surrogates(s: &str) -> String {
  let b = s.as_bytes();
  let mut out = String::with_capacity(s.len());
  let (mut i, mut from) = (0, 0);
  while i < b.len() {
    if b[i] != b'\\' {
      i += 1;
      continue;
    }
    if b.get(i + 1) != Some(&b'u') {
      i += 2;
      continue;
    }
    let Some(u) = hex4(&b[i + 2..]) else {
      i += 2;
      continue;
    };
    let low_next = |j: usize| b.get(j) == Some(&b'\\') && b.get(j + 1) == Some(&b'u') && hex4(&b[j + 2..]).is_some_and(|v| (0xdc00..0xe000).contains(&v));
    if (0xd800..0xdc00).contains(&u) && low_next(i + 6) {
      i += 12;
    } else if (0xd800..0xe000).contains(&u) {
      out.push_str(&s[from..i]);
      out.push_str("\\ufffd");
      i += 6;
      from = i;
    } else {
      i += 6;
    }
  }
  out.push_str(&s[from..]);
  out
}

#[cfg(test)]
mod tests {
  #[test]
  fn lone_surrogates() {
    assert_eq!(super::parse(r#"{"a":"x\ud83d"}"#).unwrap()["a"], "x\u{fffd}");
    assert_eq!(super::parse(r#"{"a":"😀"}"#).unwrap()["a"], "😀");
    assert_eq!(super::parse(r#"{"a":"\\ud83d"}"#).unwrap()["a"], "\\ud83d");
  }
}
