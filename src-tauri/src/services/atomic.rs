// Atomic, serialized writes (src/main/atomicWrite.ts). A write goes to
// <file>.riven-tmp and is renamed over the target, so a crash mid-write cannot
// truncate it. Writes to the same target take a per-path lock in arrival order
// (tokio's Mutex is fair), so overlapping saves cannot interleave and the last
// queued one wins. The blocking variant takes the same lock, so a sync flush on
// unload is ordered with the async saves before it.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

/// The watcher and the directory walks hide files with this suffix.
pub const TMP_SUFFIX: &str = ".riven-tmp";

type Lock = Arc<tokio::sync::Mutex<()>>;

fn locks() -> &'static Mutex<HashMap<PathBuf, Lock>> {
  static L: OnceLock<Mutex<HashMap<PathBuf, Lock>>> = OnceLock::new();
  L.get_or_init(Default::default)
}

fn lock_for(file: &Path) -> Lock {
  locks().lock().unwrap().entry(file.to_path_buf()).or_default().clone()
}

// Drop the entry once nobody else holds or waits on it, so the map cannot grow.
fn release(file: &Path, l: Lock) {
  let mut m = locks().lock().unwrap();
  drop(l);
  if m.get(file).map(|x| Arc::strong_count(x) == 1).unwrap_or(false) {
    m.remove(file);
  }
}

fn tmp_of(file: &Path) -> PathBuf {
  let mut s = file.as_os_str().to_owned();
  s.push(TMP_SUFFIX);
  PathBuf::from(s)
}

fn write_now(file: &Path, content: &[u8]) -> std::io::Result<()> {
  let tmp = tmp_of(file);
  std::fs::write(&tmp, content)?;
  std::fs::rename(&tmp, file)
}

pub async fn write(file: &Path, content: Vec<u8>) -> std::io::Result<()> {
  let l = lock_for(file);
  let r = {
    let _g = l.lock().await;
    let f = file.to_path_buf();
    tokio::task::spawn_blocking(move || write_now(&f, &content))
      .await
      .unwrap_or_else(|e| Err(std::io::Error::other(e)))
  };
  release(file, l);
  r
}

/// For callers on a plain thread (never inside the async runtime).
pub fn write_blocking(file: &Path, content: &[u8]) -> std::io::Result<()> {
  let l = lock_for(file);
  let r = {
    let _g = l.blocking_lock();
    write_now(file, content)
  };
  release(file, l);
  r
}

/// JSON.stringify(data, null, 2).
pub fn json_pretty(v: &serde_json::Value) -> Vec<u8> {
  serde_json::to_vec_pretty(v).unwrap_or_else(|_| b"null".to_vec())
}
