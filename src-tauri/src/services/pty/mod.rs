// Terminals: the PTYs, their libghostty-vt model, flow control toward the
// page, and the agent activity of each terminal. Port of src/main/pty.ts and
// src/main/terminal/* (the Node worker), now in this process.
//
// Sessions are keyed by a stable sessionKey and are NOT tied to the page's
// lifetime (they survive reloads; they die only on explicit kill or exit). A
// model ingests every byte the shell produces, so the authoritative screen +
// scrollback exist whether or not a page is looking. Hidden panes are free
// (their bytes are not delivered), a reattach is exact (the page gets a
// snapshot of the model), and reconnection is race-free: every delivered
// chunk carries a model revision, a snapshot carries the revision it reflects,
// and the page drops any chunk at or below it.
//
// Per terminal there are two threads: the reader (poll + read, feeds the
// model, coalesces, pauses itself when the page falls behind) and the writer
// (keystrokes and pastes, which may block on a full pty). Everything the page
// asks for (write/ack/visible/resize/seen/kill) is queued to one control
// thread in arrival order, so the main thread only enqueues.
//
// Output, snapshots, exit, bell and title go to the page as binary frames on
// its loopback WebSocket (stream.rs says why not a Tauri Channel), in order.
// Status events (busy, agent, done, reply) are ordinary 'riven:ipc' events.

mod activity;
pub mod stream;
pub(crate) mod vt;

use activity::{Activity, Attention, HookEvent, State};
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{Read, Write};
use std::os::fd::{AsRawFd, FromRawFd};
use std::sync::{mpsc, Arc, Condvar, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};
use tauri::AppHandle;
use vt::Vt;

// Model scrollback: what a reattach/reveal can restore. The page keeps its
// own (larger) scrollback for what it has already seen.
const MODEL_SCROLLBACK: usize = 2000;
// Flow-control water marks (UTF-16 units in flight to the page, per
// terminal, the unit the page acks in). 2MB is ~20ms of the page's parse
// rate: enough to stream, small enough that a flood cannot balloon memory.
const HIGH_WATER: u64 = 2 * 1024 * 1024;
const LOW_WATER: u64 = 256 * 1024;
// Coalescing: leading + trailing. The first chunk after a quiet spell goes at
// once (keystroke echo), a burst waits this long.
const FLUSH_DELAY: Duration = Duration::from_millis(5);
const FLUSH_MAX_UNITS: usize = 256 * 1024;
const READ_BUF: usize = 64 * 1024;

// Activity (pty.ts).
const POLL: Duration = Duration::from_millis(1500);
const IDLE_POLL: Duration = Duration::from_millis(5000);
const HOOKED_POLL: Duration = Duration::from_millis(5000);
const ACTIVE: Duration = Duration::from_millis(800);
const INPUT_ECHO: Duration = Duration::from_millis(350);
const NOTIFY_MIN_BUSY: Duration = Duration::from_millis(1200);
const HIDDEN_ACTIVITY_PING: Duration = Duration::from_millis(250);
const STARTUP_QUIET: Duration = Duration::from_millis(3000);


struct St {
  sender: String,
  model: Vt,
  // Chunks the model has parsed; a snapshot reflects exactly this revision.
  parsed: u64,
  // Bytes of a UTF-8 sequence split across reads, held for the next one so
  // the model and the page always see whole characters.
  carry: Vec<u8>,
  visible: bool,
  needs_snapshot: bool,
  // Flow control, TCP-style: the page reports the cumulative units it has
  // parsed for the current epoch; in flight = sent - acked.
  epoch: u32,
  sent: u64,
  acked: u64,
  paused: bool,
  cols: u16,
  rows: u16,
  // coalescer
  pending: String,
  pending_units: usize,
  pending_rev: u64,
  last_flush: Option<Instant>,
  deadline: Option<Instant>,
  last_ping: Option<Instant>,
  // activity
  activity: Activity,
  agent_present: bool,
  agent_name: Option<String>,
  agent_session_id: Option<String>,
  agent_session_kind: Option<String>,
  polling: bool,
  last_probe: Option<Instant>,
  busy_start: Instant,
  last_input: Option<Instant>,
  last_data: Instant,
  startup_until: Instant,
  awaiting_reply: bool,
  active_until: Instant,
  timer: u64,
  timer_armed: bool,
  dead: bool,
}

pub struct Session {
  key: String,
  pid: u32,
  st: Mutex<St>,
  cv: Condvar,
  input: mpsc::Sender<Vec<u8>>,
  master: Mutex<Box<dyn MasterPty + Send>>,
}

enum Op {
  Write(String, String),
  Ack(String, u32, f64),
  Visible(String, bool),
  Resize(String, u16, u16),
  Seen(String),
  Kill(String),
  Resync(String),
}

static APP: OnceLock<AppHandle> = OnceLock::new();
static SESSIONS: OnceLock<Mutex<HashMap<String, Arc<Session>>>> = OnceLock::new();
static CTL: OnceLock<Mutex<mpsc::Sender<Op>>> = OnceLock::new();
static WORKING: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

fn sessions() -> MutexGuard<'static, HashMap<String, Arc<Session>>> {
  SESSIONS.get_or_init(Default::default).lock().unwrap()
}
fn get(key: &str) -> Option<Arc<Session>> {
  sessions().get(key).cloned()
}
fn lock(s: &Session) -> MutexGuard<'_, St> {
  s.st.lock().unwrap_or_else(|e| e.into_inner())
}

