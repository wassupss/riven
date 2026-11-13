// Agent lifecycle hooks (was src/main/agentHooks.ts, agents.ts, agentEdits.ts
// and the hook mapping of terminal/activity.ts). Claude Code and Codex tell
// riven when a turn starts, ends and when it waits on the user, which
// conversation a pane is in, what the agent answered, and which files it
// wrote.
//
// Mechanics: riven writes a settings file with `hooks` entries and hands it
// to the CLI with --settings (deep-merged, so the user's own hooks keep
// firing). Each hook is a one-line shell command that POSTs the hook's stdin
// to /hook on the loopback server, tagged with the pane it runs in
// (RIVEN_PANE, which every terminal and chat CLI riven starts has). A CLI
// started anywhere else finds the variable empty and the command is a no-op.

use super::http::{query, Response};
use crate::services::pty;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

// SessionStart is what makes a terminal's conversation recoverable: it carries
// the session id the moment the CLI comes up.
const HOOK_EVENTS: [&str; 6] = ["SessionStart", "UserPromptSubmit", "Stop", "StopFailure", "SessionEnd", "Notification"];
// The file tools, whose Pre/PostToolUse hooks feed the changes timeline. The
// matcher is a regex over the tool name, so a Bash or a Read never pays.
const EDIT_TOOL_MATCHER: &str = "Write|Edit|MultiEdit|NotebookEdit";
// Codex keys a hook's trust by source + event + POSITION and remembers the
// hash of what it approved, so these never change between runs.
const CODEX_HOOK_EVENTS: [&str; 4] = ["SessionStart", "UserPromptSubmit", "PermissionRequest", "Stop"];
const CODEX_EDIT_TOOL_MATCHER: &str = "apply_patch|Edit|Write";

/// The same command for every run (Codex remembers the hash of a hook the
/// user approved): everything variable (pane, url, token) comes from the
/// environment the CLI inherited.
pub fn hook_command(event: &str, agent: &str) -> String {
  let who = if agent == "claude" { String::new() } else { format!("&agent={agent}") };
  format!(
    "if [ -n \"$RIVEN_PANE\" ] && [ -n \"$RIVEN_HOOK_URL\" ]; then curl -s -m 2 -X POST -H 'content-type: application/json' --data-binary @- \"$RIVEN_HOOK_URL?pane=$RIVEN_PANE&event={event}{who}&token=$RIVEN_HOOK_TOKEN\" >/dev/null 2>&1; fi; exit 0"
  )
}

/// The --settings file, written once per run. None if it could not be
/// written (a terminal without hooks still works; the heuristic stays).
pub fn settings_path() -> Option<&'static Path> {
  static P: OnceLock<Option<PathBuf>> = OnceLock::new();
  P.get_or_init(|| {
    let r = (|| -> std::io::Result<PathBuf> {
      use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
      let dir = crate::services::paths::user_data().join("hooks");
      std::fs::DirBuilder::new().recursive(true).mode(0o700).create(&dir)?;
      let file = dir.join("claude-settings.json");
      let mut hooks = serde_json::Map::new();
      let entry = |matcher: &str, ev: &str| json!([{ "matcher": matcher, "hooks": [{ "type": "command", "command": hook_command(ev, "claude"), "timeout": 5 }] }]);
      for ev in HOOK_EVENTS {
        hooks.insert(ev.into(), entry("", ev));
      }
      for ev in ["PreToolUse", "PostToolUse"] {
        hooks.insert(ev.into(), entry(EDIT_TOOL_MATCHER, ev));
      }
      let text = serde_json::to_string_pretty(&json!({ "hooks": hooks })).unwrap_or_default() + "\n";
      let mut f = std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(&file)?;
      std::io::Write::write_all(&mut f, text.as_bytes())?;
      Ok(file)
    })();
    r.map_err(|e| eprintln!("[hooks] settings write failed {e}")).ok()
  })
  .as_deref()
}

/// Environment a terminal (or chat CLI) needs so its hooks reach us.
pub fn hook_env(pane: &str) -> HashMap<String, String> {
  let (Some(base), Some(settings)) = (super::base_url(), settings_path()) else { return HashMap::new() };
  HashMap::from([
    ("RIVEN_PANE".into(), pane.to_string()),
    ("RIVEN_HOOK_URL".into(), format!("{base}/hook")),
    ("RIVEN_HOOK_TOKEN".into(), super::token().to_string()),
    ("RIVEN_HOOKS_SETTINGS".into(), settings.to_string_lossy().into_owned()),
  ])
}

// A TOML basic string. JSON's escaping is a subset TOML accepts.
fn toml_string(s: &str) -> String {
  serde_json::to_string(s).unwrap_or_default()
}

