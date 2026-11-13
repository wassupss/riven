// The Node.js debugger (was src/main/debugger.ts): runs the user's `node`
// (login PATH; nothing bundled) with --inspect-brk and drives the V8
// inspector over CDP on its loopback WebSocket. One session at a time.
// Breakpoints, stepping, call stack, the top frame's scopes, properties and
// evaluate on a frame. TypeScript entry files run with
// --experimental-strip-types (Node >= 22.6).
//
// Events go to the page that started the session as 'debug:event'
// {type, payload}: started, paused {reason, frames, scopes}, resumed,
// output {level, text}, terminated {code}. Same shapes as the Node module.
//
// Node reports script URLs by their real path (/tmp -> /private/tmp), so
// breakpoint files are realpath'd before they become file URLs.

use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::path::Path;
use std::process::{Child, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::AppHandle;
use tokio::sync::oneshot;

static APP: OnceLock<AppHandle> = OnceLock::new();

pub fn init(app: &AppHandle) {
  let _ = APP.set(app.clone());
}

type Pending = oneshot::Sender<Result<Value, String>>;

struct Session {
  gen: u64,
  sink: String,
  child: Mutex<Option<Child>>,
  ws: Mutex<Option<TcpStream>>,
  next_id: AtomicU64,
  pending: Mutex<HashMap<u64, Pending>>,
  scripts: Mutex<HashMap<String, String>>,
}

#[derive(Default)]
struct State {
  session: Option<Arc<Session>>,
  /// path -> 1-based lines, applied at start and while running.
  breakpoints: Vec<(String, Vec<i64>)>,
}

static STATE: OnceLock<Mutex<State>> = OnceLock::new();
static GEN: AtomicU64 = AtomicU64::new(1);

fn state() -> std::sync::MutexGuard<'static, State> {
  STATE.get_or_init(Default::default).lock().unwrap()
}

fn current() -> Option<Arc<Session>> {
  state().session.clone()
}

fn emit(sink: &str, kind: &str, payload: Option<Value>) {
  let Some(app) = APP.get() else { return };
  let mut ev = Map::new();
  ev.insert("type".into(), Value::String(kind.into()));
  if let Some(p) = payload {
    ev.insert("payload".into(), p);
  }
  crate::commands::emit_ipc(app, sink, "debug:event", json!([Value::Object(ev)]));
}

fn realpath(p: &str) -> String {
  std::fs::canonicalize(p).map(|r| r.to_string_lossy().into_owned()).unwrap_or_else(|_| p.to_string())
}

fn file_url(p: &str) -> String {
  url::Url::from_file_path(realpath(p)).map(|u| u.to_string()).unwrap_or_else(|_| format!("file://{p}"))
}

fn url_to_path(u: &str) -> String {
  if !u.starts_with("file:") {
    return String::new();
  }
  url::Url::parse(u).ok().and_then(|u| u.to_file_path().ok()).map(|p| p.to_string_lossy().into_owned()).unwrap_or_default()
}

/// JS String(v) for a CDP RemoteObject's primitive value.
fn js_string(v: &Value) -> String {
  match v {
    Value::String(s) => s.clone(),
    Value::Number(n) => crate::services::db::js::num_str(n.as_f64().unwrap_or(0.0)),
    Value::Bool(b) => b.to_string(),
    Value::Null => "null".into(),
    other => other.to_string(),
  }
}

/// description, else String(value), else 'undefined' (the Node module's value text).
fn value_text(v: &Value) -> String {
  if let Some(d) = v.get("description").and_then(Value::as_str) {
    return d.to_string();
  }
  match v.get("value") {
    Some(x) => js_string(x),
    None => "undefined".into(),
  }
}

// ---- the WebSocket to the inspector (client side: masked frames) ------------------------

fn ws_connect(url: &str) -> Result<TcpStream, String> {
  let rest = url.strip_prefix("ws://").ok_or("inspector connect failed")?;
  let (host, path) = rest.split_once('/').map(|(h, p)| (h, format!("/{p}"))).unwrap_or((rest, "/".into()));
  let mut s = TcpStream::connect(host).map_err(|_| "inspector connect failed".to_string())?;
  let _ = s.set_nodelay(true);
  let key = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, rand16());
  let req = format!("GET {path} HTTP/1.1\r\nHost: {host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n");
  s.write_all(req.as_bytes()).map_err(|_| "inspector connect failed".to_string())?;
  // Read the response headers byte by byte so no frame bytes are consumed.
  let mut head = Vec::new();
  let mut b = [0u8; 1];
  while !head.ends_with(b"\r\n\r\n") {
    if s.read(&mut b).map_err(|_| "inspector connect failed".to_string())? == 0 || head.len() > 16 * 1024 {
      return Err("inspector connect failed".into());
    }
    head.push(b[0]);
  }
  if !head.starts_with(b"HTTP/1.1 101") {
    return Err("inspector connect failed".into());
  }
  Ok(s)
}