pub fn init(app: &AppHandle) {
  let _ = APP.set(app.clone());
  let (tx, rx) = mpsc::channel::<Op>();
  let _ = CTL.set(Mutex::new(tx));
  std::thread::Builder::new()
    .name("pty-control".into())
    .spawn(move || {
      for op in rx {
        control(op);
      }
    })
    .expect("pty control thread");
}

fn ctl(op: Op) {
  if let Some(tx) = CTL.get() {
    let _ = tx.lock().unwrap().send(op);
  }
}

// ---- page side ----------------------------------------------------------------

fn emit(label: &str, ch: &str, payload: Value) {
  if let Some(app) = APP.get() {
    crate::commands::emit_ipc(app, label, ch, json!([payload]));
  }
}

// Frame kinds on the page's stream.
const F_DATA: u8 = 1;
const F_SNAPSHOT: u8 = 2;
const F_EXIT: u8 = 3;
const F_BELL: u8 = 4;
const F_TITLE: u8 = 5;

// [kind u8][key len u16][key][kind-specific header][payload], little endian.
// tauri/shim/pty-stream.ts decodes it back into the ipc events the page has
// always had.
fn frame(kind: u8, key: &str, header: &[u8], payload: &[u8]) -> Vec<u8> {
  let mut f = Vec::with_capacity(3 + key.len() + header.len() + payload.len());
  f.push(kind);
  f.extend_from_slice(&(key.len() as u16).to_le_bytes());
  f.extend_from_slice(key.as_bytes());
  f.extend_from_slice(header);
  f.extend_from_slice(payload);
  f
}

// ---- open ---------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenOpts {
  session_key: String,
  #[serde(default)]
  cwd: String,
  initial_command: Option<String>,
  cols: Option<f64>,
  rows: Option<f64>,
  config_dir: Option<String>,
}

#[derive(Serialize)]
pub struct Opened {
  id: String,
  existed: bool,
  #[serde(skip_serializing_if = "Option::is_none")]
  error: Option<String>,
}

fn default_shell() -> String {
  std::env::var("SHELL").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "/bin/zsh".into())
}

pub async fn open(label: String, opts: OpenOpts) -> Opened {
  let key = opts.session_key.clone();
  if let Some(s) = get(&key) {
    // Reattach after a reload / remount: the page's terminal is fresh, so the
    // next time it says it is visible it gets the model. Marking it hidden is
    // what arms that snapshot.
    let mut st = lock(&s);
    st.sender = label;
    hide(&s, &mut st);
    return Opened { id: key, existed: true, error: None };
  }

  // riven's own environment for the shell: the zsh shim that gives a typed
  // `claude`/`codex` riven's MCP tools, and the hook URL (services/mcp).
  let extras = crate::services::mcp::pty_env(&key).await;
  let cols = opts.cols.filter(|c| *c > 0.0).map(|c| c as u16).unwrap_or(80);
  let rows = opts.rows.filter(|r| *r > 0.0).map(|r| r as u16).unwrap_or(24);
  let spawned = tauri::async_runtime::spawn_blocking(move || spawn(label, opts, extras, cols, rows, Launch::default())).await;
  match spawned.map_err(|e| e.to_string()).and_then(|r| r) {
    Ok(()) => Opened { id: key, existed: false, error: None },
    Err(e) => {
      // A bad shell / cwd shouldn't reject the invoke and break the pane.
      eprintln!("[pty] spawn failed: {e}");
      Opened { id: key, existed: false, error: Some(e) }
    }
  }
}

/// How a session other than a terminal pane launches (services/clichat).
#[derive(Default)]
pub struct Launch {
  /// The command REPLACES the shell (`exec`): when it exits the session
  /// ends, instead of dropping back to a prompt.
  pub exec: bool,
  /// Inherited variables the program must not see.
  pub env_remove: &'static [&'static str],
}

/// Open a pty no terminal pane owns: the same login shell, environment and
/// model as a terminal (so a CLI started here gets riven's MCP and hooks the
/// way a typed one does), but the caller supplies the environment it has
/// already computed and decides how the command ends. A terminal view can
/// attach to it later by its key (pty_open with the same sessionKey).
pub async fn open_hidden(label: String, key: String, cwd: String, command: String, cols: u16, rows: u16, config_dir: Option<String>, extras: HashMap<String, String>, launch: Launch) -> Result<bool, String> {
  if let Some(s) = get(&key) {
    lock(&s).sender = label;
    return Ok(true);
  }
  let opts = OpenOpts { session_key: key, cwd, initial_command: Some(command), cols: None, rows: None, config_dir };
  tauri::async_runtime::spawn_blocking(move || spawn(label, opts, extras, cols, rows, launch)).await.map_err(|e| e.to_string())??;
  Ok(false)
}

/// The visible screen of a session's model, as plain text (rows lines).
pub fn screen_text(key: &str) -> Option<String> {
  let s = get(key)?;
  let st = lock(&s);
  let all = st.model.plain_text();
  let lines: Vec<&str> = all.split('\n').collect();
  let from = lines.len().saturating_sub(st.rows as usize);
  Some(lines[from..].join("\n"))
}

