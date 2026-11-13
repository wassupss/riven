// Past conversations: the CLI's own transcripts, read the way agentChat.ts,
// sessionScan.ts, sessionTitle.ts and codexSessions.ts read them. Nothing here
// writes a format of its own: a rename is the same `custom-title` line the
// CLI's /rename appends, and a delete removes the transcript file.
//
// Claude stores each session as <config>/projects/<encoded-cwd>/<id>.jsonl,
// where the cwd's "/" and "." become "-". <config> is CLAUDE_CONFIG_DIR when
// the pane runs under a profile, else ~/.claude.

use super::util::{clamp, home, js_string, mtime_ms, slice, truthy};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

pub fn project_dir(cwd: &str, config_dir: Option<&str>) -> PathBuf {
  let base = match config_dir.filter(|d| !d.is_empty()) {
    Some(d) => PathBuf::from(d),
    None => home().join(".claude"),
  };
  let enc: String = cwd.chars().map(|c| if c == '/' || c == '.' { '-' } else { c }).collect();
  base.join("projects").join(enc)
}

// ---- titles (sessionTitle.ts) --------------------------------------------------

#[derive(Clone, Default)]
pub struct TitleScan {
  custom: String,
  ai: String,
  first_user: String,
  pub messages: u64,
}

use super::util::js_trim;

pub fn scan_line(out: &mut TitleScan, line: &str) {
  if line.is_empty() {
    return;
  }
  let Some(j) = super::util::parse(line) else { return };
  let ty = j.get("type").and_then(Value::as_str).unwrap_or("");
  if ty == "custom-title" {
    if let Some(t) = j.get("customTitle").and_then(Value::as_str).filter(|t| !js_trim(t).is_empty()) {
      out.custom = js_trim(t).to_string();
    }
  }
  if out.ai.is_empty() && ty == "ai-title" {
    if let Some(t) = j.get("title").and_then(Value::as_str).filter(|t| !js_trim(t).is_empty()) {
      out.ai = js_trim(t).to_string();
    }
  }
  if ty == "user" || ty == "assistant" {
    out.messages += 1;
  }
  if out.first_user.is_empty() && ty == "user" {
    // A '<' opener is one of the CLI's own synthetic messages.
    if let Some(c) = j.get("message").and_then(|m| m.get("content")).and_then(Value::as_str) {
      if !c.is_empty() && !c.starts_with('<') {
        out.first_user = js_trim(c.split('\n').next().unwrap_or("")).to_string();
      }
    }
  }
}

/// The name to show, truncated for a tab or a list row.
pub fn title_of(scan: &TitleScan, max: usize) -> String {
  let pick = [&scan.custom, &scan.ai, &scan.first_user].into_iter().find(|s| !s.is_empty());
  pick.map(|p| clamp(p, max)).unwrap_or_default()
}

// ---- incremental scan (sessionScan.ts) -------------------------------------------

struct Entry {
  size: u64,
  mtime: f64,
  offset: u64,
  scan: TitleScan,
}

const CACHE_MAX: usize = 2000;

#[derive(Default)]
struct ScanCache {
  map: HashMap<PathBuf, Entry>,
  order: VecDeque<PathBuf>,
}

fn scan_cache() -> &'static Mutex<ScanCache> {
  static C: OnceLock<Mutex<ScanCache>> = OnceLock::new();
  C.get_or_init(Default::default)
}

/// readLinesFrom: complete lines from `start`, returning the offset just past
/// the last one (a trailing line without its newline is still being written).
fn read_lines_from(file: &Path, start: u64, mut on_line: impl FnMut(&str)) -> std::io::Result<u64> {
  let mut f = std::fs::File::open(file)?;
  f.seek(SeekFrom::Start(start))?;
  let mut r = std::io::BufReader::with_capacity(64 * 1024, f);
  let mut offset = start;
  let mut line = Vec::new();
  loop {
    line.clear();
    let n = r.read_until(b'\n', &mut line)?;
    if n == 0 || line.last() != Some(&b'\n') {
      break;
    }
    offset += n as u64;
    on_line(&String::from_utf8_lossy(&line[..n - 1]));
  }
  Ok(offset)
}

