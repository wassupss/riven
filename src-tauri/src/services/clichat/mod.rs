// CLI chat (experimental): riven's chat view over the REAL interactive
// `claude`, not the headless `-p --input-format stream-json` driver of
// services/chat.
//
// A session is a hidden pty (services/pty, the same login shell and riven
// environment a terminal gets) running `claude` in the workspace. Nothing is
// scraped for structure:
//
// - the conversation comes from the session's transcript JSONL, tailed by
//   offset (transcript.rs), branch-resolved, sent to the page as items;
// - state comes from the CLI's hooks, posted straight to the loopback server
//   (hooks.rs): a turn started/ended, it waits on the person, a permission
//   request (answered from a riven card, or left to the CLI's own dialog);
// - the text of a reply still streaming comes from the MessageDisplay hook
//   (whole lines as they complete) and, between those, from the pty's screen
//   (preview.rs, a tolerant heuristic). The JSONL version replaces it.
//
// Input is typed into the pty: a bracketed paste and Enter. Slash commands,
// skills, /compact, /model all work because it is the CLI itself; anything
// the chat view cannot draw (a picker, the trust dialog) is answered in the
// terminal view, which attaches to the same pty by its key.

pub mod hooks;
pub mod preview;
pub mod transcript;

#[cfg(test)]
mod measure;

use hooks::Decision;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{mpsc, Arc, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};
use tauri::AppHandle;
use transcript::{Chunk, Delta, Item, Store, Tail};

/// Wide enough that a reply never wraps on the hidden screen (wrapping would
/// break the preview's line structure), tall enough for a reply in flight.
pub const COLS: u16 = 220;
pub const ROWS: u16 = 50;

const TICK_BUSY: Duration = Duration::from_millis(200);
const TICK_IDLE: Duration = Duration::from_millis(1000);
// Keystrokes sent before the TUI drew its input box can be lost; a message
// waits for it this long at most.
const READY_TIMEOUT: Duration = Duration::from_secs(20);
// Between the paste and the Enter: the TUI handles a paste as one event and
// an Enter that arrives in the same read can be taken as part of it.
const PASTE_SETTLE: Duration = Duration::from_millis(120);
const MENU_SETTLE: Duration = Duration::from_millis(800);

// Inherited from a parent Claude Code (riven started from a Claude terminal
// in development). A CLI that sees them thinks it is a child session: it
// does not persist its transcript, so the chat would never see a message.
const SCRUB: &[&str] = &[
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_CHILD_NOTES_DIR",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_PID",
];

#[derive(Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct StartOpts {
  pub cwd: String,
  pub resume: Option<String>,
  pub model: Option<String>,
  pub permission_mode: Option<String>,
  pub config_dir: Option<String>,
}

struct Pending {
  id: String,
  tx: mpsc::Sender<Decision>,
}

struct Sess {
  key: String,
  label: String,
  session_id: String,
  config_dir: Option<String>,
  store: Store,
  tail: Tail,
  sent: Vec<String>,
  busy: bool,
  waiting: bool,
  ready: bool,
  blocked: Option<&'static str>,
  // The input box has been on screen at least once (startup is not a menu).
  box_seen: bool,
  menu_since: Option<Instant>,
  started: Instant,
  queue: Vec<String>,
  // MessageDisplay: (message id, text so far) of the reply on screen.
  shown: Option<(String, String)>,
  preview: Option<String>,
  // What the screen showed when the real message landed: the same reply is
  // still on screen afterwards and must not come back as a preview.
  landed: Option<String>,
  terminal: bool,
  perms: Vec<Pending>,
  dead: bool,
}

static APP: OnceLock<AppHandle> = OnceLock::new();
static SESS: OnceLock<Mutex<HashMap<String, Arc<Mutex<Sess>>>>> = OnceLock::new();

fn all() -> MutexGuard<'static, HashMap<String, Arc<Mutex<Sess>>>> {
  SESS.get_or_init(Default::default).lock().unwrap_or_else(|e| e.into_inner())
}
fn get(key: &str) -> Option<Arc<Mutex<Sess>>> {
  all().get(key).cloned()
}
fn lock(s: &Mutex<Sess>) -> MutexGuard<'_, Sess> {
  s.lock().unwrap_or_else(|e| e.into_inner())
}

pub fn init(app: &AppHandle) {
  let _ = APP.set(app.clone());
}

fn emit(label: &str, payload: Value) {
  if let Some(app) = APP.get() {
    crate::commands::emit_ipc(app, label, "clichat:event", json!([payload]));
  }
}