/// Whether a session is registered under this key (a kill takes it out on
/// the control thread, so a restart under the same key waits for this).
pub fn exists(key: &str) -> bool {
  get(key).is_some()
}

/// Resize from Rust (a hidden session going back to its own width).
pub fn resize_now(key: &str, cols: u16, rows: u16) {
  ctl(Op::Resize(key.to_string(), cols, rows));
}

fn spawn(label: String, opts: OpenOpts, extras: HashMap<String, String>, cols: u16, rows: u16, launch: Launch) -> Result<(), String> {
  let key = opts.session_key.clone();
  let shell = default_shell();
  // A LOGIN + INTERACTIVE shell like every real terminal emulator, so the full
  // init runs (.zprofile + .zshrc): PATH, homebrew, prompt daemons. For a
  // launch command, run it in that shell, then drop back to one.
  let mut args: Vec<String> = vec!["-l".into(), "-i".into()];
  if let Some(cmd) = opts.initial_command.as_deref().filter(|c| !c.is_empty()) {
    args.push("-c".into());
    if launch.exec {
      args.push(format!("exec {cmd}"));
    } else {
      args.push(format!("{cmd}; exec {shell} -il"));
    }
  }

  let mut cmd = CommandBuilder::new(&shell);
  cmd.args(&args);
  let home = std::env::var("HOME").unwrap_or_else(|_| "/".into());
  cmd.cwd(if opts.cwd.is_empty() { home } else { opts.cwd.clone() });
  cmd.env("PATH", crate::services::shell_env::login_path());
  cmd.env("TERM", "xterm-256color");
  // Only when the workspace pins a Claude account profile, so a terminal and
  // the native chat in the same workspace run as the same account.
  if let Some(d) = opts.config_dir.as_deref().filter(|d| !d.is_empty()) {
    cmd.env("CLAUDE_CONFIG_DIR", d);
  }
  for k in launch.env_remove {
    cmd.env_remove(k);
  }
  for (k, v) in &extras {
    cmd.env(k, v);
  }
  // A GUI launch usually has no LANG/LC_*, and the shell then falls back to
  // the C locale and mangles multibyte input (Korean through an IME). Set a
  // UTF-8 one unless the user already has one.
  let utf8 = ["LC_ALL", "LC_CTYPE", "LANG"]
    .iter()
    .any(|k| cmd.get_env(k).and_then(|v| v.to_str()).is_some_and(|v| v.to_ascii_lowercase().replace('-', "").contains("utf8")));
  if !utf8 {
    if cmd.get_env("LANG").is_none() {
      cmd.env("LANG", "en_US.UTF-8");
    }
    cmd.env("LC_CTYPE", "en_US.UTF-8");
  }

  let model = Vt::new(cols, rows, MODEL_SCROLLBACK)?;
  let pair = native_pty_system()
    .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
    .map_err(|e| e.to_string())?;
  let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
  // Our copy of the slave must close, or the reader never sees EOF.
  drop(pair.slave);
  let pid = child.process_id().unwrap_or(0);
  let master = pair.master;
  let writer = master.take_writer().map_err(|e| e.to_string())?;
  // The reader gets its own descriptor, so a session dropped mid-poll can
  // never leave it polling a closed (and reused) fd number.
  let raw = master.as_raw_fd().ok_or("no pty descriptor")?;
  let dup = unsafe { libc::dup(raw) };
  if dup < 0 {
    return Err(std::io::Error::last_os_error().to_string());
  }
  let reader = unsafe { File::from_raw_fd(dup) };

  let (tx, rx) = mpsc::channel::<Vec<u8>>();
  let now = Instant::now();
  let s = Arc::new(Session {
    key: key.clone(),
    pid,
    st: Mutex::new(St {
      sender: label,
      model,
      parsed: 0,
      carry: Vec::new(),
      visible: false,
      needs_snapshot: false,
      epoch: 0,
      sent: 0,
      acked: 0,
      paused: false,
      cols,
      rows,
      pending: String::new(),
      pending_units: 0,
      pending_rev: 0,
      last_flush: None,
      deadline: None,
      last_ping: None,
      activity: Activity::default(),
      agent_present: false,
      agent_name: None,
      agent_session_id: None,
      agent_session_kind: None,
      polling: false,
      last_probe: None,
      busy_start: now,
      last_input: None,
      last_data: now,
      startup_until: now + STARTUP_QUIET,
      awaiting_reply: false,
      active_until: now,
      timer: 0,
      timer_armed: false,
      dead: false,
    }),
    cv: Condvar::new(),
    input: tx,
    master: Mutex::new(master),
  });
  sessions().insert(key.clone(), s.clone());

  std::thread::Builder::new()
    .name(format!("pty-write-{pid}"))
    .spawn(move || write_loop(rx, writer))
    .map_err(|e| e.to_string())?;
  let rs = s.clone();
  std::thread::Builder::new()
    .name(format!("pty-read-{pid}"))
    .spawn(move || read_loop(rs, reader, child))
    .map_err(|e| e.to_string())?;
  tauri::async_runtime::spawn(probe_loop(s));
  Ok(())
}

fn write_loop(rx: mpsc::Receiver<Vec<u8>>, mut w: Box<dyn Write + Send>) {
  for data in rx {
    // The pty may have exited between the keystroke and here.
    let _ = w.write_all(&data);
  }
}

