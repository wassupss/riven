// riven's own MCP tool server: the tools agents get (ask_user, open file,
// panels, browser, notes, agents, DB, ...) over Streamable-HTTP on a loopback
// port, plus the agent hook route on the same port. Port of
// src/main/mcpServer.ts + agentHooks.ts + agents.ts + agentEdits.ts and the
// riven environment and zsh shim src/main/pty.ts gave a terminal.
//
// Every agent riven starts (a chat pane's CLI, or a CLI typed in a riven
// terminal) gets a URL that names its pane and a per-run token; nothing is
// written into the user's CLI configs. A tools/call is done by the app page
// (Rust sends 'mcp:invoke', the page answers 'mcp:result'), except the tools
// whose engine is still Node (the HTTP request): it goes to Node on the
// control line ('mcpTool', answered with 'mcp.toolResult'). The DB tools run
// here (services/db/engine.rs).
//
// The tool catalog and the tool prompt are not written here: catalog.json is
// generated from src/main/mcpServer.ts by tauri/build.mjs, so the Electron and
// Tauri builds offer agents the same tools, schemas, descriptions and prompt.
//
// Why a hand-rolled HTTP server (http.rs) and not rmcp + axum: the Node one
// was hand-rolled too (JSON responses only, no SSE leg: a tools-only server
// never needs it, verified against both CLIs), it is ~300 lines, and nothing
// in this process compiles hyper today. rmcp's streamable-http server would
// bring axum, hyper, tower and an SSE stack for the same 6 methods, and its
// session handling differs from what agents saw so far (one Mcp-Session-Id
// for the whole run, notifications answered 202, a cancelled call answered
// in words).

mod http;
pub mod hooks;
mod shim;

use crate::services::chat::util;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::net::TcpStream;
use std::sync::{mpsc, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

/// How long riven waits on a tool call that needs a person (ask_user). Agents
/// are told to wait as long (MCP_TOOL_TIMEOUT, the server's `timeout`).
pub const REQUEST_TIMEOUT_MS: u64 = 1_800_000;
/// allowedTools entry so every riven tool auto-approves in a chat pane.
pub const TOOL_PREFIX: &str = "mcp__riven";

const RELOADED: &str = "riven: the app reloaded before this could be answered \u{2014} ask again if you still need it.";
const CANCELLED: &str = "riven: the caller cancelled this request";
const TIMED_OUT: &str = "riven: timed out waiting for the user";
const NO_WINDOW: &str = "riven: no window available";

static APP: OnceLock<AppHandle> = OnceLock::new();

// ---- the server -------------------------------------------------------------------

struct Server {
  base: Option<String>,
  // Random per run and only ever handed to processes riven spawns (or shells
  // riven opens), so a config copied elsewhere cannot drive this app after a
  // restart.
  token: String,
  session: String,
}

static SERVER: OnceLock<Server> = OnceLock::new();

fn server() -> &'static Server {
  SERVER.get_or_init(|| {
    let base = http::listen().map(|port| format!("http://127.0.0.1:{port}"));
    if base.is_none() {
      eprintln!("[mcp] loopback server failed to listen; agents run without riven's tools and hooks");
    }
    Server { base, token: util::uuid(), session: util::uuid() }
  })
}

/// Start the server (before any terminal or chat pane can ask for its URL)
/// and write the zsh shim.
pub fn init(app: &AppHandle) {
  let _ = APP.set(app.clone());
  server();
  shim::setup();
}

pub fn base_url() -> Option<&'static str> {
  server().base.as_deref()
}

pub fn token() -> &'static str {
  &server().token
}

// ---- the catalog --------------------------------------------------------------------

struct Tool {
  name: String,
  def: Value,
  implemented: bool,
  advertised: bool,
}

struct Catalog {
  tools: Vec<Tool>,
  head: String,
  lines: Vec<(Vec<String>, String)>,
}