/// The title scan of one transcript, reading only what was appended since the
/// last look. Blocking.
pub fn scan_session_file(file: &Path) -> std::io::Result<(TitleScan, f64)> {
  let meta = std::fs::metadata(file)?;
  let (size, mtime) = (meta.len(), mtime_ms(&meta));
  let (resume_from, mut scan) = {
    let c = scan_cache().lock().unwrap();
    match c.map.get(file) {
      Some(h) if h.size == size && h.mtime == mtime => return Ok((h.scan.clone(), mtime)),
      Some(h) if size >= h.offset && size >= h.size => (h.offset, h.scan.clone()),
      _ => (0, TitleScan::default()),
    }
  };
  let offset = read_lines_from(file, resume_from, |l| scan_line(&mut scan, l))?;
  let mut c = scan_cache().lock().unwrap();
  if !c.map.contains_key(file) {
    if c.map.len() >= CACHE_MAX {
      if let Some(oldest) = c.order.pop_front() {
        c.map.remove(&oldest);
      }
    }
    c.order.push_back(file.to_path_buf());
  }
  c.map.insert(file.to_path_buf(), Entry { size, mtime, offset, scan: scan.clone() });
  Ok((scan, mtime))
}

fn forget_session_file(file: &Path) {
  let mut c = scan_cache().lock().unwrap();
  if c.map.remove(file).is_some() {
    c.order.retain(|p| p != file);
  }
}

// ---- the resume list ------------------------------------------------------------

#[derive(Serialize, Clone)]
pub struct SessionSummary {
  id: String,
  title: String,
  mtime: Value,
  messages: u64,
}

type Inflight = Arc<tokio::sync::OnceCell<Vec<SessionSummary>>>;

fn list_inflight() -> &'static Mutex<HashMap<PathBuf, Inflight>> {
  static M: OnceLock<Mutex<HashMap<PathBuf, Inflight>>> = OnceLock::new();
  M.get_or_init(Default::default)
}

/// After a restart every chat pane without a session asks at once; one scan
/// answers them all.
pub async fn list_sessions(cwd: String, config_dir: Option<String>) -> Vec<SessionSummary> {
  let dir = project_dir(&cwd, config_dir.as_deref());
  let cell = list_inflight().lock().unwrap().entry(dir.clone()).or_default().clone();
  let d = dir.clone();
  let out = cell
    .get_or_init(|| async move { tokio::task::spawn_blocking(move || list_sessions_now(&d)).await.unwrap_or_default() })
    .await
    .clone();
  let mut m = list_inflight().lock().unwrap();
  if m.get(&dir).is_some_and(|c| Arc::ptr_eq(c, &cell)) {
    m.remove(&dir);
  }
  out
}

fn list_sessions_now(dir: &Path) -> Vec<SessionSummary> {
  let Ok(entries) = crate::services::fsx::read_dir_sorted(dir) else { return Vec::new() };
  let mut out: Vec<(f64, SessionSummary)> = Vec::new();
  for e in entries {
    let name = e.file_name().to_string_lossy().into_owned();
    let Some(id) = name.strip_suffix(".jsonl") else { continue };
    let Ok((scan, mtime)) = scan_session_file(&e.path()) else { continue };
    if scan.messages == 0 {
      continue;
    }
    let title = title_of(&scan, 60);
    out.push((
      mtime,
      SessionSummary {
        id: id.to_string(),
        title: if title.is_empty() { "(제목 없음)".into() } else { title },
        mtime: super::util::jnum(mtime),
        messages: scan.messages,
      },
    ));
  }
  // Stable, newest first (Array#sort is stable).
  out.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
  out.into_iter().take(50).map(|(_, s)| s).collect()
}

// A session id is a filename and arrives from the page: checked, not trusted.
fn is_session_id(id: &str) -> bool {
  let parts: Vec<&str> = id.split('-').collect();
  let lens = [8, 4, 4, 4, 12];
  parts.len() == 5 && parts.iter().zip(lens).all(|(p, n)| p.len() == n && p.chars().all(|c| c.is_ascii_hexdigit()))
}

/// Name a past session: one more `custom-title` line, as the CLI's /rename.
pub fn rename_session(cwd: &str, id: &str, title: &str, config_dir: Option<&str>) -> bool {
  let name = js_trim(title);
  if !is_session_id(id) || name.is_empty() {
    return false;
  }
  let full = project_dir(cwd, config_dir).join(format!("{id}.jsonl"));
  let line = json!({ "type": "custom-title", "customTitle": name, "sessionId": id }).to_string() + "\n";
  use std::io::Write;
  std::fs::OpenOptions::new().create(true).append(true).open(full).and_then(|mut f| f.write_all(line.as_bytes())).is_ok()
}