// ---- reading --------------------------------------------------------------------

fn read_loop(s: Arc<Session>, mut f: File, mut child: Box<dyn portable_pty::Child + Send + Sync>) {
  let fd = f.as_raw_fd();
  let mut buf = vec![0u8; READ_BUF];
  loop {
    let timeout: i32 = {
      let mut st = lock(&s);
      // Paused: the page has HIGH_WATER unacked. Not reading is what pushes
      // back on the shell (its writes block once the pty buffer fills).
      while st.paused && !st.dead {
        st = s.cv.wait(st).unwrap_or_else(|e| e.into_inner());
      }
      match st.deadline {
        Some(d) => {
          let now = Instant::now();
          if d <= now {
            flush(&s, &mut st);
            -1
          } else {
            (d - now).as_micros().div_ceil(1000) as i32
          }
        }
        None => -1,
      }
    };
    let mut p = libc::pollfd { fd, events: libc::POLLIN, revents: 0 };
    let r = unsafe { libc::poll(&mut p, 1, timeout) };
    if r < 0 {
      if std::io::Error::last_os_error().kind() == std::io::ErrorKind::Interrupted {
        continue;
      }
      break;
    }
    if r == 0 {
      continue; // the coalescer's deadline; flushed at the top
    }
    match f.read(&mut buf) {
      Ok(0) => break,
      Ok(n) => ingest(&s, &buf[..n]),
      Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
      // EIO: the slave side is gone (macOS reports a closed pty this way).
      Err(_) => break,
    }
  }
  let code = child.wait().map(|st| st.exit_code() as i32).unwrap_or(-1);
  finish(&s, code);
}

fn ingest(s: &Arc<Session>, bytes: &[u8]) {
  let mut st = lock(s);
  if st.dead {
    return; // killed: drain until the shell is gone, deliver nothing
  }
  let text = decode_utf8(&mut st.carry, bytes);
  if text.is_empty() {
    return;
  }
  let now = Instant::now();
  st.last_data = now;
  let rev = st.parsed + 1;
  let ev = st.model.write(text.as_bytes());
  st.parsed = rev;
  queue(s, &mut st, text, rev);
  // Reported after the chunk's own output, never ahead of it.
  if ev.bell || ev.title.is_some() {
    flush(s, &mut st);
    if ev.bell {
      stream::send(&st.sender, frame(F_BELL, &s.key, &[], &[]));
    }
    if let Some(t) = ev.title {
      stream::send(&st.sender, frame(F_TITLE, &s.key, &[], t.as_bytes()));
    }
  }
}

// The coalescer: leading + trailing.
fn queue(s: &Arc<Session>, st: &mut St, text: String, rev: u64) {
  if !st.visible {
    // Nobody is looking: the model has it, and the reveal restores from the
    // model. Dropping here is what keeps a background agent free. The output
    // heuristic still hears about it, throttled.
    st.needs_snapshot = true;
    let now = Instant::now();
    if st.last_ping.is_none_or(|t| now - t >= HIDDEN_ACTIVITY_PING) {
      st.last_ping = Some(now);
      output_activity(s, st);
    }
    return;
  }
  st.pending_units += utf16_len(&text);
  if st.pending.is_empty() {
    st.pending = text;
  } else {
    st.pending.push_str(&text);
  }
  st.pending_rev = rev;
  if st.pending_units >= FLUSH_MAX_UNITS {
    flush(s, st);
    return;
  }
  if st.deadline.is_some() {
    return;
  }
  let now = Instant::now();
  if st.last_flush.is_none_or(|t| now - t >= FLUSH_DELAY) {
    flush(s, st);
  } else {
    st.deadline = Some(now + FLUSH_DELAY);
  }
}

fn flush(s: &Arc<Session>, st: &mut St) {
  st.deadline = None;
  if st.pending.is_empty() {
    return;
  }
  let data = std::mem::take(&mut st.pending);
  let units = std::mem::take(&mut st.pending_units) as u64;
  st.last_flush = Some(Instant::now());
  if !st.visible {
    st.needs_snapshot = true;
    return;
  }
  st.sent += units;
  let mut h = [0u8; 12];
  h[..8].copy_from_slice(&(st.pending_rev as f64).to_le_bytes());
  h[8..].copy_from_slice(&st.epoch.to_le_bytes());
  stream::send(&st.sender, frame(F_DATA, &s.key, &h, data.as_bytes()));
  output_activity(s, st);
  // Above the high-water mark of unacked data: stop reading so memory can't
  // grow while the page catches up.
  if !st.paused && st.sent - st.acked >= HIGH_WATER {
    st.paused = true;
  }
}

fn resume(s: &Session, st: &mut St) {
  if st.paused {
    st.paused = false;
    s.cv.notify_all();
  }
}

