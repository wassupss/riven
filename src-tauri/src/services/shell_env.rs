// The user's login-shell PATH. A GUI app started from Finder or the Dock gets
// launchd's short PATH (/usr/bin:/bin:...), without what ~/.zshrc adds (nvm,
// Homebrew, pyenv). Children riven spawns (git, gh, claude, language servers)
// need the real one, so it is read once at startup from
// `$SHELL -lic 'echo $PATH'`, off the main thread and with a timeout.
//
//   start()       at startup; returns at once
//   login_path()  the PATH; waits for the shell (up to the timeout) the first time
//   command(p)    a std Command for program p with that PATH
//   tokio_command(p)  the same for tokio::process

// Used by the groups that spawn children (git, chat, language servers) as they move here.
#![allow(dead_code)]

use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::{Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

const TIMEOUT: Duration = Duration::from_secs(5);
const MARK: &str = "__RIVEN_PATH__";

static STATE: OnceLock<(Mutex<Option<String>>, Condvar)> = OnceLock::new();

fn state() -> &'static (Mutex<Option<String>>, Condvar) {
  STATE.get_or_init(|| (Mutex::new(None), Condvar::new()))
}

pub fn start() {
  std::thread::spawn(|| {
    let t = Instant::now();
    let got = read_login_path();
    let path = match &got {
      Some(p) => p.clone(),
      None => std::env::var("PATH").unwrap_or_default(),
    };
    eprintln!(
      "[shell-env] login PATH {} in {}ms ({} entries)",
      if got.is_some() { "read" } else { "unavailable, using inherited" },
      t.elapsed().as_millis(),
      path.split(':').filter(|s| !s.is_empty()).count()
    );
    let (m, cv) = state();
    *m.lock().unwrap() = Some(path);
    cv.notify_all();
  });
}

fn read_login_path() -> Option<String> {
  let shell = std::env::var("SHELL").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "/bin/zsh".into());
  // Markers around the value: an interactive shell may print its own banner.
  let mut child = Command::new(&shell)
    .args(["-lic", &format!("echo \"{MARK}${{PATH}}{MARK}\"")])
    .stdin(Stdio::null())
    .stdout(Stdio::piped())
    .stderr(Stdio::null())
    .spawn()
    .ok()?;
  let mut out = child.stdout.take()?;
  let (tx, rx) = std::sync::mpsc::channel();
  // Stop reading at the closing marker: something the rc files started in the
  // background may hold stdout open long after the echo.
  std::thread::spawn(move || {
    let mut s = Vec::new();
    let mut buf = [0u8; 4096];
    while let Ok(n) = out.read(&mut buf) {
      if n == 0 {
        break;
      }
      s.extend_from_slice(&buf[..n]);
      if String::from_utf8_lossy(&s).matches(MARK).count() >= 2 {
        break;
      }
    }
    let _ = tx.send(String::from_utf8_lossy(&s).into_owned());
  });
  let text = rx.recv_timeout(TIMEOUT).unwrap_or_default();
  let _ = child.kill();
  let _ = child.wait();
  let start = text.find(MARK)? + MARK.len();
  let end = start + text[start..].find(MARK)?;
  let p = text[start..end].trim().to_string();
  (!p.is_empty()).then_some(p)
}

/// The login-shell PATH (or the inherited one if the shell could not be read).
pub fn login_path() -> String {
  let (m, cv) = state();
  let g = m.lock().unwrap();
  let (g, _) = cv.wait_timeout_while(g, TIMEOUT + Duration::from_secs(1), |v| v.is_none()).unwrap();
  g.clone().unwrap_or_else(|| std::env::var("PATH").unwrap_or_default())
}

pub fn command(program: impl AsRef<std::ffi::OsStr>) -> Command {
  let mut c = Command::new(program);
  c.env("PATH", login_path());
  c
}

pub fn tokio_command(program: impl AsRef<std::ffi::OsStr>) -> tokio::process::Command {
  let mut c = tokio::process::Command::new(program);
  c.env("PATH", login_path());
  c
}

/// The full path of `program` on the login PATH, if it is there.
pub fn which(program: &str) -> Option<std::path::PathBuf> {
  login_path().split(':').filter(|d| !d.is_empty()).map(|d| std::path::Path::new(d).join(program)).find(|p| p.is_file())
}
