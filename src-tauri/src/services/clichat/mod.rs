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
// Input is typed into the pty: a bracketed paste and Enter (images as pasted
// file paths, files as @-mentions). Slash commands, skills, /compact work
// because it is the CLI itself. Questions come through the PermissionRequest
// hook and are answered there; numbered menus on screen (plan approval, the
// trust dialog) are drawn as cards and answered with keys; anything else is
// answered in the terminal view, which attaches to the same pty by its key.
//
// The model and the permission mode are flags of the process: switching is
// a restart with --resume at a turn boundary (life.rs), never /model, which
// writes the person's global default. An idle session is parked (process
// stopped) and resumed by the next message; a new CLI binary on disk
// restarts it the same way.

pub mod agents;
pub mod attach;
pub mod hooks;
pub mod life;
pub mod preview;
pub mod transcript;

#[cfg(test)]
mod measure;
#[cfg(test)]
mod probe;

use hooks::Decision;
use serde::Deserialize;
use serde_json::{json, Map, Value};
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
// Subagent folders are looked at this often while anything runs.
const AGENTS_EVERY: Duration = Duration::from_secs(1);
// The CLI binary is compared with what this process started from.
const BIN_EVERY: Duration = Duration::from_secs(30);
// A killed pty leaves the registry on the control thread: a restart under
// the same key waits for that.
const GONE_TIMEOUT: Duration = Duration::from_secs(3);

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

#[derive(Deserialize, Clone, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct StartOpts {
  pub cwd: String,
  pub resume: Option<String>,
  /// With `resume`: continue in a copy under a new id (--fork-session).
  pub fork: Option<bool>,
  pub model: Option<String>,
  pub permission_mode: Option<String>,
  pub config_dir: Option<String>,
  /// The chat settings the headless chat launches with (Settings > AI):
  /// riven's own tools switched off, built-in tools held back from the
  /// allow list (the CLI asks for them), the autocompact window, the global
  /// prompt (with a group member's persona), and a custom agent.
  pub mcp_disabled: Option<Vec<String>>,
  pub tools_denied: Option<Vec<String>>,
  pub autocompact: Option<String>,
  pub global_prompt: Option<String>,
  pub agent: Option<String>,
}

/// What the launch adds to the command line besides `StartOpts`.
#[derive(Default, Debug)]
pub struct Flags {
  /// riven's MCP config is in $RIVEN_MCP_CONFIG.
  pub mcp: bool,
  /// A system prompt to append is in $RIVEN_CLICHAT_PROMPT.
  pub prompt: bool,
  /// The --allowedTools value.
  pub allowed: Option<String>,
}

/// The system prompt appended to the CLI's: riven's tool guide (with MCP),
/// then the person's own instructions, as the headless chat composes it.
pub fn system_prompt(mcp_prompt: Option<&str>, global: Option<&str>) -> Option<String> {
  let mut parts: Vec<String> = Vec::new();
  if let Some(p) = mcp_prompt.filter(|p| !p.trim().is_empty()) {
    parts.push(p.to_string());
  }
  if let Some(g) = global.map(str::trim).filter(|g| !g.is_empty()) {
    parts.push(format!("# 사용자 지정 지침\n{g}"));
  }
  (!parts.is_empty()).then(|| parts.join("\n\n"))
}

/// A message on its way into the TUI: text, and image files pasted after it.
#[derive(Clone, Debug, Default)]
pub struct Outgoing {
  pub text: String,
  pub images: Vec<String>,
}

#[derive(Clone, Copy, PartialEq)]
enum Ask {
  Permission,
  Question,
}

struct Pending {
  id: String,
  ask: Ask,
  tool: String,
  input: Value,
  tx: mpsc::Sender<Decision>,
}

