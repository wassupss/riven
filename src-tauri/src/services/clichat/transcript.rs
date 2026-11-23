// The structured feed of an interactive CLI session: its transcript JSONL
// (<config>/projects/<encoded cwd>/<session id>.jsonl), tailed by offset and
// turned into display items.
//
// The file is append-only, one JSON record per line, but it is not a flat
// list of messages: every conversation record names its parent (parentUuid),
// and a rewind or an abandoned branch leaves records behind that are no
// longer part of the conversation. The conversation on screen is the chain
// from the newest record back to the root, so that is what `branch()` walks.
// A compact boundary starts a new root (parentUuid null) and points at the
// old chain through logicalParentUuid; the walk follows it so the history
// before a /compact stays visible.
//
// Nothing here knows about Tauri: pure, tested with hand-written fixtures.

use serde::Serialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::io::{Read, Seek, SeekFrom};
use std::path::PathBuf;

const MAX_TEXT: usize = 20_000;
const MAX_RESULT: usize = 4_000;
const MAX_INPUT_STRING: usize = 2_000;

/// What the page draws. One record can yield several (an assistant record
/// with text + tool_use, a user record with several tool results).
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Item {
  #[serde(rename_all = "camelCase")]
  User { key: String, text: String, command: Option<String>, images: u32 },
  #[serde(rename_all = "camelCase")]
  Text { key: String, msg_id: String, text: String },
  #[serde(rename_all = "camelCase")]
  Thinking { key: String, text: String },
  #[serde(rename_all = "camelCase")]
  Tool { key: String, tool_id: String, name: String, input: Value },
  #[serde(rename_all = "camelCase")]
  ToolResult { key: String, tool_id: String, text: String, is_error: bool },
  #[serde(rename_all = "camelCase")]
  Usage { key: String, msg_id: String, model: String, input: u64, cache_write: u64, cache_read: u64, output: u64 },
  #[serde(rename_all = "camelCase")]
  Compact { key: String, trigger: String, pre_tokens: u64 },
  #[serde(rename_all = "camelCase")]
  Note { key: String, level: String, text: String },
  #[serde(rename_all = "camelCase")]
  TurnEnd { key: String, duration_ms: u64 },
}

impl Item {
  pub fn key(&self) -> &str {
    match self {
      Item::User { key, .. }
      | Item::Text { key, .. }
      | Item::Thinking { key, .. }
      | Item::Tool { key, .. }
      | Item::ToolResult { key, .. }
      | Item::Usage { key, .. }
      | Item::Compact { key, .. }
      | Item::Note { key, .. }
      | Item::TurnEnd { key, .. } => key,
    }
  }
}

/// What the agent said in the last turn: the text items after the last
/// user message (the answer a delegating agent or a phone waits for, when the
/// Stop hook did not carry it).
pub fn last_reply(items: &[Item]) -> Option<String> {
  let from = items.iter().rposition(|i| matches!(i, Item::User { .. })).map_or(0, |i| i + 1);
  let texts: Vec<&str> = items[from..]
    .iter()
    .filter_map(|i| match i {
      Item::Text { text, .. } if !text.trim().is_empty() => Some(text.as_str()),
      _ => None,
    })
    .collect();
  (!texts.is_empty()).then(|| texts.join("\n\n"))
}

struct Rec {
  parent: Option<String>,
  logical_parent: Option<String>,
  items: Vec<Item>,
}

#[derive(Default)]
pub struct Store {
  recs: HashMap<String, Rec>,
  /// The newest main-chain record: the end of the conversation on screen.
  leaf: Option<String>,
  /// Records seen since the last branch() (cheap "anything new?" check).
  dirty: bool,
  custom_title: Option<String>,
  ai_title: Option<String>,
  title_dirty: bool,
}

fn s(v: &Value, k: &str) -> Option<String> {
  v.get(k).and_then(Value::as_str).filter(|x| !x.is_empty()).map(str::to_string)
}

fn cut(text: &str, max: usize) -> String {
  if text.len() <= max {
    return text.to_string();
  }
  let mut end = max;
  while !text.is_char_boundary(end) {
    end -= 1;
  }
  format!("{}…", &text[..end])
}

// Tool inputs can carry whole files (Write.content); the page only needs a
// glance at them.
fn trim_input(v: &Value) -> Value {
  match v {
    Value::String(x) if x.len() > MAX_INPUT_STRING => Value::String(cut(x, MAX_INPUT_STRING)),
    Value::Object(m) => Value::Object(m.iter().map(|(k, v)| (k.clone(), trim_input(v))).collect()),
    Value::Array(a) => Value::Array(a.iter().take(50).map(trim_input).collect()),
    _ => v.clone(),
  }
}

