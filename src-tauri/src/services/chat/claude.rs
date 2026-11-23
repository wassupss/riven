// One Claude Code CLI child per chat pane, in headless stream-json mode
// (`claude -p --input-format stream-json --output-format stream-json`), and
// the translation of its stream into the pane's ChatEvents. Port of the
// Session half of agentChat.ts; the payloads are the same, field for field.
//
// Auth: no ANTHROPIC_API_KEY and no --bare, so the CLI uses the user's
// subscription login.

use super::tools::{count_diff, tool_code, tool_detail, tool_path, EDIT_TOOLS};
use crate::services::util::{jnum, js_string, num_or0, slice, string_or, truthy};
use super::StartOpts;
use serde_json::{json, Value};
use std::collections::{HashSet, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::time::Instant;
use tokio::sync::mpsc::UnboundedSender;

pub enum Msg {
  Line(String),
  Close,
}

pub struct Session {
  pub key: String,
  pub pid: u32,
  /// Which installed CLI build this process runs (binIdentity at spawn).
  pub bin: Option<String>,
  pub tx: UnboundedSender<Msg>,
  pub exited: AtomicBool,
  pub st: Mutex<St>,
}

pub struct St {
  pub sender: String,
  pub session_id: Option<String>,
  pub alive: bool,
  pub ctrl_seq: u64,
  pub saw_init: bool,
  /// Messages written before init: if the --resume target is gone the CLI
  /// exits without reading them and the fresh child gets them instead.
  pub unsent: Vec<(Value, String)>,
  streamed_text: bool,
  // Token totals for the turn so far (a turn is many model calls).
  turn_in: f64,
  turn_out_done: f64,
  call_out: f64,
  pub opts: StartOpts,
  pub last_active: Instant,
  pub turn_busy: bool,
  pub parking: bool,
  /// Ids of messages sent and not yet answered, oldest first.
  pub turns: VecDeque<String>,
  // Results owed to turns the CLI started by itself (turnClaim.ts).
  auto_turns: u32,
  auto_turn_at: f64,
  bg_task_ids: HashSet<String>,
  pub bg_running: usize,
}

impl St {
  pub fn new(sender: String, opts: StartOpts) -> St {
    St {
      sender,
      session_id: super::nz(&opts.resume).map(str::to_string),
      alive: true,
      ctrl_seq: 0,
      saw_init: false,
      unsent: Vec::new(),
      streamed_text: false,
      turn_in: 0.0,
      turn_out_done: 0.0,
      call_out: 0.0,
      opts,
      last_active: Instant::now(),
      turn_busy: false,
      parking: false,
      turns: VecDeque::new(),
      auto_turns: 0,
      auto_turn_at: 0.0,
      bg_task_ids: HashSet::new(),
      bg_running: 0,
    }
  }
}

impl Session {
  pub fn lock(&self) -> MutexGuard<'_, St> {
    self.st.lock().unwrap_or_else(|e| e.into_inner())
  }

  /// Never fails on a dead pipe (the writer task drops it).
  pub fn write_line(&self, st: &St, obj: &Value) {
    if !st.alive {
      return;
    }
    let _ = self.tx.send(Msg::Line(obj.to_string() + "\n"));
  }

  /// Hand a user message to the child, holding a slot for its result. ALWAYS
  /// pushes an id, even for an unnamed turn (a bare /clear): one line, one
  /// result.
  pub fn deliver(&self, line: Value, turn: Option<String>) {
    let mut st = self.lock();
    st.turn_busy = true;
    st.last_active = Instant::now();
    let id = turn.unwrap_or_else(|| format!("main_{}", crate::services::util::uuid()));
    st.turns.push_back(id.clone());
    if !st.saw_init {
      st.unsent.push((line.clone(), id));
    }
    self.write_line(&st, &line);
  }

  pub fn control(&self, prefix: char, request: Value) {
    let mut st = self.lock();
    st.ctrl_seq += 1;
    let id = format!("{prefix}{}", st.ctrl_seq);
    self.write_line(&st, &json!({ "type": "control_request", "request_id": id, "request": request }));
  }

  pub fn kill(&self) {
    if !self.exited.load(Ordering::SeqCst) {
      crate::services::util::sigterm(self.pid);
    }
  }
}

/// Everything that happens while a turn is answered belongs to that turn (the
/// front of the queue); an event that names its own turn keeps it.
pub fn emit(st: &St, mut ev: Value) {
  if let Some(o) = ev.as_object_mut() {
    if !o.contains_key("turn") {
      o.insert("turn".into(), st.turns.front().map(|t| json!(t)).unwrap_or(Value::Null));
    }
  }
  super::emit(&st.sender, ev);
}

/// What handle_event leaves for after the session lock is released.
pub enum Post {
  Remember(Vec<String>),
  RestartIfMarked,
  ResumeId(String),
}

