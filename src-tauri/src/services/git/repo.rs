// git:* (src/main/git.ts): the git panel, the explorer's badges, the status
// bar, the commit graph, inline blame. Same git commands, arguments, limits and
// answers as the Node module.

use super::{basename, dirname, exec, join, Out, DEFAULT_MAX_BUFFER};
use crate::services::chat::util::{js_string, js_trim, truthy};
use crate::services::collate::locale_compare;
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, HashMap};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

const MB: usize = 1024 * 1024;

fn args(folder: &str, rest: &[&str]) -> Vec<String> {
  let mut v = vec!["-C".to_string(), folder.to_string()];
  v.extend(rest.iter().map(|s| s.to_string()));
  v
}

async fn git(argv: Vec<String>, max_buffer: usize) -> Out {
  exec("git", &argv, None, None, max_buffer).await
}

/// Bumped by every change riven makes to a repo (see status()'s sharing).
static MUTATIONS: AtomicU64 = AtomicU64::new(0);

fn bump() {
  MUTATIONS.fetch_add(1, Ordering::SeqCst);
}

/// `symbolic-ref --short HEAD` works on an unborn branch; a detached HEAD
/// falls back to the short SHA.
pub async fn current_branch(folder: &str) -> Option<String> {
  let r = git(args(folder, &["symbolic-ref", "--short", "HEAD"]), DEFAULT_MAX_BUFFER).await;
  if r.ok {
    return Some(js_trim(&r.stdout).to_string());
  }
  let r = git(args(folder, &["rev-parse", "--short", "HEAD"]), DEFAULT_MAX_BUFFER).await;
  r.ok.then(|| js_trim(&r.stdout).to_string())
}

pub async fn info(folder: &str) -> Value {
  let top = git(args(folder, &["rev-parse", "--show-toplevel"]), DEFAULT_MAX_BUFFER).await;
  if top.ok {
    json!({ "repoName": basename(js_trim(&top.stdout)), "branch": current_branch(folder).await, "isRepo": true })
  } else {
    json!({ "repoName": basename(folder), "branch": null, "isRepo": false })
  }
}

/// Repos at or one level under the workspace folder.
pub async fn repos(folder: &str) -> Value {
  async fn add(dir: String) -> Option<Value> {
    if !std::path::Path::new(&join(&dir, ".git")).exists() {
      return None;
    }
    let branch = current_branch(&dir).await;
    Some(json!({ "path": dir, "name": basename(&dir), "branch": branch }))
  }
  let mut out: Vec<Value> = Vec::new();
  if let Some(v) = add(folder.to_string()).await {
    out.push(v);
  }
  let dir = folder.to_string();
  let dirs: Vec<String> = tokio::task::spawn_blocking(move || {
    crate::services::fsx::read_dir_sorted(std::path::Path::new(&dir))
      .map(|es| {
        es.into_iter()
          .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
          .filter_map(|e| e.file_name().to_str().map(str::to_string))
          .filter(|n| !n.starts_with('.') && n != "node_modules")
          .map(|n| join(&dir, &n))
          .collect()
      })
      .unwrap_or_default()
  })
  .await
  .unwrap_or_default();
  let tasks: Vec<_> = dirs.into_iter().map(|d| tokio::spawn(add(d))).collect();
  for t in tasks {
    if let Ok(Some(v)) = t.await {
      out.push(v);
    }
  }
  let name = |v: &Value| v["name"].as_str().unwrap_or("").to_string();
  out.sort_by(|a, b| locale_compare(&name(a), &name(b)));
  Value::Array(out)
}

