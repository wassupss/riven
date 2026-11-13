// Files of the open workspaces (src/main/workspace.ts): listing, reading,
// writing, creating, renaming, deleting, copying in, and the walks quick-open
// and agent-diff baselines use. Plain blocking std::fs; commands run these on
// the blocking pool.

use super::atomic::TMP_SUFFIX;
use super::collate::locale_compare;
use super::fsx::{io_err, read_utf8, resolve};
use serde::Serialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

const IGNORED: &[&str] = &[
  ".git", "node_modules", ".DS_Store", "out", "dist", ".cache", ".next", ".turbo", ".svelte-kit", ".nuxt", ".output",
  ".vercel", ".vite", ".parcel-cache", "coverage", "__pycache__", ".pytest_cache", ".mypy_cache", ".venv", "venv",
  "target",
  // macOS home noise, so opening ~ does not scan the whole tree.
  "Library", ".Trash", ".Trashes",
];

/// Hidden from listings: ignored names and the atomic-write temp files.
pub fn is_hidden(name: &str) -> bool {
  IGNORED.contains(&name) || name.ends_with(TMP_SUFFIX)
}

// ---- confinement ------------------------------------------------------------

// The open workspace roots, kept in sync by the renderer. Writes are confined
// to them so a bad path (buggy code, agent output) cannot write or delete
// outside an open project.
fn roots() -> &'static Mutex<Vec<String>> {
  static R: OnceLock<Mutex<Vec<String>>> = OnceLock::new();
  R.get_or_init(Default::default)
}

pub fn set_roots(list: Vec<String>) -> Vec<String> {
  let mut seen = HashSet::new();
  let list: Vec<String> = list.into_iter().filter(|r| !r.is_empty() && seen.insert(r.clone())).collect();
  *roots().lock().unwrap() = list.clone();
  list
}

pub fn is_confined(target: &str) -> bool {
  let rs = roots().lock().unwrap();
  if rs.is_empty() {
    return true; // nothing open yet
  }
  let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/"));
  let t = resolve(&cwd, Path::new(target));
  rs.iter().any(|r| {
    let r = resolve(&cwd, Path::new(r));
    t == r || t.starts_with(&r)
  })
}

pub fn assert_confined(target: &str) -> Result<(), String> {
  if is_confined(target) {
    Ok(())
  } else {
    Err(format!("refused: path is outside any open workspace: {target}"))
  }
}

// ---- listing ------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
  pub name: String,
  pub path: String,
  pub is_directory: bool,
  pub is_symlink: bool,
}

fn join(dir: &str, name: &str) -> String {
  Path::new(dir).join(name).to_string_lossy().into_owned()
}

pub fn read_dir(dir: &str) -> Result<Vec<DirEntry>, String> {
  let rd = super::fsx::read_dir_sorted(Path::new(dir)).map_err(|e| io_err(&e, "scandir", Path::new(dir)))?;
  let mut out: Vec<DirEntry> = Vec::new();
  for e in rd {
    let name = e.file_name().to_string_lossy().into_owned();
    if is_hidden(&name) {
      continue;
    }
    let full = join(dir, &name);
    let ft = e.file_type().ok();
    let is_symlink = ft.map(|t| t.is_symlink()).unwrap_or(false);
    // A symlink to a directory renders (and expands) as one; a broken link is a plain entry.
    let is_directory = if is_symlink {
      std::fs::metadata(&full).map(|m| m.is_dir()).unwrap_or(false)
    } else {
      ft.map(|t| t.is_dir()).unwrap_or(false)
    };
    out.push(DirEntry { name, path: full, is_directory, is_symlink });
  }
  out.sort_by(|a, b| b.is_directory.cmp(&a.is_directory).then_with(|| locale_compare(&a.name, &b.name)));
  Ok(out)
}

/// Workspace-relative paths of every file (quick-open), at most 20000.
pub fn list_files(folder: &str) -> Vec<String> {
  fn walk(root: &Path, dir: &Path, out: &mut Vec<String>) {
    let Ok(rd) = super::fsx::read_dir_sorted(dir) else { return };
    for e in rd {
      if out.len() >= 20000 {
        return;
      }
      let name = e.file_name();
      if is_hidden(&name.to_string_lossy()) {
        continue;
      }
      let Ok(ft) = e.file_type() else { continue };
      let full = dir.join(&name);
      if ft.is_dir() {
        walk(root, &full, out);
      } else if ft.is_file() {
        out.push(full.strip_prefix(root).unwrap_or(&full).to_string_lossy().into_owned());
      }
      if out.len() >= 20000 {
        return;
      }
    }
  }
  let mut out = Vec::new();
  walk(Path::new(folder), Path::new(folder), &mut out);
  out
}

