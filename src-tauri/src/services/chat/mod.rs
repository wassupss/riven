// Agent chat: Claude Code and Codex CLIs behind the chat panes. Port of
// src/main/agentChat.ts + codexChat.ts and the helpers only they used
// (mcpServers, mcpRepair, sessionProbe, sessionScan, sessionTitle, turnClaim,
// resultError, cliArgs, chatContent).
//
// One CLI child per pane, keyed by the pane's stable key, living in this
// process (it survives page reloads; it dies on an explicit stop, the idle
// park, or quit). Events go to the page that started (or last reattached) the
// pane as 'chat:event' on the ordinary 'riven:ipc' event: a chat stream is a
// few KB per turn, not the pty's megabytes.
//
// riven's MCP config, tool prompt and hook env for a pane come from
// services/mcp, and so does the changes timeline a Codex pane's file edits go
// to.

pub mod claude;
mod cli;
pub mod codex;
pub(crate) mod history;
pub(crate) mod mcp;
mod tools;
pub mod util;

use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};
use tauri::AppHandle;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt};

pub use cli::UpdateState;
pub use history::{read_codex_session_title, SessionSummary};
pub use mcp::SessionInfo;

#[derive(Deserialize, Clone, Default, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct StartOpts {
  pub cwd: String,
  pub resume: Option<String>,
  /// Resume into a copy (--fork-session).
  pub fork: Option<bool>,
  pub model: Option<String>,
  pub permission_mode: Option<String>,
  /// riven's own tools the user switched off.
  pub mcp_disabled: Option<Vec<String>>,
  /// Whole MCP servers riven's agents may not use unasked.
  pub mcp_servers_disabled: Option<Vec<String>>,
  pub global_prompt: Option<String>,
  pub agent: Option<String>,
  pub config_dir: Option<String>,
  pub cli: Option<String>,
  pub tools_denied: Option<Vec<String>>,
  pub autocompact: Option<String>,
}

/// A JS-truthy string option.
pub fn nz(v: &Option<String>) -> Option<&str> {
  v.as_deref().filter(|s| !s.is_empty())
}

// ---- page side --------------------------------------------------------------------

static APP: OnceLock<AppHandle> = OnceLock::new();

pub fn emit(label: &str, ev: Value) {
  if let Some(app) = APP.get() {
    crate::commands::emit_ipc(app, label, "chat:event", json!([ev]));
  }
}

/// webContents.send to every app window (BrowserWindow.getAllWindows).
pub fn broadcast(ch: &str, payload: Value) {
  use tauri::Manager;
  let Some(app) = APP.get() else { return };
  for label in app.webview_windows().keys() {
    if crate::commands::app_page(label) {
      crate::commands::emit_ipc(app, label, ch, json!([payload]));
    }
  }
}

// ---- images (chatContent.ts) --------------------------------------------------------

pub struct Image {
  pub media_type: String,
  pub data: String,
}

const IMAGE_TYPES: [&str; 4] = ["image/png", "image/jpeg", "image/gif", "image/webp"];
const MAX_IMAGE_BASE64: usize = 5 * 1024 * 1024 * 4 / 3;

/// The usable images out of what the page sent (anything else is dropped,
/// as isUsableImage did).
pub fn usable_images(raw: Option<Vec<Value>>) -> Vec<Image> {
  raw
    .unwrap_or_default()
    .into_iter()
    .filter_map(|v| {
      let data = v.get("data")?.as_str()?;
      let mt = v.get("mediaType")?.as_str()?;
      (!data.is_empty() && data.len() <= MAX_IMAGE_BASE64 && IMAGE_TYPES.contains(&mt)).then(|| Image { media_type: mt.into(), data: data.into() })
    })
    .collect()
}

/// A plain string when there is nothing to attach, else content blocks.
fn user_content(text: &str, images: &[Image]) -> Value {
  if images.is_empty() {
    return json!(text);
  }
  let mut blocks = Vec::new();
  if !text.trim().is_empty() {
    blocks.push(json!({ "type": "text", "text": text }));
  }
  for img in images {
    blocks.push(json!({ "type": "image", "source": { "type": "base64", "media_type": img.media_type, "data": img.data } }));
  }
  Value::Array(blocks)
}

// ---- riven's MCP server and hooks (services/mcp) ----------------------------------------