fn rand16() -> [u8; 16] {
  let mut b = [0u8; 16];
  if std::fs::File::open("/dev/urandom").and_then(|mut f| f.read_exact(&mut b)).is_err() {
    let t = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos();
    b = t.to_le_bytes();
  }
  b
}

fn ws_send(s: &mut TcpStream, text: &str) -> std::io::Result<()> {
  let p = text.as_bytes();
  let mut f = Vec::with_capacity(p.len() + 14);
  f.push(0x81);
  match p.len() {
    n if n < 126 => f.push(0x80 | n as u8),
    n if n <= 0xFFFF => {
      f.push(0x80 | 126);
      f.extend_from_slice(&(n as u16).to_be_bytes());
    }
    n => {
      f.push(0x80 | 127);
      f.extend_from_slice(&(n as u64).to_be_bytes());
    }
  }
  let m = rand16();
  let mask = [m[0], m[1], m[2], m[3]];
  f.extend_from_slice(&mask);
  f.extend(p.iter().enumerate().map(|(i, b)| b ^ mask[i % 4]));
  s.write_all(&f)
}

/// The next whole text message (fragments joined); None when the socket closes.
fn ws_read(r: &mut impl Read) -> Option<String> {
  let mut msg = Vec::new();
  loop {
    let mut h = [0u8; 2];
    r.read_exact(&mut h).ok()?;
    let fin = h[0] & 0x80 != 0;
    let op = h[0] & 0x0F;
    let masked = h[1] & 0x80 != 0;
    let mut len = (h[1] & 0x7F) as u64;
    if len == 126 {
      let mut b = [0u8; 2];
      r.read_exact(&mut b).ok()?;
      len = u16::from_be_bytes(b) as u64;
    } else if len == 127 {
      let mut b = [0u8; 8];
      r.read_exact(&mut b).ok()?;
      len = u64::from_be_bytes(b);
    }
    let mut mask = [0u8; 4];
    if masked {
      r.read_exact(&mut mask).ok()?;
    }
    let mut p = vec![0u8; len as usize];
    r.read_exact(&mut p).ok()?;
    if masked {
      for (i, b) in p.iter_mut().enumerate() {
        *b ^= mask[i % 4];
      }
    }
    match op {
      0x8 => return None,
      0x9 | 0xA => continue, // ping/pong: the inspector does not send them
      _ => msg.extend_from_slice(&p),
    }
    if fin {
      return Some(String::from_utf8_lossy(&msg).into_owned());
    }
  }
}

// ---- CDP ------------------------------------------------------------------------------------

impl Session {
  fn send(&self, method: &str, params: Value) -> oneshot::Receiver<Result<Value, String>> {
    let (tx, rx) = oneshot::channel();
    let id = self.next_id.fetch_add(1, Ordering::Relaxed);
    let mut ws = self.ws.lock().unwrap();
    let Some(s) = ws.as_mut() else {
      let _ = tx.send(Err("no debug session".into()));
      return rx;
    };
    self.pending.lock().unwrap().insert(id, tx);
    let line = json!({ "id": id, "method": method, "params": params }).to_string();
    if ws_send(s, &line).is_err() {
      if let Some(tx) = self.pending.lock().unwrap().remove(&id) {
        let _ = tx.send(Err("no debug session".into()));
      }
    }
    rx
  }
}

async fn send(method: &str, params: Value) -> Result<Value, String> {
  let s = current().ok_or("no debug session")?;
  s.send(method, params).await.unwrap_or_else(|_| Err("no debug session".into()))
}