fn result_text(c: &Value) -> String {
  match c {
    Value::String(x) => x.clone(),
    Value::Array(a) => a
      .iter()
      .filter_map(|b| match b.get("type").and_then(Value::as_str) {
        Some("text") => b.get("text").and_then(Value::as_str).map(str::to_string),
        Some("image") => Some("[image]".into()),
        _ => None,
      })
      .collect::<Vec<_>>()
      .join("\n"),
    _ => String::new(),
  }
}

fn tag<'a>(text: &'a str, name: &str) -> Option<&'a str> {
  let open = format!("<{name}>");
  let close = format!("</{name}>");
  let a = text.find(&open)? + open.len();
  let b = text[a..].find(&close)? + a;
  Some(&text[a..b])
}

// A user record's own text: what the person typed, a slash command, or the
// output of a local command.
fn user_text_items(uuid: &str, text: &str, images: u32, out: &mut Vec<Item>) {
  let key = |i: usize| format!("{uuid}:{i}");
  let n = out.len();
  if let Some(name) = tag(text, "command-name") {
    let args = tag(text, "command-args").unwrap_or("").trim();
    let shown = if args.is_empty() { name.to_string() } else { format!("{name} {args}") };
    out.push(Item::User { key: key(n), text: shown, command: Some(name.to_string()), images: 0 });
    return;
  }
  if let Some(o) = tag(text, "local-command-stdout").or_else(|| tag(text, "local-command-stderr")) {
    if !o.trim().is_empty() {
      out.push(Item::Note { key: key(n), level: "command".into(), text: cut(o.trim(), MAX_RESULT) });
    }
    return;
  }
  let t = text.trim();
  // A background task (subagent, shell) finished: the CLI hands its result
  // to the model as a user turn nobody typed.
  if t.starts_with("<task-notification>") {
    let summary = tag(t, "summary").or_else(|| tag(t, "status")).unwrap_or("task finished").trim();
    out.push(Item::Note { key: key(n), level: "task".into(), text: cut(summary, MAX_RESULT) });
    return;
  }
  if t.starts_with("[Request interrupted by user") {
    out.push(Item::Note { key: key(n), level: "interrupted".into(), text: t.into() });
    return;
  }
  if t.is_empty() && images == 0 {
    return;
  }
  out.push(Item::User { key: key(n), text: cut(t, MAX_TEXT), command: None, images });
}