/// riven's MCP config, prompt and hook env for a pane. kind: 'claude' |
/// 'codex' | 'probe'.
pub fn mcp_env(kind: &str, key: &str, disabled: &[String]) -> Value {
  crate::services::mcp::chat_env(kind, key, disabled)
}

pub fn report_edit(edit: Value) {
  crate::services::mcp::hooks::report_edit(edit);
}

/// Panes whose agent is mid-turn: what quitting would cut off (Node's quit
/// confirmation asks).
pub fn running_count() -> usize {
  let (c, x) = {
    let r = reg();
    (r.claude.values().cloned().collect::<Vec<_>>(), r.codex.values().cloned().collect::<Vec<_>>())
  };
  c.iter().filter(|s| s.lock().turn_busy).count() + x.iter().filter(|s| s.lock().turn_busy).count()
}

// ---- registry ---------------------------------------------------------------------------

#[derive(Default)]
struct Reg {
  claude: HashMap<String, Arc<claude::Session>>,
  codex: HashMap<String, Arc<codex::Session>>,
  /// What each pane was last started with: a message for a pane whose child
  /// is gone starts it again instead of being dropped.
  last_start: HashMap<String, (StartOpts, String)>,
  /// Idle-parked panes: the next message respawns them with --resume.
  parked: HashMap<String, (StartOpts, String)>,
  /// Panes waiting for their turn to end before getting the new CLI.
  restart_when_idle: HashSet<String>,
}

// Lock order: the registry is never held while a session's state is locked
// the other way round (callers clone the Arcs and release it first).
fn reg() -> MutexGuard<'static, Reg> {
  static R: OnceLock<Mutex<Reg>> = OnceLock::new();
  R.get_or_init(Default::default).lock().unwrap_or_else(|e| e.into_inner())
}

// 15 minutes: a parked pane costs one --resume to bring back, an idle CLI
// ~130MB. RIVEN_CHAT_IDLE_PARK_MS shortens it for testing.
fn idle_park() -> Duration {
  let ms = std::env::var("RIVEN_CHAT_IDLE_PARK_MS").ok().and_then(|v| v.parse::<u64>().ok()).filter(|v| *v > 0).unwrap_or(15 * 60_000);
  Duration::from_millis(ms)
}

pub fn init(app: &AppHandle) {
  let _ = APP.set(app.clone());
  let park = idle_park();
  let every = Duration::from_millis((park.as_millis() as u64 / 2).clamp(2_000, 60_000));
  tauri::async_runtime::spawn(async move {
    let mut t = tokio::time::interval(every);
    t.tick().await;
    loop {
      t.tick().await;
      reap_idle(park);
    }
  });
}

pub type Started = Value;

fn ok() -> Started {
  json!({ "ok": true })
}
fn err(e: impl Into<String>) -> Started {
  json!({ "ok": false, "error": e.into() })
}

type BoxFut<T> = Pin<Box<dyn Future<Output = T> + Send>>;

pub fn start(key: String, opts: StartOpts, label: String) -> BoxFut<Started> {
  Box::pin(async move {
    if opts.cli.as_deref() == Some("codex") {
      start_codex(key, opts, label).await
    } else {
      start_claude(key, opts, label).await
    }
  })
}

const DEFAULT_ALLOWED: &str = "Task,Read,Grep,Glob,LS,Edit,Write,MultiEdit,NotebookEdit,Bash,BashOutput,WebFetch,WebSearch,TodoWrite";

/// The allow-list minus what the user held back (not forbidden: the CLI asks).
pub(crate) fn allowed_base(denied: &Option<Vec<String>>) -> String {
  match denied.as_ref().filter(|d| !d.is_empty()) {
    None => DEFAULT_ALLOWED.into(),
    Some(off) => DEFAULT_ALLOWED.split(',').filter(|n| !off.iter().any(|o| o == n)).collect::<Vec<_>>().join(","),
  }
}

/// --autocompact: 'auto' passes nothing; outside 100K-1M is dropped (the CLI
/// would refuse to start).
pub(crate) fn autocompact_arg(v: Option<&str>) -> Option<String> {
  let v = v.unwrap_or("").trim().to_lowercase();
  if v.is_empty() || v == "auto" {
    return None;
  }
  let re = regex::Regex::new(r"^(\d+(?:\.\d+)?)(k|m)?$").unwrap();
  let m = re.captures(&v)?;
  let mul = match m.get(2).map(|x| x.as_str()) {
    Some("m") => 1_000_000.0,
    Some("k") => 1_000.0,
    _ => 1.0,
  };
  let n = (m[1].parse::<f64>().ok()? * mul).round();
  (100_000.0..=1_000_000.0).contains(&n).then(|| format!("{}", n as i64))
}