fn on_paused(s: &Session, params: &Value) {
  let empty = Vec::new();
  let call_frames = params.get("callFrames").and_then(Value::as_array).unwrap_or(&empty);
  let scripts = s.scripts.lock().unwrap();
  let frames: Vec<Value> = call_frames
    .iter()
    .map(|f| {
      let loc = f.get("location").cloned().unwrap_or(Value::Null);
      let sid = loc.get("scriptId").and_then(Value::as_str).unwrap_or("");
      let url = scripts.get(sid).cloned().unwrap_or_default();
      let name = f.get("functionName").and_then(Value::as_str).filter(|n| !n.is_empty()).unwrap_or("(anonymous)");
      json!({
        "id": f.get("callFrameId").cloned().unwrap_or(Value::Null),
        "name": name,
        "file": url_to_path(&url),
        "line": loc.get("lineNumber").and_then(Value::as_i64).unwrap_or(0) + 1,
        "column": loc.get("columnNumber").and_then(Value::as_i64).unwrap_or(0) + 1,
      })
    })
    .collect();
  drop(scripts);
  // The top frame's scopes, without the (huge) global one.
  let scopes: Vec<Value> = call_frames
    .first()
    .and_then(|t| t.get("scopeChain"))
    .and_then(Value::as_array)
    .map(|chain| {
      chain
        .iter()
        .filter(|c| c.get("type").and_then(Value::as_str) != Some("global"))
        .map(|c| {
          let mut o = Map::new();
          o.insert("type".into(), c.get("type").cloned().unwrap_or(Value::Null));
          if let Some(n) = c.get("name").and_then(Value::as_str).filter(|n| !n.is_empty()) {
            o.insert("name".into(), Value::String(n.into()));
          }
          if let Some(id) = c.get("object").and_then(|o| o.get("objectId")).cloned() {
            o.insert("objectId".into(), id);
          }
          Value::Object(o)
        })
        .collect()
    })
    .unwrap_or_default();
  let mut payload = Map::new();
  if let Some(r) = params.get("reason") {
    payload.insert("reason".into(), r.clone());
  }
  payload.insert("frames".into(), Value::Array(frames));
  payload.insert("scopes".into(), Value::Array(scopes));
  emit(&s.sink, "paused", Some(Value::Object(payload)));
}

fn reader(s: Arc<Session>, mut r: TcpStream) {
  while let Some(text) = ws_read(&mut r) {
    let Ok(msg) = serde_json::from_str::<Value>(&text) else { continue };
    if let Some(id) = msg.get("id").and_then(Value::as_u64) {
      if let Some(tx) = s.pending.lock().unwrap().remove(&id) {
        let r = match msg.get("error") {
          Some(e) => Err(e.get("message").and_then(Value::as_str).unwrap_or("").to_string()),
          None => Ok(msg.get("result").cloned().unwrap_or(Value::Null)),
        };
        let _ = tx.send(r);
        continue;
      }
    }
    let p = msg.get("params").cloned().unwrap_or(Value::Null);
    match msg.get("method").and_then(Value::as_str).unwrap_or("") {
      "Debugger.scriptParsed" => {
        let id = p.get("scriptId").and_then(Value::as_str).unwrap_or("").to_string();
        let url = p.get("url").and_then(Value::as_str).unwrap_or("").to_string();
        s.scripts.lock().unwrap().insert(id, url);
      }
      "Debugger.paused" => on_paused(&s, &p),
      "Debugger.resumed" => emit(&s.sink, "resumed", None),
      "Runtime.consoleAPICalled" => {
        let empty = Vec::new();
        let args = p.get("args").and_then(Value::as_array).unwrap_or(&empty);
        let text: Vec<String> = args
          .iter()
          .map(|a| match a.get("value") {
            Some(v) => js_string(v),
            None => a.get("description").and_then(Value::as_str).unwrap_or("").to_string(),
          })
          .collect();
        emit(&s.sink, "output", Some(json!({ "level": p.get("type").cloned().unwrap_or(Value::Null), "text": text.join(" ") })));
      }
      "Runtime.exceptionThrown" => {
        let d = p.get("exceptionDetails").cloned().unwrap_or(Value::Null);
        let text = d
          .get("exception")
          .and_then(|e| e.get("description"))
          .and_then(Value::as_str)
          .filter(|t| !t.is_empty())
          .or_else(|| d.get("text").and_then(Value::as_str).filter(|t| !t.is_empty()))
          .unwrap_or("exception");
        emit(&s.sink, "output", Some(json!({ "level": "error", "text": text })));
      }
      _ => {}
    }
  }
  // The socket closed: nothing more will answer.
  for (_, tx) in s.pending.lock().unwrap().drain() {
    let _ = tx.send(Err("no debug session".into()));
  }
}

async fn apply_breakpoints(file: &str, lines: &[i64]) {
  let url = file_url(file);
  for l in lines {
    // A file not parsed yet is fine: Node binds pending breakpoints on parse.
    let _ = send("Debugger.setBreakpointByUrl", json!({ "url": url, "lineNumber": (l - 1).max(0), "columnNumber": 0 })).await;
  }
}