/// Parse one transcript line into a record's items. None for lines that are
/// not part of the conversation (metadata, request blobs, sidechains).
fn parse_rec(v: &Value) -> Option<(String, Rec)> {
  let ty = v.get("type").and_then(Value::as_str)?;
  if !matches!(ty, "user" | "assistant" | "system" | "attachment") {
    return None;
  }
  let uuid = s(v, "uuid")?;
  // Subagent records belong to their own chain.
  if v.get("isSidechain").and_then(Value::as_bool) == Some(true) {
    return None;
  }
  let parent = s(v, "parentUuid");
  let logical_parent = s(v, "logicalParentUuid");
  let mut items = Vec::new();
  let key = |i: usize| format!("{uuid}:{i}");
  let msg = v.get("message").cloned().unwrap_or(Value::Null);
  match ty {
    "user" => {
      // Meta records are the CLI talking to the model (caveats, reminders),
      // never something the person said.
      let meta = v.get("isMeta").and_then(Value::as_bool) == Some(true);
      if v.get("isCompactSummary").and_then(Value::as_bool) == Some(true) {
        let text = match msg.get("content") {
          Some(Value::String(x)) => x.clone(),
          Some(c) => result_text(c),
          None => String::new(),
        };
        items.push(Item::Note { key: key(0), level: "summary".into(), text: cut(&text, MAX_RESULT) });
      } else {
        match msg.get("content") {
          Some(Value::String(text)) if !meta => user_text_items(&uuid, text, 0, &mut items),
          Some(Value::Array(blocks)) => {
            let mut text = String::new();
            let mut images = 0;
            for b in blocks {
              match b.get("type").and_then(Value::as_str) {
                Some("text") if !meta => {
                  if !text.is_empty() {
                    text.push('\n');
                  }
                  text.push_str(b.get("text").and_then(Value::as_str).unwrap_or(""));
                }
                Some("image") if !meta => images += 1,
                Some("tool_result") => items.push(Item::ToolResult {
                  key: key(items.len()),
                  tool_id: s(b, "tool_use_id").unwrap_or_default(),
                  text: cut(&result_text(b.get("content").unwrap_or(&Value::Null)), MAX_RESULT),
                  is_error: b.get("is_error").and_then(Value::as_bool) == Some(true),
                }),
                _ => {}
              }
            }
            if !text.is_empty() || images > 0 {
              user_text_items(&uuid, &text, images, &mut items);
            }
          }
          _ => {}
        }
      }
    }
    "assistant" => {
      let msg_id = s(&msg, "id");
      let error = v.get("isApiErrorMessage").and_then(Value::as_bool) == Some(true);
      for b in msg.get("content").and_then(Value::as_array).into_iter().flatten() {
        let k = key(items.len());
        match b.get("type").and_then(Value::as_str) {
          Some("text") => {
            let text = b.get("text").and_then(Value::as_str).unwrap_or("");
            if error {
              items.push(Item::Note { key: k, level: "error".into(), text: cut(text, MAX_RESULT) });
            } else if !text.trim().is_empty() {
              items.push(Item::Text { key: k, msg_id: msg_id.clone().unwrap_or_default(), text: cut(text, MAX_TEXT) });
            }
          }
          // Thinking text can be withheld (empty, only a signature): the
          // block is still worth a collapsed "thought" marker.
          Some("thinking") => items.push(Item::Thinking { key: k, text: cut(b.get("thinking").and_then(Value::as_str).unwrap_or(""), MAX_TEXT) }),
          Some("redacted_thinking") => items.push(Item::Thinking { key: k, text: String::new() }),
          Some("tool_use") | Some("server_tool_use") => items.push(Item::Tool {
            key: k,
            tool_id: s(b, "id").unwrap_or_default(),
            name: s(b, "name").unwrap_or_default(),
            input: trim_input(b.get("input").unwrap_or(&Value::Null)),
          }),
          _ => {}
        }
      }
      if let (Some(id), Some(u)) = (&msg_id, msg.get("usage")) {
        let n = |k: &str| u.get(k).and_then(Value::as_u64).unwrap_or(0);
        items.push(Item::Usage {
          key: key(items.len()),
          msg_id: id.clone(),
          model: s(&msg, "model").unwrap_or_default(),
          input: n("input_tokens"),
          cache_write: n("cache_creation_input_tokens"),
          cache_read: n("cache_read_input_tokens"),
          output: n("output_tokens"),
        });
      }
    }
    "system" => match v.get("subtype").and_then(Value::as_str) {
      Some("compact_boundary") => {
        let m = v.get("compactMetadata").cloned().unwrap_or(Value::Null);
        items.push(Item::Compact {
          key: key(0),
          trigger: s(&m, "trigger").unwrap_or_else(|| "auto".into()),
          pre_tokens: m.get("preTokens").and_then(Value::as_u64).unwrap_or(0),
        });
      }
      Some("turn_duration") => items.push(Item::TurnEnd { key: key(0), duration_ms: v.get("durationMs").and_then(Value::as_u64).unwrap_or(0) }),
      Some("api_error") => items.push(api_error_note(v, key(0))),
      Some("local_command") | Some("informational") => {
        if let Some(text) = s(v, "content") {
          let shown = tag(&text, "local-command-stdout").unwrap_or(&text).trim().to_string();
          if !shown.is_empty() {
            items.push(Item::Note { key: key(0), level: "command".into(), text: cut(&shown, MAX_RESULT) });
          }
        }
      }
      _ => {}
    },
    // Attachments are context for the model (environment, hook results,
    // file snapshots); they stay in the chain but draw nothing. Except a
    // message typed while a turn ran: the CLI queues it and hands it to the
    // model at the next tool boundary as a queued_command attachment, never
    // as a user record (2.1.330, verified), so it is drawn as one here.
    _ => {
      let a = v.get("attachment").unwrap_or(&Value::Null);
      if a.get("type").and_then(Value::as_str) == Some("queued_command") {
        match a.get("prompt") {
          Some(Value::String(text)) => user_text_items(&uuid, text, 0, &mut items),
          Some(Value::Array(blocks)) => {
            let text = blocks.iter().filter(|b| b.get("type").and_then(Value::as_str) == Some("text")).filter_map(|b| b.get("text").and_then(Value::as_str)).collect::<Vec<_>>().join("\n");
            let images = blocks.iter().filter(|b| b.get("type").and_then(Value::as_str) == Some("image")).count() as u32;
            user_text_items(&uuid, &text, images, &mut items);
          }
          _ => {}
        }
      }
    }
  }
  Some((uuid, Rec { parent, logical_parent, items }))
}

