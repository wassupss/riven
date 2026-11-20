// git and GitHub (src/main/git.ts, githubPr.ts, githubPrDetail.ts,
// githubPrReview.ts). Everything shells out to the user's own `git` and `gh`,
// found on the login PATH (services/shell_env), so the same binaries and the
// same `gh` wrapper a terminal would use answer here. GitHub access is the gh
// CLI's login; riven keeps no token.
//
//   exec          child_process.execFile, with its errors and limits
//   spawn_io      spawn + stdin + collect (ghStdin / ghJson)
//   repo          git:* channels
//   github        gh:* channels
//   watch         git:watch ('git:changed' on HEAD / ORIG_HEAD / index)

pub mod github;
pub mod repo;

use crate::services::chat::util::sigterm;
use std::process::Stdio;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// Node's execFile default when no maxBuffer is given.
pub const DEFAULT_MAX_BUFFER: usize = 1024 * 1024;

pub struct Out {
  pub ok: bool,
  pub stdout: String,
  pub stderr: String,
  /// The rejection's message when !ok ("Command failed: <cmd>\n<stderr>",
  /// "spawn git ENOENT", "stdout maxBuffer length exceeded").
  pub message: String,
}

impl Out {
  /// `e.stderr || e.message`
  pub fn err_text(&self) -> String {
    if self.stderr.is_empty() { self.message.clone() } else { self.stderr.clone() }
  }
}

fn spawn_message(bin: &str, e: &std::io::Error) -> String {
  let code = match e.kind() {
    std::io::ErrorKind::NotFound => "ENOENT",
    std::io::ErrorKind::PermissionDenied => "EACCES",
    _ => "UNKNOWN",
  };
  format!("spawn {bin} {code}")
}

/// promisify(execFile)(bin, args, { cwd, timeout, maxBuffer }): the login PATH
/// on top of this process's environment, stdout/stderr as UTF-8. Fails on a
/// non-zero exit, a signal, the timeout (SIGTERM) or either stream passing
/// maxBuffer (SIGTERM), with Node's messages.
pub async fn exec(bin: &str, args: &[String], cwd: Option<&str>, timeout: Option<Duration>, max_buffer: usize) -> Out {
  let mut c = crate::services::shell_env::tokio_command(bin);
  c.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
  if let Some(d) = cwd {
    c.current_dir(d);
  }
  let mut child = match c.spawn() {
    Ok(ch) => ch,
    Err(e) => return Out { ok: false, stdout: String::new(), stderr: String::new(), message: spawn_message(bin, &e) },
  };
  let pid = child.id().unwrap_or(0);
  // Which stream passed maxBuffer first, if any.
  let over: Arc<Mutex<Option<&'static str>>> = Arc::new(Mutex::new(None));
  let read = |stream: Option<Box<dyn tokio::io::AsyncRead + Unpin + Send>>, name: &'static str| {
    let over = over.clone();
    tokio::spawn(async move {
      let mut buf = Vec::new();
      let Some(mut s) = stream else { return buf };
      let mut chunk = [0u8; 16384];
      while let Ok(n) = s.read(&mut chunk).await {
        if n == 0 {
          break;
        }
        if buf.len() + n > max_buffer {
          let room = max_buffer.saturating_sub(buf.len());
          buf.extend_from_slice(&chunk[..room]);
          {
            let mut o = over.lock().unwrap();
            if o.is_none() {
              *o = Some(name);
              sigterm(pid);
            }
          }
          // Drain the rest so the child is not blocked on a full pipe.
          while let Ok(n) = s.read(&mut chunk).await {
            if n == 0 {
              break;
            }
          }
          break;
        }
        buf.extend_from_slice(&chunk[..n]);
      }
      buf
    })
  };
  let so = read(child.stdout.take().map(|s| Box::new(s) as _), "stdout");
  let se = read(child.stderr.take().map(|s| Box::new(s) as _), "stderr");
  let wait = async {
    let status = child.wait().await.ok();
    let out = so.await.unwrap_or_default();
    let err = se.await.unwrap_or_default();
    (status, out, err)
  };
  tokio::pin!(wait);
  let (status, out, err) = match timeout {
    None => wait.await,
    Some(t) => match tokio::time::timeout(t, &mut wait).await {
      Ok(r) => r,
      Err(_) => {
        sigterm(pid);
        // Node waits for 'close'; a child that ignores SIGTERM would hang it,
        // so this gives up after a while.
        match tokio::time::timeout(Duration::from_secs(5), &mut wait).await {
          Ok(r) => r,
          Err(_) => {
            unsafe {
              libc::kill(pid as i32, libc::SIGKILL);
            }
            (None, Vec::new(), Vec::new())
          }
        }
      }
    },
  };
  let stdout = String::from_utf8_lossy(&out).into_owned();
  let stderr = String::from_utf8_lossy(&err).into_owned();
  let over = *over.lock().unwrap();
  if let Some(name) = over {
    return Out { ok: false, stdout, stderr, message: format!("{name} maxBuffer length exceeded") };
  }
  if status.is_some_and(|s| s.code() == Some(0)) {
    return Out { ok: true, stdout, stderr, message: String::new() };
  }
  let mut cmd = bin.to_string();
  if !args.is_empty() {
    cmd.push(' ');
    cmd.push_str(&args.join(" "));
  }
  let message = format!("Command failed: {cmd}\n{stderr}");
  Out { ok: false, stdout, stderr, message }
}