fn toml_hook(command: &str, matcher: Option<&str>) -> String {
  let m = matcher.map(|m| format!("matcher={},", toml_string(m))).unwrap_or_default();
  format!("[{{{m}hooks=[{{type=\"command\",command={},timeout=5}}]}}]", toml_string(command))
}

/// `-c key=value` overrides for a Codex launched in a riven terminal: riven's
/// MCP server for this pane, and the lifecycle + file-edit hooks. Nothing is
/// written into the user's ~/.codex. Values only (without the `-c`).
pub fn codex_config_overrides(mcp_url: Option<&str>, instructions: Option<&str>, tool_timeout_sec: u64) -> Vec<String> {
  let mut out = Vec::new();
  if let Some(u) = mcp_url {
    out.push(format!("mcp_servers.riven.url={}", toml_string(u)));
    // The token stays out of argv (visible to `ps`); Codex reads it from here.
    out.push("mcp_servers.riven.bearer_token_env_var=\"RIVEN_MCP_TOKEN\"".into());
    // ask_user waits on a person; riven's own ceiling is the one that applies.
    out.push(format!("mcp_servers.riven.tool_timeout_sec={tool_timeout_sec}"));
  }
  for ev in CODEX_HOOK_EVENTS {
    out.push(format!("hooks.{ev}={}", toml_hook(&hook_command(ev, "codex"), None)));
  }
  for ev in ["PreToolUse", "PostToolUse"] {
    out.push(format!("hooks.{ev}={}", toml_hook(&hook_command(ev, "codex"), Some(CODEX_EDIT_TOOL_MATCHER))));
  }
  if let Some(i) = instructions {
    out.push(format!("developer_instructions={}", toml_string(i)));
  }
  out
}

// ---- hook -> activity ------------------------------------------------------------------

// Anything unrecognised is Claude, which is what every hook sent before
// agents were told apart was.
fn agent_kind(v: Option<&str>) -> &'static str {
  if v == Some("codex") {
    "codex"
  } else {
    "claude"
  }
}

fn hook_to_event(agent: &str, hook: &str) -> Option<&'static str> {
  if agent == "codex" {
    return match hook {
      "UserPromptSubmit" => Some("working"),
      "SessionStart" | "Stop" | "SessionEnd" => Some("idle"),
      // Codex has no Notification hook; a permission prompt is the moment it
      // stops and waits for the person.
      "PermissionRequest" => Some("needs_input"),
      _ => None,
    };
  }
  match hook {
    "UserPromptSubmit" => Some("working"),
    "SessionStart" | "Stop" | "StopFailure" | "SessionEnd" => Some("idle"),
    // The event exists for one reason: Claude wants the user.
    "Notification" => Some("needs_input"),
    _ => None,
  }
}

// It ends up in a shell command (`... resume <id>`), so only the UUID shape
// both CLIs emit is accepted.
fn session_id_of(payload: &Value) -> Option<String> {
  static RE: OnceLock<regex::Regex> = OnceLock::new();
  let re = RE.get_or_init(|| regex::Regex::new(r"(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$").unwrap());
  payload.get("session_id").and_then(Value::as_str).filter(|s| re.is_match(s)).map(str::to_string)
}

// The answer a turn ended with. Stop carries it for both CLIs.
fn reply_of(hook: &str, payload: &Value) -> Option<String> {
  if hook != "Stop" {
    return None;
  }
  payload.get("last_assistant_message").and_then(Value::as_str).filter(|s| !crate::services::chat::util::js_trim(s).is_empty()).map(str::to_string)
}

// ---- the route -----------------------------------------------------------------------------

static DELIVERED: AtomicU64 = AtomicU64::new(0);
static DROPPED: AtomicU64 = AtomicU64::new(0);

fn debug() -> bool {
  static D: OnceLock<bool> = OnceLock::new();
  *D.get_or_init(|| std::env::var("RIVEN_HOOK_DEBUG").as_deref() == Ok("1"))
}

fn parse(body: &str) -> Value {
  if body.is_empty() {
    return Value::Null;
  }
  crate::services::chat::util::parse(body).unwrap_or(Value::Null)
}