// A failed API call the CLI is retrying (overload, rate limit, network):
// "retry 2/10 in 4s" when the record says so, else just the error.
fn api_error_note(v: &Value, key: String) -> Item {
  let err = s(v, "content")
    .or_else(|| v.pointer("/error/error/message").and_then(Value::as_str).map(str::to_string))
    .or_else(|| v.pointer("/error/message").and_then(Value::as_str).map(str::to_string))
    .or_else(|| v.get("error").filter(|e| !e.is_null()).map(|e| e.to_string()))
    .unwrap_or_else(|| "API error".into());
  let n = |k: &str| v.get(k).and_then(Value::as_u64);
  match (n("retryAttempt"), n("maxRetries")) {
    (Some(a), Some(m)) => {
      let wait = n("retryInMs").map(|ms| format!(" ({:.0}s)", ms as f64 / 1000.0)).unwrap_or_default();
      Item::Note { key, level: "retry".into(), text: cut(&format!("retry {a}/{m}{wait}: {err}"), MAX_RESULT) }
    }
    _ => Item::Note { key, level: "error".into(), text: cut(&err, MAX_RESULT) },
  }
}

impl Store {
  /// The session's name: the person's (/rename) over the CLI's own.
  pub fn title(&self) -> Option<&str> {
    self.custom_title.as_deref().or(self.ai_title.as_deref())
  }

  /// Feed one complete line. Returns whether it was a conversation record.
  pub fn ingest(&mut self, line: &str) -> bool {
    let Ok(v) = serde_json::from_str::<Value>(line) else { return false };
    match v.get("type").and_then(Value::as_str) {
      Some("custom-title") => {
        if let Some(t) = s(&v, "customTitle") {
          self.title_dirty |= self.custom_title.as_deref() != Some(t.as_str());
          self.custom_title = Some(t);
        }
        return false;
      }
      Some("ai-title") => {
        if let Some(t) = s(&v, "aiTitle").or_else(|| s(&v, "title")) {
          self.title_dirty |= self.ai_title.as_deref() != Some(t.as_str());
          self.ai_title = Some(t);
        }
        return false;
      }
      _ => {}
    }
    let Some((uuid, rec)) = parse_rec(&v) else { return false };
    self.recs.insert(uuid.clone(), rec);
    self.leaf = Some(uuid);
    self.dirty = true;
    true
  }

  pub fn take_dirty(&mut self) -> bool {
    std::mem::take(&mut self.dirty)
  }

  pub fn take_title_dirty(&mut self) -> bool {
    std::mem::take(&mut self.title_dirty)
  }

  /// The conversation on screen: the chain from the leaf to the root, oldest
  /// first, with each API message's usage counted once.
  pub fn branch(&self) -> Vec<Item> {
    let mut chain: Vec<&Rec> = Vec::new();
    let mut seen: HashSet<&str> = HashSet::new();
    let mut cur = self.leaf.as_deref();
    while let Some(id) = cur {
      if !seen.insert(id) {
        break; // a cycle would be a corrupt file; never loop on it
      }
      let Some(r) = self.recs.get(id) else { break };
      chain.push(r);
      cur = r.parent.as_deref().or(r.logical_parent.as_deref());
    }
    chain.reverse();
    // One API message is split over several records (thinking, text,
    // tool_use), each repeating the same usage, which must count once.
    let mut out = Vec::new();
    let mut counted: HashSet<&str> = HashSet::new();
    for r in chain {
      for it in &r.items {
        if let Item::Usage { msg_id, .. } = it {
          if !counted.insert(msg_id.as_str()) {
            continue;
          }
        }
        out.push(it.clone());
      }
    }
    out
  }
}

/// What changed between what the page has and the current branch: an append
/// when the old list is a prefix of the new one, else a full reset (a rewind
/// or another branch became current).
pub enum Delta {
  None,
  Append(Vec<Item>),
  Reset(Vec<Item>),
}

pub fn delta(sent: &[String], now: &[Item]) -> Delta {
  let prefix = sent.len() <= now.len() && sent.iter().zip(now).all(|(a, b)| a == b.key());
  if prefix {
    if sent.len() == now.len() {
      Delta::None
    } else {
      Delta::Append(now[sent.len()..].to_vec())
    }
  } else {
    Delta::Reset(now.to_vec())
  }
}

/// Reads whole lines appended to a file since the last call. A line still
/// being written (no newline yet) waits for the next read; a file that got
/// shorter (rewritten) starts over.
pub struct Tail {
  pub path: PathBuf,
  offset: u64,
  partial: Vec<u8>,
}