// Deliver a model snapshot and start a fresh flow-control epoch. Anything
// still queued goes FIRST (the page drops it by revision anyway).
fn send_snapshot(s: &Arc<Session>, st: &mut St) {
  flush(s, st);
  st.epoch += 1;
  st.sent = 0;
  st.acked = 0;
  resume(s, st);
  let data = st.model.snapshot().unwrap_or_else(|e| {
    eprintln!("[pty] {e}");
    Vec::new()
  });
  let mut h = [0u8; 16];
  h[..8].copy_from_slice(&(st.parsed as f64).to_le_bytes());
  h[8..12].copy_from_slice(&st.epoch.to_le_bytes());
  h[12..14].copy_from_slice(&st.cols.to_le_bytes());
  h[14..].copy_from_slice(&st.rows.to_le_bytes());
  // Not connected yet: stay armed; the connection's resync sends it.
  st.needs_snapshot = !stream::send(&st.sender, frame(F_SNAPSHOT, &s.key, &h, &data));
  st.last_flush = Some(Instant::now());
}

fn hide(s: &Arc<Session>, st: &mut St) {
  st.visible = false;
  st.epoch += 1;
  st.sent = 0;
  st.acked = 0;
  st.pending.clear();
  st.pending_units = 0;
  st.deadline = None;
  resume(s, st);
  // Chunks already on the wire are lost to the page (it discards its queue),
  // so the reveal must come from the model.
  st.needs_snapshot = true;
}

fn finish(s: &Arc<Session>, code: i32) {
  {
    let mut st = lock(s);
    flush(s, &mut st);
    if !st.dead {
      st.dead = true;
      stream::send(&st.sender, frame(F_EXIT, &s.key, &code.to_le_bytes(), &[]));
    }
    st.timer += 1;
  }
  let mut m = sessions();
  // Still registered: the program ended by itself. A killed session left the
  // registry already, and its key may belong to a new one by now (a CLI chat
  // restarting under the same key), which must not hear this exit.
  let natural = m.get(&s.key).is_some_and(|x| Arc::ptr_eq(x, s));
  if natural {
    m.remove(&s.key);
  }
  drop(m);
  if natural {
    set_working(&s.key, false);
    crate::services::clichat::on_pty_exit(&s.key, code);
  }
}

// ---- control --------------------------------------------------------------------

fn control(op: Op) {
  match op {
    Op::Write(key, data) => {
      let Some(s) = get(&key) else { return };
      {
        let mut st = lock(&s);
        st.last_input = Some(Instant::now()); // its echo isn't "work"
        // A carriage return = the user submitted a line: arm the one-shot
        // "reply done" notification for an agent without hooks.
        if st.agent_present && !st.activity.hook_driven && data.contains('\r') {
          st.awaiting_reply = true;
        }
      }
      let _ = s.input.send(data.into_bytes());
    }
    Op::Ack(key, epoch, processed) => {
      let Some(s) = get(&key) else { return };
      let mut st = lock(&s);
      if epoch != st.epoch {
        return;
      }
      let p = if processed.is_finite() && processed > 0.0 { processed as u64 } else { 0 };
      st.acked = st.sent.min(st.acked.max(p));
      if st.paused && st.sent - st.acked <= LOW_WATER {
        resume(&s, &mut st);
      }
    }
    Op::Visible(key, visible) => {
      let Some(s) = get(&key) else { return };
      let mut st = lock(&s);
      if !visible {
        hide(&s, &mut st);
        return;
      }
      st.visible = true;
      if st.needs_snapshot {
        send_snapshot(&s, &mut st);
      }
    }
    Op::Resize(key, cols, rows) => {
      let Some(s) = get(&key) else { return };
      let mut st = lock(&s);
      // Same size = no SIGWINCH. A refit after a font load or a tab switch
      // must not make every TUI redraw itself.
      if cols == 0 || rows == 0 || (cols == st.cols && rows == st.rows) {
        return;
      }
      st.cols = cols;
      st.rows = rows;
      st.model.resize(cols, rows);
      let _ = s.master.lock().unwrap().resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 });
    }
    Op::Seen(key) => {
      let Some(s) = get(&key) else { return };
      let mut st = lock(&s);
      if st.activity.clear_attention() {
        publish(&s, &mut st, None);
      }
    }
    Op::Resync(label) => {
      let all: Vec<Arc<Session>> = sessions().values().cloned().collect();
      for s in all {
        let mut st = lock(&s);
        if st.sender != label || st.dead {
          continue;
        }
        if st.visible {
          send_snapshot(&s, &mut st);
        } else {
          st.needs_snapshot = true;
        }
      }
    }
    Op::Kill(key) => {
      let Some(s) = sessions().remove(&key) else { return };
      {
        let mut st = lock(&s);
        st.dead = true;
        st.timer += 1;
        s.cv.notify_all();
      }
      set_working(&key, false);
      hangup(s.pid);
    }
  }
}

fn hangup(pid: u32) {
  if pid > 0 {
    unsafe { libc::kill(pid as i32, libc::SIGHUP) };
  }
}

pub fn write(key: String, data: String) {
  ctl(Op::Write(key, data));
}
pub fn ack(key: String, epoch: f64, processed: f64) {
  ctl(Op::Ack(key, epoch as u32, processed));
}
pub fn visible(key: String, v: bool) {
  ctl(Op::Visible(key, v));
}
pub fn resize(key: String, cols: f64, rows: f64) {
  if cols > 0.0 && rows > 0.0 {
    ctl(Op::Resize(key, cols as u16, rows as u16));
  }
}
pub fn seen(key: String) {
  ctl(Op::Seen(key));
}
pub fn kill(key: String) {
  ctl(Op::Kill(key));
}
/// A page's stream connection just opened: frames sent before it were lost.
pub fn resync_page(label: String) {
  ctl(Op::Resync(label));
}