/// Recent commits across all refs, NUL-separated fields.
pub async fn log(folder: &str, limit: Option<&Value>) -> Value {
  let n = match limit {
    None | Some(Value::Null) => "200".to_string(),
    Some(v) => js_string(v),
  };
  let r = git(
    args(folder, &["log", "--all", "--date-order", &format!("-n{n}"), "--pretty=format:%H%x00%P%x00%an%x00%ar%x00%d%x00%s"]),
    DEFAULT_MAX_BUFFER,
  )
  .await;
  if !r.ok {
    return json!([]);
  }
  static PARENS: OnceLock<regex::Regex> = OnceLock::new();
  let parens = PARENS.get_or_init(|| regex::Regex::new(r"^\s*\(|\)\s*$").unwrap());
  let list: Vec<Value> = r
    .stdout
    .split('\n')
    .filter(|l| !l.is_empty())
    .map(|line| {
      let f: Vec<&str> = line.split('\0').collect();
      let mut o = Map::new();
      if let Some(h) = f.first() {
        o.insert("hash".into(), json!(h));
      }
      let parents: Vec<&str> = f.get(1).map(|p| p.split(' ').filter(|s| !s.is_empty()).collect()).unwrap_or_default();
      o.insert("parents".into(), json!(parents));
      if let Some(a) = f.get(2) {
        o.insert("author".into(), json!(a));
      }
      if let Some(d) = f.get(3) {
        o.insert("date".into(), json!(d));
      }
      let refs = f.get(4).copied().unwrap_or("");
      o.insert("refs".into(), json!(js_trim(&parens.replace_all(refs, ""))));
      o.insert("subject".into(), json!(f.get(5).copied().unwrap_or("")));
      Value::Object(o)
    })
    .collect();
  Value::Array(list)
}

async fn status_now(folder: String) -> Value {
  let fail = json!({ "branch": null, "files": [], "isRepo": false, "ahead": 0, "behind": 0, "hasUpstream": false, "remote": null });
  if !git(args(&folder, &["rev-parse", "--is-inside-work-tree"]), DEFAULT_MAX_BUFFER).await.ok {
    return fail;
  }
  let branch = current_branch(&folder).await;
  // -z: raw (unquoted) paths, so non-ASCII names match the page's.
  let st = git(args(&folder, &["status", "--porcelain=v1", "-z"]), 10 * MB).await;
  if !st.ok {
    return fail;
  }
  let records: Vec<&str> = st.stdout.split('\0').collect();
  let mut files = Vec::new();
  let mut i = 0;
  while i < records.len() {
    let entry = records[i];
    // "XY p": X and Y are ASCII, so UTF-16 and byte offsets agree up to 3.
    if crate::services::fsx::utf16_len(entry) < 4 || !entry.is_char_boundary(3) {
      i += 1;
      continue;
    }
    let x = &entry[0..1];
    let y = &entry[1..2];
    let p = &entry[3..];
    // A rename/copy carries its source path in the next record.
    if x == "R" || x == "C" || y == "R" || y == "C" {
      i += 1;
    }
    let untracked = x == "?" && y == "?";
    files.push(json!({
      "path": p,
      "x": x,
      "y": y,
      "staged": !untracked && x != " ",
      "unstaged": untracked || y != " ",
      "untracked": untracked,
    }));
    i += 1;
  }
  let (mut ahead, mut behind, mut has_upstream) = (0i64, 0i64, false);
  let lr = git(args(&folder, &["rev-list", "--left-right", "--count", "@{upstream}...HEAD"]), DEFAULT_MAX_BUFFER).await;
  if lr.ok {
    // `lr.trim().split(/\s+/).map(Number)`, NaN -> 0
    let nums: Vec<i64> = js_trim(&lr.stdout).split(char::is_whitespace).filter(|s| !s.is_empty()).map(|s| s.parse::<f64>().map(|f| f as i64).unwrap_or(0)).collect();
    behind = nums.first().copied().unwrap_or(0);
    ahead = nums.get(1).copied().unwrap_or(0);
    has_upstream = true;
  }
  let url = git(args(&folder, &["config", "--get", "remote.origin.url"]), DEFAULT_MAX_BUFFER).await;
  let remote = if url.ok { Some(js_trim(&url.stdout).to_string()).filter(|s| !s.is_empty()) } else { None };
  json!({ "branch": branch, "files": files, "isRepo": true, "ahead": ahead, "behind": behind, "hasUpstream": has_upstream, "remote": remote })
}