/// Forget a past session: the transcript file IS the session.
pub fn delete_session(cwd: &str, id: &str, config_dir: Option<&str>) -> bool {
  if !is_session_id(id) {
    return false;
  }
  let file = project_dir(cwd, config_dir).join(format!("{id}.jsonl"));
  if std::fs::remove_file(&file).is_err() {
    return false;
  }
  forget_session_file(&file);
  true
}

pub fn read_session_title(cwd: &str, id: &str, config_dir: Option<&str>) -> Option<String> {
  let full = project_dir(cwd, config_dir).join(format!("{id}.jsonl"));
  let (scan, _) = scan_session_file(&full).ok()?;
  let t = title_of(&scan, 48);
  (!t.is_empty()).then_some(t)
}

// ---- transcripts ------------------------------------------------------------------

/// A past Claude session's transcript for display (user text + assistant
/// text/tools).
pub fn read_session_transcript(cwd: &str, id: &str, config_dir: Option<&str>) -> Vec<Value> {
  let full = project_dir(cwd, config_dir).join(format!("{id}.jsonl"));
  let Ok(raw) = crate::services::fsx::read_utf8(&full) else { return Vec::new() };
  let mut msgs = Vec::new();
  for line in raw.split('\n').filter(|l| !l.is_empty()) {
    let Some(j) = super::util::parse(line) else { continue };
    // A compaction stores its summary as a user message nobody said.
    if truthy(j.get("isCompactSummary")) || truthy(j.get("isVisibleInTranscriptOnly")) {
      continue;
    }
    let ty = j.get("type").and_then(Value::as_str).unwrap_or("");
    let Some(msg) = j.get("message").filter(|m| truthy(Some(m))) else { continue };
    if ty == "user" {
      match msg.get("content") {
        Some(Value::String(c)) => {
          if c.starts_with('<') || c.starts_with('/') {
            continue;
          }
          msgs.push(json!({ "role": "user", "text": c, "tools": [] }));
        }
        Some(Value::Array(blocks)) => {
          if blocks.iter().any(|b| b.get("type").and_then(Value::as_str) == Some("tool_result")) {
            continue;
          }
          let text = blocks
            .iter()
            .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|b| b.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n");
          let images = blocks.iter().filter(|b| b.get("type").and_then(Value::as_str) == Some("image")).count();
          if text.is_empty() && images == 0 {
            continue;
          }
          if text.starts_with('<') {
            continue;
          }
          msgs.push(json!({ "role": "user", "text": text, "tools": [], "images": images }));
        }
        _ => {}
      }
    } else if ty == "assistant" {
      let Some(content) = msg.get("content").and_then(Value::as_array) else { continue };
      let mut text = String::new();
      let mut tools = Vec::new();
      for b in content {
        match b.get("type").and_then(Value::as_str) {
          Some("text") => {
            if let Some(t) = b.get("text") {
              if !t.is_null() {
                text.push_str(&js_string(t));
              }
            }
          }
          Some("tool_use") => {
            let inp = b.get("input").cloned().unwrap_or(Value::Null);
            let detail = ["file_path", "command", "pattern"]
              .iter()
              .map(|k| inp.get(*k))
              .find(|v| truthy(*v))
              .flatten()
              .map(js_string)
              .unwrap_or_default();
            let name = b.get("name").filter(|n| !n.is_null()).map(js_string).unwrap_or_else(|| "tool".into());
            tools.push(json!({ "name": name, "detail": slice(&detail, 120) }));
          }
          _ => {}
        }
      }
      if !js_trim(&text).is_empty() || !tools.is_empty() {
        msgs.push(json!({ "role": "assistant", "text": js_trim(&text), "tools": tools }));
      }
    }
  }
  msgs
}

// ---- Codex rollouts (codexSessions.ts) ----------------------------------------------

fn codex_home() -> PathBuf {
  std::env::var_os("CODEX_HOME").filter(|v| !v.is_empty()).map(PathBuf::from).unwrap_or_else(|| home().join(".codex"))
}