fn catalog() -> &'static Catalog {
  static C: OnceLock<Catalog> = OnceLock::new();
  C.get_or_init(|| {
    let v: Value = serde_json::from_str(include_str!("catalog.json")).expect("mcp catalog.json");
    let tools = v["tools"]
      .as_array()
      .map(|a| {
        a.iter()
          .map(|t| Tool {
            name: t["name"].as_str().unwrap_or("").to_string(),
            def: json!({ "name": t["name"], "description": t["description"], "inputSchema": t["inputSchema"] }),
            implemented: t["implemented"].as_bool().unwrap_or(false),
            advertised: t["advertised"].as_bool().unwrap_or(true),
          })
          .collect()
      })
      .unwrap_or_default();
    let lines = v["promptLines"]
      .as_array()
      .map(|a| {
        a.iter()
          .map(|l| {
            let tools = l[0].as_array().map(|x| x.iter().filter_map(Value::as_str).map(str::to_string).collect()).unwrap_or_default();
            (tools, l[1].as_str().unwrap_or("").to_string())
          })
          .collect()
      })
      .unwrap_or_default();
    Catalog { tools, head: v["promptHead"].as_str().unwrap_or("").to_string(), lines }
  })
}

fn tool(name: &str) -> Option<&'static Tool> {
  catalog().tools.iter().find(|t| t.name == name)
}

/// Tool names this build can service, as advertised to agents.
pub fn implemented_tool_names() -> Vec<String> {
  catalog().tools.iter().filter(|t| t.implemented && t.advertised).map(|t| t.name.clone()).collect()
}

fn tool_defs(enabled: Option<&HashSet<String>>) -> Vec<&'static Tool> {
  catalog().tools.iter().filter(|t| t.implemented && t.advertised && enabled.is_none_or(|e| e.contains(&t.name))).collect()
}

/// The MCP endpoint for one pane: the pane attributes calls to its
/// workspace, and `tools` narrows what the agent is offered. None when there
/// is nothing to offer.
pub fn pane_url(enabled: Option<&[String]>, pane: Option<&str>) -> Option<String> {
  let base = base_url()?;
  let allow: Option<HashSet<String>> = enabled.map(|e| e.iter().cloned().collect());
  let defs = tool_defs(allow.as_ref());
  if defs.is_empty() {
    return None;
  }
  let mut url = url::Url::parse(&format!("{base}/mcp")).ok()?;
  {
    let mut q = url.query_pairs_mut();
    if let Some(p) = pane.filter(|p| !p.is_empty()) {
      q.append_pair("pane", p);
    }
    if allow.is_some() {
      q.append_pair("tools", &defs.iter().map(|t| t.name.as_str()).collect::<Vec<_>>().join(","));
    }
  }
  Some(url.to_string())
}

/// The --mcp-config value for one agent: inline JSON, nothing on disk.
pub fn config_json(enabled: Option<&[String]>, pane: Option<&str>) -> Option<String> {
  let url = pane_url(enabled, pane)?;
  Some(
    json!({
      "mcpServers": {
        "riven": {
          "type": "http",
          "url": url,
          "headers": { "Authorization": format!("Bearer {}", token()) },
          // How long the CLI lets a call to THIS server go silent: ask_user is
          // silent while a person thinks, and Claude Code's own idle timeout
          // (5 minutes) would cut it.
          "timeout": REQUEST_TIMEOUT_MS
        }
      }
    })
    .to_string(),
  )
}

/// The tool prompt (--append-system-prompt / developer_instructions): one
/// line per area, only for the areas this agent is offered.
pub fn system_prompt(enabled: &[String]) -> String {
  let on: HashSet<&str> = enabled.iter().map(String::as_str).collect();
  let c = catalog();
  let lines: Vec<&str> = c.lines.iter().filter(|(tools, _)| tools.iter().any(|t| on.contains(t.as_str()))).map(|(_, l)| l.as_str()).collect();
  if lines.is_empty() {
    return String::new();
  }
  std::iter::once(c.head.as_str()).chain(lines).collect::<Vec<_>>().join("\n")
}