// The git panel, the explorer's badges and the workspace card all ask at once,
// and each ask is ~5 git processes. One in flight (or finished within
// STATUS_SHARE) for a folder answers all of them, unless riven changed the repo
// since it started (a new MUTATIONS generation).
const STATUS_SHARE: Duration = Duration::from_millis(300);

struct Shared {
  at: Instant,
  gen: u64,
  cell: Arc<tokio::sync::OnceCell<Value>>,
}

fn shares() -> &'static Mutex<HashMap<String, Shared>> {
  static S: OnceLock<Mutex<HashMap<String, Shared>>> = OnceLock::new();
  S.get_or_init(Default::default)
}

pub async fn status(folder: &str) -> Value {
  let gen = MUTATIONS.load(Ordering::SeqCst);
  let cell = {
    let mut m = shares().lock().unwrap();
    match m.get(folder) {
      Some(hit) if hit.gen == gen && hit.at.elapsed() < STATUS_SHARE => hit.cell.clone(),
      _ => {
        let cell = Arc::new(tokio::sync::OnceCell::new());
        m.insert(folder.to_string(), Shared { at: Instant::now(), gen, cell: cell.clone() });
        cell
      }
    }
  };
  let f = folder.to_string();
  let v = cell.get_or_init(|| status_now(f)).await.clone();
  // Measured from when it finished, so a slow status still serves its peers.
  if let Some(cur) = shares().lock().unwrap().get_mut(folder) {
    if Arc::ptr_eq(&cur.cell, &cell) {
      cur.at = Instant::now();
    }
  }
  v
}

fn result(r: &Out) -> Value {
  if r.ok { json!({ "ok": true }) } else { json!({ "ok": false, "error": r.err_text() }) }
}

/// run(): a change with a 10MB buffer (push, pull, discard's checkout).
async fn run(folder: &str, rest: &[&str]) -> Value {
  bump();
  let r = git(args(folder, rest), 10 * MB).await;
  bump(); // and again once done: a status begun mid-change is stale too
  result(&r)
}

/// gitOk(): a change with the default buffer.
async fn git_ok(folder: &str, rest: &[&str]) -> Value {
  bump();
  let r = git(args(folder, rest), DEFAULT_MAX_BUFFER).await;
  bump();
  result(&r)
}

pub async fn show_file(folder: &str, rel: &str) -> Value {
  let r = git(args(folder, &["show", &format!("HEAD:./{rel}")]), 20 * MB).await;
  if r.ok { Value::String(r.stdout) } else { Value::Null }
}

/// Per-line blame, resolved from the file's own directory so a nested repo
/// still answers. Lines keyed by 1-based number; uncommitted lines omitted.
pub async fn blame(file_path: &str) -> Value {
  let r = git(args(&dirname(file_path), &["blame", "--line-porcelain", "--", &basename(file_path)]), 50 * MB).await;
  if !r.ok {
    return json!({ "ok": false, "error": r.message });
  }
  static HEADER: OnceLock<regex::Regex> = OnceLock::new();
  let header = HEADER.get_or_init(|| regex::Regex::new(r"^([0-9a-f]{40}) [0-9]+ ([0-9]+)").unwrap());
  #[derive(Clone, Default)]
  struct Meta {
    author: String,
    time: i64,
    summary: String,
  }
  let mut meta: HashMap<String, Meta> = HashMap::new();
  let mut lines: BTreeMap<u64, Value> = BTreeMap::new();
  let mut hash = String::new();
  let mut final_line = 0u64;
  for raw in r.stdout.split('\n') {
    if let Some(c) = header.captures(raw) {
      hash = c[1].to_string();
      final_line = c[2].parse().unwrap_or(0);
      meta.entry(hash.clone()).or_default();
      continue;
    }
    let Some(m) = meta.get_mut(&hash) else { continue };
    if let Some(v) = raw.strip_prefix("author ") {
      m.author = v.to_string();
    } else if let Some(v) = raw.strip_prefix("author-time ") {
      m.time = parse_int(v);
    } else if let Some(v) = raw.strip_prefix("summary ") {
      m.summary = v.to_string();
    } else if raw.starts_with('\t') && hash.bytes().any(|b| b != b'0') {
      let m = m.clone();
      lines.insert(final_line, json!({ "hash": hash, "author": m.author, "time": m.time, "summary": m.summary }));
    }
  }
  // A JS object with integer keys lists them in ascending order.
  let lines: Map<String, Value> = lines.into_iter().map(|(k, v)| (k.to_string(), v)).collect();
  json!({ "ok": true, "lines": lines })
}