/// POST /hook?pane=&event=&agent=. Always 204: a hook must never make the
/// agent wait on riven's opinion. The second value runs after the answer.
pub fn handle(url: &url::Url, body: &str) -> (Response, Option<Box<dyn FnOnce()>>) {
  let pane = query(url, "pane");
  let hook = query(url, "event").unwrap_or_default();
  let agent = agent_kind(query(url, "agent").as_deref());
  // The file tools are answered here: this response is what the CLI waits on
  // before running the tool, so the baseline read has to happen BEFORE the
  // 204, or it reads the already-edited file.
  if hook == "PreToolUse" || hook == "PostToolUse" {
    if let Some(pane) = pane {
      let payload = parse(body);
      let mut t = tracker().lock().unwrap_or_else(|e| e.into_inner());
      if hook == "PreToolUse" {
        t.pre(&pane, &payload);
      } else {
        let edits = t.post(&pane, &payload);
        drop(t);
        if debug() {
          let paths: Vec<&str> = edits.iter().map(|e| e["path"].as_str().unwrap_or("")).collect();
          eprintln!("[hooks] {hook} pane={pane} edits={}", if paths.is_empty() { "none".into() } else { paths.join(",") });
        }
        for e in edits {
          report_edit(e);
        }
      }
    }
    return (Response::empty(204), None);
  }
  let body = body.to_string();
  let after = move || {
    let Some(pane) = pane else {
      DROPPED.fetch_add(1, Ordering::Relaxed);
      if debug() {
        eprintln!("[hooks] {} dropped: no pane", if hook.is_empty() { "(none)" } else { &hook });
      }
      return;
    };
    let payload = parse(&body);
    let Some(event) = hook_to_event(agent, &hook) else {
      DROPPED.fetch_add(1, Ordering::Relaxed);
      if debug() {
        eprintln!("[hooks] {} dropped: unmapped, pane={pane}", if hook.is_empty() { "(none)" } else { &hook });
      }
      return;
    };
    DELIVERED.fetch_add(1, Ordering::Relaxed);
    if debug() {
      eprintln!("[hooks] {hook} pane={pane} -> {event} ok");
    }
    pty::hook(&pty::AgentHook { pane: &pane, agent, event, hook: &hook, session_id: session_id_of(&payload), reply: reply_of(&hook, &payload) });
  };
  (Response::empty(204), Some(Box::new(after)))
}

/// A file an agent wrote, attributed to its pane: to every app page (each
/// keeps only the panes its own layout owns).
pub fn report_edit(edit: Value) {
  crate::services::chat::broadcast("agent:fileEdit", edit);
}

// ---- the edit tracker (agentEdits.ts) ----------------------------------------------------------

// Files big enough to be generated output, binaries and anything unreadable
// are not diffable review material.
const MAX_DIFF_BYTES: u64 = 2_000_000;

fn read_for_diff(p: &Path) -> Option<String> {
  let m = std::fs::metadata(p).ok()?;
  if !m.is_file() || m.len() > MAX_DIFF_BYTES {
    return None;
  }
  let text = crate::services::fsx::read_utf8(p).ok()?;
  (!text.contains('\0')).then_some(text)
}

/// The files a file-editing tool is about to touch, absolute. Claude Code's
/// Write/Edit/MultiEdit carry file_path and NotebookEdit notebook_path;
/// Codex's apply_patch carries a patch naming each file, relative to the
/// session's cwd.
pub fn edit_paths(payload: &Value) -> Vec<String> {
  let Some(input) = payload.get("tool_input").filter(|v| crate::services::chat::util::truthy(Some(v))) else { return Vec::new() };
  if input.is_object() || input.is_array() {
    let raw = input.get("file_path").filter(|v| !v.is_null()).or_else(|| input.get("notebook_path"));
    if let Some(Value::String(raw)) = raw {
      return if Path::new(raw).is_absolute() { vec![raw.clone()] } else { Vec::new() };
    }
  }
  let texts: Vec<&str> = match input {
    Value::String(s) => vec![s.as_str()],
    Value::Object(m) => m.values().filter_map(Value::as_str).collect(),
    Value::Array(a) => a.iter().filter_map(Value::as_str).collect(),
    _ => Vec::new(),
  };
  let cwd = payload.get("cwd").and_then(Value::as_str).filter(|c| Path::new(c).is_absolute());
  static RE: OnceLock<regex::Regex> = OnceLock::new();
  let re = RE.get_or_init(|| regex::Regex::new(r"(?m)^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$").unwrap());
  let mut out: Vec<String> = Vec::new();
  for text in texts {
    for c in re.captures_iter(text) {
      let f = crate::services::chat::util::js_trim(&c[1]);
      let p = if Path::new(f).is_absolute() {
        normalize(f)
      } else if let Some(cwd) = cwd {
        crate::services::fsx::resolve(Path::new(cwd), Path::new(f)).to_string_lossy().into_owned()
      } else {
        continue;
      };
      if !out.contains(&p) {
        out.push(p);
      }
    }
  }
  out
}