/// The `spawn` helpers of githubPr.ts (ghStdin) and githubPrReview.ts
/// (ghJson): stdin gets `input` (or is just closed), ok is exit code 0, a
/// spawn failure's message is the stderr, and the timeout is SIGKILL with
/// "\ntimed out" added to stderr. Returns (ok, stdout, stderr).
pub async fn spawn_io(bin: &str, args: &[String], cwd: &str, input: Option<&str>, timeout: Duration) -> (bool, String, String) {
  let mut c = crate::services::shell_env::tokio_command(bin);
  c.args(args).current_dir(cwd).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
  let mut child = match c.spawn() {
    Ok(ch) => ch,
    Err(e) => return (false, String::new(), spawn_message(bin, &e)),
  };
  let pid = child.id().unwrap_or(0);
  if let Some(mut stdin) = child.stdin.take() {
    let data = input.unwrap_or("").as_bytes().to_vec();
    tokio::spawn(async move {
      let _ = stdin.write_all(&data).await;
      let _ = stdin.shutdown().await;
    });
  }
  let collect = |stream: Option<Box<dyn tokio::io::AsyncRead + Unpin + Send>>| {
    tokio::spawn(async move {
      let mut buf = Vec::new();
      if let Some(mut s) = stream {
        let _ = s.read_to_end(&mut buf).await;
      }
      buf
    })
  };
  let so = collect(child.stdout.take().map(|s| Box::new(s) as _));
  let se = collect(child.stderr.take().map(|s| Box::new(s) as _));
  let wait = async {
    let status = child.wait().await.ok();
    (status, so.await.unwrap_or_default(), se.await.unwrap_or_default())
  };
  tokio::pin!(wait);
  let mut timed_out = false;
  let (status, out, err) = match tokio::time::timeout(timeout, &mut wait).await {
    Ok(r) => r,
    Err(_) => {
      timed_out = true;
      unsafe {
        libc::kill(pid as i32, libc::SIGKILL);
      }
      tokio::time::timeout(Duration::from_secs(5), &mut wait).await.unwrap_or((None, Vec::new(), Vec::new()))
    }
  };
  let mut stderr = String::from_utf8_lossy(&err).into_owned();
  if timed_out {
    stderr.push_str("\ntimed out");
  }
  let ok = !timed_out && status.is_some_and(|s| s.code() == Some(0));
  (ok, String::from_utf8_lossy(&out).into_owned(), stderr)
}

// ---- Node's path module (posix), for values that reach the page -----------------

