// Scratch markdown notes (src/main/notes.ts): the Notes panel and the note_*
// MCP tools. Kept out of the repo, per workspace under
// userData/notes/<sha1(ws)[..16]>/<name>.md. doc_write / note_save_file are the
// escape hatches that write a real .md into the workspace.

use super::fsx::{base36, io_err, now_ms, read_utf8, resolve, utf16_prefix};
use serde::Serialize;
use sha1::{Digest, Sha1};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

fn notes_dir(ws: &str) -> PathBuf {
  let hex: String = Sha1::digest(ws.as_bytes()).iter().map(|b| format!("{b:02x}")).collect();
  super::paths::user_data().join("notes").join(&hex[..16])
}

// s.trim().toLowerCase().replace(/[^\w가-힣\- ]/g, '').replace(/\s+/g, '-').slice(0, 40) || 'note'
fn slug(s: &str) -> String {
  let kept: String = s
    .trim()
    .to_lowercase()
    .chars()
    .filter(|&c| c.is_ascii_alphanumeric() || c == '_' || ('가'..='힣').contains(&c) || c == '-' || c == ' ')
    .collect();
  static WS: OnceLock<regex::Regex> = OnceLock::new();
  let dashed = WS.get_or_init(|| regex::Regex::new(r"\s+").unwrap()).replace_all(&kept, "-");
  let out = utf16_prefix(&dashed, 40).to_string();
  if out.is_empty() {
    "note".into()
  } else {
    out
  }
}

// content.match(/^#\s+(.+)$/m)?.[1].trim() ?? first non-blank line (60 units) ?? fallback
fn title_of(content: &str, fallback: &str) -> String {
  static H: OnceLock<regex::Regex> = OnceLock::new();
  let re = H.get_or_init(|| regex::Regex::new(r"(?mR)^#\s+([^\r\n\u{2028}\u{2029}]+)").unwrap());
  if let Some(m) = re.captures(content) {
    return m[1].trim().to_string();
  }
  match content.split('\n').find(|l| !l.trim().is_empty()) {
    Some(l) if !l.is_empty() => utf16_prefix(l, 60).to_string(),
    _ => fallback.to_string(),
  }
}

#[derive(Serialize, Clone)]
pub struct NoteMeta {
  pub name: String,
  pub title: String,
  pub mtime: f64,
}

pub fn list(ws: &str) -> Vec<NoteMeta> {
  let dir = notes_dir(ws);
  let Ok(rd) = super::fsx::read_dir_sorted(&dir) else { return vec![] };
  let mut out = Vec::new();
  for e in rd {
    let f = e.file_name().to_string_lossy().into_owned();
    let Some(name) = f.strip_suffix(".md") else { continue };
    let full = dir.join(&f);
    let (Ok(content), Ok(md)) = (read_utf8(&full), std::fs::metadata(&full)) else { continue };
    let mtime = md
      .modified()
      .ok()
      .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
      .map(|d| d.as_secs_f64() * 1000.0)
      .unwrap_or(0.0);
    out.push(NoteMeta { name: name.to_string(), title: title_of(&content, name), mtime });
  }
  out.sort_by(|a, b| b.mtime.partial_cmp(&a.mtime).unwrap_or(std::cmp::Ordering::Equal));
  out
}

/// A note reference (name, title or file name) -> its name (no .md).
fn resolve_name(ws: &str, r: &str) -> Option<String> {
  let bare = r.strip_suffix(".md").unwrap_or(r);
  let notes = list(ws);
  if let Some(n) = notes.iter().find(|n| n.name == bare) {
    return Some(n.name.clone());
  }
  notes.iter().find(|n| n.title == r).map(|n| n.name.clone())
}

pub fn read(ws: &str, r: &str) -> Option<String> {
  let name = resolve_name(ws, r)?;
  read_utf8(&notes_dir(ws).join(format!("{name}.md"))).ok()
}

pub fn write(ws: &str, r: Option<&str>, title: &str, body: &str) -> Result<String, String> {
  let dir = notes_dir(ws);
  std::fs::create_dir_all(&dir).map_err(|e| io_err(&e, "mkdir", &dir))?;
  let content = if body.trim_start().starts_with('#') { body.to_string() } else { format!("# {title}\n\n{body}") };
  let name = match r.and_then(|r| resolve_name(ws, r)) {
    Some(n) => n,
    None => format!("{}-{}", slug(title), base36(now_ms())),
  };
  let file = dir.join(format!("{name}.md"));
  std::fs::write(&file, content).map_err(|e| io_err(&e, "open", &file))?;
  Ok(name)
}

pub fn append(ws: &str, r: &str, body: &str) -> Result<Option<String>, String> {
  let Some(name) = resolve_name(ws, r) else { return Ok(None) };
  let file = notes_dir(ws).join(format!("{name}.md"));
  let prev = read_utf8(&file).unwrap_or_default();
  std::fs::write(&file, format!("{}\n\n{body}\n", prev.trim_end())).map_err(|e| io_err(&e, "open", &file))?;
  Ok(Some(name))
}

pub fn delete(ws: &str, r: &str) -> Result<bool, String> {
  let Some(name) = resolve_name(ws, r) else { return Ok(false) };
  let file = notes_dir(ws).join(format!("{name}.md"));
  match std::fs::remove_file(&file) {
    Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(io_err(&e, "rm", &file)),
    _ => Ok(true),
  }
}

#[derive(Serialize)]
pub struct WriteFileResult {
  pub ok: bool,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub path: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub error: Option<String>,
}

fn fail(msg: &str) -> WriteFileResult {
  WriteFileResult { ok: false, path: None, error: Some(msg.into()) }
}

/// A real .md in the workspace (doc_write / note_save_file). A bare name goes
/// under .claude/docs; never escapes the workspace; refuses to clobber unless
/// `overwrite`.
pub fn write_workspace_file(ws: &str, rel_path: &str, body: &str, overwrite: bool) -> Result<WriteFileResult, String> {
  let rel = if rel_path.contains('/') {
    PathBuf::from(rel_path)
  } else {
    Path::new(".claude").join("docs").join(rel_path)
  };
  let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/"));
  let root = resolve(&cwd, Path::new(ws));
  let abs = resolve(&root, &rel);
  if abs == root || !abs.starts_with(&root) {
    return Ok(fail("path escapes the workspace"));
  }
  if !overwrite && std::fs::symlink_metadata(&abs).is_ok() {
    return Ok(fail("file exists (set overwrite to replace)"));
  }
  if let Some(parent) = abs.parent() {
    std::fs::create_dir_all(parent).map_err(|e| io_err(&e, "mkdir", parent))?;
  }
  std::fs::write(&abs, body).map_err(|e| io_err(&e, "open", &abs))?;
  Ok(WriteFileResult { ok: true, path: Some(abs.to_string_lossy().into_owned()), error: None })
}

pub fn save_to_file(ws: &str, r: &str, rel_path: &str, overwrite: bool) -> Result<WriteFileResult, String> {
  match read(ws, r) {
    None => Ok(fail("note not found")),
    Some(content) => write_workspace_file(ws, rel_path, &content, overwrite),
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  #[test]
  fn slugs_and_titles() {
    assert_eq!(slug("  Hello World! 메모 "), "hello-world-메모");
    assert_eq!(slug("!!!"), "note");
    assert_eq!(title_of("intro\n# Plan  \nx", "f"), "Plan");
    assert_eq!(title_of("\n\n  first line\n", "f"), "  first line");
    assert_eq!(title_of("", "f"), "f");
  }
}
