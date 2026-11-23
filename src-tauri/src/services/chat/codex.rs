// A chat pane backed by Codex (port of codexChat.ts).
//
// `codex app-server` speaks JSON-RPC over stdio, one message per line. A
// thread is a conversation (its id is what `codex resume` takes), a turn is
// one exchange, and everything inside a turn arrives as notifications. This
// turns them into the pane's own ChatEvents, so a Codex conversation renders
// exactly like a Claude one. Auth is the user's own Codex login.

use crate::services::util::{clamp, jnum, js_string, shorten};
use super::StartOpts;
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::time::Instant;
use tokio::sync::{mpsc::UnboundedSender, oneshot, watch};

// ---- mapping (pure) ------------------------------------------------------------

/// Claude's permission modes as a Codex sandbox + approval policy.
pub fn policy(mode: Option<&str>) -> (&'static str, &'static str) {
  match mode {
    Some("plan") => ("read-only", "never"),
    Some("bypassPermissions") => ("danger-full-access", "never"),
    _ => ("workspace-write", "on-request"),
  }
}

pub fn sandbox_policy(mode: Option<&str>) -> Value {
  match mode {
    Some("plan") => json!({ "type": "readOnly", "networkAccess": false }),
    Some("bypassPermissions") => json!({ "type": "dangerFullAccess" }),
    _ => json!({ "type": "workspaceWrite", "writableRoots": [], "networkAccess": false, "excludeTmpdirEnvVar": false, "excludeSlashTmp": false }),
  }
}

pub fn user_input(text: &str, images: &[super::Image]) -> Vec<Value> {
  let mut input = Vec::new();
  if !text.trim().is_empty() {
    input.push(json!({ "type": "text", "text": text, "text_elements": [] }));
  }
  for img in images {
    input.push(json!({ "type": "image", "url": format!("data:{};base64,{}", img.media_type, img.data) }));
  }
  input
}

fn diff_counts(diff: &str) -> String {
  let (mut a, mut r) = (0, 0);
  for l in diff.split('\n') {
    if l.starts_with('+') && !l.starts_with("+++") {
      a += 1;
    } else if l.starts_with('-') && !l.starts_with("---") {
      r += 1;
    }
  }
  if a > 0 || r > 0 {
    format!("  +{a} -{r}")
  } else {
    String::new()
  }
}

pub struct ToolLine {
  name: String,
  detail: String,
  path: Option<String>,
  code: Option<String>,
}

fn st(v: Option<&Value>) -> String {
  v.and_then(Value::as_str).unwrap_or("").to_string()
}

/// One item -> the tool line(s) the pane shows, in the pane's vocabulary.
pub fn tool_lines(item: &Value) -> Vec<ToolLine> {
  match item.get("type").and_then(Value::as_str).unwrap_or("") {
    "commandExecution" => {
      let command = st(item.get("command"));
      vec![ToolLine { name: "Bash".into(), detail: clamp(&command, 120), path: None, code: (!command.is_empty()).then_some(command) }]
    }
    "fileChange" => item
      .get("changes")
      .and_then(Value::as_array)
      .map(|chs| {
        chs
          .iter()
          .map(|ch| {
            let kind = ch.get("kind").and_then(|k| k.get("type")).and_then(Value::as_str);
            let mv = st(ch.get("kind").and_then(|k| k.get("move_path")));
            let file = if mv.is_empty() { st(ch.get("path")) } else { mv };
            let diff = st(ch.get("diff"));
            let add = kind == Some("add");
            ToolLine {
              name: if add { "Write".into() } else { "Edit".into() },
              detail: clamp(&shorten(&file), 120) + &if add { String::new() } else { diff_counts(&diff) },
              path: (!file.is_empty()).then_some(file),
              code: (!diff.is_empty()).then_some(diff),
            }
          })
          .collect()
      })
      .unwrap_or_default(),
    "mcpToolCall" => {
      let args = match item.get("arguments") {
        Some(v @ (Value::Object(_) | Value::Array(_) | Value::Null)) => v.to_string(),
        Some(Value::String(s)) => s.clone(),
        _ => String::new(),
      };
      vec![ToolLine { name: format!("mcp__{}__{}", st(item.get("server")), st(item.get("tool"))), detail: clamp(&args, 120), path: None, code: None }]
    }
    "webSearch" => vec![ToolLine { name: "WebSearch".into(), detail: clamp(&st(item.get("query")), 120), path: None, code: None }],
    "collabAgentToolCall" => {
      let p = st(item.get("prompt"));
      let d = if p.is_empty() { st(item.get("tool")) } else { p };
      vec![ToolLine { name: "Agent".into(), detail: clamp(&d, 120), path: None, code: None }]
    }
    _ => Vec::new(),
  }
}