/// path.normalize
pub fn normalize(p: &str) -> String {
  if p.is_empty() {
    return ".".into();
  }
  let abs = p.starts_with('/');
  let trailing = p.ends_with('/');
  let mut out: Vec<&str> = Vec::new();
  for seg in p.split('/') {
    match seg {
      "" | "." => {}
      ".." => {
        if out.last().is_some_and(|l| *l != "..") {
          out.pop();
        } else if !abs {
          out.push("..");
        }
      }
      s => out.push(s),
    }
  }
  let mut s = out.join("/");
  if s.is_empty() && !abs {
    s = ".".into();
  }
  if !s.is_empty() && trailing {
    s.push('/');
  }
  if abs { format!("/{s}") } else { s }
}

/// path.join(a, b)
pub fn join(a: &str, b: &str) -> String {
  let parts: Vec<&str> = [a, b].into_iter().filter(|s| !s.is_empty()).collect();
  if parts.is_empty() {
    return ".".into();
  }
  normalize(&parts.join("/"))
}

/// path.basename
pub fn basename(p: &str) -> String {
  let t = p.trim_end_matches('/');
  if t.is_empty() {
    return String::new();
  }
  t.rsplit('/').next().unwrap_or("").to_string()
}

/// path.dirname
pub fn dirname(p: &str) -> String {
  if p.is_empty() {
    return ".".into();
  }
  let b = p.as_bytes();
  let has_root = b[0] == b'/';
  let mut end: Option<usize> = None;
  let mut matched_slash = true;
  for i in (1..b.len()).rev() {
    if b[i] == b'/' {
      if !matched_slash {
        end = Some(i);
        break;
      }
    } else {
      matched_slash = false;
    }
  }
  match end {
    None => (if has_root { "/" } else { "." }).into(),
    Some(1) if has_root => "//".into(),
    Some(e) => p[..e].to_string(),
  }
}

// ---- git:watch ------------------------------------------------------------------

struct HeadWatch {
  _w: notify::RecommendedWatcher,
}

fn head_slot() -> &'static Mutex<Option<HeadWatch>> {
  static S: OnceLock<Mutex<Option<HeadWatch>>> = OnceLock::new();
  S.get_or_init(Default::default)
}

/// One watch for the app, replaced by each call (headWatcher in git.ts): a
/// non-recursive watch of <folder>/.git that calls `changed` when HEAD,
/// ORIG_HEAD or index changes (branch switches, commits, staging). A folder
/// without a .git, or whose .git is a file (a worktree), gets no watch, as
/// before (fs.watch on that file never named HEAD).
pub fn watch_head(folder: &str, changed: Box<dyn Fn() + Send + 'static>) {
  use notify::Watcher;
  let mut slot = head_slot().lock().unwrap();
  *slot = None;
  let git_dir = std::path::PathBuf::from(join(folder, ".git"));
  if !git_dir.is_dir() {
    return;
  }
  let real = std::fs::canonicalize(&git_dir).unwrap_or_else(|_| git_dir.clone());
  let dir = git_dir.clone();
  let w = notify::recommended_watcher(move |r: notify::Result<notify::Event>| {
    let Ok(ev) = r else { return };
    for p in &ev.paths {
      let direct = p.parent().is_some_and(|d| d == real || d == dir);
      let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
      if direct && matches!(name, "HEAD" | "ORIG_HEAD" | "index") {
        changed();
      }
    }
  });
  let Ok(mut w) = w else { return };
  if w.watch(&git_dir, notify::RecursiveMode::NonRecursive).is_ok() {
    *slot = Some(HeadWatch { _w: w });
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn node_paths() {
    assert_eq!(join("/a/b/", "c"), "/a/b/c");
    assert_eq!(join("/a/b", ".git"), "/a/b/.git");
    assert_eq!(join("a/../..", "x"), "../x");
    assert_eq!(normalize("/a//b/./c/.."), "/a/b");
    assert_eq!(normalize("/.."), "/");
    assert_eq!(normalize("a/"), "a/");
    assert_eq!(basename("/a/b/"), "b");
    assert_eq!(basename("/"), "");
    assert_eq!(basename("x"), "x");
    assert_eq!(dirname("/a/b/c.ts"), "/a/b");
    assert_eq!(dirname("/a"), "/");
    assert_eq!(dirname("a"), ".");
    assert_eq!(dirname("/a/b/"), "/a");
    assert_eq!(dirname("//a"), "//");
  }
}