fn emit_state(s: &Sess) {
  emit(
    &s.label,
    json!({
      "key": s.key, "kind": "state", "busy": s.busy, "waiting": s.waiting, "ready": s.ready,
      "blocked": s.blocked, "sessionId": s.session_id, "dead": s.dead, "terminal": s.terminal
    }),
  );
}

fn sq(s: &str) -> String {
  format!("'{}'", s.replace('\'', "'\\''"))
}

// The settings file every session of this run passes with --settings.
fn settings_file() -> Result<PathBuf, String> {
  static P: OnceLock<Result<PathBuf, String>> = OnceLock::new();
  P.get_or_init(|| {
    let base = crate::services::mcp::base_url().ok_or("riven's loopback server is not running")?;
    use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
    let dir = crate::services::paths::user_data().join("hooks");
    std::fs::DirBuilder::new().recursive(true).mode(0o700).create(&dir).map_err(|e| e.to_string())?;
    let file = dir.join("clichat-settings.json");
    let text = serde_json::to_string_pretty(&hooks::settings(base)).unwrap_or_default() + "\n";
    let mut f = std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(&file).map_err(|e| e.to_string())?;
    std::io::Write::write_all(&mut f, text.as_bytes()).map_err(|e| e.to_string())?;
    Ok(file)
  })
  .clone()
}

/// The command line the hidden shell execs. MCP config and prompt are
/// referenced as variables (the environment services/mcp computed for this
/// pane), the same values a typed `claude` gets from riven's shell shim.
pub fn command_line(real: Option<&str>, has_mcp: bool, settings: &str, opts: &StartOpts, session: &str, resume: bool) -> String {
  let mut c = vec![real.map(sq).unwrap_or_else(|| "claude".into())];
  if has_mcp {
    c.push("--mcp-config \"$RIVEN_MCP_CONFIG\"".into());
    c.push("--append-system-prompt \"$RIVEN_MCP_PROMPT\"".into());
  }
  c.push(format!("--settings {}", sq(settings)));
  if let Some(m) = opts.model.as_deref().filter(|m| !m.is_empty() && *m != "default") {
    c.push(format!("--model {}", sq(m)));
  }
  if let Some(p) = opts.permission_mode.as_deref().filter(|p| !p.is_empty()) {
    c.push(format!("--permission-mode {}", sq(p)));
  }
  c.push(format!("{} {}", if resume { "--resume" } else { "--session-id" }, sq(session)));
  c.join(" ")
}

pub async fn start(label: String, key: String, opts: StartOpts) -> Result<Value, String> {
  if let Some(s) = get(&key) {
    // Reattach (page reload): the page starts empty, so send everything.
    let mut st = lock(&s);
    if !st.dead {
      st.label = label;
      st.sent.clear();
      let items = st.store.branch();
      st.sent = items.iter().map(|i| i.key().to_string()).collect();
      emit(&st.label, json!({ "key": key, "kind": "items", "reset": true, "items": items }));
      emit_state(&st);
      return Ok(json!({ "sessionId": st.session_id, "existed": true }));
    }
    drop(st);
    all().remove(&key);
  }
  if opts.cwd.is_empty() {
    return Err("no workspace folder".into());
  }
  let resume = opts.resume.as_deref().filter(|r| !r.is_empty()).map(str::to_string);
  if let Some(r) = &resume {
    if !transcript::is_uuid(r) {
      return Err("not a session id".into());
    }
  }
  let session_id = resume.clone().unwrap_or_else(crate::services::chat::util::uuid);
  let settings = settings_file()?;
  let extras = crate::services::mcp::pty_env(&key).await;
  let has_mcp = extras.contains_key("RIVEN_MCP_CONFIG");
  let real = extras.get("RIVEN_REAL_CLAUDE").cloned();
  let cmd = command_line(real.as_deref(), has_mcp, &settings.to_string_lossy(), &opts, &session_id, resume.is_some());
  let path = transcript::transcript_path(&opts.cwd, opts.config_dir.as_deref(), &session_id);
  let sess = Arc::new(Mutex::new(Sess {
    key: key.clone(),
    label: label.clone(),
    session_id: session_id.clone(),
    config_dir: opts.config_dir.clone(),
    store: Store::default(),
    tail: Tail::new(path),
    sent: Vec::new(),
    busy: false,
    waiting: false,
    ready: false,
    blocked: None,
    box_seen: false,
    menu_since: None,
    started: Instant::now(),
    queue: Vec::new(),
    shown: None,
    preview: None,
    landed: None,
    terminal: false,
    perms: Vec::new(),
    dead: false,
  }));
  all().insert(key.clone(), sess.clone());
  let launch = crate::services::pty::Launch { exec: true, env_remove: SCRUB };
  if let Err(e) = crate::services::pty::open_hidden(label, key.clone(), opts.cwd.clone(), cmd, COLS, ROWS, opts.config_dir.clone(), extras, launch).await {
    all().remove(&key);
    return Err(e);
  }
  tauri::async_runtime::spawn(run(sess));
  Ok(json!({ "sessionId": session_id, "existed": false }))
}