fn spawn_writer(mut stdin: tokio::process::ChildStdin) -> tokio::sync::mpsc::UnboundedSender<claude::Msg> {
  let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<claude::Msg>();
  tauri::async_runtime::spawn(async move {
    while let Some(m) = rx.recv().await {
      match m {
        claude::Msg::Line(l) => {
          if stdin.write_all(l.as_bytes()).await.is_err() {
            break;
          }
        }
        claude::Msg::Close => break,
      }
    }
    // dropping stdin = stdin.end()
  });
  tx
}

fn log_stderr(tag: String, err: tokio::process::ChildStderr, max: usize) {
  tauri::async_runtime::spawn(async move {
    let mut r = tokio::io::BufReader::new(err);
    let mut buf = Vec::new();
    loop {
      buf.clear();
      match r.read_until(b'\n', &mut buf).await {
        Ok(0) | Err(_) => break,
        Ok(_) => {
          let l = String::from_utf8_lossy(&buf);
          let l = l.trim();
          if !l.is_empty() {
            eprintln!("[{tag}] {}", util::slice(l, max));
          }
        }
      }
    }
  });
}

/// Complete lines from a child's stdout (a trailing partial line at EOF is
/// dropped, as the Node buffer did).
async fn each_line(out: tokio::process::ChildStdout, mut f: impl FnMut(&str)) {
  let mut r = tokio::io::BufReader::with_capacity(64 * 1024, out);
  let mut buf = Vec::new();
  loop {
    buf.clear();
    match r.read_until(b'\n', &mut buf).await {
      Ok(0) | Err(_) => break,
      Ok(n) if buf[n - 1] == b'\n' => f(&String::from_utf8_lossy(&buf[..n - 1])),
      Ok(_) => break,
    }
  }
}