struct Sess {
  key: String,
  label: String,
  session_id: String,
  /// What the process runs with now (cwd, model, mode, profile); a restart
  /// starts from it, resuming `session_id`.
  opts: StartOpts,
  store: Store,
  tail: Tail,
  sent: Vec<String>,
  /// The next items emit replaces what the page has (a fresh process).
  fresh: bool,
  busy: bool,
  waiting: bool,
  ready: bool,
  blocked: Option<&'static str>,
  // The input box has been on screen at least once (startup is not a menu).
  box_seen: bool,
  menu_since: Option<Instant>,
  menu: Option<preview::Menu>,
  /// The plan of an ExitPlanMode waiting in the TUI's approval menu.
  plan: Option<String>,
  started: Instant,
  queue: Vec<Outgoing>,
  // MessageDisplay: (message id, text so far) of the reply on screen.
  shown: Option<(String, String)>,
  preview: Option<String>,
  // What the screen showed when the real message landed: the same reply is
  // still on screen afterwards and must not come back as a preview.
  landed: Option<String>,
  terminal: bool,
  perms: Vec<Pending>,
  dead: bool,
  /// The process was stopped for being idle; the next message resumes it.
  parked: bool,
  /// The permission mode the CLI reports in its hooks (plan mode entered by
  /// the model, a plan approved into another mode).
  mode: Option<String>,
  /// Background agents/shells from the last Stop hook.
  background: Vec<Value>,
  last_active: Instant,
  reconfigure: bool,
  bin: Option<life::Fingerprint>,
  bin_path: Option<PathBuf>,
  bin_checked: Instant,
  updated: bool,
  agents: agents::Agents,
  agents_polled: Instant,
  /// Messages are typed one after another, never interleaved.
  typing: Arc<tokio::sync::Mutex<()>>,
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

/// CLI chats mid-turn: what quitting would cut off (lifecycle::busy).
pub fn running_count() -> usize {
  let list: Vec<Arc<Mutex<Sess>>> = all().values().cloned().collect();
  list.iter().filter(|s| { let st = lock(s); st.busy && !st.dead && !st.parked }).count()
}

/// Whether this pty key is a CLI chat's hidden process.
pub fn owns(key: &str) -> bool {
  get(key).is_some()
}

pub fn init(app: &AppHandle) {
  let _ = APP.set(app.clone());
  attach::sweep();
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
      "blocked": s.blocked, "sessionId": s.session_id, "dead": s.dead, "terminal": s.terminal,
      "parked": s.parked, "mode": s.mode.clone().or_else(|| s.opts.permission_mode.clone()),
      "model": s.opts.model, "background": s.background, "menu": s.menu, "plan": s.plan,
      "restartPending": s.reconfigure || s.updated
    }),
  );
}

fn emit_ask(s: &Sess, p: &Pending) {
  let kind = if p.ask == Ask::Question { "question" } else { "permission" };
  emit(&s.label, json!({ "key": s.key, "kind": kind, "id": p.id, "tool": p.tool, "input": p.input }));
}

fn emit_agents(s: &Sess) {
  emit(&s.label, json!({ "key": s.key, "kind": "agents", "agents": s.agents.snapshot() }));
}

/// A turn is over: what it answered (the Stop hook's last message, else the
/// transcript's), for the roster, notifications, the pet and whoever asked
/// this pane something (riven_ask_agent, a phone).
fn emit_turn_done(s: &Sess, reply: Option<String>, error: Option<String>, interrupted: bool) {
  let reply = reply.filter(|r| !r.trim().is_empty()).or_else(|| transcript::last_reply(&s.store.branch()));
  emit(
    &s.label,
    json!({ "key": s.key, "kind": "turnDone", "reply": reply.unwrap_or_default(), "error": error, "interrupted": interrupted }),
  );
}