fn note_background_report(st: &mut St) {
  if !st.turns.is_empty() {
    return;
  }
  st.auto_turns += 1;
  st.auto_turn_at = crate::services::util::now_ms();
}

const AUTO_TURN_WINDOW_MS: f64 = 60_000.0;

fn claim_result(st: &mut St) -> Option<String> {
  if st.auto_turns > 0 {
    if crate::services::util::now_ms() - st.auto_turn_at < AUTO_TURN_WINDOW_MS {
      st.auto_turns -= 1;
      return None;
    }
    st.auto_turns = 0;
  }
  st.turns.pop_front()
}

/// resultError: what a failed `result` should say.
fn result_error(ev: &Value) -> String {
  if let Some(errs) = ev.get("errors").and_then(Value::as_array) {
    if let Some(e) = errs.iter().filter_map(Value::as_str).find(|e| !e.trim().is_empty()) {
      return slice(crate::services::util::first_line(e), 300);
    }
  }
  if ev.get("subtype").and_then(Value::as_str) == Some("success") {
    if let Some(r) = ev.get("result").and_then(Value::as_str).filter(|r| !r.trim().is_empty()) {
      return slice(crate::services::util::first_line(r.trim()), 300);
    }
  }
  string_or(ev.get("subtype"), "error")
}