async fn start_claude(key: String, opts: StartOpts, label: String) -> Started {
  let existing = reg().claude.get(&key).cloned();
  if let Some(s) = existing {
    {
      let mut st = s.lock();
      st.sender = label; // reattach after a reload
      st.last_active = Instant::now();
    }
    // An updated CLI replaces the old build in place, resuming.
    let now = util::bin_identity(util::resolve_bin("claude").await.as_deref()).await;
    if matches!((&s.bin, &now), (Some(b), Some(n)) if b != n) {
      tauri::async_runtime::spawn(restart_in_place(key));
    }
    return ok();
  }
  // Starting explicitly supersedes a parked child.
  reg().parked.remove(&key);
  let disabled = opts.mcp_disabled.clone().unwrap_or_default();
  let renv = mcp_env("claude", &key, &disabled);
  let Some(cmd) = util::resolve_bin("claude").await else { return err("claude CLI not found on PATH") };

  let mut args: Vec<String> = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--include-hook-events", "--permission-mode"]
    .iter()
    .map(|s| s.to_string())
    .collect();
  args.push(nz(&opts.permission_mode).unwrap_or("acceptEdits").to_string());
  // Every MCP server this project has, allowed by name (a pane cannot answer
  // a permission prompt).
  let prefix = renv.get("prefix").and_then(Value::as_str).unwrap_or("mcp__riven").to_string();
  let external = mcp::configured_mcp_servers(&opts.cwd, nz(&opts.config_dir)).await;
  args.push("--allowedTools".into());
  args.push(mcp::allowed_tools_value(&allowed_base(&opts.tools_denied), &prefix, &external, &opts.mcp_servers_disabled.clone().unwrap_or_default()));
  if !external.is_empty() {
    eprintln!("[chat:{key}] mcp servers allowed: {}", external.join(", "));
  }
  let enabled = renv.get("enabled").and_then(Value::as_u64).unwrap_or(0);
  let mcp_config = renv.get("mcpConfig").and_then(Value::as_str).map(str::to_string);
  if let Some(c) = &mcp_config {
    args.push("--mcp-config".into());
    args.push(c.clone());
  } else if enabled > 0 {
    eprintln!("[chat:{key}] starting WITHOUT riven MCP (no loopback server)");
  }
  let global = opts.global_prompt.as_deref().unwrap_or("").trim().to_string();
  let mut parts: Vec<String> = Vec::new();
  if mcp_config.is_some() {
    if let Some(p) = renv.get("prompt").and_then(Value::as_str) {
      parts.push(p.to_string());
    }
  }
  if !global.is_empty() {
    parts.push(format!("# 사용자 지정 지침\n{global}"));
  }
  if !parts.is_empty() {
    args.push("--append-system-prompt".into());
    args.push(parts.join("\n\n"));
  }
  if let Some(m) = nz(&opts.model).filter(|m| *m != "default") {
    args.push("--model".into());
    args.push(m.into());
  }
  if let Some(a) = nz(&opts.agent) {
    args.push("--agent".into());
    args.push(a.into());
  }
  if let Some(ac) = autocompact_arg(opts.autocompact.as_deref()) {
    args.push("--autocompact".into());
    args.push(ac);
  }
  // No resume id means a NEW conversation: say so, or the CLI continues the
  // cwd's most recent one.
  if let Some(r) = nz(&opts.resume) {
    args.push("--resume".into());
    args.push(r.into());
    if opts.fork == Some(true) {
      args.push("--fork-session".into());
    }
  } else {
    args.push("--session-id".into());
    args.push(util::uuid());
  }
  let env_map = |k: &str| renv.get(k).and_then(Value::as_object).cloned().unwrap_or_default();
  let hooks = env_map("hooks");
  if let Some(s) = hooks.get("RIVEN_HOOKS_SETTINGS").and_then(Value::as_str) {
    args.push("--settings".into());
    args.push(s.into());
  }
  let mut c = tokio::process::Command::new(&cmd);
  c.args(&args).current_dir(&opts.cwd).env("PATH", util::login_path());
  for (k, v) in env_map("agentEnv").iter().chain(hooks.iter()) {
    if let Some(v) = v.as_str() {
      c.env(k, v);
    }
  }
  c.env("RIVEN_CHAT_KEY", &key);
  if let Some(d) = nz(&opts.config_dir) {
    c.env("CLAUDE_CONFIG_DIR", d);
    mcp::ensure_profile_plugins(d).await;
  }
  c.stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped());
  let mut child = match c.spawn() {
    Ok(ch) => ch,
    Err(e) => return err(e.to_string()),
  };
  let pid = child.id().unwrap_or(0);
  let tx = spawn_writer(child.stdin.take().unwrap());
  let bin = util::bin_identity(Some(&cmd)).await;
  let s = Arc::new(claude::Session { key: key.clone(), pid, bin, tx, exited: false.into(), st: Mutex::new(claude::St::new(label.clone(), opts.clone())) });
  {
    let mut r = reg();
    r.claude.insert(key.clone(), s.clone());
    r.last_start.insert(key.clone(), (opts.clone(), label.clone()));
  }
  log_stderr(format!("chat:{key}"), child.stderr.take().unwrap(), usize::MAX);
  let stdout = child.stdout.take().unwrap();
  let s2 = s.clone();
  let reader = tauri::async_runtime::spawn(async move {
    each_line(stdout, |line| {
      if line.trim().is_empty() {
        return;
      }
      let Some(ev) = util::parse(line) else {
        s2.lock().last_active = Instant::now();
        return;
      };
      let posts = {
        let mut st = s2.lock();
        st.last_active = Instant::now();
        claude::handle_event(&s2.key, &mut st, &ev)
      };
      for p in posts {
        run_post(&s2, p);
      }
    })
    .await
  });
  tauri::async_runtime::spawn(async move {
    let code = child.wait().await.ok().and_then(|st| st.code()).unwrap_or(0);
    s.exited.store(true, Ordering::SeqCst);
    let _ = tokio::time::timeout(Duration::from_secs(2), reader).await;
    claude_exited(s, code).await;
  });
  ok()
}