/// An elicitation that only asks "may I?": a form with nothing to fill in.
pub fn is_plain_approval(params: &Value) -> bool {
  let mode = params.get("mode").and_then(Value::as_str);
  if !matches!(mode, Some("form" | "openai/form" | "openaiForm")) {
    return false;
  }
  let schema = params.get("requestedSchema");
  let props = schema.and_then(|s| s.get("properties")).and_then(Value::as_object).map(|o| o.len()).unwrap_or(0);
  let required = schema.and_then(|s| s.get("required")).and_then(Value::as_array).map(|a| a.len()).unwrap_or(0);
  props == 0 && required == 0
}

pub fn item_failed(item: &Value) -> bool {
  let status = item.get("status").and_then(Value::as_str);
  matches!(status, Some("failed" | "declined")) || item.get("exitCode").and_then(Value::as_f64).is_some_and(|c| c != 0.0)
}

const MAX_DIFF_BYTES: u64 = 2_000_000;
fn read_for_diff(p: &Path) -> Option<String> {
  let m = std::fs::metadata(p).ok()?;
  if !m.is_file() || m.len() > MAX_DIFF_BYTES {
    return None;
  }
  crate::services::fsx::read_utf8(p).ok()
}

// ---- session ------------------------------------------------------------------------

pub struct Session {
  pub key: String,
  pub pid: u32,
  pub bin: Option<String>,
  pub tx: UnboundedSender<super::claude::Msg>,
  pub exited: AtomicBool,
  seq: AtomicU64,
  pending: Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>,
  /// Whether the thread opened (None until it has tried).
  pub ready: watch::Sender<Option<bool>>,
  pub st: Mutex<St>,
}

pub struct St {
  pub sender: String,
  pub opts: StartOpts,
  pub model: Option<String>,
  pub alive: bool,
  pub thread_id: Option<String>,
  turn_id: Option<String>,
  /// riven's ids for messages still waiting on an answer, oldest first.
  pub turns: VecDeque<String>,
  pub saw_thread: bool,
  baselines: HashMap<PathBuf, Option<String>>,
  pub turn_busy: bool,
  usage_total: Option<(f64, f64)>,
  usage_at_turn: Option<(f64, f64)>,
  /// A restart deferred until this turn ends (onTurnEnd in the Node build).
  pub restart_on_turn_end: bool,
  pub last_active: Instant,
}

impl St {
  pub fn new(sender: String, opts: StartOpts) -> St {
    St {
      sender,
      model: super::nz(&opts.model).map(str::to_string),
      opts,
      alive: true,
      thread_id: None,
      turn_id: None,
      turns: VecDeque::new(),
      saw_thread: false,
      baselines: HashMap::new(),
      turn_busy: false,
      usage_total: None,
      usage_at_turn: None,
      restart_on_turn_end: false,
      last_active: Instant::now(),
    }
  }
}

fn emit(st: &St, mut ev: Value) {
  if let Some(o) = ev.as_object_mut() {
    if !o.contains_key("turn") {
      o.insert("turn".into(), st.turns.front().map(|t| json!(t)).unwrap_or(Value::Null));
    }
  }
  super::emit(&st.sender, ev);
}

impl Session {
  pub fn new(key: String, pid: u32, bin: Option<String>, tx: UnboundedSender<super::claude::Msg>, sender: String, opts: StartOpts) -> Session {
    Session {
      key,
      pid,
      bin,
      tx,
      exited: AtomicBool::new(false),
      seq: AtomicU64::new(0),
      pending: Mutex::new(HashMap::new()),
      ready: watch::channel(None).0,
      st: Mutex::new(St::new(sender, opts)),
    }
  }