/// parseInt(s, 10) for the digits git prints.
fn parse_int(s: &str) -> i64 {
  let t = s.trim_start();
  let (sign, rest) = match t.strip_prefix('-') {
    Some(r) => (-1, r),
    None => (1, t.strip_prefix('+').unwrap_or(t)),
  };
  let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
  digits.parse::<i64>().map(|n| sign * n).unwrap_or(0)
}

pub async fn push(folder: &str) -> Value {
  run(folder, &["push"]).await
}

pub async fn pull(folder: &str) -> Value {
  run(folder, &["pull", "--ff-only"]).await
}

/// Tracked files go back to HEAD; an untracked file or folder is deleted.
/// git.ts used rm without recursive, which refuses a folder (git status shows
/// a new folder as one `dir/` entry), and answered ok anyway: nothing went and
/// the panel said it had. Electron still does that.
pub async fn discard(folder: &str, rel: &str, untracked: Option<&Value>) -> Value {
  bump();
  if truthy(untracked) {
    let (folder, rel) = (folder.to_string(), rel.to_string());
    let r = tokio::task::spawn_blocking(move || remove_untracked(&folder, &rel))
      .await
      .unwrap_or_else(|e| Err(e.to_string()));
    bump();
    return match r {
      Ok(()) => json!({ "ok": true }),
      Err(e) => json!({ "ok": false, "error": e }),
    };
  }
  run(folder, &["reset", "-q", "HEAD", "--", rel]).await; // unstage if staged
  run(folder, &["checkout", "--", rel]).await
}

/// Delete an untracked path inside the repo: a file or symlink itself, a
/// folder with everything in it (symlinks inside are removed, not followed).
/// Never the repo itself or anything outside it. Gone already is fine (rm -f).
pub(crate) fn remove_untracked(folder: &str, rel: &str) -> Result<(), String> {
  let root = join(folder, "");
  let p = join(folder, rel);
  let rel_ok = !rel.is_empty() && std::path::Path::new(rel).components().all(|c| matches!(c, std::path::Component::Normal(_)) || matches!(c, std::path::Component::CurDir));
  if !rel_ok || p == root || !p.starts_with(&format!("{}/", root.trim_end_matches('/'))) {
    return Err(format!("refusing to delete '{rel}': not inside the repository"));
  }
  // "dir/" as git prints it; with the slash a symlink would be followed.
  let p = p.trim_end_matches('/').to_string();
  let md = match std::fs::symlink_metadata(&p) {
    Ok(md) => md,
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
    Err(e) => return Err(e.to_string()),
  };
  let r = if md.is_dir() { std::fs::remove_dir_all(&p) } else { std::fs::remove_file(&p) };
  r.map_err(|e| e.to_string())
}

pub async fn stage(folder: &str, rel: &str) -> Value {
  git_ok(folder, &["add", "--", rel]).await
}

pub async fn unstage(folder: &str, rel: &str) -> Value {
  git_ok(folder, &["reset", "-q", "HEAD", "--", rel]).await
}

pub async fn stage_all(folder: &str) -> Value {
  git_ok(folder, &["add", "-A"]).await
}

pub async fn commit(folder: &str, message: &str) -> Value {
  git_ok(folder, &["commit", "-m", message]).await
}

pub async fn branches(folder: &str) -> Value {
  let r = git(args(folder, &["branch", "--format=%(refname:short)%00%(HEAD)"]), DEFAULT_MAX_BUFFER).await;
  if !r.ok {
    return json!([]);
  }
  let mut out = Vec::new();
  for l in r.stdout.split('\n').filter(|l| !l.is_empty()) {
    let mut f = l.split('\0');
    let name = f.next().unwrap_or("");
    // `head.trim()` on a missing field threw, and the whole list was [].
    let Some(head) = f.next() else { return json!([]) };
    out.push(json!({ "name": name, "current": js_trim(head) == "*" }));
  }
  Value::Array(out)
}