/// Text contents under the workspace, as baselines for agent-edit diffs.
/// At most 2000 files, each under 200KB and without NUL bytes.
pub fn snapshot_contents(folder: &str) -> serde_json::Map<String, serde_json::Value> {
  fn walk(dir: &Path, out: &mut serde_json::Map<String, serde_json::Value>) {
    if out.len() >= 2000 {
      return;
    }
    let Ok(rd) = super::fsx::read_dir_sorted(dir) else { return };
    for e in rd {
      if out.len() >= 2000 {
        return;
      }
      let name = e.file_name();
      if is_hidden(&name.to_string_lossy()) {
        continue;
      }
      let Ok(ft) = e.file_type() else { continue };
      let full = dir.join(&name);
      if ft.is_dir() {
        walk(&full, out);
      } else if ft.is_file() {
        let Ok(md) = std::fs::metadata(&full) else { continue };
        if md.len() > 200_000 {
          continue;
        }
        let Ok(content) = read_utf8(&full) else { continue };
        if content.contains('\0') {
          continue;
        }
        out.insert(full.to_string_lossy().into_owned(), serde_json::Value::String(content));
      }
    }
  }
  let mut out = serde_json::Map::new();
  walk(Path::new(folder), &mut out);
  out
}

// ---- reading and writing ----------------------------------------------------------

pub fn read_file(file: &str) -> Result<String, String> {
  read_utf8(Path::new(file)).map_err(|e| io_err(&e, "open", Path::new(file)))
}

pub fn create_file(p: &str) -> Result<(), String> {
  assert_confined(p)?;
  std::fs::OpenOptions::new()
    .write(true)
    .create_new(true)
    .open(p)
    .map(|_| ())
    .map_err(|e| io_err(&e, "open", Path::new(p)))
}

pub fn create_folder(p: &str) -> Result<(), String> {
  assert_confined(p)?;
  std::fs::create_dir(p).map_err(|e| io_err(&e, "mkdir", Path::new(p)))
}

pub fn rename(old: &str, new: &str) -> Result<(), String> {
  assert_confined(old)?;
  assert_confined(new)?;
  std::fs::rename(old, new).map_err(|e| {
    let m = io_err(&e, "rename", Path::new(old));
    format!("{m} -> '{new}'")
  })
}

/// fs.rm(target, { recursive: true, force: true }): a missing target is fine,
/// and a symlink is removed itself, never what it points to.
pub fn delete(target: &str) -> Result<(), String> {
  assert_confined(target)?;
  let p = Path::new(target);
  let md = match std::fs::symlink_metadata(p) {
    Ok(m) => m,
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
    Err(e) => return Err(io_err(&e, "lstat", p)),
  };
  let r = if md.is_dir() { std::fs::remove_dir_all(p) } else { std::fs::remove_file(p) };
  match r {
    Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(io_err(&e, "rm", p)),
    _ => Ok(()),
  }
}

// ---- copying in -----------------------------------------------------------------

/// A path in `dir` for `name` that does not exist yet: "note.md", then
/// "note 2.md", "note 3.md" (Finder's scheme), bounded.
fn free_name(dir: &Path, name: &str) -> Result<PathBuf, String> {
  let (stem, ext) = match name.rfind('.') {
    Some(i) if i > 0 => (&name[..i], &name[i..]),
    _ => (name, ""),
  };
  for n in 1..1000 {
    let candidate = if n == 1 { dir.join(name) } else { dir.join(format!("{stem} {n}{ext}")) };
    if std::fs::symlink_metadata(&candidate).is_err() {
      return Ok(candidate);
    }
  }
  Err(format!("too many files named like \"{name}\""))
}