fn run_post(s: &Arc<claude::Session>, p: claude::Post) {
  match p {
    claude::Post::Remember(names) => {
      let (cwd, cd) = {
        let st = s.lock();
        (st.opts.cwd.clone(), st.opts.config_dir.clone())
      };
      mcp::remember_session_servers(&cwd, nz(&cd), &names);
    }
    claude::Post::RestartIfMarked => {
      if reg().restart_when_idle.contains(&s.key) {
        tauri::async_runtime::spawn(restart_in_place(s.key.clone()));
      }
    }
    claude::Post::ResumeId(id) => {
      if let Some(prev) = reg().last_start.get_mut(&s.key) {
        prev.0.resume = Some(id);
      }
    }
  }
}

async fn claude_exited(s: Arc<claude::Session>, code: i32) {
  s.lock().alive = false;
  // The pane may already have a NEW child (restart): only clear our own.
  let mine = {
    let mut r = reg();
    if r.claude.get(&s.key).is_some_and(|x| Arc::ptr_eq(x, &s)) {
      r.claude.remove(&s.key);
      true
    } else {
      false
    }
  };
  if !mine {
    return;
  }
  let (parking, saw_init, opts, sender, unsent) = {
    let mut st = s.lock();
    (st.parking, st.saw_init, st.opts.clone(), st.sender.clone(), std::mem::take(&mut st.unsent))
  };
  // Parked by the idle reaper: the pane is still open.
  if parking {
    return;
  }
  // --resume of a stale session that never reached init: start fresh once,
  // keeping the visible transcript, and hand it the unsent messages.
  if nz(&opts.resume).is_some() && !saw_init {
    eprintln!("[chat:{}] resume failed (stale session), starting fresh", s.key);
    let mut fresh = opts.clone();
    fresh.resume = None;
    let key = s.key.clone();
    start(key.clone(), fresh, sender).await;
    let revived = reg().claude.get(&key).cloned();
    if let Some(f) = revived {
      for (line, turn) in unsent {
        f.deliver(line, Some(turn));
      }
    }
    return;
  }
  let st = s.lock();
  claude::emit(&st, json!({ "key": s.key, "kind": "exit", "code": code }));
}

async fn start_codex(key: String, opts: StartOpts, label: String) -> Started {
  let existing = reg().codex.get(&key).cloned();
  if let Some(x) = existing {
    x.lock().sender = label;
    tauri::async_runtime::spawn(async move {
      let now = util::bin_identity(util::resolve_bin("codex").await.as_deref()).await;
      if matches!((&x.bin, &now), (Some(b), Some(n)) if b != n) {
        restart_in_place(x.key.clone()).await;
      }
    });
    return ok();
  }
  let disabled = opts.mcp_disabled.clone().unwrap_or_default();
  let renv = mcp_env("codex", &key, &disabled);
  let Some(cmd) = util::resolve_bin("codex").await else { return err("codex CLI not found on PATH") };
  let bin = util::bin_identity(Some(&cmd)).await;
  let url = renv.get("url").and_then(Value::as_str).map(str::to_string);
  let mut args: Vec<String> = Vec::new();
  if let Some(u) = &url {
    let timeout = renv.get("timeoutSec").and_then(Value::as_i64).unwrap_or(1800);
    for a in [
      format!("mcp_servers.riven.url={}", serde_json::to_string(u).unwrap_or_default()),
      "mcp_servers.riven.bearer_token_env_var=\"RIVEN_MCP_TOKEN\"".into(),
      format!("mcp_servers.riven.tool_timeout_sec={timeout}"),
      // A chat pane has nobody to ask; riven's own tools confirm where it matters.
      "mcp_servers.riven.default_tools_approval_mode=\"approve\"".into(),
    ] {
      args.push("-c".into());
      args.push(a);
    }
  }
  args.push("app-server".into());
  let mut c = tokio::process::Command::new(&cmd);
  c.args(&args).current_dir(&opts.cwd).env("PATH", util::login_path());
  c.env("RIVEN_MCP_TOKEN", renv.get("token").and_then(Value::as_str).unwrap_or(""));
  c.env("RIVEN_CHAT_KEY", &key);
  c.stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped());
  let mut child = match c.spawn() {
    Ok(ch) => ch,
    Err(e) => return err(e.to_string()),
  };
  let pid = child.id().unwrap_or(0);
  let tx = spawn_writer(child.stdin.take().unwrap());
  let x = Arc::new(codex::Session::new(key.clone(), pid, bin, tx, label, opts));
  reg().codex.insert(key.clone(), x.clone());
  log_stderr(format!("codex:{key}"), child.stderr.take().unwrap(), 500);
  let stdout = child.stdout.take().unwrap();
  let x2 = x.clone();
  let reader = tauri::async_runtime::spawn(async move { each_line(stdout, |l| x2.on_line(l)).await });
  let x3 = x.clone();
  tauri::async_runtime::spawn(async move {
    let code = child.wait().await.ok().and_then(|st| st.code()).unwrap_or(0);
    x3.exited.store(true, Ordering::SeqCst);
    let _ = tokio::time::timeout(Duration::from_secs(2), reader).await;
    x3.lock().alive = false;
    x3.fail_pending();
    {
      let mut r = reg();
      if r.codex.get(&x3.key).is_some_and(|y| Arc::ptr_eq(y, &x3)) {
        r.codex.remove(&x3.key);
      }
    }
    x3.emit_exit(code);
  });
  let prompt = renv.get("prompt").and_then(Value::as_str).map(str::to_string);
  let x4 = x.clone();
  tauri::async_runtime::spawn(async move { x4.open(url.is_some(), prompt).await });
  ok()
}