/// Env every agent riven spawns gets: the CLI's own tool timeout is far
/// shorter than the 30 minutes riven waits on a person.
pub fn agent_env() -> [(&'static str, String); 1] {
  [("MCP_TOOL_TIMEOUT", REQUEST_TIMEOUT_MS.to_string())]
}

// ---- what agents are started with ------------------------------------------------------

/// riven's part of a terminal's environment (services/pty adds the login
/// PATH, TERM, CLAUDE_CONFIG_DIR, a UTF-8 locale): the zsh shim that gives a
/// typed `claude`/`codex` riven's tools and hooks, and the hook env.
pub async fn pty_env(key: &str) -> HashMap<String, String> {
  let mut env = HashMap::new();
  let zsh = std::env::var("SHELL").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "/bin/zsh".into()).ends_with("zsh");
  let names = implemented_tool_names();
  let mcp_config = if shim::ready() && zsh { config_json(Some(&names), Some(key)) } else { None };
  if let Some(cfg) = mcp_config {
    env.insert("ZDOTDIR".into(), shim::dir().to_string_lossy().into_owned());
    env.insert("RIVEN_MCP_CONFIG".into(), cfg);
    env.insert("RIVEN_MCP_PROMPT".into(), system_prompt(&names));
    if let Some(p) = shim::real_bin("claude").await {
      env.insert("RIVEN_REAL_CLAUDE".into(), p);
    }
    env.insert("RIVEN_CODEX_ARGS".into(), shim::codex_args(key, &names));
    env.insert("RIVEN_MCP_TOKEN".into(), token().to_string());
    if let Some(p) = shim::real_bin("codex").await {
      env.insert("RIVEN_REAL_CODEX".into(), p);
    }
  }
  env.extend(hooks::hook_env(key));
  env.extend(agent_env().map(|(k, v)| (k.to_string(), v)));
  env
}

/// riven's MCP config, tool prompt and hook env for a chat pane, in the shape
/// services/chat reads. kind: 'claude' | 'codex' | 'probe' (the environment
/// probe: every tool, no pane).
pub fn chat_env(kind: &str, key: &str, disabled: &[String]) -> Value {
  if kind == "probe" {
    return json!({ "mcpConfig": config_json(Some(&implemented_tool_names()), None) });
  }
  let off: HashSet<&str> = disabled.iter().map(String::as_str).collect();
  let enabled: Vec<String> = implemented_tool_names().into_iter().filter(|n| !off.contains(n.as_str())).collect();
  if kind == "codex" {
    let url = if enabled.is_empty() { None } else { pane_url(Some(&enabled), Some(key)) };
    let prompt = url.as_ref().map(|_| system_prompt(&enabled));
    return json!({ "url": url, "prompt": prompt, "token": token(), "timeoutSec": (REQUEST_TIMEOUT_MS as f64 / 1000.0).round() as u64 });
  }
  let mcp_config = if enabled.is_empty() { None } else { config_json(Some(&enabled), Some(key)) };
  let prompt = mcp_config.as_ref().map(|_| system_prompt(&enabled));
  let agent_env: Map<String, Value> = agent_env().into_iter().map(|(k, v)| (k.to_string(), Value::String(v))).collect();
  let hooks: Map<String, Value> = hooks::hook_env(key).into_iter().map(|(k, v)| (k, Value::String(v))).collect();
  json!({
    "enabled": enabled.len(),
    "mcpConfig": mcp_config,
    "prompt": prompt,
    "prefix": TOOL_PREFIX,
    "agentEnv": agent_env,
    "hooks": hooks
  })
}

// ---- tool calls ----------------------------------------------------------------------

// A call waiting on an answer: from the page (page = its label), or from
// Node (page = None). A DB tool's confirmation is a page call whose parent is
// the Node call, so cancelling the agent's request cancels both.
struct Waiter {
  tx: mpsc::Sender<String>,
  page: Option<String>,
  parent: Option<String>,
}

#[derive(Default)]
struct Calls {
  waiters: HashMap<String, Waiter>,
  // In-flight tools/call requests by the CLIENT's JSON-RPC id (scoped to the
  // pane that made it), so a `notifications/cancelled` naming that id can
  // stop the wait.
  inflight: HashMap<String, String>,
  // The page that answers tool calls (the app window's, which says so when
  // it starts listening: mcp_attach).
  page: Option<String>,
}

fn calls() -> MutexGuard<'static, Calls> {
  static C: OnceLock<Mutex<Calls>> = OnceLock::new();
  C.get_or_init(Default::default).lock().unwrap_or_else(|e| e.into_inner())
}

fn emit_page(label: &str, ch: &str, payload: Value) {
  if let Some(app) = APP.get() {
    crate::commands::emit_ipc(app, label, ch, json!([payload]));
  }
}

/// The app page started listening for tool calls (its preload, when App.tsx
/// registers the handler).
pub fn attach(label: &str) {
  calls().page = Some(label.to_string());
}