pub enum Chunk {
  Lines(Vec<String>),
  /// The file shrank: everything known about it is stale.
  Restarted(Vec<String>),
}

impl Tail {
  pub fn new(path: PathBuf) -> Self {
    Tail { path, offset: 0, partial: Vec::new() }
  }

  #[cfg(test)]
  pub fn offset(&self) -> u64 {
    self.offset
  }

  pub fn read(&mut self) -> std::io::Result<Chunk> {
    let mut f = std::fs::File::open(&self.path)?;
    let len = f.metadata()?.len();
    let mut restarted = false;
    if len < self.offset {
      self.offset = 0;
      self.partial.clear();
      restarted = true;
    }
    if len == self.offset {
      return Ok(if restarted { Chunk::Restarted(Vec::new()) } else { Chunk::Lines(Vec::new()) });
    }
    f.seek(SeekFrom::Start(self.offset))?;
    let mut buf = Vec::with_capacity((len - self.offset) as usize);
    f.take(len - self.offset).read_to_end(&mut buf)?;
    self.offset += buf.len() as u64;
    let mut data = std::mem::take(&mut self.partial);
    data.extend_from_slice(&buf);
    let mut lines = Vec::new();
    let mut start = 0;
    for (i, b) in data.iter().enumerate() {
      if *b == b'\n' {
        let l = String::from_utf8_lossy(&data[start..i]).trim_end_matches('\r').to_string();
        if !l.trim().is_empty() {
          lines.push(l);
        }
        start = i + 1;
      }
    }
    self.partial = data[start..].to_vec();
    Ok(if restarted { Chunk::Restarted(lines) } else { Chunk::Lines(lines) })
  }
}

/// <config>/projects/<cwd with every non-alphanumeric char as '-'>: the
/// CLI's rule, shared with the session list (services/chat/history.rs).
pub fn project_dir(cwd: &str, config_dir: Option<&str>) -> PathBuf {
  crate::services::agentcli::history::project_dir(cwd, config_dir)
}

/// Where the session's transcript is, or will be.
pub fn transcript_path(cwd: &str, config_dir: Option<&str>, session_id: &str) -> PathBuf {
  project_dir(cwd, config_dir).join(format!("{session_id}.jsonl"))
}

/// Long cwds are shortened with a hash by the CLI; when the expected file
/// never shows up, find the session by its id (only this id is looked at).
pub fn find_by_id(config_dir: Option<&str>, session_id: &str) -> Option<PathBuf> {
  let base = match config_dir.filter(|d| !d.is_empty()) {
    Some(d) => PathBuf::from(d),
    None => crate::services::paths::home().join(".claude"),
  };
  let name = format!("{session_id}.jsonl");
  for e in std::fs::read_dir(base.join("projects")).ok()?.flatten() {
    let p = e.path().join(&name);
    if p.is_file() {
      return Some(p);
    }
  }
  None
}

pub fn is_uuid(id: &str) -> bool {
  let b = id.as_bytes();
  b.len() == 36
    && b.iter().enumerate().all(|(i, c)| if matches!(i, 8 | 13 | 18 | 23) { *c == b'-' } else { c.is_ascii_hexdigit() })
}