// path.normalize for an absolute path: `.`, `..` and repeated slashes folded,
// a trailing slash kept.
fn normalize(p: &str) -> String {
  let mut s = crate::services::fsx::resolve(Path::new("/"), Path::new(p)).to_string_lossy().into_owned();
  if p.ends_with('/') && !s.ends_with('/') {
    s.push('/');
  }
  s
}

// A turn can only have so many file tools in flight; the caps keep a pane
// whose PostToolUse never arrives from growing this for the life of the app.
const MAX_PENDING: usize = 256;
const MAX_PENDING_BYTES: usize = 64 * 1024 * 1024;

#[derive(Default)]
pub struct EditTracker {
  // Insertion order (oldest first), like the Map it was.
  pending: Vec<(String, Option<String>)>,
  bytes: usize,
}

fn units(s: &Option<String>) -> usize {
  s.as_deref().map(crate::services::fsx::utf16_len).unwrap_or(0)
}

impl EditTracker {
  fn drop_key(&mut self, key: &str) -> Option<Option<String>> {
    let i = self.pending.iter().position(|(k, _)| k == key)?;
    let (_, v) = self.pending.remove(i);
    self.bytes -= units(&v);
    Some(v)
  }

  /// Before the tool runs (while the hook's request is still open).
  pub fn pre(&mut self, pane: &str, payload: &Value) {
    for p in edit_paths(payload) {
      let key = format!("{pane}\u{0}{p}");
      self.drop_key(&key);
      let text = read_for_diff(Path::new(&p));
      let n = units(&text);
      while !self.pending.is_empty() && (self.pending.len() >= MAX_PENDING || self.bytes + n > MAX_PENDING_BYTES) {
        let (_, v) = self.pending.remove(0);
        self.bytes -= units(&v);
      }
      self.bytes += n;
      self.pending.push((key, text));
    }
  }

  /// After the tool ran: one edit per file that actually changed.
  pub fn post(&mut self, pane: &str, payload: &Value) -> Vec<Value> {
    let mut out = Vec::new();
    for p in edit_paths(payload) {
      let key = format!("{pane}\u{0}{p}");
      let seen = self.drop_key(&key);
      let saw_baseline = seen.is_some();
      let before = seen.flatten();
      // Deleted, unreadable, binary or too big to diff: nothing to review.
      let Some(after) = read_for_diff(Path::new(&p)) else { continue };
      // The tool ran but left the file as it was.
      if saw_baseline && before.as_deref() == Some(after.as_str()) {
        continue;
      }
      out.push(json!({ "pane": pane, "path": p, "before": before, "after": after }));
    }
    out
  }
}

fn tracker() -> &'static Mutex<EditTracker> {
  static T: OnceLock<Mutex<EditTracker>> = OnceLock::new();
  T.get_or_init(Default::default)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn paths_from_payloads() {
    assert_eq!(edit_paths(&json!({ "tool_input": { "file_path": "/a/b.ts" } })), vec!["/a/b.ts"]);
    assert!(edit_paths(&json!({ "tool_input": { "file_path": "rel.ts" } })).is_empty());
    assert_eq!(edit_paths(&json!({ "tool_input": { "notebook_path": "/n.ipynb" } })), vec!["/n.ipynb"]);
    let patch = "*** Begin Patch\n*** Update File: src/x.rs\n@@\n*** Add File: /abs/./y.rs\r\n*** Move to: ../z.rs\n*** End Patch";
    assert_eq!(edit_paths(&json!({ "cwd": "/w/p", "tool_input": { "input": patch } })), vec!["/w/p/src/x.rs", "/abs/y.rs", "/w/z.rs"]);
    assert_eq!(edit_paths(&json!({ "cwd": "/w", "tool_input": "*** Delete File: a\n" })), vec!["/w/a"]);
    assert!(edit_paths(&json!({ "tool_input": "*** Delete File: a\n" })).is_empty());
  }

  #[test]
  fn hook_mapping() {
    assert_eq!(hook_to_event("claude", "Notification"), Some("needs_input"));
    assert_eq!(hook_to_event("codex", "Notification"), None);
    assert_eq!(hook_to_event("codex", "PermissionRequest"), Some("needs_input"));
    assert_eq!(session_id_of(&json!({ "session_id": "0A1B2C3D-0000-4000-8000-000000000000" })).as_deref(), Some("0A1B2C3D-0000-4000-8000-000000000000"));
    assert_eq!(session_id_of(&json!({ "session_id": "x; rm -rf" })), None);
    assert_eq!(reply_of("Stop", &json!({ "last_assistant_message": "  " })), None);
  }
}