/// The page's answer to an 'mcp:invoke'.
pub fn page_result(payload: &Value) {
  let id = payload.get("id").and_then(Value::as_str).unwrap_or("");
  let result = match payload.get("result") {
    None | Some(Value::Null) => String::new(),
    Some(v) => util::js_string(v),
  };
  let w = calls().waiters.remove(id);
  if let Some(w) = w {
    let _ = w.tx.send(result);
  }
}

/// Node's answer to an 'mcpTool' (main.rs dispatch 'mcp.toolResult').
pub fn node_result(a: &Value) {
  page_result(&json!({ "id": a.get("id"), "result": a.get("text") }))
}

// End a call with `msg`, and every call made on its behalf. A page call is
// told to drop its UI (the ask_user card must stop offering choices, or a
// click goes to a call that already returned).
fn finish(c: &mut Calls, id: &str, msg: &str) {
  let Some(w) = c.waiters.remove(id) else { return };
  if let Some(label) = &w.page {
    emit_page(label, "mcp:cancel", json!({ "id": id }));
  }
  let _ = w.tx.send(msg.to_string());
  let kids: Vec<String> = c.waiters.iter().filter(|(_, k)| k.parent.as_deref() == Some(id)).map(|(k, _)| k.clone()).collect();
  for k in kids {
    finish(c, &k, CANCELLED);
  }
}

/// Fail every call still waiting on the page: a fresh page means its half of
/// the conversation (the ask_user queue, the browser panel's handler) is gone,
/// so every waiting agent is told in words it can act on instead of hanging
/// until the timeout.
pub fn fail_page_calls(reason: &str) -> usize {
  let mut c = calls();
  let ids: Vec<String> = c.waiters.iter().filter(|(_, w)| w.page.is_some()).map(|(k, _)| k.clone()).collect();
  for id in &ids {
    if let Some(w) = c.waiters.remove(id) {
      let _ = w.tx.send(reason.to_string());
    }
  }
  c.inflight.retain(|_, id| !ids.contains(id));
  ids.len()
}

/// A window's page started loading (main.rs on_page_load). Only the page
/// that answers tool calls matters.
pub fn page_started(label: &str) {
  if calls().page.as_deref() != Some(label) {
    return;
  }
  let n = fail_page_calls(RELOADED);
  if n > 0 {
    eprintln!("[mcp] dropped {n} tool call(s) waiting on the old page");
  }
}

/// The app is going away.
pub fn shutdown() {
  let mut c = calls();
  for (_, w) in c.waiters.drain() {
    let _ = w.tx.send("riven: shutting down".into());
  }
  c.inflight.clear();
}

/// `notifications/cancelled` from a client, for one of its requests.
fn cancel_rpc(rpc: &str) {
  let mut c = calls();
  if let Some(id) = c.inflight.get(rpc).cloned() {
    finish(&mut c, &id, CANCELLED);
  }
}

// A client's request ids are only unique per client, so they are scoped by
// the pane (every agent riven starts carries its pane on the URL).
fn rpc_key(pane: Option<&str>, request_id: Option<&Value>) -> Option<String> {
  match request_id {
    Some(v @ (Value::String(_) | Value::Number(_))) => Some(format!("{}\u{0}{}", pane.unwrap_or(""), util::js_string(v))),
    _ => None,
  }
}

// Whether the client hung up (its own timeout, or it was killed).
fn closed(conn: &TcpStream) -> bool {
  if conn.set_nonblocking(true).is_err() {
    return true;
  }
  let mut b = [0u8; 1];
  let r = conn.peek(&mut b);
  let _ = conn.set_nonblocking(false);
  match r {
    Ok(0) => true,
    Ok(_) => false,
    Err(e) => e.kind() != std::io::ErrorKind::WouldBlock,
  }
}

struct Call<'a> {
  conn: Option<&'a TcpStream>,
  rpc: Option<String>,
}