/// Quit: hang up every shell, or they outlive the app.
pub fn shutdown() {
  let all: Vec<Arc<Session>> = sessions().drain().map(|(_, s)| s).collect();
  for s in all {
    lock(&s).dead = true;
    hangup(s.pid);
  }
}

// ---- activity -------------------------------------------------------------------

fn output_activity(s: &Arc<Session>, st: &mut St) {
  // Output right after a keystroke is its echo, not the agent working.
  if st.last_input.is_none_or(|t| t.elapsed() > INPUT_ECHO) {
    mark_active(s, st);
  }
}

// Output-flow heuristic for agents without hooks: bytes flowing from an agent
// process = working; ACTIVE of silence = idle. A finished turn only counts
// (and notifies) if the user kicked it off with Enter and it ran a while.
fn mark_active(s: &Arc<Session>, st: &mut St) {
  if !st.agent_present || st.activity.hook_driven {
    return;
  }
  if st.activity.state != State::Working {
    st.busy_start = Instant::now();
    let n = st.activity.heuristic(State::Working);
    publish(s, st, n);
  }
  st.active_until = Instant::now() + ACTIVE;
  if !st.timer_armed {
    st.timer_armed = true;
    let gen = st.timer;
    let s = s.clone();
    tauri::async_runtime::spawn(async move { active_timer(s, gen).await });
  }
}

async fn active_timer(s: Arc<Session>, gen: u64) {
  loop {
    let wait = {
      let mut st = lock(&s);
      if st.timer != gen || st.dead {
        return;
      }
      let now = Instant::now();
      if st.active_until > now {
        st.active_until - now
      } else {
        st.timer_armed = false;
        let duration = now - st.busy_start;
        let reason = st.activity.heuristic(State::Idle);
        let notify = if st.awaiting_reply && duration > NOTIFY_MIN_BUSY { reason } else { None };
        if notify.is_none() {
          st.activity.clear_attention();
        }
        st.awaiting_reply = false;
        publish(&s, &mut st, notify);
        return;
      }
    };
    tokio::time::sleep(wait).await;
  }
}

fn cancel_timer(st: &mut St) {
  st.timer += 1;
  st.timer_armed = false;
}

fn publish(s: &Arc<Session>, st: &mut St, notify: Option<Attention>) {
  let busy = st.activity.state == State::Working;
  emit(
    &st.sender,
    "pty:status",
    json!({ "key": s.key, "busy": busy, "attention": st.activity.attention.map(Attention::as_str), "hooked": st.activity.hook_driven }),
  );
  set_working(&s.key, st.agent_present && busy);
  if let Some(reason) = notify {
    if Instant::now() >= st.startup_until {
      let summary = st.model.tail(8);
      emit(&st.sender, "pty:done", json!({ "key": s.key, "reason": reason.as_str(), "summary": summary }));
    }
  }
}

// Terminals whose CLI agent is working right now.
fn set_working(key: &str, on: bool) {
  let mut w = WORKING.get_or_init(Default::default).lock().unwrap();
  if on {
    w.insert(key.to_string());
  } else {
    w.remove(key);
  }
}

/// How many terminal agents are working (Node's quit confirmation asks).
pub fn working_count() -> usize {
  WORKING.get_or_init(Default::default).lock().unwrap().len()
}

/// An agent hook for a pane, from the hook route (services/mcp/hooks.rs).
pub struct AgentHook<'a> {
  pub pane: &'a str,
  pub agent: &'a str,
  /// working | idle | needs_input
  pub event: &'a str,
  /// The CLI's hook name (SessionStart, Stop, ...).
  pub hook: &'a str,
  pub session_id: Option<String>,
  /// What the agent answered, when this hook ended a turn.
  pub reply: Option<String>,
}

pub fn hook(h: &AgentHook) {
  let pane = h.pane.to_string();
  let Some(s) = get(&pane) else { return };
  let agent = h.agent.to_string();
  let hook = h.hook;
  let session_id = h.session_id.clone();
  let mut st = lock(&s);
  cancel_timer(&mut st);
  st.awaiting_reply = false;
  // Remember WHICH conversation this terminal's CLI is having, so the pane
  // can come back to it after a restart. SessionEnd means the user left on
  // purpose: forget it.
  let next = if hook == "SessionEnd" { None } else { session_id.clone().or_else(|| st.agent_session_id.clone()) };
  let next_kind = next.as_ref().map(|_| {
    if session_id.is_some() {
      agent.clone()
    } else {
      st.agent_session_kind.clone().unwrap_or_else(|| agent.clone())
    }
  });
  if next != st.agent_session_id || next_kind != st.agent_session_kind {
    st.agent_session_id = next.clone();
    st.agent_session_kind = next_kind.clone();
    emit(&st.sender, "pty:agentSession", json!({ "key": pane, "sessionId": next, "agent": next_kind }));
  }
  let notify = HookEvent::parse(h.event).and_then(|e| st.activity.hook(e));
  publish(&s, &mut st, notify);
  // A finished turn's answer, for whoever asked this pane something.
  if let Some(text) = &h.reply {
    emit(&st.sender, "pty:reply", json!({ "key": pane, "text": text }));
  }
}