// fs.cp(src, dst, { recursive, errorOnExist, force: false }): symlinks are
// copied as links, files keep their permissions.
fn copy_tree(src: &Path, dst: &Path) -> std::io::Result<()> {
  let md = std::fs::symlink_metadata(src)?;
  if md.file_type().is_symlink() {
    let target = std::fs::read_link(src)?;
    std::os::unix::fs::symlink(target, dst)
  } else if md.is_dir() {
    std::fs::create_dir(dst)?;
    std::fs::set_permissions(dst, md.permissions())?;
    for e in std::fs::read_dir(src)? {
      let e = e?;
      copy_tree(&e.path(), &dst.join(e.file_name()))?;
    }
    Ok(())
  } else {
    if std::fs::symlink_metadata(dst).is_ok() {
      return Err(std::io::Error::from_raw_os_error(17));
    }
    std::fs::copy(src, dst).map(|_| ())
  }
}

#[derive(Serialize)]
pub struct ImportResult {
  pub copied: Vec<String>,
  pub errors: Vec<String>,
}

/// Copy dropped files/folders into `dest_dir`. Only the destination is
/// confined (the sources come from outside on purpose). Never overwrites.
pub fn import_paths(dest_dir: &str, sources: Vec<String>) -> Result<ImportResult, String> {
  assert_confined(dest_dir)?;
  let (mut copied, mut errors) = (Vec::new(), Vec::new());
  let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/"));
  let dest = resolve(&cwd, Path::new(dest_dir));
  for src in sources {
    let base = Path::new(&src).file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    // A folder dropped onto itself or into its own subtree would recurse forever.
    let s = resolve(&cwd, Path::new(&src));
    if dest == s || dest.starts_with(&s) {
      errors.push(format!("{base}: cannot copy a folder into itself"));
      continue;
    }
    let r = free_name(Path::new(dest_dir), &base)
      .and_then(|target| copy_tree(Path::new(&src), &target).map(|_| target).map_err(|e| io_err(&e, "cp", Path::new(&src))));
    match r {
      Ok(t) => copied.push(t.to_string_lossy().into_owned()),
      Err(e) => errors.push(format!("{base}: {e}")),
    }
  }
  Ok(ImportResult { copied, errors })
}

// ---- small extras that live in workspace.ts ----------------------------------------

/// A pasted image (data URL) written to a temp file the agent CLI can read.
pub fn save_temp_image(data_url: &str) -> Result<Option<String>, String> {
  use base64::Engine;
  let Some(rest) = data_url.strip_prefix("data:image/") else { return Ok(None) };
  let Some((kind, b64)) = rest.split_once(";base64,") else { return Ok(None) };
  if kind.is_empty() || !kind.chars().all(|c| c.is_ascii_alphanumeric() || ".+-".contains(c)) {
    return Ok(None);
  }
  let ext: String = kind.to_lowercase().replacen("jpeg", "jpg", 1).chars().filter(|c| c.is_ascii_alphanumeric()).collect();
  let ext = if ext.is_empty() { "png".to_string() } else { ext };
  let clean: String = b64.chars().filter(|c| !c.is_whitespace()).collect();
  let bytes = base64::engine::general_purpose::STANDARD
    .decode(clean.trim_end_matches('='))
    .or_else(|_| base64::engine::general_purpose::STANDARD_NO_PAD.decode(clean.trim_end_matches('=')))
    .unwrap_or_default();
  let dir = std::env::temp_dir().join("riven-paste");
  std::fs::create_dir_all(&dir).map_err(|e| io_err(&e, "mkdir", &dir))?;
  let file = dir.join(format!("paste-{}-{}.{ext}", super::fsx::base36(super::fsx::now_ms()), super::fsx::rand6()));
  std::fs::write(&file, bytes).map_err(|e| io_err(&e, "open", &file))?;
  Ok(Some(file.to_string_lossy().into_owned()))
}

#[derive(Serialize)]
pub struct Scripts {
  pub manager: String,
  pub scripts: Vec<String>,
}

/// package.json scripts and the package manager its lockfile names.
pub fn list_scripts(folder: &str) -> Scripts {
  let dir = Path::new(folder);
  let manager = if dir.join("pnpm-lock.yaml").exists() {
    "pnpm"
  } else if dir.join("yarn.lock").exists() {
    "yarn"
  } else if dir.join("bun.lockb").exists() {
    "bun"
  } else {
    "npm"
  };
  let scripts = std::fs::read_to_string(dir.join("package.json"))
    .ok()
    .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
    .and_then(|v| v.get("scripts").and_then(|s| s.as_object()).map(|o| o.keys().cloned().collect()))
    .unwrap_or_default();
  Scripts { manager: manager.into(), scripts }
}