// One loop per session: tail the transcript, watch the screen until the CLI
// is ready, keep the streaming preview fresh while a turn runs.
async fn run(s: Arc<Mutex<Sess>>) {
  loop {
    let wait = {
      let mut st = lock(&s);
      if st.dead {
        return;
      }
      pump(&mut st);
      if st.busy || !st.ready { TICK_BUSY } else { TICK_IDLE }
    };
    tokio::time::sleep(wait).await;
  }
}

fn pump(st: &mut Sess) {
  // 1. The transcript.
  if !st.tail.path.is_file() {
    // Long cwds get a hashed folder name: find the session by its id.
    if st.started.elapsed() > Duration::from_secs(3) {
      if let Some(p) = transcript::find_by_id(st.config_dir.as_deref(), &st.session_id) {
        st.tail = Tail::new(p);
      }
    }
  }
  if st.tail.path.is_file() {
    match st.tail.read() {
      Ok(Chunk::Lines(lines)) => {
        for l in lines {
          st.store.ingest(&l);
        }
      }
      Ok(Chunk::Restarted(lines)) => {
        st.store = Store::default();
        for l in lines {
          st.store.ingest(&l);
        }
        st.sent.clear();
      }
      Err(_) => {}
    }
  }
  let mut landed_now = false;
  if st.store.take_dirty() {
    let items = st.store.branch();
    let landed_text = match transcript::delta(&st.sent, &items) {
      Delta::None => false,
      Delta::Append(new) => {
        let text = new.iter().any(|i| matches!(i, Item::Text { .. }));
        emit(&st.label, json!({ "key": st.key, "kind": "items", "reset": false, "items": new }));
        text
      }
      Delta::Reset(all) => {
        emit(&st.label, json!({ "key": st.key, "kind": "items", "reset": true, "items": all }));
        true
      }
    };
    st.sent = items.iter().map(|i| i.key().to_string()).collect();
    // The real message is in: the preview has done its job.
    if landed_text {
      st.shown = None;
      landed_now = true;
      set_preview(st, None);
    }
  }
  // 2. The screen: is the CLI up, or is it asking something only the
  // terminal view can answer?
  let screen = crate::services::pty::screen_text(&st.key);
  if landed_now {
    st.landed = screen.as_deref().and_then(preview::extract);
  }
  if let Some(screen) = &screen {
    let boxed = preview::has_input_box(screen);
    let mut blocked = preview::blocked(screen);
    if boxed {
      st.box_seen = true;
      st.menu_since = None;
    } else if blocked.is_none() && st.box_seen && st.perms.is_empty() {
      // The input box went away and no permission card explains it: a menu
      // or dialog only the terminal view can answer. Not on the first
      // frame of a redraw.
      let since = *st.menu_since.get_or_insert_with(Instant::now);
      if since.elapsed() > MENU_SETTLE {
        blocked = Some("menu");
      }
    }
    let ready = boxed && blocked.is_none();
    if blocked != st.blocked || ready != st.ready {
      st.blocked = blocked;
      st.ready = ready;
      emit_state(st);
    }
  }
  if !st.queue.is_empty() && (st.ready || (st.blocked.is_none() && st.started.elapsed() > READY_TIMEOUT)) {
    for text in std::mem::take(&mut st.queue) {
      type_message(st, &text);
    }
  }
  // 3. The reply in flight.
  if st.busy {
    let from_screen = screen.as_deref().and_then(preview::extract).filter(|t| st.landed.as_deref() != Some(t.as_str()));
    let from_hook = st.shown.as_ref().map(|(_, t)| t.clone()).filter(|t| !t.trim().is_empty());
    // The screen is ahead of the hook (it has the line being written); the
    // hook is right when the screen heuristic finds nothing.
    let next = match (from_screen, from_hook) {
      (Some(a), Some(b)) => Some(if a.len() >= b.len() { a } else { b }),
      (a, b) => a.or(b),
    };
    if next.is_some() {
      set_preview(st, next);
    }
  }
}