async fn connect(s: Arc<Session>, url: String) -> Result<(), String> {
  let sock = tokio::task::spawn_blocking(move || ws_connect(&url)).await.map_err(|e| e.to_string())??;
  let r = sock.try_clone().map_err(|e| e.to_string())?;
  *s.ws.lock().unwrap() = Some(sock);
  {
    let s = s.clone();
    std::thread::Builder::new().name("debug-cdp".into()).spawn(move || reader(s, r)).map_err(|e| e.to_string())?;
  }
  send("Runtime.enable", json!({})).await?;
  send("Debugger.enable", json!({})).await?;
  send("Debugger.setPauseOnExceptions", json!({ "state": "uncaught" })).await?;
  // Breakpoints set before launch.
  let bps = state().breakpoints.clone();
  for (f, lines) in bps {
    apply_breakpoints(&f, &lines).await;
  }
  send("Runtime.runIfWaitingForDebugger", json!({})).await?;
  emit(&s.sink, "started", None);
  Ok(())
}

fn cleanup_session(s: &Session) {
  if let Some(ws) = s.ws.lock().unwrap().take() {
    let _ = ws.shutdown(std::net::Shutdown::Both);
  }
  s.scripts.lock().unwrap().clear();
  s.pending.lock().unwrap().clear();
  if let Some(mut c) = s.child.lock().unwrap().take() {
    let _ = c.kill();
    let _ = c.wait();
  }
}

/// Drop the current session (if `gen` is given, only if it is still that one).
fn cleanup(gen: Option<u64>) {
  let s = {
    let mut st = state();
    match (&st.session, gen) {
      (Some(cur), Some(g)) if cur.gen != g => return,
      _ => st.session.take(),
    }
  };
  if let Some(s) = s {
    cleanup_session(&s);
  }
}

// ---- the channels ---------------------------------------------------------------------------

pub async fn start(cfg: Value, sink: String) -> Value {
  cleanup(None); // one session at a time
  let file_arg = cfg.get("file").and_then(Value::as_str).unwrap_or("").to_string();
  let file = realpath(&file_arg);
  let is_ts = [".ts", ".tsx", ".mts", ".cts"].iter().any(|e| file.ends_with(e));
  let Some(node) = crate::services::shell_env::which("node") else {
    return json!({ "ok": false, "error": "node was not found on PATH (the debugger runs your installed Node.js)" });
  };
  let mut args = vec!["--inspect-brk=127.0.0.1:0".to_string()];
  if is_ts {
    args.push("--experimental-strip-types".into());
  }
  args.push(file.clone());
  if let Some(a) = cfg.get("args").and_then(Value::as_array) {
    args.extend(a.iter().map(js_string));
  }
  let cwd = cfg
    .get("cwd")
    .and_then(Value::as_str)
    .filter(|c| !c.is_empty())
    .map(str::to_string)
    .unwrap_or_else(|| Path::new(&file_arg).parent().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default());
  let mut cmd = crate::services::shell_env::command(&node);
  cmd.args(&args).current_dir(&cwd).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
  let mut child = match cmd.spawn() {
    Ok(c) => c,
    Err(e) => return json!({ "ok": false, "error": format!("Error: spawn {} {e}", node.display()) }),
  };
  let gen = GEN.fetch_add(1, Ordering::Relaxed);
  let stdout = child.stdout.take();
  let stderr = child.stderr.take();
  let s = Arc::new(Session {
    gen,
    sink: sink.clone(),
    child: Mutex::new(Some(child)),
    ws: Mutex::new(None),
    next_id: AtomicU64::new(1),
    pending: Mutex::new(HashMap::new()),
    scripts: Mutex::new(HashMap::new()),
  });
  state().session = Some(s.clone());

  if let Some(mut out) = stdout {
    let sink = sink.clone();
    std::thread::spawn(move || {
      let mut b = [0u8; 16 * 1024];
      while let Ok(n) = out.read(&mut b) {
        if n == 0 {
          break;
        }
        if current().is_some_and(|c| c.gen == gen) {
          emit(&sink, "output", Some(json!({ "level": "stdout", "text": String::from_utf8_lossy(&b[..n]) })));
        }
      }
    });
  }

  // stderr: Node prints "Debugger listening on ws://127.0.0.1:PORT/UUID" there.
  let (url_tx, url_rx) = oneshot::channel::<Option<String>>();
  {
    let sink = sink.clone();
    let s2 = s.clone();
    let mut url_tx = Some(url_tx);
    std::thread::spawn(move || {
      if let Some(err) = stderr {
        let mut r = BufReader::new(err);
        loop {
          let chunk = match r.fill_buf() {
            Ok([]) | Err(_) => break,
            Ok(c) => c.to_vec(),
          };
          r.consume(chunk.len());
          let text = String::from_utf8_lossy(&chunk).into_owned();
          let found = text.find("ws://").map(|i| text[i..].split_whitespace().next().unwrap_or("").to_string());
          match found {
            Some(u) if url_tx.is_some() => {
              let _ = url_tx.take().unwrap().send(Some(u));
            }
            Some(_) => {}
            None => {
              if current().is_some_and(|c| c.gen == gen) {
                emit(&sink, "output", Some(json!({ "level": "stderr", "text": text })));
              }
            }
          }
        }
      }
      if let Some(tx) = url_tx.take() {
        let _ = tx.send(None);
      }
      // stderr closes when node exits: report it and drop the session.
      let code = {
        let c = s2.child.lock().unwrap().take();
        c.and_then(|mut c| c.wait().ok()).and_then(|st| st.code())
      };
      if current().is_some_and(|c| c.gen == gen) {
        emit(&sink, "terminated", Some(json!({ "code": code })));
        cleanup(Some(gen));
      }
    });
  }

  match url_rx.await.ok().flatten() {
    Some(u) => match connect(s, u).await {
      Ok(()) => json!({ "ok": true }),
      Err(e) => {
        cleanup(Some(gen));
        json!({ "ok": false, "error": format!("Error: {e}") })
      }
    },
    // Exited before it listened (bad file, old Node). The terminated event says so.
    None => json!({ "ok": false, "error": "Error: node exited before the inspector started" }),
  }
}