// ---- pane actions ---------------------------------------------------------------------------

pub fn send(label: String, key: String, text: String, images: Option<Vec<Value>>, turn: Option<String>) {
  let images = usable_images(images);
  let codex = reg().codex.get(&key).cloned();
  if let Some(x) = codex {
    tauri::async_runtime::spawn(async move { x.send(text, images, turn).await });
    return;
  }
  let line = json!({ "type": "user", "message": { "role": "user", "content": user_content(&text, &images) }, "parent_tool_use_id": null });
  let s = reg().claude.get(&key).cloned();
  if let Some(s) = s {
    s.deliver(line, turn);
    return;
  }
  // Parked while idle, or gone: respawn (resuming) and deliver, so a message
  // is never silently dropped.
  let p = {
    let r = reg();
    r.parked.get(&key).or_else(|| r.last_start.get(&key)).cloned()
  };
  let Some((opts, _)) = p else {
    emit(&label, json!({ "key": key, "kind": "turnDone", "costUSD": null, "sessionId": null, "error": "no agent for this pane", "turn": turn }));
    return;
  };
  reg().parked.remove(&key);
  tauri::async_runtime::spawn(async move {
    start(key.clone(), opts, label).await;
    let revived = reg().claude.get(&key).cloned();
    if let Some(s) = revived {
      s.deliver(line, turn);
    }
  });
}

pub fn alive(key: &str) -> Value {
  let (c, x, revivable) = {
    let r = reg();
    (r.claude.get(key).cloned(), r.codex.get(key).cloned(), r.parked.contains_key(key) || r.last_start.contains_key(key))
  };
  if let Some(s) = c {
    let st = s.lock();
    return json!({ "alive": st.alive, "running": st.turn_busy });
  }
  if let Some(x) = x {
    return json!({ "alive": true, "running": x.lock().turn_busy });
  }
  json!({ "alive": revivable, "running": false })
}

pub fn interrupt(key: &str) {
  let (c, x) = {
    let r = reg();
    (r.claude.get(key).cloned(), r.codex.get(key).cloned())
  };
  if let Some(x) = x {
    x.interrupt();
  }
  if let Some(s) = c {
    s.lock().last_active = Instant::now();
    s.control('i', json!({ "subtype": "interrupt" }));
  }
}

pub fn set_model(key: &str, model: &str) {
  let (c, x) = {
    let r = reg();
    (r.claude.get(key).cloned(), r.codex.get(key).cloned())
  };
  if let Some(x) = x {
    x.set_model(model);
  }
  if let Some(s) = c {
    s.control('m', json!({ "subtype": "set_model", "model": model }));
  }
}

pub fn set_mode(key: &str, mode: &str) {
  let (c, x) = {
    let r = reg();
    (r.claude.get(key).cloned(), r.codex.get(key).cloned())
  };
  if let Some(x) = x {
    x.set_mode(mode);
  }
  // riven's "auto" is a riven-side policy; the CLI's name is "default".
  if let Some(s) = c {
    s.control('m', json!({ "subtype": "set_permission_mode", "mode": if mode == "auto" { "default" } else { mode } }));
  }
}

/// The pane is gone: forget how to revive it too.
pub fn stop(key: &str) {
  reg().last_start.remove(key);
  stop_session(key);
}