fn agent_re() -> &'static regex::Regex {
  static RE: OnceLock<regex::Regex> = OnceLock::new();
  RE.get_or_init(|| {
    regex::Regex::new(
      r"(?i)(?:^|/|\s)(claude|codex|aider|gemini|opencode|cursor-agent|ollama|goose|crush|cline|amp)(?:\s|$)|[\\/](?:share|bin)[\\/]claude[\\/]",
    )
    .unwrap()
  })
}

// The name of the agent running as the shell's foreground child, or None.
async fn agent_running(pid: u32) -> Option<String> {
  let run = |prog: &'static str, args: Vec<String>| async move {
    let out = tokio::time::timeout(
      Duration::from_millis(1500),
      tokio::process::Command::new(prog).args(&args).kill_on_drop(true).output(),
    )
    .await
    .ok()?
    .ok()?;
    Some(String::from_utf8_lossy(&out.stdout).into_owned())
  };
  let kids = run("/usr/bin/pgrep", vec!["-P".into(), pid.to_string()]).await?;
  let kids: Vec<&str> = kids.split('\n').filter(|l| !l.is_empty()).collect();
  if kids.is_empty() {
    return None;
  }
  let args = run("/bin/ps", vec!["-o".into(), "args=".into(), "-p".into(), kids.join(",")]).await?;
  let c = agent_re().captures(&args)?;
  // The path-based branch (no capture group) is claude.
  Some(c.get(1).map(|m| m.as_str().to_string()).unwrap_or_else(|| "claude".into()))
}

// Whether an agent is the foreground child (tab title, context routing, and
// the heuristic's gate).
async fn probe_loop(s: Arc<Session>) {
  loop {
    tokio::time::sleep(POLL).await;
    {
      let mut st = lock(&s);
      if st.dead {
        return;
      }
      if st.polling || s.pid == 0 {
        continue;
      }
      // No agent and a silent terminal: skip the probe. An agent can only
      // appear after output flows, which refreshes last_data.
      if !st.agent_present && st.last_data.elapsed() > IDLE_POLL {
        continue;
      }
      // A hook-reporting agent tells us when it works and stops; the probe
      // only has to notice it exiting, which can wait a few seconds.
      if st.agent_present && st.activity.hook_driven && st.last_probe.is_some_and(|t| t.elapsed() < HOOKED_POLL) {
        continue;
      }
      st.last_probe = Some(Instant::now());
      st.polling = true;
    }
    let name = agent_running(s.pid).await;
    let mut st = lock(&s);
    st.polling = false;
    if st.dead {
      return;
    }
    let was = st.agent_present;
    let was_name = st.agent_name.clone();
    st.agent_present = name.is_some();
    st.agent_name = name.clone();
    if st.agent_present != was || name != was_name {
      emit(&st.sender, "pty:agent", json!({ "key": s.key, "agent": st.agent_present, "name": name }));
    }
    // Agent gone: not running, and its hooks are gone with it. An unread
    // "finished" is kept.
    if !st.agent_present && was {
      cancel_timer(&mut st);
      st.activity.agent_gone();
      publish(&s, &mut st, None);
    }
  }
}

// ---- remote (a paired phone, see src/renderer/src/state/remoteTerms.ts) ---------
//
// The page decides WHO may look and type (the device's capabilities, the
// pane's opt-in) and redacts what it sends. These two are the last gate and do
// not trust the page either: text is only read from the model, and input is
// limited to a fixed set of keys or one cleaned line, written only while an
// agent is the terminal's foreground program. No raw bytes from a phone ever
// reach a pty.

/// Longest line a phone may type, in characters.
const REMOTE_LINE_MAX: usize = 500;
/// The pause between a typed line and its Enter (askAgent.ts says why).
const REMOTE_ENTER_DELAY: Duration = Duration::from_millis(120);

#[derive(Serialize)]
pub struct RemoteText {
  /// What the text reflects: parsed chunks and size. Equal = unchanged.
  pub rev: String,
  /// The last lines, or None when `rev` is what the caller already has.
  pub text: Option<String>,
  /// An agent is the foreground program right now.
  pub agent: bool,
}

/// The tail of a terminal as plain text, for a phone watching it. Formats
/// only when the model moved since `since`, so an idle watched pane costs a
/// lock and a compare.
pub fn remote_text(key: &str, lines: usize, since: &str) -> Option<RemoteText> {
  let s = get(key)?;
  let st = lock(&s);
  if st.dead {
    return None;
  }
  let rev = format!("{}:{}x{}", st.parsed, st.cols, st.rows);
  let agent = st.agent_present;
  if rev == since {
    return Some(RemoteText { rev, text: None, agent });
  }
  let all = st.model.text();
  drop(st);
  Some(RemoteText { rev, text: Some(last_lines(&all, lines)), agent })
}

fn last_lines(all: &str, n: usize) -> String {
  let trimmed = all.trim_end_matches(['\n', ' ']);
  let lines: Vec<&str> = trimmed.split('\n').collect();
  lines[lines.len().saturating_sub(n)..].join("\n")
}