/// Per-turn usage summed over a branch (what the measurement reports; the
/// page sums the same items itself).
#[cfg(test)]
pub fn turn_usage(items: &[Item]) -> Vec<Value> {
  use serde_json::json;
  let mut out = Vec::new();
  let mut cur: Option<(String, u64, u64, u64, u64, u32)> = None;
  let flush = |cur: &mut Option<(String, u64, u64, u64, u64, u32)>, out: &mut Vec<Value>| {
    if let Some((prompt, i, w, r, o, n)) = cur.take() {
      out.push(json!({ "prompt": prompt, "requests": n, "input": i, "cacheWrite": w, "cacheRead": r, "output": o }));
    }
  };
  for it in items {
    match it {
      Item::User { text, .. } => {
        flush(&mut cur, &mut out);
        cur = Some((text.clone(), 0, 0, 0, 0, 0));
      }
      Item::Usage { input, cache_write, cache_read, output, .. } => {
        let c = cur.get_or_insert_with(|| (String::new(), 0, 0, 0, 0, 0));
        c.1 += input;
        c.2 += cache_write;
        c.3 += cache_read;
        c.4 += output;
        c.5 += 1;
      }
      _ => {}
    }
  }
  flush(&mut cur, &mut out);
  out
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;

  #[test]
  fn last_reply_is_the_text_after_the_last_prompt() {
    let user = |k: &str| Item::User { key: k.into(), text: "q".into(), command: None, images: 0 };
    let text = |k: &str, t: &str| Item::Text { key: k.into(), msg_id: "m".into(), text: t.into() };
    let tool = Item::Tool { key: "t".into(), tool_id: "x".into(), name: "Bash".into(), input: json!({}) };
    let items = vec![user("u1"), text("a", "old"), user("u2"), text("b", "first"), tool, text("c", " "), text("d", "second")];
    assert_eq!(last_reply(&items).as_deref(), Some("first\n\nsecond"));
    assert_eq!(last_reply(&[user("u")]), None);
    assert_eq!(last_reply(&[text("a", "no prompt yet")]).as_deref(), Some("no prompt yet"));
  }

  // Hand-written in the shape 2.1.330 writes (trimmed to the fields read).
  fn fixture() -> Vec<String> {
    vec![
      r#"{"type":"mode","mode":"normal","sessionId":"s"}"#.into(),
      r#"{"type":"attachment","uuid":"a0","parentUuid":null,"isSidechain":false,"attachment":{"type":"hook_success"}}"#.into(),
      r#"{"type":"user","uuid":"u1","parentUuid":"a0","isSidechain":false,"message":{"role":"user","content":"hello"}}"#.into(),
      r#"{"type":"attachment","uuid":"a1","parentUuid":"u1","isSidechain":false,"attachment":{"type":"environment"}}"#.into(),
      r#"{"type":"api-request-blob","hash":"x"}"#.into(),
      r#"{"type":"assistant","uuid":"m1","parentUuid":"a1","isSidechain":false,"message":{"id":"msg_1","model":"claude-haiku","content":[{"type":"thinking","thinking":"","signature":"sig"}],"usage":{"input_tokens":2,"cache_creation_input_tokens":100,"cache_read_input_tokens":900,"output_tokens":30}}}"#.into(),
      r#"{"type":"assistant","uuid":"m2","parentUuid":"m1","isSidechain":false,"message":{"id":"msg_1","model":"claude-haiku","content":[{"type":"tool_use","id":"t1","name":"Write","input":{"file_path":"/w/a.txt","content":"hi"}}],"usage":{"input_tokens":2,"cache_creation_input_tokens":100,"cache_read_input_tokens":900,"output_tokens":30}}}"#.into(),
      r#"{"type":"user","uuid":"r1","parentUuid":"m2","isSidechain":false,"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"File created"}]}}"#.into(),
      r#"{"type":"assistant","uuid":"m3","parentUuid":"r1","isSidechain":false,"message":{"id":"msg_2","model":"claude-haiku","content":[{"type":"text","text":"written"}],"usage":{"input_tokens":2,"cache_creation_input_tokens":5,"cache_read_input_tokens":1000,"output_tokens":3}}}"#.into(),
      r#"{"type":"assistant","uuid":"x1","parentUuid":"m3","isSidechain":true,"message":{"id":"msg_s","content":[{"type":"text","text":"subagent"}]}}"#.into(),
      r#"{"type":"system","subtype":"turn_duration","uuid":"d1","parentUuid":"m3","isSidechain":false,"durationMs":1200,"isMeta":false}"#.into(),
    ]
  }

  fn kinds(items: &[Item]) -> Vec<String> {
    items
      .iter()
      .map(|i| match i {
        Item::User { text, .. } => format!("user:{text}"),
        Item::Text { text, .. } => format!("text:{text}"),
        Item::Thinking { .. } => "thinking".into(),
        Item::Tool { name, .. } => format!("tool:{name}"),
        Item::ToolResult { tool_id, .. } => format!("result:{tool_id}"),
        Item::Usage { msg_id, .. } => format!("usage:{msg_id}"),
        Item::Compact { trigger, .. } => format!("compact:{trigger}"),
        Item::Note { level, .. } => format!("note:{level}"),
        Item::TurnEnd { .. } => "end".into(),
      })
      .collect()
  }

  #[test]
  fn parses_a_turn_with_a_tool() {
    let mut st = Store::default();
    for l in fixture() {
      st.ingest(&l);
    }
    assert_eq!(
      kinds(&st.branch()),
      ["user:hello", "thinking", "usage:msg_1", "tool:Write", "result:t1", "text:written", "usage:msg_2", "end"]
    );
    let u = turn_usage(&st.branch());
    assert_eq!(u.len(), 1);
    assert_eq!(u[0]["cacheRead"], 1900);
    assert_eq!(u[0]["cacheWrite"], 105);
    assert_eq!(u[0]["requests"], 2);
  }

  #[test]
  fn a_message_typed_mid_turn_is_drawn_where_the_cli_delivered_it() {
    // 2.1.330: typed while a tool ran, queued by the CLI, handed to the model
    // after the tool result as a queued_command attachment.
    let lines = [
      r#"{"type":"user","uuid":"u1","parentUuid":null,"isSidechain":false,"message":{"role":"user","content":"run it"}}"#,
      r#"{"type":"assistant","uuid":"m1","parentUuid":"u1","isSidechain":false,"message":{"id":"msg_1","content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"sleep 15"}}]}}"#,
      r#"{"type":"queue-operation","operation":"enqueue","content":"also this","sessionId":"s"}"#,
      r#"{"type":"user","uuid":"r1","parentUuid":"m1","isSidechain":false,"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":""}]}}"#,
      r#"{"type":"attachment","uuid":"q1","parentUuid":"r1","isSidechain":false,"attachment":{"type":"queued_command","prompt":"also this","commandMode":"prompt"}}"#,
      r#"{"type":"assistant","uuid":"m2","parentUuid":"q1","isSidechain":false,"message":{"id":"msg_2","content":[{"type":"text","text":"done"}]}}"#,
    ];
    let mut st = Store::default();
    for l in lines {
      st.ingest(l);
    }
    assert_eq!(kinds(&st.branch()), ["user:run it", "tool:Bash", "result:t1", "user:also this", "text:done"]);
  }

  #[test]
  fn a_rewind_drops_the_abandoned_branch() {
    let mut st = Store::default();
    for l in fixture() {
      st.ingest(&l);
    }
    // The person rewound to before "hello" and asked something else: the new
    // prompt hangs off a0, so u1..d1 are no longer the conversation.
    st.ingest(r#"{"type":"user","uuid":"u2","parentUuid":"a0","isSidechain":false,"message":{"role":"user","content":"again"}}"#);
    st.ingest(r#"{"type":"assistant","uuid":"m4","parentUuid":"u2","isSidechain":false,"message":{"id":"msg_3","content":[{"type":"text","text":"ok"}]}}"#);
    assert_eq!(kinds(&st.branch()), ["user:again", "text:ok"]);
  }

  #[test]
  fn compact_boundary_keeps_the_history_before_it() {
    let mut st = Store::default();
    for l in fixture() {
      st.ingest(&l);
    }
    st.ingest(r#"{"type":"system","subtype":"compact_boundary","uuid":"c1","parentUuid":null,"logicalParentUuid":"d1","isSidechain":false,"compactMetadata":{"trigger":"manual","preTokens":5000}}"#);
    st.ingest(r#"{"type":"user","uuid":"s1","parentUuid":"c1","isSidechain":false,"isCompactSummary":true,"message":{"role":"user","content":"summary text"}}"#);
    st.ingest(r#"{"type":"user","uuid":"u3","parentUuid":"s1","isSidechain":false,"message":{"role":"user","content":"<command-name>/compact</command-name>\n<command-args></command-args>"}}"#);
    let k = kinds(&st.branch());
    assert_eq!(k.first().map(String::as_str), Some("user:hello"));
    assert_eq!(&k[k.len() - 3..], ["compact:manual", "note:summary", "user:/compact"]);
  }

  #[test]
  fn meta_interrupt_and_local_command() {
    let mut st = Store::default();
    st.ingest(r#"{"type":"user","uuid":"a","parentUuid":null,"isMeta":true,"message":{"role":"user","content":"<local-command-caveat>x</local-command-caveat>"}}"#);
    st.ingest(r#"{"type":"user","uuid":"b","parentUuid":"a","message":{"role":"user","content":"<local-command-stdout>Set model to haiku</local-command-stdout>"}}"#);
    st.ingest(r#"{"type":"user","uuid":"c","parentUuid":"b","message":{"role":"user","content":[{"type":"text","text":"[Request interrupted by user]"}]}}"#);
    st.ingest(r#"{"type":"user","uuid":"d","parentUuid":"c","message":{"role":"user","content":[{"type":"text","text":"look"},{"type":"image","source":{}}]}}"#);
    let b = st.branch();
    assert_eq!(kinds(&b), ["note:command", "note:interrupted", "user:look"]);
    assert!(matches!(&b[2], Item::User { images: 1, .. }));
  }

  #[test]
  fn titles_task_notes_and_retries() {
    let mut st = Store::default();
    st.ingest(r#"{"type":"ai-title","aiTitle":"Image color question","sessionId":"s"}"#);
    assert_eq!(st.title(), Some("Image color question"));
    assert!(st.take_title_dirty());
    st.ingest(r#"{"type":"custom-title","customTitle":"mine","sessionId":"s"}"#);
    st.ingest(r#"{"type":"ai-title","aiTitle":"later ai","sessionId":"s"}"#);
    assert_eq!(st.title(), Some("mine"));
    // As 2.1.330 writes a finished background agent.
    st.ingest(r#"{"type":"user","uuid":"t1","parentUuid":null,"origin":{"kind":"task-notification"},"message":{"role":"user","content":"<task-notification>\n<task-id>a03</task-id>\n<status>completed</status>\n<summary>Agent \"Run echo\" completed</summary>\n</task-notification>"}}"#);
    st.ingest(r#"{"type":"system","subtype":"api_error","uuid":"e1","parentUuid":"t1","retryAttempt":2,"maxRetries":10,"retryInMs":4100,"error":{"error":{"message":"Overloaded"}}}"#);
    st.ingest(r#"{"type":"system","subtype":"api_error","uuid":"e2","parentUuid":"e1","content":"boom"}"#);
    let b = st.branch();
    assert_eq!(kinds(&b), ["note:task", "note:retry", "note:error"]);
    let Item::Note { text, .. } = &b[0] else { panic!() };
    assert_eq!(text, "Agent \"Run echo\" completed");
    let Item::Note { text, .. } = &b[1] else { panic!() };
    assert_eq!(text, "retry 2/10 (4s): Overloaded");
  }

  #[test]
  fn delta_appends_or_resets() {
    let mut st = Store::default();
    let lines = fixture();
    for l in &lines[..4] {
      st.ingest(l);
    }
    let first = st.branch();
    let sent: Vec<String> = first.iter().map(|i| i.key().to_string()).collect();
    for l in &lines[4..] {
      st.ingest(l);
    }
    match delta(&sent, &st.branch()) {
      Delta::Append(v) => assert_eq!(v.len(), 7),
      _ => panic!("expected append"),
    }
    st.ingest(r#"{"type":"user","uuid":"u9","parentUuid":"a0","message":{"role":"user","content":"other"}}"#);
    let sent: Vec<String> = vec!["u1:0".into(), "m1:0".into()];
    assert!(matches!(delta(&sent, &st.branch()), Delta::Reset(_)));
    let now = st.branch();
    let same: Vec<String> = now.iter().map(|i| i.key().to_string()).collect();
    assert!(matches!(delta(&same, &now), Delta::None));
  }

  #[test]
  fn tail_reads_whole_lines_only() {
    let dir = std::env::temp_dir().join(format!("riven-tail-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let p = dir.join("t.jsonl");
    std::fs::write(&p, "{\"a\":1}\n{\"b\":").unwrap();
    let mut t = Tail::new(p.clone());
    let Chunk::Lines(l) = t.read().unwrap() else { panic!() };
    assert_eq!(l, vec!["{\"a\":1}"]);
    assert_eq!(t.offset(), 13);
    use std::io::Write;
    let mut f = std::fs::OpenOptions::new().append(true).open(&p).unwrap();
    f.write_all("2}\r\n\n{\"c\":\"한\"}\n".as_bytes()).unwrap();
    let Chunk::Lines(l) = t.read().unwrap() else { panic!() };
    assert_eq!(l, vec!["{\"b\":2}", "{\"c\":\"한\"}"]);
    let Chunk::Lines(l) = t.read().unwrap() else { panic!() };
    assert!(l.is_empty());
    std::fs::write(&p, "{\"z\":0}\n").unwrap();
    let Chunk::Restarted(l) = t.read().unwrap() else { panic!("expected restart") };
    assert_eq!(l, vec!["{\"z\":0}"]);
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn paths() {
    assert!(is_uuid("2c3fb035-08f1-46f7-b0dc-6869053b21d9"));
    assert!(!is_uuid("2c3fb035-08f1-46f7-b0dc-6869053b21d9; x"));
    let p = transcript_path("/private/tmp/a_b.c/ws", Some("/cfg"), "id");
    assert_eq!(p, PathBuf::from("/cfg/projects/-private-tmp-a-b-c-ws/id.jsonl"));
  }

  #[test]
  fn long_strings_are_cut_on_char_boundaries() {
    let s = "한".repeat(3000);
    let c = cut(&s, 10);
    assert!(c.ends_with('…'));
    let v = trim_input(&json!({ "content": "x".repeat(5000) }));
    assert!(v["content"].as_str().unwrap().len() < 2100);
  }
}