fn stop_session(key: &str) {
  let (x, c) = {
    let mut r = reg();
    r.parked.remove(key);
    r.restart_when_idle.remove(key);
    (r.codex.remove(key), r.claude.remove(key))
  };
  if let Some(x) = x {
    x.stop();
  }
  if let Some(s) = c {
    s.lock().alive = false;
    let _ = s.tx.send(claude::Msg::Close);
    s.kill();
  }
}

/// Replace the process behind a pane with the installed CLI, resuming the same
/// conversation. A pane mid-turn (or with background tasks) is marked and
/// restarted when that ends.
pub fn restart_in_place(key: String) -> BoxFut<&'static str> {
  Box::pin(async move {
    let (c, x) = {
      let r = reg();
      (r.claude.get(&key).cloned(), r.codex.get(&key).cloned())
    };
    if let Some(s) = c {
      let (busy, opts, sender) = {
        let st = s.lock();
        let mut o = st.opts.clone();
        o.resume = st.session_id.clone().or(o.resume);
        (st.turn_busy || st.bg_running > 0, o, st.sender.clone())
      };
      if busy {
        reg().restart_when_idle.insert(key);
        return "deferred";
      }
      reg().restart_when_idle.remove(&key);
      // Not an ending: its exit must not reach the page.
      s.lock().parking = true;
      stop_session(&key);
      let res = start(key, opts, sender).await;
      return if res["ok"] == true { "restarted" } else { "none" };
    }
    let Some(x) = x else { return "none" };
    if x.lock().turn_busy {
      reg().restart_when_idle.insert(key);
      x.lock().restart_on_turn_end = true;
      return "deferred";
    }
    reg().restart_when_idle.remove(&key);
    let mut opts = x.restart_opts();
    opts.cli = Some("codex".into());
    let sender = x.lock().sender.clone();
    stop_session(&key);
    let res = start_codex(key, opts, sender).await;
    if res["ok"] == true {
      "restarted"
    } else {
      "none"
    }
  })
}

pub async fn restart(key: Option<String>) -> Value {
  let keys: Vec<String> = match key {
    Some(k) => vec![k],
    None => {
      let r = reg();
      r.claude.keys().chain(r.codex.keys()).cloned().collect()
    }
  };
  let (mut restarted, mut busy) = (0, 0);
  for k in keys {
    match restart_in_place(k).await {
      "restarted" => restarted += 1,
      "deferred" => busy += 1,
      _ => {}
    }
  }
  json!({ "restarted": restarted, "busy": busy })
}

/// Park every pane quiet past the threshold (never mid-turn, never with a
/// background task running, never before init: nothing to resume from).
fn reap_idle(park: Duration) {
  let all: Vec<Arc<claude::Session>> = reg().claude.values().cloned().collect();
  for s in all {
    let entry = {
      let mut st = s.lock();
      let Some(sid) = st.session_id.clone() else { continue };
      if st.turn_busy || st.bg_running > 0 || st.last_active.elapsed() < park {
        continue;
      }
      st.parking = true;
      let mut o = st.opts.clone();
      o.resume = Some(sid);
      (o, st.sender.clone())
    };
    eprintln!("[chat:{}] idle, parking its CLI", s.key);
    stop_session(&s.key);
    reg().parked.insert(s.key.clone(), entry);
  }
}

pub fn open_agents(cmd: &str) -> u32 {
  let r = reg();
  (if cmd == "codex" { r.codex.len() } else { r.claude.len() }) as u32
}

/// Quit: kill every CLI child, or they outlive the app holding memory.
pub fn shutdown() {
  let (x, c) = {
    let mut r = reg();
    r.parked.clear();
    (r.codex.drain().map(|(_, v)| v).collect::<Vec<_>>(), r.claude.drain().map(|(_, v)| v).collect::<Vec<_>>())
  };
  for x in x {
    x.stop();
  }
  for s in c {
    s.lock().parking = true;
    s.kill();
  }
}

// ---- the rest of the group ------------------------------------------------------------------

pub async fn transcript(cwd: String, id: String, config_dir: Option<String>) -> Vec<Value> {
  tokio::task::spawn_blocking(move || {
    let c = history::read_session_transcript(&cwd, &id, config_dir.as_deref());
    if c.is_empty() {
      history::read_codex_transcript(&id)
    } else {
      c
    }
  })
  .await
  .unwrap_or_default()
}