pub fn stop(sink: &str) -> Value {
  let s = current();
  cleanup(None);
  emit(s.as_ref().map(|s| s.sink.as_str()).unwrap_or(sink), "terminated", Some(json!({ "code": Value::Null })));
  json!({ "ok": true })
}

pub async fn step(method: &str) -> Value {
  send(method, json!({})).await.unwrap_or_else(|_| json!({}))
}

pub async fn set_breakpoints(file: String, lines: Vec<i64>) -> Value {
  {
    let mut st = state();
    match st.breakpoints.iter_mut().find(|(f, _)| *f == file) {
      Some(e) => e.1 = lines.clone(),
      None => st.breakpoints.push((file.clone(), lines.clone())),
    }
  }
  if current().is_some_and(|s| s.ws.lock().unwrap().is_some()) {
    apply_breakpoints(&file, &lines).await;
  }
  json!({ "ok": true })
}

pub async fn get_properties(object_id: String) -> Value {
  let Ok(r) = send("Runtime.getProperties", json!({ "objectId": object_id, "ownProperties": true, "generatePreview": true })).await else {
    return json!([]);
  };
  let empty = Vec::new();
  let props = r.get("result").and_then(Value::as_array).unwrap_or(&empty);
  Value::Array(
    props
      .iter()
      .filter(|p| p.get("enumerable") != Some(&Value::Bool(false)))
      .map(|p| {
        let v = p.get("value").cloned().unwrap_or(json!({}));
        json!({
          "name": p.get("name").cloned().unwrap_or(Value::Null),
          "type": v.get("type").and_then(Value::as_str).unwrap_or("undefined"),
          "value": value_text(&v),
          "objectId": v.get("objectId").cloned().unwrap_or(Value::Null),
        })
      })
      .collect(),
  )
}

pub async fn evaluate(call_frame_id: String, expression: String) -> Value {
  match send(
    "Debugger.evaluateOnCallFrame",
    json!({ "callFrameId": call_frame_id, "expression": expression, "returnByValue": false, "generatePreview": true }),
  )
  .await
  {
    Ok(r) => {
      let v = r.get("result").cloned().unwrap_or(json!({}));
      json!({
        "value": value_text(&v),
        "type": v.get("type").and_then(Value::as_str).unwrap_or("undefined"),
        "objectId": v.get("objectId").cloned().unwrap_or(Value::Null),
      })
    }
    Err(e) => json!({ "value": format!("Error: {e}"), "type": "error", "objectId": Value::Null }),
  }
}

/// Quit: no orphaned debuggee.
pub fn shutdown() {
  cleanup(None);
}