fn emit_title(s: &Sess) {
  emit(&s.label, json!({ "key": s.key, "kind": "meta", "title": s.store.title() }));
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

/// The CLI's name for the mode the hooks report as "default" (2.1.330's
/// --permission-mode takes "manual", not "default").
fn mode_arg(m: &str) -> &str {
  if m == "default" { "manual" } else { m }
}

/// The command line the hidden shell execs. MCP config and prompt are
/// referenced as variables (the environment services/mcp computed for this
/// pane), the same values a typed `claude` gets from riven's shell shim.
///
/// The model and mode are per process flags: nothing here (or anywhere in
/// the CLI chat) types /model, which would write the person's global
/// default into ~/.claude/settings.json. Another model is a restart with
/// --resume and --model.
pub fn command_line(real: Option<&str>, flags: &Flags, settings: &str, opts: &StartOpts, session: &str, resume_from: Option<&str>, fork: bool) -> String {
  let mut c = vec![real.map(sq).unwrap_or_else(|| "claude".into())];
  if flags.mcp {
    c.push("--mcp-config \"$RIVEN_MCP_CONFIG\"".into());
  }
  if flags.prompt {
    c.push("--append-system-prompt \"$RIVEN_CLICHAT_PROMPT\"".into());
  }
  if let Some(a) = flags.allowed.as_deref().filter(|a| !a.is_empty()) {
    c.push(format!("--allowedTools {}", sq(a)));
  }
  c.push(format!("--settings {}", sq(settings)));
  if let Some(a) = opts.agent.as_deref().filter(|a| !a.is_empty()) {
    c.push(format!("--agent {}", sq(a)));
  }
  if let Some(ac) = crate::services::chat::autocompact_arg(opts.autocompact.as_deref()) {
    c.push(format!("--autocompact {ac}"));
  }
  if let Some(m) = opts.model.as_deref().filter(|m| !m.is_empty() && *m != "default") {
    c.push(format!("--model {}", sq(m)));
  }
  if let Some(p) = opts.permission_mode.as_deref().filter(|p| !p.is_empty()) {
    c.push(format!("--permission-mode {}", sq(mode_arg(p))));
  }
  match resume_from {
    // A fork names its new id up front, so the transcript to tail is known
    // before the CLI writes it.
    Some(from) if fork => c.push(format!("--resume {} --fork-session --session-id {}", sq(from), sq(session))),
    Some(from) => c.push(format!("--resume {}", sq(from))),
    None => c.push(format!("--session-id {}", sq(session))),
  }
  c.join(" ")
}

/// Open a session for a pane, or reattach to the one it already has (a page
/// reload: the page starts empty, so everything is sent again).
pub async fn start(label: String, key: String, opts: StartOpts) -> Result<Value, String> {
  if let Some(s) = get(&key) {
    let mut st = lock(&s);
    if !st.dead {
      st.label = label;
      let items = st.store.branch();
      st.sent = items.iter().map(|i| i.key().to_string()).collect();
      emit(&st.label, json!({ "key": key, "kind": "items", "reset": true, "items": items }));
      emit_state(&st);
      emit_title(&st);
      emit_agents(&st);
      for p in &st.perms {
        emit_ask(&st, p);
      }
      if let Some(pv) = st.preview.clone() {
        emit(&st.label, json!({ "key": key, "kind": "preview", "text": pv }));
      }
      return Ok(json!({ "sessionId": st.session_id, "existed": true }));
    }
    drop(st);
    all().remove(&key);
  }
  launch(label, key, opts, Vec::new()).await
}

fn transcript_exists(opts: &StartOpts, id: &str) -> bool {
  transcript::transcript_path(&opts.cwd, opts.config_dir.as_deref(), id).is_file() || transcript::find_by_id(opts.config_dir.as_deref(), id).is_some()
}

async fn launch(label: String, key: String, opts: StartOpts, queue: Vec<Outgoing>) -> Result<Value, String> {
  if opts.cwd.is_empty() {
    return Err("no workspace folder".into());
  }
  let resume = opts.resume.as_deref().filter(|r| !r.is_empty()).map(str::to_string);
  if let Some(r) = &resume {
    if !transcript::is_uuid(r) {
      return Err("not a session id".into());
    }
  }
  // Only a conversation with a transcript can be resumed (a new chat that
  // never got a message has none, and --resume would refuse it): such an id
  // starts fresh under the same id.
  let resume_from = resume.clone().filter(|r| transcript_exists(&opts, r));
  let fork = opts.fork == Some(true) && resume_from.is_some();
  let session_id = if fork { crate::services::chat::util::uuid() } else { resume.clone().unwrap_or_else(crate::services::chat::util::uuid) };
  let settings = settings_file()?;
  let (extras, flags) = launch_env(&key, &opts).await;
  let real = extras.get("RIVEN_REAL_CLAUDE").cloned();
  let cmd = command_line(real.as_deref(), &flags, &settings.to_string_lossy(), &opts, &session_id, resume_from.as_deref(), fork);
  let path = transcript::transcript_path(&opts.cwd, opts.config_dir.as_deref(), &session_id);
  let bin_path = real.map(PathBuf::from).or_else(|| crate::services::shell_env::which("claude"));
  let kept = StartOpts { resume: None, fork: None, ..opts.clone() };
  let now = Instant::now();
  let sess = Arc::new(Mutex::new(Sess {
    key: key.clone(),
    label: label.clone(),
    session_id: session_id.clone(),
    opts: kept,
    store: Store::default(),
    agents: agents::Agents::new(&path),
    tail: Tail::new(path),
    sent: Vec::new(),
    fresh: true,
    busy: false,
    waiting: false,
    ready: false,
    blocked: None,
    box_seen: false,
    menu_since: None,
    menu: None,
    plan: None,
    started: now,
    queue,
    shown: None,
    preview: None,
    landed: None,
    terminal: false,
    perms: Vec::new(),
    dead: false,
    parked: false,
    mode: None,
    background: Vec::new(),
    last_active: now,
    reconfigure: false,
    bin: bin_path.as_deref().and_then(life::fingerprint),
    bin_path,
    bin_checked: now,
    updated: false,
    agents_polled: now,
    typing: Arc::new(tokio::sync::Mutex::new(())),
  }));
  all().insert(key.clone(), sess.clone());
  {
    let st = lock(&sess);
    // Whatever the page shows belongs to the process before this one.
    emit(&st.label, json!({ "key": key, "kind": "items", "reset": true, "items": [] }));
    emit_state(&st);
  }
  let launch = crate::services::pty::Launch { exec: true, env_remove: SCRUB };
  if let Err(e) = crate::services::pty::open_hidden(label, key.clone(), opts.cwd.clone(), cmd, COLS, ROWS, opts.config_dir.clone(), extras, launch).await {
    all().remove(&key);
    return Err(e);
  }
  tauri::async_runtime::spawn(run(sess));
  Ok(json!({ "sessionId": session_id, "existed": false }))
}

/// The pty's environment and the flags that read it: riven's MCP config
/// without the tools the person switched off, the appended prompt, and the
/// allow list (built-ins minus the held-back ones, riven's tools, every MCP
/// server the CLI sees), as services/chat starts the headless chat.
async fn launch_env(key: &str, opts: &StartOpts) -> (HashMap<String, String>, Flags) {
  let mut extras = crate::services::mcp::pty_env(key).await;
  let disabled = opts.mcp_disabled.clone().unwrap_or_default();
  if extras.contains_key("RIVEN_MCP_CONFIG") && !disabled.is_empty() {
    let env = crate::services::mcp::chat_env("claude", key, &disabled);
    match env.get("mcpConfig").and_then(Value::as_str) {
      Some(cfg) => {
        extras.insert("RIVEN_MCP_CONFIG".into(), cfg.to_string());
        extras.insert("RIVEN_MCP_PROMPT".into(), env.get("prompt").and_then(Value::as_str).unwrap_or("").to_string());
      }
      None => {
        extras.remove("RIVEN_MCP_CONFIG");
        extras.remove("RIVEN_MCP_PROMPT");
      }
    }
  }
  let mcp = extras.contains_key("RIVEN_MCP_CONFIG");
  let prompt = system_prompt(extras.get("RIVEN_MCP_PROMPT").filter(|_| mcp).map(String::as_str), opts.global_prompt.as_deref());
  if let Some(p) = &prompt {
    extras.insert("RIVEN_CLICHAT_PROMPT".into(), p.clone());
  }
  let external = crate::services::chat::mcp::configured_mcp_servers(&opts.cwd, opts.config_dir.as_deref().filter(|d| !d.is_empty())).await;
  let base = crate::services::chat::allowed_base(&opts.tools_denied);
  let allowed = crate::services::chat::mcp::allowed_tools_value(&base, crate::services::mcp::TOOL_PREFIX, &external, &[]);
  (extras, Flags { mcp, prompt: prompt.is_some(), allowed: Some(allowed) })
}

/// Stop the process of a pane but keep nothing else: the half of a restart
/// before the new launch. Waits until the pty is gone from the registry, so
/// the new one can take the same key.
async fn halt(key: &str) {
  if let Some(s) = all().remove(key) {
    let mut st = lock(&s);
    st.dead = true;
    for p in st.perms.drain(..) {
      let _ = p.tx.send(Decision::Terminal);
    }
  }
  crate::services::pty::kill(key.to_string());
  let t = Instant::now();
  while crate::services::pty::exists(key) && t.elapsed() < GONE_TIMEOUT {
    tokio::time::sleep(Duration::from_millis(50)).await;
  }
}

/// A new process for the pane: another conversation (resume, fork, new) or
/// the same one with other flags. The page's own items are replaced by the
/// new transcript.
pub async fn restart(label: String, key: String, opts: StartOpts, queue: Vec<Outgoing>) -> Result<Value, String> {
  halt(&key).await;
  launch(label, key, opts, queue).await
}

// The same conversation in a new process (park/resume, model, mode, update).
fn relaunch(st: &Sess, queue: Vec<Outgoing>) {
  let opts = StartOpts { resume: Some(st.session_id.clone()), ..st.opts.clone() };
  let (label, key) = (st.label.clone(), st.key.clone());
  tauri::async_runtime::spawn(async move {
    if let Err(e) = restart(label.clone(), key.clone(), opts, queue).await {
      emit(&label, json!({ "key": key, "kind": "notice", "level": "error", "text": e }));
    }
  });
}

// One loop per process: tail the transcript, watch the screen, keep the
// streaming preview fresh, and decide when to park or restart.
async fn run(s: Arc<Mutex<Sess>>) {
  loop {
    let wait = {
      let mut st = lock(&s);
      if st.dead || st.parked {
        return;
      }
      pump(&mut st);
      let snap = life::Snapshot {
        dead: st.dead,
        parked: st.parked,
        busy: st.busy,
        asking: !st.perms.is_empty(),
        menu: st.blocked.is_some(),
        terminal: st.terminal,
        background: !st.background.is_empty() || st.agents.any_running(),
        reconfigure: st.reconfigure,
        updated: st.updated,
        idle_for: st.last_active.elapsed(),
      };
      match life::next(&snap) {
        life::Next::Stay => {}
        life::Next::Park => {
          park(&mut st);
          return;
        }
        life::Next::Restart(why) => {
          if why == life::Why::Update {
            emit(&st.label, json!({ "key": st.key, "kind": "notice", "level": "update", "text": "updated" }));
          }
          st.dead = true;
          let queue = std::mem::take(&mut st.queue);
          relaunch(&st, queue);
          return;
        }
      }
      if st.busy || !st.ready { TICK_BUSY } else { TICK_IDLE }
    };
    tokio::time::sleep(wait).await;
  }
}

fn park(st: &mut Sess) {
  st.parked = true;
  st.ready = false;
  for p in st.perms.drain(..) {
    let _ = p.tx.send(Decision::Terminal);
  }
  crate::services::pty::kill(st.key.clone());
  emit_state(st);
}

// New transcript lines into the store (no event yet: pump sends the delta).
fn pump_transcript(st: &mut Sess) {
  if !st.tail.path.is_file() {
    // Long cwds get a hashed folder name: find the session by its id.
    if st.started.elapsed() > Duration::from_secs(3) {
      if let Some(p) = transcript::find_by_id(st.opts.config_dir.as_deref(), &st.session_id) {
        st.agents = agents::Agents::new(&p);
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
        st.fresh = true;
      }
      Err(_) => {}
    }
  }
}

fn pump(st: &mut Sess) {
  // 1. The transcript.
  pump_transcript(st);
  if st.store.take_title_dirty() {
    emit_title(st);
  }
  let mut landed_now = false;
  if st.store.take_dirty() {
    let items = st.store.branch();
    let d = if std::mem::take(&mut st.fresh) { Delta::Reset(items.clone()) } else { transcript::delta(&st.sent, &items) };
    let landed_text = match d {
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
  // 2. Subagents, while anything may be running.
  if (st.busy || st.agents.any_running() || !st.background.is_empty()) && st.agents_polled.elapsed() >= AGENTS_EVERY {
    st.agents_polled = Instant::now();
    if st.agents.poll() {
      emit_agents(st);
    }
  }
  // 3. The CLI binary: an update on disk restarts the session at the next
  // turn boundary (life.rs), on the new version.
  if st.bin_checked.elapsed() >= BIN_EVERY {
    st.bin_checked = Instant::now();
    if let (Some(path), Some(was)) = (&st.bin_path, &st.bin) {
      let now = life::fingerprint(path);
      if now.is_some() && now.as_ref() != Some(was) && !st.updated {
        st.updated = true;
        emit_state(st);
      }
    }
  }
  // 4. The screen: is the CLI up, or is it asking something only the
  // terminal view (or a menu card) can answer?
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
      // The input box went away and no card explains it: a menu or dialog.
      // Not on the first frame of a redraw.
      let since = *st.menu_since.get_or_insert_with(Instant::now);
      if since.elapsed() > MENU_SETTLE {
        blocked = Some("menu");
      }
    }
    // A card is up for it (permission, question): the TUI's own copy of
    // the dialog is not a second menu.
    let menu = if blocked.is_some() && st.perms.is_empty() { preview::menu(screen) } else { None };
    let ready = boxed && blocked.is_none();
    if blocked != st.blocked || ready != st.ready || menu != st.menu {
      st.blocked = blocked;
      st.ready = ready;
      st.menu = menu;
      emit_state(st);
    }
  }
  if !st.queue.is_empty() && (st.ready || (st.blocked.is_none() && st.started.elapsed() > READY_TIMEOUT)) {
    for m in std::mem::take(&mut st.queue) {
      type_message(st, m);
    }
  }
  // 5. The reply in flight.
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

/// The keystrokes for one message: the text as a bracketed paste (a slash
/// command typed, so the CLI sees `/name` at the start of its input), then
/// each image path as a paste of its own (the CLI turns it into
/// "[Image #N]"), then Enter.
pub fn message_writes(m: &Outgoing) -> (Vec<String>, bool) {
  let text = m.text.replace("\r\n", "\n");
  let command = m.images.is_empty() && text.starts_with('/') && !text.contains('\n');
  let mut w = Vec::new();
  if command {
    w.push(text);
  } else {
    if !text.trim().is_empty() {
      let sep = if m.images.is_empty() { "" } else { " " };
      w.push(format!("\x1b[200~{text}{sep}\x1b[201~"));
    }
    for p in &m.images {
      w.push(format!("\x1b[200~{p}\x1b[201~"));
    }
  }
  (w, command)
}

fn type_message(st: &mut Sess, m: Outgoing) {
  let (writes, command) = message_writes(&m);
  if writes.is_empty() {
    return;
  }
  // Prose always starts a turn. A slash command may not (/cost just
  // prints): its UserPromptSubmit hook says if it did.
  if !command {
    st.busy = true;
  }
  st.waiting = false;
  st.last_active = Instant::now();
  emit_state(st);
  let key = st.key.clone();
  let typing = st.typing.clone();
  tauri::async_runtime::spawn(async move {
    let _turn = typing.lock().await;
    for (i, w) in writes.into_iter().enumerate() {
      if i > 0 {
        tokio::time::sleep(PASTE_SETTLE).await;
      }
      crate::services::pty::write(key.clone(), w);
    }
    tokio::time::sleep(PASTE_SETTLE).await;
    crate::services::pty::write(key, "\r".into());
  });
}

pub fn send(key: &str, text: String, images: Vec<String>) {
  let Some(s) = get(key) else { return };
  let mut st = lock(&s);
  let images: Vec<String> = images.into_iter().filter(|p| attach::is_image(p) && std::path::Path::new(p).is_file()).collect();
  if st.dead || (text.trim().is_empty() && images.is_empty()) {
    return;
  }
  let m = Outgoing { text, images };
  st.last_active = Instant::now();
  if st.parked {
    // Back from idle: the same conversation in a new process, this
    // message first.
    st.dead = true;
    relaunch(&st, vec![m]);
    return;
  }
  if !st.ready {
    st.queue.push(m);
    return;
  }
  type_message(&mut st, m);
}

/// Esc: what the CLI takes as "stop this turn". No Stop hook follows an
/// interrupt, so the turn is over as far as the view is concerned.
pub fn interrupt(key: &str) {
  let Some(s) = get(key) else { return };
  let mut st = lock(&s);
  if st.parked {
    return;
  }
  crate::services::pty::write(key.to_string(), "\x1b".into());
  if st.busy {
    emit_turn_done(&st, None, None, true);
  }
  st.busy = false;
  st.shown = None;
  st.last_active = Instant::now();
  for p in st.perms.drain(..) {
    let _ = p.tx.send(Decision::Terminal);
  }
  set_preview(&mut st, None);
  emit_state(&st);
}

/// Raw keys for the CLI (Esc on a menu, a key the chat view has no card for).
pub fn keys(key: &str, data: String) {
  let Some(s) = get(key) else { return };
  let mut st = lock(&s);
  if !st.parked {
    st.last_active = Instant::now();
    st.menu_since = None;
    crate::services::pty::write(key.to_string(), data);
  }
}

/// Pick option `index` of the menu on screen (text: what to type into a
/// text option such as "Tell Claude what to change").
pub fn menu_pick(key: &str, index: usize, text: Option<String>) {
  let Some(s) = get(key) else { return };
  let mut st = lock(&s);
  let Some(m) = st.menu.take() else { return };
  if index >= m.options.len() {
    st.menu = Some(m);
    return;
  }
  let keys = preview::menu_keys(m.selected, index, text.as_deref().filter(|_| m.options[index].input));
  st.last_active = Instant::now();
  st.menu_since = None;
  emit_state(&st);
  let key = key.to_string();
  tauri::async_runtime::spawn(async move {
    if !keys.is_empty() {
      crate::services::pty::write(key.clone(), keys);
      tokio::time::sleep(PASTE_SETTLE).await;
    }
    crate::services::pty::write(key, "\r".into());
  });
}

/// The header picked another model and/or mode: applied by a restart at
/// the next turn boundary (life.rs). Never through /model, which would
/// change the person's global default.
pub fn reconfigure(key: &str, model: Option<String>, mode: Option<String>) {
  let Some(s) = get(key) else { return };
  let mut st = lock(&s);
  if let Some(m) = model {
    st.opts.model = Some(m).filter(|m| !m.is_empty());
  }
  if let Some(m) = mode {
    st.opts.permission_mode = Some(m).filter(|m| !m.is_empty());
    // What the hooks said belongs to the old process.
    st.mode = None;
  }
  if st.parked {
    // Nothing runs: the flags apply when the next message resumes it.
    emit_state(&st);
    return;
  }
  st.reconfigure = true;
  emit_state(&st);
}

/// Rename the conversation this pane runs: /rename typed into the CLI, so
/// it is the CLI that writes the title (it re-appends its own copy of the
/// title later, which a line written from outside would lose to).
pub fn rename(key: &str, title: &str) -> bool {
  let name: String = title.split_whitespace().collect::<Vec<_>>().join(" ");
  if name.is_empty() {
    return false;
  }
  let Some(s) = get(key) else { return false };
  let parked = lock(&s).parked;
  if parked {
    return false;
  }
  send(key, format!("/rename {name}"), Vec::new());
  true
}

pub fn stop(key: &str) {
  let s = all().remove(key);
  if let Some(s) = s {
    let mut st = lock(&s);
    st.dead = true;
    for p in st.perms.drain(..) {
      let _ = p.tx.send(Decision::Terminal);
    }
  }
  crate::services::pty::kill(key.to_string());
  attach::clear(key);
}

/// The terminal view took over (on) or gave the pty back (off). Off means
/// the wide size again: the terminal view resized it to its own.
pub fn set_terminal(key: &str, on: bool) {
  let Some(s) = get(key) else { return };
  let mut st = lock(&s);
  st.terminal = on;
  st.last_active = Instant::now();
  if !on {
    crate::services::pty::resize_now(key, COLS, ROWS);
  }
  emit_state(&st);
}

pub fn answer(key: &str, id: &str, decision: &str) {
  let Some(s) = get(key) else { return };
  let mut st = lock(&s);
  st.last_active = Instant::now();
  if let Some(i) = st.perms.iter().position(|p| p.id == id) {
    let p = st.perms.remove(i);
    let _ = p.tx.send(Decision::parse(decision));
  }
}

/// An AskUserQuestion answered from the chat view: `answers` maps question
/// text to a label, labels, or typed text. None declines (the TUI's own
/// picker takes over, reachable through the terminal view).
pub fn answer_question(key: &str, id: &str, answers: Option<Map<String, Value>>) {
  let Some(s) = get(key) else { return };
  let mut st = lock(&s);
  st.last_active = Instant::now();
  if let Some(i) = st.perms.iter().position(|p| p.id == id) {
    let p = st.perms.remove(i);
    let d = match answers {
      Some(a) => Decision::AllowWith(hooks::question_input(&p.input, &a)),
      None => Decision::Terminal,
    };
    let _ = p.tx.send(d);
  }
}

/// An image of a user message, for its thumbnail.
pub fn image(key: &str, uuid: &str, index: usize) -> Option<String> {
  let path = get(key).map(|s| lock(&s).tail.path.clone())?;
  if !transcript::is_uuid(uuid) {
    return None;
  }
  attach::image_in_transcript(&path, uuid, index)
}

pub fn on_pty_exit(key: &str, code: i32) {
  let Some(s) = all().remove(key) else { return };
  let mut st = lock(&s);
  st.dead = true;
  if st.busy {
    emit_turn_done(&st, None, Some(format!("the CLI exited ({code})")), false);
  }
  st.busy = false;
  for p in st.perms.drain(..) {
    let _ = p.tx.send(Decision::Terminal);
  }
  emit(&st.label, json!({ "key": key, "kind": "exit", "code": code }));
  emit_state(&st);
}

pub fn shutdown() {
  let keys: Vec<String> = all().keys().cloned().collect();
  // Each pane's attachments go with it (stop).
  for k in keys {
    stop(&k);
  }
}

/// Whether a finished tool call (PostToolUse) is the one a card asked about:
/// the same input, or for a question the same questions (its input gains
/// `answers` on the way).
pub fn same_call(asked: &Value, done: &Value) -> bool {
  asked == done || asked.get("questions").is_some_and(|q| Some(q) == done.get("questions"))
}

// A card that is still up for a call the CLI has moved past (answered in the
// terminal view, or the turn ended): take it down and let its hook go.
// `call`: the tool and input that just finished; None: every card.
fn settle(st: &mut Sess, call: Option<(&str, &Value)>) {
  let before = st.perms.len();
  let (gone, keep): (Vec<Pending>, Vec<Pending>) =
    std::mem::take(&mut st.perms).into_iter().partition(|p| call.is_none_or(|(t, input)| p.tool == t && same_call(&p.input, input)));
  st.perms = keep;
  for p in gone {
    emit(&st.label, json!({ "key": st.key, "kind": "permissionDone", "id": p.id, "decision": "terminal" }));
    let _ = p.tx.send(Decision::Terminal);
  }
  if st.perms.len() != before && st.perms.is_empty() {
    st.waiting = false;
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
  st.last_active = Instant::now();
  // Subagent hooks (agent_id set) describe the subagent's tools, not the
  // main conversation's state.
  let sub = payload.get("agent_id").is_some_and(|a| !a.is_null());
  if let Some(m) = payload.get("permission_mode").and_then(Value::as_str).filter(|_| !sub) {
    if st.mode.as_deref() != Some(m) {
      st.mode = Some(m.to_string());
      emit_state(&st);
    }
  }
  let tool = payload.get("tool_name").and_then(Value::as_str).unwrap_or("").to_string();
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
      if event != "SessionEnd" && !sub {
        let reply = payload.get("last_assistant_message").and_then(Value::as_str).map(str::to_string);
        let error = (event == "StopFailure").then(|| payload.get("error").map(|e| e.to_string()).unwrap_or_else(|| "turn failed".into()));
        // The transcript may still be a line behind the hook: read it first.
        pump_transcript(&mut st);
        emit_turn_done(&st, reply, error, false);
      }
      st.busy = false;
      st.waiting = false;
      st.plan = None;
      settle(&mut st, None);
      if let Some(bg) = payload.get("background_tasks").and_then(Value::as_array) {
        st.background = bg.clone();
      }
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
      let level = match payload.get("notification_type").and_then(Value::as_str) {
        Some("idle_prompt") => "idle",
        _ => "waiting",
      };
      emit(&st.label, json!({ "key": pane, "kind": "notice", "level": level, "text": text }));
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
    "PreToolUse" if !sub && hooks::is_plan(&tool) => {
      st.plan = payload.pointer("/tool_input/plan").and_then(Value::as_str).map(str::to_string);
      emit_state(&st);
    }
    "PostToolUse" | "PostToolUseFailure" | "PermissionDenied" if !sub => {
      let input = payload.get("tool_input").cloned().unwrap_or(Value::Null);
      settle(&mut st, Some((&tool, &input)));
      if hooks::is_plan(&tool) {
        st.plan = None;
      }
      emit_state(&st);
    }
    "PermissionRequest" if hooks::is_plan(&tool) => {
      // The CLI ignores a hook's answer here; its approval menu is drawn by
      // the chat view from the screen (and the plan from PreToolUse).
      if st.plan.is_none() {
        st.plan = payload.pointer("/tool_input/plan").and_then(Value::as_str).map(str::to_string);
      }
      emit_state(&st);
    }
    "PermissionRequest" => {
      let id = crate::services::chat::util::uuid();
      let (tx, rx) = mpsc::channel();
      let ask = if hooks::is_question(&tool) { Ask::Question } else { Ask::Permission };
      let p = Pending { id: id.clone(), ask, tool, input: payload.get("tool_input").cloned().unwrap_or(Value::Null), tx };
      emit_ask(&st, &p);
      st.perms.push(p);
      st.waiting = true;
      emit_state(&st);
      drop(st);
      let d = rx.recv_timeout(Duration::from_secs(hooks::PERMISSION_TIMEOUT_SECS)).unwrap_or(Decision::Terminal);
      let mut st = lock(&s);
      let was_open = st.perms.iter().any(|p| p.id == id);
      st.perms.retain(|p| p.id != id);
      st.waiting = !st.perms.is_empty();
      let name = match &d {
        Decision::Allow | Decision::AllowWith(_) => "allow",
        Decision::Deny => "deny",
        Decision::Terminal => "terminal",
      };
      if was_open || name != "terminal" {
        emit(&st.label, json!({ "key": pane, "kind": "permissionDone", "id": id, "decision": name }));
      }
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
      st.agents = agents::Agents::new(&p);
      st.tail = Tail::new(p);
      st.store = Store::default();
      st.sent.clear();
      st.fresh = true;
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
    let flags = Flags { mcp: true, prompt: true, allowed: Some("Read,Bash,mcp__riven".into()) };
    let c = command_line(Some("/bin/cl aude"), &flags, "/s/x.json", &o, "id-1", None, false);
    assert_eq!(
      c,
      "'/bin/cl aude' --mcp-config \"$RIVEN_MCP_CONFIG\" --append-system-prompt \"$RIVEN_CLICHAT_PROMPT\" --allowedTools 'Read,Bash,mcp__riven' --settings '/s/x.json' --model 'haiku' --permission-mode 'acceptEdits' --session-id 'id-1'"
    );
    let none = Flags::default();
    let r = command_line(None, &none, "/s", &StartOpts { model: Some("default".into()), ..Default::default() }, "id", Some("id"), false);
    assert_eq!(r, "claude --settings '/s' --resume 'id'");
    // A custom agent and the autocompact window (out of range: dropped).
    let a = StartOpts { agent: Some("rev iewer".into()), autocompact: Some("250k".into()), ..Default::default() };
    assert_eq!(command_line(None, &none, "/s", &a, "id", None, false), "claude --settings '/s' --agent 'rev iewer' --autocompact 250000 --session-id 'id'");
    let a = StartOpts { autocompact: Some("5m".into()), ..Default::default() };
    assert_eq!(command_line(None, &none, "/s", &a, "id", None, false), "claude --settings '/s' --session-id 'id'");
    // A fork names its new id; "default" is spelled the way 2.1.330 takes it.
    let f = command_line(None, &none, "/s", &StartOpts { permission_mode: Some("default".into()), ..Default::default() }, "new", Some("old"), true);
    assert_eq!(f, "claude --settings '/s' --permission-mode 'manual' --resume 'old' --fork-session --session-id 'new'");
    assert_eq!(urlencode("chat-1 x"), "chat-1%20x");
  }

  #[test]
  fn appended_prompt() {
    assert_eq!(system_prompt(Some("tools"), Some("  be brief ")).as_deref(), Some("tools\n\n# 사용자 지정 지침\nbe brief"));
    assert_eq!(system_prompt(None, Some("x")).as_deref(), Some("# 사용자 지정 지침\nx"));
    assert_eq!(system_prompt(Some(" "), Some("")), None);
  }

  #[test]
  fn finished_calls_match_their_cards() {
    let q = json!({ "questions": [{ "question": "Which fruit?" }] });
    let done = json!({ "questions": [{ "question": "Which fruit?" }], "answers": { "Which fruit?": "Banana" } });
    assert!(same_call(&q, &done));
    assert!(same_call(&json!({ "command": "ls" }), &json!({ "command": "ls" })));
    assert!(!same_call(&json!({ "command": "ls" }), &json!({ "command": "rm x" })));
  }

  #[test]
  fn message_keystrokes() {
    let (w, cmd) = message_writes(&Outgoing { text: "hi\r\nthere".into(), images: vec![] });
    assert_eq!((w, cmd), (vec!["\x1b[200~hi\nthere\x1b[201~".to_string()], false));
    let (w, cmd) = message_writes(&Outgoing { text: "/rename x".into(), images: vec![] });
    assert_eq!((w, cmd), (vec!["/rename x".to_string()], true));
    // Images: each path is a paste of its own after the text (the CLI turns
    // a pasted image path into [Image #N]); a slash command with an image
    // is just text.
    let (w, cmd) = message_writes(&Outgoing { text: "/what is this".into(), images: vec!["/t/a b.png".into()] });
    assert_eq!(w, vec!["\x1b[200~/what is this \x1b[201~".to_string(), "\x1b[200~/t/a b.png\x1b[201~".to_string()]);
    assert!(!cmd);
    let (w, _) = message_writes(&Outgoing { text: "  ".into(), images: vec!["/t/x.png".into()] });
    assert_eq!(w, vec!["\x1b[200~/t/x.png\x1b[201~".to_string()]);
    assert!(message_writes(&Outgoing::default()).0.is_empty());
  }
}