// Register a waiter and wait for its answer. Returns None when the client
// hung up (nobody to answer).
fn wait(id: &str, page: Option<String>, parent: Option<String>, call: &Call, timeout: Option<Duration>, start: impl FnOnce() -> bool) -> Option<String> {
  let (tx, rx) = mpsc::channel();
  {
    let mut c = calls();
    if let Some(p) = &parent {
      if !c.waiters.contains_key(p) {
        return Some(CANCELLED.into());
      }
    }
    c.waiters.insert(id.to_string(), Waiter { tx, page, parent });
    if let Some(r) = &call.rpc {
      c.inflight.insert(r.clone(), id.to_string());
    }
  }
  if !start() {
    let mut c = calls();
    c.waiters.remove(id);
    if let Some(r) = &call.rpc {
      c.inflight.remove(r);
    }
    return Some(NO_WINDOW.into());
  }
  let deadline = timeout.map(|t| Instant::now() + t);
  let mut hung_up = false;
  let out = loop {
    match rx.recv_timeout(Duration::from_millis(250)) {
      Ok(s) => break s,
      Err(mpsc::RecvTimeoutError::Disconnected) => break String::new(),
      Err(mpsc::RecvTimeoutError::Timeout) => {
        if deadline.is_some_and(|d| Instant::now() >= d) {
          finish(&mut calls(), id, TIMED_OUT);
        } else if call.conn.is_some_and(closed) {
          // The agent hung up: stop waiting on the user, and tell the page.
          hung_up = true;
          finish(&mut calls(), id, CANCELLED);
        }
      }
    }
  };
  if let Some(r) = &call.rpc {
    let mut c = calls();
    if c.inflight.get(r).map(String::as_str) == Some(id) {
      c.inflight.remove(r);
    }
  }
  (!hung_up).then_some(out)
}

// A tool the page performs (open a file, ask the user, drive the browser, ...).
fn page_call(name: &str, args: &Value, cwd: Option<&str>, key: Option<&str>, parent: Option<String>, call: &Call) -> Option<String> {
  let Some(app) = APP.get() else { return Some(NO_WINDOW.into()) };
  let label = calls().page.clone();
  let Some(label) = label.filter(|l| app.webview_windows().contains_key(l)) else { return Some(NO_WINDOW.into()) };
  let id = util::uuid();
  let msg = json!({ "id": id, "tool": name, "args": args, "cwd": cwd, "key": key });
  let l2 = label.clone();
  wait(&id, Some(label), parent, call, Some(Duration::from_millis(REQUEST_TIMEOUT_MS)), move || {
    emit_page(&l2, "mcp:invoke", msg);
    true
  })
}

// riven_db_* (services/db/engine.rs). riven_db_execute asks the calling pane
// to confirm (ask_user on its behalf), so a cancelled call drops the card.
fn db_call(name: &str, args: &Value, cwd: Option<&str>, key: Option<&str>, call: &Call) -> Option<String> {
  use crate::services::db::engine;
  let id = util::uuid();
  let (name, args, cwd, key, id2) = (name.to_string(), args.clone(), cwd.map(str::to_string), key.map(str::to_string), id.clone());
  wait(&id, None, None, call, None, move || {
    crate::services::db::runtime().spawn(async move {
      let parent = id2.clone();
      let ask: engine::Ask = Box::new(move |question, options| {
        Box::pin(async move {
          let args = json!({ "question": question, "options": options });
          let none = Call { conn: None, rpc: None };
          tokio::task::spawn_blocking(move || page_call("ask_user", &args, cwd.as_deref(), key.as_deref(), Some(parent), &none).unwrap_or_else(|| CANCELLED.into()))
            .await
            .unwrap_or_default()
        })
      });
      let text = engine::run_db_tool(&name, &args, ask).await;
      page_result(&json!({ "id": id2, "result": text }));
    });
    true
  })
}

// A tool whose engine is still Node (tauri/shim/moved/mcpServer.ts).
fn node_call(name: &str, args: &Value, cwd: Option<&str>, key: Option<&str>, call: &Call) -> Option<String> {
  let id = util::uuid();
  let msg = json!({ "ev": "mcpTool", "id": id, "tool": name, "args": args, "cwd": cwd, "key": key });
  wait(&id, None, None, call, None, move || crate::try_emit(msg))
}

// One tools/call. None: the client is gone, nothing to answer.
fn call_tool(name: &str, args: &Value, cwd: Option<&str>, pane: Option<&str>, call: &Call) -> Option<String> {
  let known = tool(name);
  if name == "riven_api_request" {
    return node_call(name, args, cwd, pane, call);
  }
  if name.starts_with("riven_db_") && known.is_some() {
    return db_call(name, args, cwd, pane, call);
  }
  if !known.is_some_and(|t| t.implemented) {
    return Some(format!("error: unknown tool {name}"));
  }
  page_call(name, args, cwd, pane, None, call)
}