pub fn handle_event(key: &str, st: &mut St, ev: &Value) -> Vec<Post> {
  let ty = ev.get("type").and_then(Value::as_str).unwrap_or("");
  let sub = ev.get("subtype").and_then(Value::as_str).unwrap_or("");
  let sys = ty == "system";
  let mut post = Vec::new();
  // ---- the CLI's own status ----
  if sys && sub == "api_retry" {
    emit(st, json!({
      "key": key, "kind": "retry",
      "attempt": jnum(num_or0(ev.get("attempt"))),
      "max": jnum(num_or0(ev.get("max_retries"))),
      "delayMs": jnum(num_or0(ev.get("retry_delay_ms"))),
      "status": ev.get("error_status").filter(|v| v.is_number()).cloned().unwrap_or(Value::Null),
    }));
    return post;
  }
  if ty == "rate_limit_event" {
    let info = ev.get("rate_limit_info").filter(|v| !v.is_null()).cloned().unwrap_or(json!({}));
    let kind = info.get("rateLimitType").and_then(Value::as_str).map(str::to_string);
    let used = kind.as_ref().and_then(|k| info.get("unifiedWindows").and_then(|w| w.get(k)).and_then(|w| w.get("utilization"))).filter(|v| v.is_number()).cloned();
    let mut e = json!({ "key": key, "kind": "limit", "status": string_or(info.get("status"), "allowed") });
    if let Some(r) = info.get("resetsAt").filter(|v| v.is_number()) {
      e["resetsAt"] = r.clone();
    }
    if let Some(k) = kind {
      e["limitKind"] = json!(k);
    }
    if let Some(u) = used {
      e["utilization"] = u;
    }
    emit(st, e);
    return post;
  }
  if ty == "tool_progress" {
    // The heartbeat's own id is '<toolId>-heartbeat-0'; the tool is the parent.
    let id = match ev.get("parent_tool_use_id") {
      None | Some(Value::Null) => ev.get("tool_use_id"),
      v => v,
    };
    emit(st, json!({ "key": key, "kind": "toolProgress", "toolId": string_or(id, ""), "elapsed": jnum(num_or0(ev.get("elapsed_time_seconds"))) }));
    return post;
  }
  if sys && (sub == "hook_started" || sub == "hook_response") {
    let running = sub == "hook_started";
    let failed = !running && (ev.get("outcome").and_then(Value::as_str) == Some("error") || ev.get("exit_code").and_then(Value::as_f64).is_some_and(|c| c != 0.0));
    let error = if failed {
      let raw = [ev.get("stderr"), ev.get("output")].into_iter().find(|v| truthy(*v)).flatten().map(js_string).unwrap_or_default();
      let first = slice(crate::services::util::first_line(&raw), 200);
      json!(if first.is_empty() { "failed".to_string() } else { first })
    } else {
      Value::Null
    };
    emit(st, json!({ "key": key, "kind": "hook", "name": string_or(ev.get("hook_name"), "hook"), "event": string_or(ev.get("hook_event"), ""), "running": running, "error": error }));
    return post;
  }
  if sys && sub == "compact_boundary" {
    let meta = ev.get("compact_metadata").filter(|v| !v.is_null()).cloned().unwrap_or(json!({}));
    let mut e = json!({
      "key": key, "kind": "compact",
      "trigger": if meta.get("trigger").and_then(Value::as_str) == Some("manual") { "manual" } else { "auto" },
      "pre": jnum(num_or0(meta.get("pre_tokens"))),
    });
    if let Some(p) = meta.get("post_tokens").filter(|v| v.is_number()) {
      e["post"] = p.clone();
    }
    if let Some(d) = meta.get("duration_ms").filter(|v| v.is_number()) {
      e["durationMs"] = d.clone();
    }
    emit(st, e);
    return post;
  }
  // What the CLI is doing between messages ('compacting' matters most).
  if sys && sub == "status" {
    let mut e = json!({ "key": key, "kind": "status", "status": ev.get("status").filter(|v| v.is_string()).cloned().unwrap_or(Value::Null) });
    match ev.get("compact_result").and_then(Value::as_str) {
      Some("failed") => e["compactResult"] = json!("failed"),
      Some("success") => e["compactResult"] = json!("success"),
      _ => {}
    }
    if let Some(c) = ev.get("compact_error").filter(|v| v.is_string()) {
      e["compactError"] = c.clone();
    }
    emit(st, e);
    return post;
  }
  if sys && sub == "permission_denied" {
    let mut e = json!({ "key": key, "kind": "denied", "tool": string_or(ev.get("tool_name"), "") });
    if let Some(r) = ev.get("reason").filter(|v| v.is_string()) {
      e["reason"] = r.clone();
    }
    emit(st, e);
    return post;
  }
  if sys && sub == "init" {
    st.saw_init = true;
    st.unsent.clear();
    if let Some(id) = ev.get("session_id").and_then(Value::as_str) {
      st.session_id = Some(id.to_string());
    }
    let servers = ev.get("mcp_servers").and_then(Value::as_array);
    if let Some(list) = servers {
      post.push(Post::Remember(list.iter().map(|m| m.get("name").and_then(Value::as_str).unwrap_or("").to_string()).collect()));
    }
    let arr = |k: &str| ev.get(k).filter(|v| v.is_array()).cloned().unwrap_or(json!([]));
    emit(st, json!({
      "key": key, "kind": "init",
      "sessionId": st.session_id,
      "model": ev.get("model").filter(|v| !v.is_null()).cloned().unwrap_or(Value::Null),
      "tools": arr("tools"),
      "slashCommands": arr("slash_commands"),
      "mcpServers": arr("mcp_servers"),
    }));
    return post;
  }
  if ty == "stream_event" {
    let Some(e) = ev.get("event").filter(|v| truthy(Some(v))) else { return post };
    match e.get("type").and_then(Value::as_str).unwrap_or("") {
      "message_start" => {
        st.streamed_text = false;
        let u = e.get("message").and_then(|m| m.get("usage")).cloned().unwrap_or(json!({}));
        st.turn_out_done += st.call_out;
        st.call_out = 0.0;
        st.turn_in += num_or0(u.get("input_tokens")) + num_or0(u.get("cache_creation_input_tokens"));
        emit(st, json!({ "key": key, "kind": "usage", "input": jnum(st.turn_in), "output": jnum(st.turn_out_done), "isStart": true }));
      }
      "message_delta" => {
        // output_tokens is the running total for THIS call.
        if let Some(o) = e.get("usage").and_then(|u| u.get("output_tokens")).filter(|v| !v.is_null()) {
          st.call_out = num_or0(Some(o));
        }
        emit(st, json!({ "key": key, "kind": "usage", "input": -1, "output": jnum(st.turn_out_done + st.call_out), "isStart": false }));
      }
      "content_block_delta" => {
        if let Some(d) = e.get("delta").filter(|d| d.get("type").and_then(Value::as_str) == Some("text_delta")) {
          st.streamed_text = true;
          emit(st, json!({ "key": key, "kind": "text", "delta": d.get("text").cloned().unwrap_or(Value::Null) }));
        }
      }
      _ => {}
    }
    return post;
  }
  if ty == "assistant" {
    let content = ev.get("message").and_then(|m| m.get("content")).and_then(Value::as_array).cloned().unwrap_or_default();
    for block in &content {
      if block.get("type").and_then(Value::as_str) != Some("tool_use") {
        // Full text blocks were already streamed as text_delta.
        continue;
      }
      let name = block.get("name").map(js_string).unwrap_or_default();
      let input = block.get("input").filter(|v| !v.is_null()).cloned().unwrap_or(json!({}));
      let code = tool_code(&name, &input);
      let mut detail = tool_detail(&name, &input);
      if EDIT_TOOLS.contains(&name.as_str()) && name != "Write" && name != "NotebookEdit" {
        if let Some(c) = code.as_deref().filter(|c| !c.is_empty()) {
          let (a, r) = count_diff(c);
          if a > 0 || r > 0 {
            detail.push_str(&format!("  +{a} -{r}"));
          }
        }
      }
      emit(st, json!({
        "key": key, "kind": "tool", "name": name, "detail": detail,
        "path": tool_path(&name, &input), "code": code,
        "toolId": block.get("id").filter(|v| !v.is_null()).cloned().unwrap_or(Value::Null),
        // A subagent's own tool calls carry the Task's id, to nest them.
        "parent": ev.get("parent_tool_use_id").filter(|v| !v.is_null()).cloned().unwrap_or(Value::Null),
      }));
    }
    return post;
  }
  if ty == "user" {
    let content = ev.get("message").and_then(|m| m.get("content")).and_then(Value::as_array).cloned().unwrap_or_default();
    for block in &content {
      if block.get("type").and_then(Value::as_str) != Some("tool_result") {
        continue;
      }
      if let Some(id) = block.get("tool_use_id").and_then(Value::as_str).filter(|s| !s.is_empty()) {
        emit(st, json!({ "key": key, "kind": "toolResult", "toolId": id, "isError": block.get("is_error") == Some(&Value::Bool(true)) }));
      }
    }
    return post;
  }
  // A long thought emits nothing else: this is its only heartbeat.
  if sys && sub == "thinking_tokens" {
    emit(st, json!({ "key": key, "kind": "thinking", "tokens": jnum(num_or0(ev.get("estimated_tokens"))) }));
    return post;
  }
  if sys && sub == "background_tasks_changed" {
    let raw = ev.get("tasks").and_then(Value::as_array).cloned().unwrap_or_default();
    for t in &raw {
      if truthy(t.get("task_id")) {
        st.bg_task_ids.insert(js_string(&t["task_id"]));
      }
    }
    st.bg_running = raw.len();
    if raw.is_empty() && !st.turn_busy {
      post.push(Post::RestartIfMarked);
    }
    let tasks: Vec<Value> = raw.iter().map(|x| json!({ "id": string_or(x.get("task_id"), ""), "label": string_or(x.get("description"), "") })).collect();
    // Pane-level state, not part of any turn.
    emit(st, json!({ "key": key, "kind": "bgTasks", "tasks": tasks, "turn": null }));
    return post;
  }
  if sys && sub == "task_notification" {
    // Every tool call ends with one; only a backgrounded one is news.
    let task_id = string_or(ev.get("task_id"), "");
    if !st.bg_task_ids.remove(&task_id) {
      return post;
    }
    note_background_report(st);
    emit(st, json!({ "key": key, "kind": "taskDone", "taskId": task_id, "status": string_or(ev.get("status"), "completed"), "label": string_or(ev.get("summary"), ""), "turn": null }));
    return post;
  }
  if ty == "result" {
    st.turn_busy = false;
    // --resume of a session the CLI no longer has answers this before init and
    // exits; the exit path restarts the pane fresh.
    let resume = super::nz(&st.opts.resume).map(str::to_string);
    if let Some(r) = resume.filter(|_| !st.saw_init && sub == "error_during_execution") {
      eprintln!("[chat:{key}] resume target gone: {}", ev.get("errors").map(Value::to_string).unwrap_or_default());
      st.session_id = None;
      emit(st, json!({ "key": key, "kind": "sessionLost", "sessionId": r }));
      return post;
    }
    // A restart that waited for this turn happens after the result goes out.
    post.push(Post::RestartIfMarked);
    if let Some(id) = ev.get("session_id").and_then(Value::as_str) {
      st.session_id = Some(id.to_string());
    }
    if let Some(id) = st.session_id.clone() {
      post.push(Post::ResumeId(id));
    }
    let is_error = ev.get("is_error") == Some(&Value::Bool(true)) || (truthy(ev.get("subtype")) && ev.get("subtype").and_then(Value::as_str) != Some("success"));
    // Slash commands (/usage, /context) answer ONLY in the result.
    if !is_error && !st.streamed_text {
      if let Some(r) = ev.get("result").and_then(Value::as_str).filter(|r| !r.trim().is_empty()) {
        emit(st, json!({ "key": key, "kind": "text", "delta": r }));
      }
    }
    let turn = claim_result(st);
    st.turn_in = 0.0;
    st.turn_out_done = 0.0;
    st.call_out = 0.0;
    emit(st, json!({
      "key": key, "kind": "turnDone",
      "costUSD": ev.get("total_cost_usd").filter(|v| v.is_number()).cloned().unwrap_or(Value::Null),
      "sessionId": st.session_id,
      "error": if is_error { json!(result_error(ev)) } else { Value::Null },
      "turn": turn,
    }));
    return post;
  }
  post
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn result_errors() {
    assert_eq!(result_error(&json!({"errors": ["", "boom\nmore"]})), "boom");
    assert_eq!(result_error(&json!({"subtype": "success", "result": "You've hit your limit\nx"})), "You've hit your limit");
    assert_eq!(result_error(&json!({"subtype": "error_max_turns"})), "error_max_turns");
  }
}