fn list_desc(dir: &Path) -> Vec<String> {
  let mut v: Vec<String> = std::fs::read_dir(dir).map(|rd| rd.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect()).unwrap_or_default();
  v.sort();
  v.reverse();
  v
}

fn find_rollout(session_id: &str) -> Option<PathBuf> {
  static FOUND: OnceLock<Mutex<HashMap<String, PathBuf>>> = OnceLock::new();
  let found = FOUND.get_or_init(Default::default);
  if let Some(p) = found.lock().unwrap().get(session_id).filter(|p| p.exists()) {
    return Some(p.clone());
  }
  let root = codex_home().join("sessions");
  let suffix = format!("-{session_id}.jsonl");
  for y in list_desc(&root) {
    for m in list_desc(&root.join(&y)) {
      for d in list_desc(&root.join(&y).join(&m)) {
        let dir = root.join(&y).join(&m).join(&d);
        if let Some(hit) = list_desc(&dir).into_iter().find(|f| f.ends_with(&suffix)) {
          let p = dir.join(hit);
          found.lock().unwrap().insert(session_id.to_string(), p.clone());
          return Some(p);
        }
      }
    }
  }
  None
}

fn message_text(p: &Value) -> Option<String> {
  let content = p.get("content")?.as_array()?;
  let text = content
    .iter()
    .filter(|c| matches!(c.get("type").and_then(Value::as_str), Some("input_text" | "output_text")))
    .filter_map(|c| c.get("text").and_then(Value::as_str))
    .collect::<Vec<_>>()
    .join("\n");
  if js_trim(&text).is_empty() {
    return None;
  }
  static INJECTED: OnceLock<regex::Regex> = OnceLock::new();
  let re = INJECTED.get_or_init(|| regex::Regex::new(r"^\s*(<|# AGENTS\.md|# Context from my IDE)").unwrap());
  if p.get("role").and_then(Value::as_str) == Some("user") && re.is_match(&text) {
    return None;
  }
  Some(text)
}

fn transcript_from_rollout(text: &str) -> Vec<Value> {
  let mut out: Vec<Value> = Vec::new();
  for line in text.split('\n') {
    if !line.contains("\"response_item\"") {
      continue;
    }
    let Some(ev) = super::util::parse(line) else { continue };
    let Some(p) = ev.get("payload") else { continue };
    if ev.get("type").and_then(Value::as_str) != Some("response_item") || p.get("type").and_then(Value::as_str) != Some("message") {
      continue;
    }
    let role = p.get("role").and_then(Value::as_str).unwrap_or("");
    if role != "user" && role != "assistant" {
      continue;
    }
    let Some(body) = message_text(p) else { continue };
    let images = p.get("content").and_then(Value::as_array).map(|c| c.iter().filter(|x| x.get("type").and_then(Value::as_str) == Some("input_image")).count()).unwrap_or(0);
    if role == "assistant" {
      if let Some(last) = out.last_mut().filter(|l| l["role"] == "assistant") {
        let t = format!("{}\n\n{}", last["text"].as_str().unwrap_or(""), body);
        last["text"] = Value::String(t);
        continue;
      }
    }
    let mut m = json!({ "role": role, "text": body, "tools": [] });
    if images > 0 {
      m["images"] = json!(images);
    }
    out.push(m);
  }
  out
}

// A conversation's name: the first thing the user asked, on one line (Codex
// has no summarised title the way Claude Code does).
fn title_from_rollout(text: &str) -> Option<String> {
  const TITLE_MAX: usize = 80;
  let clip = |s: &str| if super::util::utf16_len(s) > TITLE_MAX { format!("{}\u{2026}", super::util::slice(s, TITLE_MAX - 1)) } else { s.to_string() };
  let first_line = |m: &str| m.split('\n').map(js_trim).find(|l| !l.is_empty()).map(str::to_string);
  for line in text.split('\n') {
    if !line.contains("user_message") {
      continue;
    }
    let Some(ev) = super::util::parse(line) else { continue };
    if ev.get("type").and_then(Value::as_str) != Some("event_msg") || ev.pointer("/payload/type").and_then(Value::as_str) != Some("user_message") {
      continue;
    }
    let msg = ev.pointer("/payload/message").and_then(Value::as_str).unwrap_or("");
    if let Some(f) = first_line(msg) {
      return Some(clip(&f));
    }
  }
  // A thread run through app-server logs no user_message events.
  let t = transcript_from_rollout(text);
  let user = t.iter().find(|m| m["role"] == "user")?;
  first_line(user["text"].as_str().unwrap_or("")).map(|l| clip(&l))
}

