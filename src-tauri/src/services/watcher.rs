// The workspace watcher (watch:start in src/main/bridge.ts): file and folder
// changes under the active workspace, sent to the page that asked as
// 'fs:changed' batches of {type, path} with type add | change | unlink |
// addDir | unlinkDir. One watcher for the whole app, as before: starting a new
// one replaces the old.
//
// FSEvents (through notify) reports coalesced flags per path rather than
// chokidar's typed events, so the type is decided when a batch is sent, from
// the flags seen and whether the path exists then:
//   exists, created or renamed  -> add / addDir
//   exists, only modified       -> change (files only)
//   gone                        -> unlink / unlinkDir
// A file replaced by an atomic save (temp + rename) therefore comes through as
// 'add' rather than chokidar's 'change'. The listeners treat both as "this
// changed" (the explorer re-reads the folder, git refreshes).
//
// Batching: events within BATCH of the first one in a batch go out together,
// one per (type, path), in order. That also stands in for chokidar's
// awaitWriteFinish (120ms of stable size).

use notify::event::{CreateKind, EventKind, ModifyKind, RemoveKind};
use notify::{RecursiveMode, Watcher};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

const BATCH: Duration = Duration::from_millis(150);

// Build/cache/VCS directories churn constantly (Next/turbopack rewrite .next
// thousands of times a second); never report them, nor our atomic-write temps.
// Matched against the path inside the workspace.
fn ignored(rel: &str) -> bool {
  static RE: OnceLock<regex::Regex> = OnceLock::new();
  RE.get_or_init(|| {
    regex::Regex::new(
      r"(\.riven-tmp$)|(^|/)(\.git|node_modules|out|dist|\.riven|\.cache|\.next|\.turbo|\.svelte-kit|\.nuxt|\.output|\.vercel|\.vite|\.parcel-cache|coverage|__pycache__|\.pytest_cache|\.mypy_cache|\.venv|venv|target|Library|\.Trash|\.Trashes)(/|$)",
    )
    .unwrap()
  })
  .is_match(rel)
}

pub type Sink = Box<dyn Fn(Vec<serde_json::Value>) + Send + 'static>;

struct Active {
  _watcher: notify::RecommendedWatcher,
}

fn slot() -> &'static Mutex<Option<Active>> {
  static S: OnceLock<Mutex<Option<Active>>> = OnceLock::new();
  S.get_or_init(Default::default)
}

#[derive(Default, Clone, Copy)]
struct Flags {
  created: bool,
  removed: bool,
  renamed: bool,
  modified: bool,
  dir: Option<bool>,
}

pub fn stop() {
  // Dropping the watcher closes its channel, which ends the batching thread.
  *slot().lock().unwrap() = None;
}

pub fn start(folder: &str, sink: Sink) -> Result<(), String> {
  stop();
  let root = PathBuf::from(folder);
  // FSEvents reports real paths (/private/var, resolved links); the page knows
  // the folder by the name it opened it with.
  let real = std::fs::canonicalize(&root).unwrap_or_else(|_| root.clone());
  let (tx, rx) = mpsc::channel::<notify::Event>();
  let mut w = notify::recommended_watcher(move |r: notify::Result<notify::Event>| {
    if let Ok(ev) = r {
      let _ = tx.send(ev);
    }
  })
  .map_err(|e| e.to_string())?;
  w.watch(&root, RecursiveMode::Recursive).map_err(|e| e.to_string())?;
  let label = folder.to_string();
  std::thread::Builder::new()
    .name("fs-watch".into())
    .spawn(move || batch_loop(rx, root, real, sink))
    .map_err(|e| e.to_string())?;
  eprintln!("[watch] ready: {label}");
  *slot().lock().unwrap() = Some(Active { _watcher: w });
  Ok(())
}

fn batch_loop(rx: mpsc::Receiver<notify::Event>, root: PathBuf, real: PathBuf, sink: Sink) {
  let mut order: Vec<PathBuf> = Vec::new();
  let mut flags: std::collections::HashMap<PathBuf, Flags> = Default::default();
  let mut known_dirs: HashSet<PathBuf> = HashSet::new();
  let mut deadline: Option<Instant> = None;
  loop {
    let got = match deadline {
      Some(d) => rx.recv_timeout(d.saturating_duration_since(Instant::now())),
      None => rx.recv().map_err(|_| mpsc::RecvTimeoutError::Disconnected),
    };
    match got {
      Ok(ev) => {
        for p in ev.paths {
          let p = if let Ok(rest) = p.strip_prefix(&real) { root.join(rest) } else { p };
          let Ok(rel) = p.strip_prefix(&root) else { continue };
          let rel = rel.to_string_lossy();
          if rel.is_empty() || ignored(&rel) {
            continue;
          }
          let f = flags.entry(p.clone()).or_insert_with(|| {
            order.push(p.clone());
            Flags::default()
          });
          match ev.kind {
            EventKind::Create(k) => {
              f.created = true;
              if k == CreateKind::Folder {
                f.dir = Some(true);
              } else if k == CreateKind::File {
                f.dir = Some(false);
              }
            }
            EventKind::Remove(k) => {
              f.removed = true;
              if k == RemoveKind::Folder {
                f.dir = Some(true);
              } else if k == RemoveKind::File {
                f.dir = Some(false);
              }
            }
            EventKind::Modify(ModifyKind::Name(_)) => f.renamed = true,
            EventKind::Modify(_) | EventKind::Any => f.modified = true,
            _ => {}
          }
        }
        if deadline.is_none() && !order.is_empty() {
          deadline = Some(Instant::now() + BATCH);
        }
      }
      Err(mpsc::RecvTimeoutError::Timeout) => {
        deadline = None;
        let mut out = Vec::new();
        let mut seen = HashSet::new();
        for p in order.drain(..) {
          let f = flags.remove(&p).unwrap_or_default();
          let kind = classify(&p, f, &mut known_dirs);
          if let Some(kind) = kind {
            let ps = p.to_string_lossy().into_owned();
            if seen.insert((kind, ps.clone())) {
              out.push(serde_json::json!({ "type": kind, "path": ps }));
            }
          }
        }
        if !out.is_empty() {
          sink(out);
        }
      }
      Err(mpsc::RecvTimeoutError::Disconnected) => return,
    }
  }
}

fn classify(p: &Path, f: Flags, known_dirs: &mut HashSet<PathBuf>) -> Option<&'static str> {
  match std::fs::symlink_metadata(p) {
    Ok(md) => {
      let dir = md.is_dir();
      if dir {
        known_dirs.insert(p.to_path_buf());
        // A folder's own "modified" is its listing changing; the entries report themselves.
        (f.created || f.renamed).then_some("addDir")
      } else if f.created || f.renamed {
        Some("add")
      } else if f.modified || f.removed {
        Some("change")
      } else {
        None
      }
    }
    Err(_) => {
      let was_dir = known_dirs.remove(p) || f.dir == Some(true);
      (f.removed || f.renamed || f.created || f.modified).then_some(if was_dir { "unlinkDir" } else { "unlink" })
    }
  }
}

#[cfg(test)]
mod tests {
  #[test]
  fn ignores() {
    assert!(super::ignored("node_modules/x/y.js"));
    assert!(super::ignored("a/.git"));
    assert!(super::ignored("src/foo.ts.riven-tmp"));
    assert!(!super::ignored("src/outer.ts"));
    assert!(!super::ignored("src/dist.ts"));
  }
}