  pub fn lock(&self) -> MutexGuard<'_, St> {
    self.st.lock().unwrap_or_else(|e| e.into_inner())
  }

  fn write(&self, obj: &Value) {
    if !self.lock().alive {
      return;
    }
    let _ = self.tx.send(super::claude::Msg::Line(obj.to_string() + "\n"));
  }

  async fn request(&self, method: &str, params: Value) -> Result<Value, String> {
    let id = self.seq.fetch_add(1, Ordering::SeqCst) + 1;
    let (tx, rx) = oneshot::channel();
    self.pending.lock().unwrap().insert(id, tx);
    self.write(&json!({ "id": id, "method": method, "params": params }));
    rx.await.unwrap_or_else(|_| Err("codex app-server exited".into()))
  }

  fn notify(&self, method: &str, params: Value) {
    self.write(&json!({ "method": method, "params": params }));
  }

  pub fn fail_pending(&self) {
    for (_, p) in self.pending.lock().unwrap().drain() {
      let _ = p.send(Err("codex app-server exited".into()));
    }
  }

  pub fn emit_exit(&self, code: i32) {
    let st = self.lock();
    emit(&st, json!({ "key": self.key, "kind": "exit", "code": code }));
  }

  /// initialize, then resume or start the thread. Sets `ready`.
  pub async fn open(&self, with_tools: bool, prompt: Option<String>) {
    let ok = self.open_inner(with_tools, prompt).await;
    self.ready.send_replace(Some(ok));
  }

  async fn open_inner(&self, with_tools: bool, prompt: Option<String>) -> bool {
    let r: Result<bool, String> = async {
      self.request("initialize", json!({ "clientInfo": { "name": "riven", "title": "riven", "version": "1" }, "capabilities": null })).await?;
      self.notify("initialized", json!({}));
      let (cwd, model, resume, mode, global) = {
        let st = self.lock();
        (st.opts.cwd.clone(), st.model.clone(), super::nz(&st.opts.resume).map(str::to_string), st.opts.permission_mode.clone(), st.opts.global_prompt.clone().unwrap_or_default())
      };
      let (sandbox, approval) = policy(mode.as_deref());
      let mut parts: Vec<String> = Vec::new();
      if with_tools {
        if let Some(p) = prompt {
          parts.push(p);
        }
      }
      let g = global.trim();
      if !g.is_empty() {
        parts.push(format!("# 사용자 지정 지침\n{g}"));
      }
      let instructions = if parts.is_empty() { Value::Null } else { json!(parts.join("\n\n")) };
      let common = json!({ "cwd": cwd, "model": model, "approvalPolicy": approval, "sandbox": sandbox, "developerInstructions": instructions });
      let mut res: Option<Value> = None;
      if let Some(r) = resume {
        let mut p = json!({ "threadId": r });
        p.as_object_mut().unwrap().extend(common.as_object().unwrap().clone());
        match self.request("thread/resume", p).await {
          Ok(v) => res = Some(v),
          // A thread that no longer exists: start a new one; the transcript stays.
          Err(e) => eprintln!("[codex:{}] resume failed, starting fresh: {e}", self.key),
        }
      }
      let res = match res {
        Some(r) => r,
        None => self.request("thread/start", common).await?,
      };
      let tid = res.get("thread").and_then(|t| t.get("id")).and_then(Value::as_str).map(str::to_string);
      let mut st = self.lock();
      st.thread_id = tid.clone();
      st.saw_thread = tid.is_some();
      let model = res.get("model").filter(|m| !m.is_null()).cloned().unwrap_or(Value::Null);
      emit(&st, json!({ "key": self.key, "kind": "init", "sessionId": tid, "model": model, "tools": [], "slashCommands": [], "mcpServers": [] }));
      Ok(tid.is_some())
    }
    .await;
    match r {
      Ok(ok) => ok,
      Err(e) => {
        eprintln!("[codex:{}] could not open a thread {e}", self.key);
        let st = self.lock();
        emit(&st, json!({ "key": self.key, "kind": "turnDone", "costUSD": null, "sessionId": null, "error": e }));
        false
      }
    }
  }

  /// One line from the app-server.
  pub fn on_line(&self, line: &str) {
    if line.trim().is_empty() {
      return;
    }
    let Some(msg) = crate::services::util::parse(line) else { return };
    self.lock().last_active = Instant::now();
    let method = msg.get("method").and_then(Value::as_str);
    let params = msg.get("params").filter(|p| !p.is_null()).cloned().unwrap_or(json!({}));
    match (method, msg.get("id")) {
      (Some(m), Some(id)) => self.on_server_request(id.clone(), m, &params),
      (Some(m), None) => self.on_notification(m, &params),
      (None, Some(Value::Number(n))) => {
        let Some(id) = n.as_u64() else { return };
        let Some(p) = self.pending.lock().unwrap().remove(&id) else { return };
        let r = match msg.get("error").filter(|e| !e.is_null()) {
          Some(e) => Err(e.get("message").and_then(Value::as_str).unwrap_or("codex error").to_string()),
          None => Ok(msg.get("result").cloned().unwrap_or(Value::Null)),
        };
        let _ = p.send(r);
      }
      _ => {}
    }
  }

  // Escalations are answered for the pane's own mode (it runs unattended);
  // anything riven can't answer is declined rather than left hanging.
  fn on_server_request(&self, id: Value, method: &str, params: &Value) {
    let plan = self.lock().opts.permission_mode.as_deref() == Some("plan");
    match method {
      "item/commandExecution/requestApproval" | "execCommandApproval" | "item/fileChange/requestApproval" | "applyPatchApproval" => {
        self.write(&json!({ "id": id, "result": { "decision": if plan { "decline" } else { "accept" } } }));
      }
      "mcpServer/elicitation/request" => {
        let accept = !plan && is_plain_approval(params);
        if !accept {
          eprintln!(
            "[codex:{}] declined MCP elicitation from {}: {}",
            self.key,
            crate::services::util::string_or(params.get("serverName"), "undefined"),
            crate::services::util::slice(&crate::services::util::string_or(params.get("message"), ""), 160)
          );
        }
        let result = if accept { json!({ "action": "accept", "content": {}, "_meta": null }) } else { json!({ "action": "decline", "content": null, "_meta": null }) };
        self.write(&json!({ "id": id, "result": result }));
      }
      _ => {
        eprintln!("[codex:{}] unanswered request {method} {}", self.key, crate::services::util::slice(&params.to_string(), 200));
        self.write(&json!({ "id": id, "error": { "code": -32601, "message": format!("riven does not handle {method}") } }));
      }
    }
  }

  fn turn_ended(&self, st: &mut St) {
    if st.restart_on_turn_end {
      st.restart_on_turn_end = false;
      let key = self.key.clone();
      tauri::async_runtime::spawn(async move {
        super::restart_in_place(key).await;
      });
    }
  }

  fn on_notification(&self, method: &str, params: &Value) {
    let mut st = self.lock();
    match method {
      "turn/started" => {
        st.turn_id = params.get("turn").and_then(|t| t.get("id")).and_then(Value::as_str).map(str::to_string);
        st.turn_busy = true;
        st.usage_at_turn = st.usage_total;
      }
      "item/agentMessage/delta" => {
        if let Some(d) = params.get("delta").and_then(Value::as_str) {
          emit(&st, json!({ "key": self.key, "kind": "text", "delta": d }));
        }
      }
      "item/started" => {
        let item = params.get("item").cloned().unwrap_or(json!({}));
        if item.get("type").and_then(Value::as_str) == Some("fileChange") {
          for f in self.files_of(&st, &item) {
            st.baselines.entry(f.clone()).or_insert_with(|| read_for_diff(&f));
          }
        }
        let id = item.get("id").and_then(Value::as_str).map(str::to_string);
        for (i, t) in tool_lines(&item).into_iter().enumerate() {
          let tool_id = id.as_ref().map(|id| if i == 0 { id.clone() } else { format!("{id}#{i}") });
          emit(&st, json!({ "key": self.key, "kind": "tool", "name": t.name, "detail": t.detail, "path": t.path, "code": t.code, "toolId": tool_id, "parent": null }));
        }
      }
      "item/completed" => {
        let item = params.get("item").cloned().unwrap_or(json!({}));
        let id = item.get("id").and_then(Value::as_str).map(str::to_string);
        let lines = tool_lines(&item);
        if let Some(id) = id.filter(|_| !lines.is_empty()) {
          let is_error = item_failed(&item);
          for i in 0..lines.len() {
            let tid = if i == 0 { id.clone() } else { format!("{id}#{i}") };
            emit(&st, json!({ "key": self.key, "kind": "toolResult", "toolId": tid, "isError": is_error }));
          }
        }
        if item.get("type").and_then(Value::as_str) == Some("fileChange") && !item_failed(&item) {
          self.report_edits(&mut st, &item);
        }
      }
      "thread/tokenUsage/updated" => {
        let usage = params.get("tokenUsage");
        // New input only: cached input is not sent again.
        let norm = |u: &Value| {
          let g = |k: &str| u.get(k).and_then(Value::as_f64).unwrap_or(0.0);
          (g("inputTokens") - g("cachedInputTokens"), g("outputTokens"))
        };
        if let Some(total) = usage.and_then(|u| u.get("total")).filter(|t| crate::services::util::truthy(Some(t))) {
          let total = norm(total);
          if st.usage_at_turn.is_none() {
            let last = usage.and_then(|u| u.get("last")).filter(|t| crate::services::util::truthy(Some(t))).map(norm).unwrap_or((0.0, 0.0));
            st.usage_at_turn = Some((total.0 - last.0, total.1 - last.1));
          }
          st.usage_total = Some(total);
          let at = st.usage_at_turn.unwrap();
          emit(&st, json!({ "key": self.key, "kind": "usage", "input": jnum((total.0 - at.0).max(0.0)), "output": jnum((total.1 - at.1).max(0.0)), "isStart": false }));
        }
      }
      "turn/completed" => {
        let turn = params.get("turn").cloned().unwrap_or(json!({}));
        st.turn_busy = false;
        self.turn_ended(&mut st);
        st.turn_id = None;
        // Ends the oldest message still waiting.
        let mine = st.turns.pop_front();
        let error = match turn.get("status").and_then(Value::as_str) {
          Some("failed") => json!(turn.get("error").and_then(|e| e.get("message")).filter(|m| !m.is_null()).map(js_string).unwrap_or_else(|| "failed".into())),
          Some("interrupted") => json!("interrupted"),
          _ => Value::Null,
        };
        let tid = st.thread_id.clone();
        emit(&st, json!({ "key": self.key, "kind": "turnDone", "costUSD": null, "sessionId": tid, "turn": mine, "error": error }));
      }
      "error" => {
        let retry = params.get("willRetry").and_then(Value::as_bool).unwrap_or(false);
        if let Some(m) = params.get("error").and_then(|e| e.get("message")).and_then(Value::as_str).filter(|m| !m.is_empty()) {
          if !retry {
            eprintln!("[codex:{}] error: {m}", self.key);
          }
        }
      }
      _ => {}
    }
  }

  fn files_of(&self, st: &St, item: &Value) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for ch in item.get("changes").and_then(Value::as_array).cloned().unwrap_or_default() {
      for p in [ch.get("path"), ch.get("kind").and_then(|k| k.get("move_path"))] {
        let Some(p) = p.and_then(Value::as_str).filter(|p| !p.is_empty()) else { continue };
        let p = Path::new(p);
        out.push(if p.is_absolute() { p.to_path_buf() } else { crate::services::fsx::resolve(Path::new(&st.opts.cwd), p) });
      }
    }
    out
  }

  fn report_edits(&self, st: &mut St, item: &Value) {
    for f in self.files_of(st, item) {
      let saw = st.baselines.contains_key(&f);
      let before = st.baselines.remove(&f).flatten();
      let Some(after) = read_for_diff(&f) else { continue };
      // An unchanged "baseline" is not a before; the diff falls back to git.
      let known = if saw && before.as_deref() != Some(after.as_str()) { before } else { None };
      let path = f.to_string_lossy().into_owned();
      // Into the changes timeline, like a hook-reported edit (services/mcp).
      super::report_edit(json!({ "pane": self.key, "path": path, "before": known, "after": after }));
      emit(st, json!({ "key": self.key, "kind": "fileEdited", "path": path }));
    }
  }

  // ---- pane actions ----

  pub async fn send(&self, text: String, images: Vec<super::Image>, turn: Option<String>) {
    {
      let mut st = self.lock();
      st.last_active = Instant::now();
      st.turn_busy = true;
      // A message sent mid-turn steers the running one: it takes that slot.
      if let Some(t) = &turn {
        if st.turn_id.is_some() && !st.turns.is_empty() {
          st.turns[0] = t.clone();
        } else {
          st.turns.push_back(t.clone());
        }
      }
    }
    let mut rx = self.ready.subscribe();
    let ok = loop {
      if let Some(v) = *rx.borrow_and_update() {
        break v;
      }
      if rx.changed().await.is_err() {
        break false;
      }
    };
    let thread = self.lock().thread_id.clone();
    let Some(thread) = thread.filter(|_| ok) else {
      let mut st = self.lock();
      st.turn_busy = false;
      self.turn_ended(&mut st);
      let t = st.turns.pop_back();
      emit(&st, json!({ "key": self.key, "kind": "turnDone", "costUSD": null, "sessionId": null, "error": "codex thread not open", "turn": t }));
      return;
    };
    let input = user_input(&text, &images);
    if input.is_empty() {
      let mut st = self.lock();
      st.turn_busy = false;
      self.turn_ended(&mut st);
      if let Some(t) = &turn {
        st.turns.retain(|x| x != t);
      }
      return;
    }
    let (turn_id, model, mode) = {
      let st = self.lock();
      (st.turn_id.clone(), st.model.clone(), st.opts.permission_mode.clone())
    };
    let r = match turn_id {
      Some(tid) => self.request("turn/steer", json!({ "threadId": thread, "expectedTurnId": tid, "input": input })).await,
      None => {
        self
          .request(
            "turn/start",
            json!({ "threadId": thread, "input": input, "model": model, "approvalPolicy": policy(mode.as_deref()).1, "sandboxPolicy": sandbox_policy(mode.as_deref()) }),
          )
          .await
      }
    };
    if let Err(e) = r {
      let mut st = self.lock();
      st.turn_busy = false;
      self.turn_ended(&mut st);
      let t = st.turns.pop_back();
      let tid = st.thread_id.clone();
      emit(&st, json!({ "key": self.key, "kind": "turnDone", "costUSD": null, "sessionId": tid, "error": e, "turn": t }));
    }
  }

  pub fn interrupt(self: &std::sync::Arc<Self>) {
    let (t, tu) = {
      let st = self.lock();
      (st.thread_id.clone(), st.turn_id.clone())
    };
    if let (Some(t), Some(tu)) = (t, tu) {
      let me = self.clone();
      tauri::async_runtime::spawn(async move {
        let _ = me.request("turn/interrupt", json!({ "threadId": t, "turnId": tu })).await;
      });
    }
  }

  pub fn set_model(&self, model: &str) {
    self.lock().model = (!model.is_empty() && model != "default").then(|| model.to_string());
  }

  pub fn set_mode(&self, mode: &str) {
    self.lock().opts.permission_mode = Some(mode.to_string());
  }

  pub fn stop(&self) {
    self.lock().alive = false;
    let _ = self.tx.send(super::claude::Msg::Close);
    if !self.exited.load(Ordering::SeqCst) {
      crate::services::util::sigterm(self.pid);
    }
  }

  /// The same options, resuming the thread it is in.
  pub fn restart_opts(&self) -> StartOpts {
    let st = self.lock();
    let mut o = st.opts.clone();
    o.model = st.model.clone();
    o.resume = st.thread_id.clone().or_else(|| o.resume.clone());
    o
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn mapping() {
    assert_eq!(policy(Some("plan")), ("read-only", "never"));
    let item = json!({"type": "fileChange", "id": "x", "changes": [{"path": "/a/b.ts", "kind": {"type": "update"}, "diff": "+a\n-b\n+++ x"}]});
    let l = tool_lines(&item);
    assert_eq!(l[0].name, "Edit");
    assert_eq!(l[0].detail, "/a/b.ts  +1 -1");
    assert!(is_plain_approval(&json!({"mode": "form", "requestedSchema": {"properties": {}}})));
    assert!(item_failed(&json!({"exitCode": 2})));
  }
}