/// pty:codexSessionTitle: the name of a Codex conversation a terminal is in.
/// Only the head of the rollout is read (it runs to megabytes).
pub fn read_codex_session_title(session_id: &str) -> Option<String> {
  use std::io::Read;
  const HEAD_BYTES: u64 = 256 * 1024;
  let file = find_rollout(session_id)?;
  let mut buf = Vec::new();
  std::fs::File::open(file).ok()?.take(HEAD_BYTES).read_to_end(&mut buf).ok()?;
  title_from_rollout(&String::from_utf8_lossy(&buf))
}

pub fn read_codex_transcript(session_id: &str) -> Vec<Value> {
  let Some(file) = find_rollout(session_id) else { return Vec::new() };
  crate::services::fsx::read_utf8(&file).map(|t| transcript_from_rollout(&t)).unwrap_or_default()
}

// ---- custom agents (.claude/agents) ----------------------------------------------------

fn parse_agent_md(file: &str, raw: &str) -> (String, String) {
  let base = file.strip_suffix(".md").unwrap_or(file).to_string();
  let (mut name, mut description) = (base, String::new());
  static FM: OnceLock<regex::Regex> = OnceLock::new();
  static KV: OnceLock<regex::Regex> = OnceLock::new();
  let fm = FM.get_or_init(|| regex::Regex::new(r"^---\s*\n([\s\S]*?)\n---").unwrap());
  let kv = KV.get_or_init(|| regex::Regex::new(r"^(\w+):\s*(.*)$").unwrap());
  if let Some(m) = fm.captures(raw) {
    for line in m[1].split('\n') {
      let Some(c) = kv.captures(js_trim(line)) else { continue };
      let v = c[2].strip_prefix(['"', '\'']).unwrap_or(&c[2]);
      let v = js_trim(v.strip_suffix(['"', '\'']).unwrap_or(v)).to_string();
      if &c[1] == "name" && !v.is_empty() {
        name = v;
      } else if &c[1] == "description" && !v.is_empty() {
        description = v;
      }
    }
  }
  (name, description)
}

/// Custom agents usable as `claude --agent <name>` (project overrides user).
pub fn list_agents(cwd: &str) -> Vec<Value> {
  let dirs = [(Path::new(cwd).join(".claude").join("agents"), "project"), (home().join(".claude").join("agents"), "user")];
  let mut seen = std::collections::HashSet::new();
  let mut out: Vec<(String, Value)> = Vec::new();
  for (dir, source) in dirs {
    let Ok(entries) = crate::services::fsx::read_dir_sorted(&dir) else { continue };
    for e in entries {
      let f = e.file_name().to_string_lossy().into_owned();
      if !f.ends_with(".md") {
        continue;
      }
      let Ok(raw) = crate::services::fsx::read_utf8(&e.path()) else { continue };
      let (name, description) = parse_agent_md(&f, &raw);
      if !seen.insert(name.clone()) {
        continue;
      }
      out.push((name.clone(), json!({ "name": name, "description": description, "source": source })));
    }
  }
  out.sort_by(|a, b| crate::services::collate::locale_compare(&a.0, &b.0));
  out.into_iter().map(|(_, v)| v).collect()
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn ids_and_titles() {
    assert!(is_session_id("0a1b2c3d-1111-2222-3333-444455556666"));
    assert!(!is_session_id("../etc/passwd"));
    let mut s = TitleScan::default();
    scan_line(&mut s, r#"{"type":"user","message":{"content":"hello there\nmore"}}"#);
    scan_line(&mut s, r#"{"type":"ai-title","title":"AI"}"#);
    assert_eq!(title_of(&s, 60), "AI");
    scan_line(&mut s, r#"{"type":"custom-title","customTitle":"Mine"}"#);
    assert_eq!(title_of(&s, 2), "Mi…");
    assert_eq!(s.messages, 1);
  }

  #[test]
  fn agent_frontmatter() {
    let (n, d) = parse_agent_md("x.md", "---\nname: \"rev\"\ndescription: reviews code\n---\nbody");
    assert_eq!((n.as_str(), d.as_str()), ("rev", "reviews code"));
  }
}