pub async fn sessions(cwd: String, config_dir: Option<String>) -> Vec<SessionSummary> {
  history::list_sessions(cwd, config_dir).await
}

pub async fn session_rename(cwd: String, id: String, title: String, config_dir: Option<String>) -> bool {
  tokio::task::spawn_blocking(move || history::rename_session(&cwd, &id, &title, config_dir.as_deref())).await.unwrap_or(false)
}

pub async fn session_delete(cwd: String, id: String, config_dir: Option<String>) -> bool {
  tokio::task::spawn_blocking(move || history::delete_session(&cwd, &id, config_dir.as_deref())).await.unwrap_or(false)
}

pub async fn session_title(cwd: String, id: String, config_dir: Option<String>) -> Option<String> {
  tokio::task::spawn_blocking(move || history::read_session_title(&cwd, &id, config_dir.as_deref())).await.ok().flatten()
}

pub async fn agents(cwd: String) -> Vec<Value> {
  tokio::task::spawn_blocking(move || history::list_agents(&cwd)).await.unwrap_or_default()
}

pub async fn session_info(cwd: String, config_dir: Option<String>, fresh: bool) -> SessionInfo {
  mcp::fetch_session_info(cwd, config_dir, fresh).await
}

pub async fn mcp_list(cwd: String, config_dir: Option<String>) -> Vec<Value> {
  mcp::mcp_list(cwd, config_dir).await
}

pub async fn mcp_logout(cwd: String, name: String, config_dir: Option<String>) -> Value {
  mcp::run_result(mcp::run_claude_mcp(&cwd, &["mcp", "logout", &name], Duration::from_secs(20), config_dir.as_deref()).await)
}

pub async fn mcp_approve(cwd: String, name: String, config_dir: Option<String>) -> Value {
  tokio::task::spawn_blocking(move || mcp::approve_mcp_json(&cwd, &name, config_dir.as_deref())).await.unwrap_or(Value::Null)
}

pub async fn title(message: String) -> String {
  cli::title(&message).await
}

pub async fn detect_clis() -> Vec<Value> {
  cli::detect_clis().await
}

pub async fn accounts(config_dir: Option<String>) -> Vec<Value> {
  cli::accounts(config_dir).await
}

pub fn profile_dir(id: &str) -> String {
  cli::profile_dir(id)
}

pub async fn logout(config_dir: Option<String>) -> Value {
  let home = util::home().to_string_lossy().into_owned();
  mcp::run_result(mcp::run_claude_mcp(&home, &["auth", "logout"], Duration::from_secs(30), config_dir.as_deref()).await)
}

pub async fn cli_update(cmd: String) -> Option<UpdateState> {
  if cmd != "claude" && cmd != "codex" {
    return None;
  }
  Some(cli::run_update(&cmd).await)
}

pub fn cli_update_status() -> Vec<UpdateState> {
  cli::update_status()
}

/// The user said yes: every open pane on this CLI gets the new build.
pub async fn cli_apply_update(cmd: String) -> Option<UpdateState> {
  if cmd != "claude" && cmd != "codex" {
    return None;
  }
  let cur = cli::current(&cmd).filter(|u| u.status == "done")?;
  let keys: Vec<String> = {
    let r = reg();
    if cmd == "codex" {
      r.codex.keys().cloned().collect()
    } else {
      r.claude.keys().cloned().collect()
    }
  };
  let (mut restarted, mut deferred) = (0, 0);
  for k in keys {
    match restart_in_place(k).await {
      "restarted" => restarted += 1,
      "deferred" => deferred += 1,
      _ => {}
    }
  }
  let next = UpdateState { restarted, deferred, answered: Some("applied".into()), ..cur };
  cli::publish(next.clone());
  Some(next)
}

pub fn cli_defer_update(cmd: &str) {
  cli::defer_update(cmd);
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn args() {
    assert_eq!(autocompact_arg(Some("auto")), None);
    assert_eq!(autocompact_arg(Some("250k")), Some("250000".into()));
    assert_eq!(autocompact_arg(Some("1.5m")), None);
    assert_eq!(autocompact_arg(Some("1m")), Some("1000000".into()));
    assert_eq!(allowed_base(&Some(vec!["Bash".into()])).contains("Bash,"), false);
    assert_eq!(user_content("hi", &[]), json!("hi"));
  }
}
