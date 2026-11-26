// A new worktree for a branch, and the gitignored files the repo asks to have
// in it. `git worktree add` makes the checkout; `.worktreeinclude` (at the repo
// root) names the gitignored files and directories to COPY into that checkout,
// so each worktree owns its copy (.env, local settings). Links are not used:
// a linked .env would change under every worktree at once.
//
// Entries are literal, repo-relative paths. Globs, negations, absolute paths
// and `..` are skipped with a reason, not guessed at. An entry is copied only
// if it exists, is gitignored, and is not tracked, so a committed file is never
// overwritten by a stale local copy.

use super::{exec, Out};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::fs;
use std::path::Path;
use std::time::Duration;

pub const INCLUDE_FILE: &str = ".worktreeinclude";
/// Largest .worktreeinclude read; a longer file is ignored whole.
const MAX_INCLUDE_BYTES: u64 = 256 * 1024;
const MAX_ENTRIES: usize = 1000;
/// Copy limits per worktree: a runaway entry (a cache named by mistake) stops
/// the copy, it does not fill the disk.
const MAX_COPY_BYTES: u64 = 512 * 1024 * 1024;
const MAX_COPY_FILES: usize = 20_000;
const GIT_TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Debug, PartialEq, Eq)]
pub struct Parsed {
  pub entries: Vec<String>,
  /// (line as written, why it was skipped)
  pub skipped: Vec<(String, &'static str)>,
}

/// Reads .worktreeinclude text: one literal path per line; blank lines and
/// `#` comments are ignored.
pub fn parse_include(content: &str) -> Parsed {
  let mut entries = Vec::new();
  let mut skipped = Vec::new();
  let mut seen = HashSet::new();
  for raw in content.lines() {
    let line = raw.trim();
    if line.is_empty() || line.starts_with('#') {
      continue;
    }
    let reason = if line.starts_with('!') {
      Some("negation")
    } else if line.contains(['*', '?', '[']) {
      Some("glob")
    } else {
      None
    };
    if let Some(reason) = reason {
      skipped.push((line.to_string(), reason));
      continue;
    }
    let norm = line.replace('\\', "/");
    let norm = norm.trim_start_matches("./").trim_end_matches('/').to_string();
    if norm.is_empty() {
      continue;
    }
    if norm.starts_with('/') {
      skipped.push((line.to_string(), "absolute"));
      continue;
    }
    if norm.split('/').any(|c| c == "..") {
      skipped.push((line.to_string(), "parent"));
      continue;
    }
    if !seen.insert(norm.clone()) {
      continue;
    }
    if entries.len() >= MAX_ENTRIES {
      skipped.push((norm, "too many entries"));
      continue;
    }
    entries.push(norm);
  }
  Parsed { entries, skipped }
}

/// Whether the repo ignores `rel` (git check-ignore: exit 0 means ignored).
async fn is_ignored(repo: &str, rel: &str) -> bool {
  let args: Vec<String> = ["-C", repo, "check-ignore", "-q", "--", rel].iter().map(|s| s.to_string()).collect();
  exec("git", &args, None, Some(GIT_TIMEOUT), 1024 * 1024).await.ok
}

/// Whether git tracks anything at `rel` (a file, or any file under a directory).
async fn is_tracked(repo: &str, rel: &str) -> bool {
  let args: Vec<String> = ["-C", repo, "ls-files", "--", rel].iter().map(|s| s.to_string()).collect();
  let out: Out = exec("git", &args, None, Some(GIT_TIMEOUT), 16 * 1024 * 1024).await;
  out.ok && !out.stdout.trim().is_empty()
}

/// For each entry: Ok(()) when it may be copied, or the reason it may not.
pub async fn classify(repo: &str, entries: &[String]) -> Vec<(String, Result<(), &'static str>)> {
  let mut out = Vec::with_capacity(entries.len());
  for rel in entries {
    let src = Path::new(repo).join(rel);
    let verdict = if fs::symlink_metadata(&src).is_err() {
      Err("missing")
    } else if is_tracked(repo, rel).await {
      Err("tracked")
    } else if !is_ignored(repo, rel).await {
      Err("not gitignored")
    } else {
      Ok(())
    };
    out.push((rel.clone(), verdict));
  }
  out
}

#[derive(Default)]
struct Budget {
  bytes: u64,
  files: usize,
}

/// Copies one file or directory tree. Symlinks are not followed or copied, so
/// nothing outside the repo can be pulled in through one.
fn copy_tree(src: &Path, dst: &Path, budget: &mut Budget) -> Result<(), String> {
  let meta = fs::symlink_metadata(src).map_err(|e| e.to_string())?;
  let ft = meta.file_type();
  if ft.is_symlink() {
    return Ok(());
  }
  if ft.is_dir() {
    fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    for entry in fs::read_dir(src).map_err(|e| e.to_string())? {
      let entry = entry.map_err(|e| e.to_string())?;
      copy_tree(&entry.path(), &dst.join(entry.file_name()), budget)?;
    }
    return Ok(());
  }
  budget.files += 1;
  budget.bytes += meta.len();
  if budget.files > MAX_COPY_FILES || budget.bytes > MAX_COPY_BYTES {
    return Err("copy limit reached".into());
  }
  if let Some(parent) = dst.parent() {
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
  }
  fs::copy(src, dst).map_err(|e| e.to_string())?;
  Ok(())
}

/// Copies the verified entries from `repo` into `worktree`. Returns what was
/// copied and what was skipped (and why).
pub fn copy_entries(repo: &Path, worktree: &Path, verified: &[String]) -> (Vec<String>, Vec<(String, String)>) {
  let mut copied = Vec::new();
  let mut failed = Vec::new();
  let mut budget = Budget::default();
  for rel in verified {
    match copy_tree(&repo.join(rel), &worktree.join(rel), &mut budget) {
      Ok(()) => copied.push(rel.clone()),
      Err(e) => {
        failed.push((rel.clone(), e));
        break;
      }
    }
  }
  (copied, failed)
}

/// `git worktree add -b <branch> <path> [base]`, then the .worktreeinclude copy.
pub async fn create(repo: &str, branch: &str, path: &str, base: Option<&str>) -> Value {
  if Path::new(path).exists() {
    return json!({ "ok": false, "error": "path already exists" });
  }
  let mut args: Vec<String> = ["-C", repo, "worktree", "add", "-b", branch, path].iter().map(|s| s.to_string()).collect();
  if let Some(b) = base.filter(|b| !b.is_empty()) {
    args.push(b.to_string());
  }
  let added = exec("git", &args, None, Some(GIT_TIMEOUT), 16 * 1024 * 1024).await;
  if !added.ok {
    let msg = if added.stderr.trim().is_empty() { added.message.clone() } else { added.stderr.clone() };
    return json!({ "ok": false, "error": msg.trim() });
  }

  let include = Path::new(repo).join(INCLUDE_FILE);
  let (copied, copy_failed, skipped) = match fs::metadata(&include) {
    Ok(m) if m.len() <= MAX_INCLUDE_BYTES => match fs::read_to_string(&include) {
      Ok(text) => {
        let parsed = parse_include(&text);
        let verdicts = classify(repo, &parsed.entries).await;
        let mut skipped: Vec<Value> =
          parsed.skipped.iter().map(|(p, why)| json!({ "path": p, "reason": why })).collect();
        let mut verified = Vec::new();
        for (rel, verdict) in verdicts {
          match verdict {
            Ok(()) => verified.push(rel),
            Err(why) => skipped.push(json!({ "path": rel, "reason": why })),
          }
        }
        let (copied, failed) = copy_entries(Path::new(repo), Path::new(path), &verified);
        let failed: Vec<Value> = failed.iter().map(|(p, e)| json!({ "path": p, "reason": e })).collect();
        (copied, failed, skipped)
      }
      Err(e) => (Vec::new(), vec![json!({ "path": INCLUDE_FILE, "reason": e.to_string() })], Vec::new()),
    },
    Ok(_) => (Vec::new(), Vec::new(), vec![json!({ "path": INCLUDE_FILE, "reason": "too large" })]),
    Err(_) => (Vec::new(), Vec::new(), Vec::new()),
  };
  json!({ "ok": true, "path": path, "copied": copied, "skipped": skipped, "copyFailed": copy_failed })
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn parses_literal_paths_and_skips_the_rest_with_a_reason() {
    let p = parse_include(
      "# local secrets\n.env\n\n.env.local\n./.vscode/settings.json\nconfig/\n.env\n*.pem\n!keep.env\n/etc/passwd\n../outside\n",
    );
    assert_eq!(p.entries, vec![".env", ".env.local", ".vscode/settings.json", "config"]);
    assert_eq!(
      p.skipped,
      vec![
        ("*.pem".to_string(), "glob"),
        ("!keep.env".to_string(), "negation"),
        ("/etc/passwd".to_string(), "absolute"),
        ("../outside".to_string(), "parent"),
      ]
    );
  }

  #[test]
  fn an_entry_list_longer_than_the_cap_is_cut_and_reported() {
    let text: String = (0..MAX_ENTRIES + 3).map(|i| format!("f{i}\n")).collect();
    let p = parse_include(&text);
    assert_eq!(p.entries.len(), MAX_ENTRIES);
    assert_eq!(p.skipped.len(), 3);
    assert!(p.skipped.iter().all(|(_, why)| *why == "too many entries"));
  }

  fn scratch(name: &str) -> std::path::PathBuf {
    let n = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
    std::env::temp_dir().join(format!("riven-wt-{name}-{}-{n}", std::process::id()))
  }

  #[test]
  fn copies_files_and_directories_but_not_symlinks() {
    let root = scratch("copy");
    let repo = root.join("repo");
    let wt = root.join("wt");
    fs::create_dir_all(repo.join(".vscode")).unwrap();
    fs::write(repo.join(".env"), "SECRET=1").unwrap();
    fs::write(repo.join(".vscode/settings.json"), "{}").unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink("/etc/hosts", repo.join("hosts-link")).unwrap();
    fs::create_dir_all(&wt).unwrap();

    let entries = vec![".env".to_string(), ".vscode".to_string(), "hosts-link".to_string()];
    let (copied, failed) = copy_entries(&repo, &wt, &entries);
    assert!(failed.is_empty());
    assert_eq!(copied, entries);
    assert_eq!(fs::read_to_string(wt.join(".env")).unwrap(), "SECRET=1");
    assert_eq!(fs::read_to_string(wt.join(".vscode/settings.json")).unwrap(), "{}");
    assert!(!wt.join("hosts-link").exists(), "a symlink must not be copied");
    let _ = fs::remove_dir_all(&root);
  }

  fn git_in(dir: &Path, args: &[&str]) {
    let st = std::process::Command::new("git")
      .arg("-C")
      .arg(dir)
      .args(["-c", "user.name=riven", "-c", "user.email=riven@example.invalid"])
      .args(args)
      .status()
      .expect("git runs");
    assert!(st.success(), "git {args:?} failed");
  }

  #[test]
  fn creates_the_worktree_and_copies_only_ignored_entries() {
    let root = scratch("e2e");
    let repo = root.join("repo");
    let wt = root.join("feature");
    fs::create_dir_all(repo.join("cache")).unwrap();
    git_in(&repo, &["init", "-q"]);
    fs::write(repo.join(".gitignore"), ".env\ncache/\n").unwrap();
    fs::write(repo.join("README.md"), "hi").unwrap();
    fs::write(repo.join(".worktreeinclude"), ".env\ncache\nREADME.md\nnot-there\n").unwrap();
    git_in(&repo, &["add", ".gitignore", "README.md", ".worktreeinclude"]);
    git_in(&repo, &["commit", "-q", "-m", "init"]);
    fs::write(repo.join(".env"), "TOKEN=x").unwrap();
    fs::write(repo.join("cache/blob.bin"), "123").unwrap();

    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    let v = rt.block_on(create(repo.to_str().unwrap(), "feature", wt.to_str().unwrap(), None));
    assert_eq!(v["ok"], true, "{v}");
    assert_eq!(fs::read_to_string(wt.join(".env")).unwrap(), "TOKEN=x");
    assert_eq!(fs::read_to_string(wt.join("cache/blob.bin")).unwrap(), "123");
    let skipped: Vec<(String, String)> = v["skipped"]
      .as_array()
      .unwrap()
      .iter()
      .map(|s| (s["path"].as_str().unwrap().to_string(), s["reason"].as_str().unwrap().to_string()))
      .collect();
    assert!(skipped.contains(&("README.md".to_string(), "tracked".to_string())), "{skipped:?}");
    assert!(skipped.contains(&("not-there".to_string(), "missing".to_string())), "{skipped:?}");
    let _ = fs::remove_dir_all(&root);
  }
}