fn set_preview(st: &mut Sess, text: Option<String>) {
  if st.preview != text {
    st.preview = text.clone();
    emit(&st.label, json!({ "key": st.key, "kind": "preview", "text": text }));
  }
}

fn type_message(st: &mut Sess, text: &str) {
  let key = st.key.clone();
  let text = text.replace("\r\n", "\n");
  let command = text.starts_with('/') && !text.contains('\n');
  // Prose always starts a turn. A slash command may not (/model opens a
  // picker, /cost just prints): its UserPromptSubmit hook says if it did.
  if !command {
    st.busy = true;
  }
  st.waiting = false;
  emit_state(st);
  // A slash command is typed, so the CLI sees `/name` at the start of its
  // input and runs it; prose goes in as one paste (multi-line safe).
  let body = if command { text } else { format!("\x1b[200~{text}\x1b[201~") };
  crate::services::pty::write(key.clone(), body);
  tauri::async_runtime::spawn(async move {
    tokio::time::sleep(PASTE_SETTLE).await;
    crate::services::pty::write(key, "\r".into());
  });
}

pub fn send(key: &str, text: String) {
  let Some(s) = get(key) else { return };
  let mut st = lock(&s);
  if st.dead || text.trim().is_empty() {
    return;
  }
  if !st.ready {
    st.queue.push(text);
    return;
  }
  type_message(&mut st, &text);
}

/// Esc: what the CLI takes as "stop this turn". No Stop hook follows an
/// interrupt, so the turn is over as far as the view is concerned.
pub fn interrupt(key: &str) {
  let Some(s) = get(key) else { return };
  crate::services::pty::write(key.to_string(), "\x1b".into());
  let mut st = lock(&s);
  st.busy = false;
  st.shown = None;
  set_preview(&mut st, None);
  emit_state(&st);
}

/// Raw keys for the CLI (a menu answered from the chat view: arrows, digits).
pub fn keys(key: &str, data: String) {
  if get(key).is_some() {
    crate::services::pty::write(key.to_string(), data);
  }
}

pub fn stop(key: &str) {
  let Some(s) = all().remove(key) else { return };
  let mut st = lock(&s);
  st.dead = true;
  for p in st.perms.drain(..) {
    let _ = p.tx.send(Decision::Terminal);
  }
  drop(st);
  crate::services::pty::kill(key.to_string());
}

/// The terminal view took over (on) or gave the pty back (off). Off means
/// the wide size again: the terminal view resized it to its own.
pub fn set_terminal(key: &str, on: bool) {
  let Some(s) = get(key) else { return };
  let mut st = lock(&s);
  st.terminal = on;
  if !on {
    crate::services::pty::resize_now(key, COLS, ROWS);
  }
  emit_state(&st);
}

pub fn answer(key: &str, id: &str, decision: &str) {
  let Some(s) = get(key) else { return };
  let mut st = lock(&s);
  if let Some(i) = st.perms.iter().position(|p| p.id == id) {
    let p = st.perms.remove(i);
    let _ = p.tx.send(Decision::parse(decision));
  }
}

pub fn on_pty_exit(key: &str, code: i32) {
  let Some(s) = all().remove(key) else { return };
  let mut st = lock(&s);
  st.dead = true;
  st.busy = false;
  for p in st.perms.drain(..) {
    let _ = p.tx.send(Decision::Terminal);
  }
  emit(&st.label, json!({ "key": key, "kind": "exit", "code": code }));
  emit_state(&st);
}

pub fn shutdown() {
  let keys: Vec<String> = all().keys().cloned().collect();
  for k in keys {
    stop(&k);
  }
}