pub async fn checkout(folder: &str, branch: &str) -> Value {
  git_ok(folder, &["checkout", branch]).await
}

pub async fn create_branch(folder: &str, name: &str) -> Value {
  git_ok(folder, &["checkout", "-b", name]).await
}

pub async fn fetch(folder: &str) -> Value {
  git_ok(folder, &["fetch", "--all", "--prune"]).await
}

pub async fn stash(folder: &str, message: Option<&Value>) -> Value {
  if truthy(message) {
    let m = js_string(message.unwrap());
    git_ok(folder, &["stash", "push", "-m", &m]).await
  } else {
    git_ok(folder, &["stash", "push"]).await
  }
}

pub async fn stash_pop(folder: &str) -> Value {
  git_ok(folder, &["stash", "pop"]).await
}

pub async fn stash_list(folder: &str) -> Value {
  // %x00: git log's pretty format has no %00 (that is for-each-ref's), so
  // git.ts got "stash@{0}%00" with no subject and every title was empty.
  // Electron still sends %00.
  let r = git(args(folder, &["stash", "list", "--format=%gd%x00%s"]), DEFAULT_MAX_BUFFER).await;
  if !r.ok {
    return json!([]);
  }
  let list: Vec<Value> = r
    .stdout
    .split('\n')
    .filter(|l| !l.is_empty())
    .map(|l| {
      let mut f = l.split('\0');
      let mut o = Map::new();
      o.insert("ref".into(), json!(f.next().unwrap_or("")));
      if let Some(s) = f.next() {
        o.insert("subject".into(), json!(s));
      }
      Value::Object(o)
    })
    .collect();
  Value::Array(list)
}

#[cfg(test)]
mod tests {
  #[test]
  fn untracked_folders_and_files_go() {
    let base = std::env::temp_dir().join(format!("riven-discard-{}", std::process::id()));
    let repo = base.join("repo");
    std::fs::create_dir_all(repo.join("newdir/sub")).unwrap();
    std::fs::write(repo.join("newdir/sub/a.txt"), "a").unwrap();
    std::fs::write(repo.join("f.txt"), "f").unwrap();
    std::fs::create_dir_all(base.join("outside")).unwrap();
    std::fs::write(base.join("outside/keep.txt"), "k").unwrap();
    // A symlink inside the new folder must not take its target with it.
    std::os::unix::fs::symlink(base.join("outside"), repo.join("newdir/link")).unwrap();
    let r = repo.to_str().unwrap();
    assert_eq!(super::remove_untracked(r, "newdir/"), Ok(()));
    assert!(!repo.join("newdir").exists());
    assert!(base.join("outside/keep.txt").exists());
    // A symlink to a folder, named as git names a folder ("ln/"): the link goes, not the folder.
    std::os::unix::fs::symlink(base.join("outside"), repo.join("ln")).unwrap();
    assert_eq!(super::remove_untracked(r, "ln/"), Ok(()));
    assert!(std::fs::symlink_metadata(repo.join("ln")).is_err());
    assert!(base.join("outside/keep.txt").exists());
    assert_eq!(super::remove_untracked(r, "f.txt"), Ok(()));
    assert!(!repo.join("f.txt").exists());
    assert_eq!(super::remove_untracked(r, "gone.txt"), Ok(()));
    assert!(super::remove_untracked(r, "../outside").is_err());
    assert!(super::remove_untracked(r, "").is_err());
    assert!(super::remove_untracked(r, ".").is_err());
    assert!(super::remove_untracked(r, "/etc").is_err());
    assert!(base.join("outside/keep.txt").exists());
    assert!(repo.exists());
    std::fs::remove_dir_all(&base).unwrap();
  }

  #[test]
  fn parse_int_like_js() {
    assert_eq!(super::parse_int("1731500000"), 1731500000);
    assert_eq!(super::parse_int("12abc"), 12);
    assert_eq!(super::parse_int("x"), 0);
  }
}