/// The bytes of a key a phone may press: answering a prompt, nothing more.
/// Ctrl+C and every other control key are deliberately absent.
fn remote_key(k: &str) -> Option<&'static str> {
  Some(match k {
    "1" => "1",
    "2" => "2",
    "3" => "3",
    "4" => "4",
    "5" => "5",
    "6" => "6",
    "7" => "7",
    "8" => "8",
    "9" => "9",
    "enter" => "\r",
    "esc" => "\x1b",
    "up" => "\x1b[A",
    "down" => "\x1b[B",
    _ => return None,
  })
}

/// One line of prompt text with every control character gone: no ESC (so no
/// bracketed-paste end marker or any other sequence), no CR/LF (so it cannot
/// submit early or become two prompts), no C1, and no invisible or
/// direction-changing format characters. None if nothing usable is left.
fn clean_remote_line(t: &str) -> Option<String> {
  let kept: String = t
    .chars()
    .filter(|&c| {
      !c.is_control()
        && !matches!(c, '\u{200B}'..='\u{200F}' | '\u{2028}'..='\u{202E}' | '\u{2060}'..='\u{2069}' | '\u{FEFF}')
    })
    .collect();
  let kept = kept.trim();
  if kept.is_empty() || kept.chars().count() > REMOTE_LINE_MAX {
    return None;
  }
  Some(kept.to_string())
}

/// Type into a terminal for a phone: exactly one of `text` (a line, then
/// Enter) or `key` (one of remote_key's). False if refused.
pub fn remote_input(key: &str, text: Option<&str>, k: Option<&str>) -> bool {
  let (data, submit) = match (text, k) {
    (Some(t), None) => match clean_remote_line(t) {
      Some(c) => (c, true),
      None => return false,
    },
    (None, Some(k)) => match remote_key(k) {
      Some(b) => (b.to_string(), false),
      None => return false,
    },
    _ => return false,
  };
  let Some(s) = get(key) else { return false };
  {
    let st = lock(&s);
    if st.dead || !st.agent_present {
      return false;
    }
  }
  ctl(Op::Write(key.to_string(), data));
  if submit {
    let key = key.to_string();
    tauri::async_runtime::spawn(async move {
      tokio::time::sleep(REMOTE_ENTER_DELAY).await;
      ctl(Op::Write(key, "\r".into()));
    });
  }
  true
}

// ---- text -----------------------------------------------------------------------

// Decode a read into whole characters. Invalid sequences become U+FFFD (as
// Node's decoder did); an incomplete one at the end waits for the next read.
fn decode_utf8(carry: &mut Vec<u8>, input: &[u8]) -> String {
  let joined;
  let mut rest: &[u8] = if carry.is_empty() {
    input
  } else {
    let mut v = std::mem::take(carry);
    v.extend_from_slice(input);
    joined = v;
    &joined
  };
  let mut out = String::with_capacity(rest.len());
  loop {
    match std::str::from_utf8(rest) {
      Ok(s) => {
        out.push_str(s);
        break;
      }
      Err(e) => {
        let (valid, after) = rest.split_at(e.valid_up_to());
        out.push_str(unsafe { std::str::from_utf8_unchecked(valid) });
        match e.error_len() {
          Some(n) => {
            out.push('\u{FFFD}');
            rest = &after[n..];
          }
          None => {
            *carry = after.to_vec();
            break;
          }
        }
      }
    }
  }
  out
}

fn utf16_len(s: &str) -> usize {
  // Every byte of ASCII is one unit; only multibyte text needs the walk.
  if s.is_ascii() {
    s.len()
  } else {
    s.chars().map(char::len_utf16).sum()
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn utf8_split_across_reads() {
    let mut carry = Vec::new();
    let all = "a한😀b".as_bytes();
    let mut out = String::new();
    for b in all {
      out.push_str(&decode_utf8(&mut carry, std::slice::from_ref(b)));
    }
    assert_eq!(out, "a한😀b");
    assert!(carry.is_empty());
    assert_eq!(decode_utf8(&mut carry, b"x\xffy"), "x\u{FFFD}y");
    assert_eq!(utf16_len("a한😀"), 4);
  }

  #[test]
  fn remote_input_is_cleaned_and_bounded() {
    assert_eq!(clean_remote_line("  fix the bug  ").as_deref(), Some("fix the bug"));
    // Bracketed-paste end marker, CR/LF, Ctrl+C, C1 and bidi overrides are gone.
    assert_eq!(clean_remote_line("a\x1b[201~b\r\nc\x03\u{9b}d\u{202e}e").as_deref(), Some("a[201~bcde"));
    assert_eq!(clean_remote_line("\x1b\r\n"), None);
    assert!(clean_remote_line(&"x".repeat(REMOTE_LINE_MAX)).is_some());
    assert!(clean_remote_line(&"x".repeat(REMOTE_LINE_MAX + 1)).is_none());
    assert_eq!(remote_key("enter"), Some("\r"));
    assert_eq!(remote_key("up"), Some("\x1b[A"));
    assert_eq!(remote_key("0"), None);
    assert_eq!(remote_key("ctrl+c"), None);
    assert_eq!(remote_key("\x03"), None);
    assert_eq!(last_lines("a\nb\nc\n\n", 2), "b\nc");
  }

  #[test]
  fn agent_regex() {
    assert!(agent_re().is_match("claude --resume x"));
    assert!(agent_re().is_match("/Users/a/.local/share/claude/versions/2.1/claude"));
    assert!(!agent_re().is_match("vim claude.md"));
  }
}