/// POST /clichat?event=: a hook of a CLI chat session (the pane is in the
/// X-Riven-Pane header). Returns the status and an optional JSON body. Runs
/// on the connection's own thread, so a permission request may block here
/// until the person answers.
pub fn hook(pane: Option<&str>, event: &str, body: &str) -> (u16, Option<String>) {
  let Some(pane) = pane.filter(|p| !p.is_empty()) else { return (204, None) };
  // What a terminal agent's hooks feed (activity, notifications, the
  // changes timeline) runs for this pane as well.
  if hooks::forwarded(event) {
    if let Ok(url) = url::Url::parse(&format!("http://127.0.0.1/hook?pane={}&event={event}", urlencode(pane))) {
      let (_res, after) = crate::services::mcp::hooks::handle(&url, body);
      if let Some(after) = after {
        after();
      }
    }
  }
  let Some(s) = get(pane) else { return (204, None) };
  let payload: Value = serde_json::from_str(body).unwrap_or(Value::Null);
  let mut st = lock(&s);
  match event {
    "UserPromptSubmit" => {
      st.busy = true;
      st.waiting = false;
      st.shown = None;
      st.landed = None;
      set_preview(&mut st, None);
      emit_state(&st);
    }
    "Stop" | "StopFailure" | "SessionEnd" => {
      st.busy = false;
      st.waiting = false;
      emit_state(&st);
      if event == "StopFailure" {
        let msg = payload.get("error").map(|e| e.to_string()).unwrap_or_else(|| "turn failed".into());
        emit(&st.label, json!({ "key": pane, "kind": "notice", "level": "error", "text": msg }));
      }
    }
    "Notification" => {
      st.waiting = true;
      emit_state(&st);
      let text = payload.get("message").and_then(Value::as_str).unwrap_or("");
      emit(&st.label, json!({ "key": pane, "kind": "notice", "level": "waiting", "text": text }));
    }
    "MessageDisplay" => {
      let id = payload.get("message_id").and_then(Value::as_str).unwrap_or("").to_string();
      let delta = payload.get("delta").and_then(Value::as_str).unwrap_or("");
      match &mut st.shown {
        Some((cur, text)) if *cur == id => text.push_str(delta),
        _ => st.shown = Some((id, delta.to_string())),
      }
    }
    "PreCompact" | "PostCompact" => {
      emit(&st.label, json!({ "key": pane, "kind": "notice", "level": "compact", "text": event }));
    }
    "PermissionRequest" => {
      let id = crate::services::chat::util::uuid();
      let (tx, rx) = mpsc::channel();
      st.perms.push(Pending { id: id.clone(), tx });
      st.waiting = true;
      emit(
        &st.label,
        json!({
          "key": pane, "kind": "permission", "id": id,
          "tool": payload.get("tool_name"), "input": payload.get("tool_input"),
          "suggestions": payload.get("permission_suggestions")
        }),
      );
      emit_state(&st);
      drop(st);
      let d = rx.recv_timeout(Duration::from_secs(hooks::PERMISSION_TIMEOUT_SECS)).unwrap_or(Decision::Terminal);
      let mut st = lock(&s);
      st.perms.retain(|p| p.id != id);
      st.waiting = false;
      emit(&st.label, json!({ "key": pane, "kind": "permissionDone", "id": id, "decision": format!("{d:?}").to_lowercase() }));
      emit_state(&st);
      return match hooks::permission_answer(d) {
        Some(v) => (200, Some(v.to_string())),
        None => (204, None),
      };
    }
    _ => {}
  }
  // The CLI reports where it actually writes the transcript.
  if let Some(p) = payload.get("transcript_path").and_then(Value::as_str) {
    let p = PathBuf::from(p);
    if p != st.tail.path && p.file_name().is_some_and(|n| n.to_string_lossy().starts_with(&st.session_id)) {
      st.tail = Tail::new(p);
      st.store = Store::default();
      st.sent.clear();
    }
  }
  (204, None)
}

fn urlencode(s: &str) -> String {
  s.bytes()
    .map(|b| if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.') { (b as char).to_string() } else { format!("%{b:02X}") })
    .collect()
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn command_lines() {
    let o = StartOpts { cwd: "/w".into(), model: Some("haiku".into()), permission_mode: Some("acceptEdits".into()), ..Default::default() };
    let c = command_line(Some("/bin/cl aude"), true, "/s/x.json", &o, "id-1", false);
    assert_eq!(
      c,
      "'/bin/cl aude' --mcp-config \"$RIVEN_MCP_CONFIG\" --append-system-prompt \"$RIVEN_MCP_PROMPT\" --settings '/s/x.json' --model 'haiku' --permission-mode 'acceptEdits' --session-id 'id-1'"
    );
    let r = command_line(None, false, "/s", &StartOpts { model: Some("default".into()), ..Default::default() }, "id", true);
    assert_eq!(r, "claude --settings '/s' --resume 'id'");
    assert_eq!(urlencode("chat-1 x"), "chat-1%20x");
  }
}
