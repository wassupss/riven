// MCP servers as the chat sees them (mcpServers.ts, mcpRepair.ts and the
// `claude mcp …` / probe parts of agentChat.ts).
//
// A chat pane runs non-interactively, so a tool that is not pre-allowed is
// refused. Every server the project has is allowed by NAME (`mcp__<server>`),
// from `claude mcp list` (cached, also on disk in userData/mcp-servers.json,
// same keys and shape as the Node build wrote) plus what live sessions report
// in their init event.

use super::util::{self, run, Run};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

const CACHE_MS: f64 = 5.0 * 60.0 * 1000.0;

/// `${configDir ?? ''}\0${cwd}`: the cache key, on disk too.
pub fn key(cwd: &str, config_dir: Option<&str>) -> String {
  format!("{}\0{}", config_dir.unwrap_or(""), cwd)
}

// ---- parsing (pure) ------------------------------------------------------------

pub fn parse_mcp_list(stdout: &str) -> Vec<String> {
  static RE: OnceLock<regex::Regex> = OnceLock::new();
  let re = RE.get_or_init(|| regex::Regex::new(r" - |\(HTTP\)|\(SSE\)|\(stdio\)").unwrap());
  let mut out: Vec<String> = Vec::new();
  for raw in stdout.split('\n') {
    let line = raw.trim();
    if line.is_empty() || line.starts_with("Checking") {
      continue;
    }
    let Some(at) = line.find(": ").filter(|a| *a > 0) else { continue };
    let name = line[..at].trim();
    if name.is_empty() || !re.is_match(line) {
      continue;
    }
    if !out.iter().any(|n| n == name) {
      out.push(name.to_string());
    }
  }
  out
}

pub fn tool_prefix(server: &str) -> String {
  let clean: String = server.chars().map(|c| if c.is_ascii_alphanumeric() || c == '_' { c } else { '_' }).collect();
  format!("mcp__{clean}")
}

fn name_ok(n: &str) -> bool {
  !n.is_empty() && n.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

fn server_names(state: Option<&Value>, paths: &[String], dot: Option<&Value>) -> Vec<String> {
  let mut out: Vec<String> = Vec::new();
  let mut take = |obj: Option<&Value>| {
    if let Some(m) = obj.and_then(Value::as_object) {
      for n in m.keys() {
        if name_ok(n) && !out.contains(n) {
          out.push(n.clone());
        }
      }
    }
  };
  for p in paths {
    take(state.and_then(|s| s.get("projects")).and_then(|p2| p2.get(p)).and_then(|x| x.get("mcpServers")));
  }
  take(dot.and_then(|d| d.get("mcpServers")));
  out
}

pub fn union_names(a: &[String], b: &[String]) -> Vec<String> {
  let mut out = a.to_vec();
  for n in b {
    if !n.is_empty() && !out.contains(n) {
      out.push(n.clone());
    }
  }
  out
}

/// The --allowedTools value: the built-ins, riven's own prefix, and every
/// server the CLI can see minus the ones the user switched off.
pub fn allowed_tools_value(base: &str, riven_prefix: &str, servers: &[String], disabled: &[String]) -> String {
  let mut external: Vec<String> = Vec::new();
  for s in servers {
    if disabled.contains(s) {
      continue;
    }
    let p = tool_prefix(s);
    if p != riven_prefix && !external.contains(&p) {
      external.push(p);
    }
  }
  [base.to_string(), riven_prefix.to_string()].into_iter().chain(external).filter(|x| !x.is_empty()).collect::<Vec<_>>().join(",")
}

/// Where the CLI keeps its state: <dir>/.claude.json under a profile (or an
/// inherited CLAUDE_CONFIG_DIR), else ~/.claude.json at the home root.
pub fn claude_state_file(config_dir: Option<&str>) -> PathBuf {
  let inherited = std::env::var("CLAUDE_CONFIG_DIR").ok().filter(|d| !d.is_empty());
  match config_dir.filter(|d| !d.is_empty()).map(str::to_string).or(inherited) {
    Some(d) => Path::new(&d).join(".claude.json"),
    None => util::home().join(".claude.json"),
  }
}

fn read_json(p: &Path) -> Option<Value> {
  util::parse(&crate::services::fsx::read_utf8(p).ok()?)
}

fn paths_of(cwd: &str) -> Vec<String> {
  let mut paths = vec![cwd.to_string()];
  if let Ok(real) = std::fs::canonicalize(cwd) {
    let real = real.to_string_lossy().into_owned();
    if real != cwd {
      paths.push(real);
    }
  }
  paths
}

fn servers_from_config(cwd: &str, config_dir: Option<&str>) -> Vec<String> {
  let state = read_json(&claude_state_file(config_dir));
  let dot = read_json(&Path::new(cwd).join(".mcp.json"));
  server_names(state.as_ref(), &paths_of(cwd), dot.as_ref())
}

// ---- the server-name cache ------------------------------------------------------

#[derive(Clone, Serialize, serde::Deserialize)]
struct Hit {
  names: Vec<String>,
  at: f64,
}

#[derive(Default)]
struct Cache {
  loaded: bool,
  // Insertion order matters for "borrow from this profile" (Map iteration).
  order: Vec<String>,
  map: HashMap<String, Hit>,
  inflight: HashMap<String, Arc<tokio::sync::OnceCell<Vec<String>>>>,
  save_pending: bool,
}

fn cache() -> &'static Mutex<Cache> {
  static C: OnceLock<Mutex<Cache>> = OnceLock::new();
  C.get_or_init(Default::default)
}

fn cache_file() -> PathBuf {
  crate::services::paths::user_data().join("mcp-servers.json")
}

impl Cache {
  fn set(&mut self, k: &str, h: Hit) {
    if !self.map.contains_key(k) {
      self.order.push(k.to_string());
    }
    self.map.insert(k.to_string(), h);
  }
  fn load(&mut self) {
    if self.loaded {
      return;
    }
    self.loaded = true;
    let Some(Value::Object(disk)) = read_json(&cache_file()) else { return };
    for (k, v) in disk {
      let Some(names) = v.get("names").and_then(Value::as_array) else { continue };
      if self.map.contains_key(&k) {
        continue;
      }
      let names = names.iter().filter_map(|n| n.as_str().map(str::to_string)).collect();
      let at = v.get("at").and_then(Value::as_f64).unwrap_or(0.0);
      self.set(&k, Hit { names, at });
    }
  }
}

fn save_cache() {
  {
    let mut c = cache().lock().unwrap();
    if c.save_pending {
      return;
    }
    c.save_pending = true;
  }
  tauri::async_runtime::spawn(async {
    tokio::time::sleep(Duration::from_millis(500)).await;
    let body = {
      let mut c = cache().lock().unwrap();
      c.save_pending = false;
      let mut out = serde_json::Map::new();
      for k in &c.order {
        if let Some(h) = c.map.get(k) {
          out.insert(k.clone(), json!({ "names": h.names, "at": util::jnum(h.at) }));
        }
      }
      Value::Object(out).to_string()
    };
    let _ = tokio::fs::write(cache_file(), body).await;
  });
}

/// Which MCP servers a pane in `cwd` may use. A known list answers at once
/// (refreshed behind it); a folder nobody opened borrows its profile's names;
/// otherwise wait briefly for `claude mcp list`, then read the config files.
pub async fn configured_mcp_servers(cwd: &str, config_dir: Option<&str>) -> Vec<String> {
  let k = key(cwd, config_dir);
  let (hit, cell) = {
    let mut c = cache().lock().unwrap();
    c.load();
    let hit = c.map.get(&k).cloned();
    let fresh = hit.as_ref().is_some_and(|h| util::now_ms() - h.at < CACHE_MS);
    if fresh {
      (hit, None)
    } else {
      let cell = c.inflight.entry(k.clone()).or_default().clone();
      (hit, Some(cell))
    }
  };
  let refresh = cell.map(|cell| {
    let (cwd, cd, k) = (cwd.to_string(), config_dir.map(str::to_string), k.clone());
    let c2 = cell.clone();
    tauri::async_runtime::spawn(async move {
      let names = c2
        .get_or_init(|| async {
          let r = run_claude_mcp(&cwd, &["mcp", "list"], Duration::from_secs(20), cd.as_deref()).await;
          let listed = parse_mcp_list(if r.0 { &r.1 } else { "" });
          if listed.is_empty() {
            return listed;
          }
          let names = {
            let mut c = cache().lock().unwrap();
            let names = union_names(&c.map.get(&k).map(|h| h.names.clone()).unwrap_or_default(), &listed);
            c.set(&k, Hit { names: names.clone(), at: util::now_ms() });
            names
          };
          save_cache();
          names
        })
        .await
        .clone();
      let mut c = cache().lock().unwrap();
      if c.inflight.get(&k).is_some_and(|x| Arc::ptr_eq(x, &c2)) {
        c.inflight.remove(&k);
      }
      names
    })
  });

  if let Some(h) = hit.as_ref().filter(|h| !h.names.is_empty()) {
    return h.names.clone();
  }
  let Some(refresh) = refresh else { return Vec::new() };

  let prefix = format!("{}\0", config_dir.unwrap_or(""));
  let borrowed = {
    let c = cache().lock().unwrap();
    let mut b: Vec<String> = Vec::new();
    for k2 in &c.order {
      if !k2.starts_with(&prefix) {
        continue;
      }
      for n in &c.map[k2].names {
        if !b.contains(n) {
          b.push(n.clone());
        }
      }
    }
    b
  };
  if !borrowed.is_empty() {
    return borrowed;
  }
  if let Ok(Ok(first)) = tokio::time::timeout(Duration::from_millis(2500), refresh).await {
    if !first.is_empty() {
      return first;
    }
  }
  let (cwd, cd) = (cwd.to_string(), config_dir.map(str::to_string));
  tokio::task::spawn_blocking(move || servers_from_config(&cwd, cd.as_deref())).await.unwrap_or_default()
}

/// Fold what a live session actually loaded (its init event) into the cache.
pub fn remember_session_servers(cwd: &str, config_dir: Option<&str>, names: &[String]) {
  let clean: Vec<String> = names.iter().filter(|n| !n.is_empty() && *n != "riven").cloned().collect();
  if clean.is_empty() {
    return;
  }
  let k = key(cwd, config_dir);
  {
    let mut c = cache().lock().unwrap();
    c.load();
    let hit = c.map.get(&k).cloned();
    let merged = union_names(&hit.as_ref().map(|h| h.names.clone()).unwrap_or_default(), &clean);
    if hit.as_ref().is_some_and(|h| merged.len() == h.names.len()) {
      return;
    }
    c.set(&k, Hit { names: merged, at: hit.map(|h| h.at).unwrap_or(0.0) });
  }
  save_cache();
}

// ---- `claude mcp …` ---------------------------------------------------------------

/// runClaudeMcp: login env, stdout+stderr together, ok on exit 0.
pub async fn run_claude_mcp(cwd: &str, args: &[&str], timeout: Duration, config_dir: Option<&str>) -> (bool, String) {
  let Some(cmd) = util::resolve_bin("claude").await else { return (false, "claude CLI not found".into()) };
  let mut env = HashMap::new();
  if let Some(d) = config_dir.filter(|d| !d.is_empty()) {
    env.insert("CLAUDE_CONFIG_DIR".to_string(), d.to_string());
  }
  let r = run(Run { bin: &cmd, args: args.iter().map(|s| s.to_string()).collect(), cwd: Some(cwd), login: true, env, stderr: true, timeout }).await;
  (r.code == Some(0), r.out)
}

pub fn run_result(r: (bool, String)) -> Value {
  json!({ "ok": r.0, "output": r.1 })
}

fn find_pasted_add_servers(config: &Value, paths: &[String]) -> Vec<(String, Vec<String>)> {
  let mut out: Vec<(String, Vec<String>)> = Vec::new();
  for p in paths {
    let Some(servers) = config.get("projects").and_then(|x| x.get(p)).and_then(|x| x.get("mcpServers")).and_then(Value::as_object) else { continue };
    for (name, entry) in servers {
      if out.iter().any(|(n, _)| n == name) {
        continue;
      }
      let Some(command) = entry.get("command").and_then(Value::as_str) else { continue };
      let Some(args) = entry.get("args").and_then(Value::as_array) else { continue };
      let bin = command.rsplit('/').next().unwrap_or(command);
      let strs: Vec<String> = args.iter().filter_map(|a| a.as_str().map(str::to_string)).collect();
      if bin == "claude" && args.len() >= 2 && strs.len() == args.len() && strs[0] == "mcp" && strs[1] == "add" {
        out.push((name.clone(), strs));
      }
    }
  }
  out
}

/// Servers registered as their own `claude mcp add` line: remove and replay.
async fn repair_pasted_add_servers(cwd: &str, config_dir: Option<&str>) {
  let Some(config) = read_json(&claude_state_file(config_dir)) else { return };
  for (name, args) in find_pasted_add_servers(&config, &paths_of(cwd)) {
    let removed = run_claude_mcp(cwd, &["mcp", "remove", &name, "-s", "local"], Duration::from_secs(20), config_dir).await;
    if !removed.0 {
      eprintln!("[mcp] could not repair \"{name}\" {}", util::slice(&removed.1, 300));
      continue;
    }
    let a: Vec<&str> = args.iter().map(String::as_str).collect();
    let added = run_claude_mcp(cwd, &a, Duration::from_secs(20), config_dir).await;
    if added.0 {
      eprintln!("[mcp] repaired \"{name}\": it was registered as its own add command");
    } else {
      eprintln!("[mcp] could not repair \"{name}\" {}", util::slice(&added.1, 300));
    }
  }
}

/// chat:mcpList: repair first, then `claude mcp list` parsed into rows.
pub async fn mcp_list(cwd: String, config_dir: Option<String>) -> Vec<Value> {
  let Some(cmd) = util::resolve_bin("claude").await else { return Vec::new() };
  repair_pasted_add_servers(&cwd, config_dir.as_deref()).await;
  let mut env = HashMap::new();
  if let Some(d) = config_dir.as_deref().filter(|d| !d.is_empty()) {
    env.insert("CLAUDE_CONFIG_DIR".to_string(), d.to_string());
  }
  let r = run(Run { bin: &cmd, args: vec!["mcp".into(), "list".into()], cwd: Some(&cwd), login: true, env, stderr: false, timeout: Duration::from_secs(20) }).await;
  static RE: OnceLock<regex::Regex> = OnceLock::new();
  let re = RE.get_or_init(|| regex::Regex::new(r"^(.+?):\s+(\S+).*?\s-\s(.+)$").unwrap());
  let ci = |p: &str, s: &str| regex::RegexBuilder::new(p).case_insensitive(true).build().unwrap().is_match(s);
  let mut out = Vec::new();
  for line in r.out.split('\n') {
    let Some(m) = re.captures(line) else { continue };
    let st = &m[3];
    let status = if ci("connected", st) {
      "connected"
    } else if ci("needs? auth", st) {
      "needs-auth"
    } else if ci("pending approval", st) {
      "pending"
    } else {
      "other"
    };
    out.push(json!({ "name": m[1].trim(), "url": &m[2], "status": status }));
  }
  out
}

/// Record a .mcp.json server approval the CLI only takes interactively.
pub fn approve_mcp_json(cwd: &str, name: &str, config_dir: Option<&str>) -> Value {
  let file = claude_state_file(config_dir);
  let r = (|| -> Result<(), String> {
    let raw = std::fs::read_to_string(&file).map_err(|e| crate::services::fsx::io_err(&e, "open", &file))?;
    let mut cfg: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    let root = cfg.as_object_mut().ok_or("not an object")?;
    let projects = root.entry("projects").or_insert_with(|| json!({}));
    let proj = projects.as_object_mut().ok_or("projects")?.entry(cwd.to_string()).or_insert_with(|| json!({}));
    let proj = proj.as_object_mut().ok_or("project")?;
    let enabled = proj.entry("enabledMcpjsonServers").or_insert_with(|| json!([]));
    if let Some(a) = enabled.as_array_mut() {
      if !a.iter().any(|x| x == name) {
        a.push(json!(name));
      }
    }
    let disabled: Vec<Value> = proj.get("disabledMcpjsonServers").and_then(Value::as_array).cloned().unwrap_or_default().into_iter().filter(|x| x != name).collect();
    proj.insert("disabledMcpjsonServers".into(), Value::Array(disabled));
    std::fs::write(&file, serde_json::to_string_pretty(&cfg).map_err(|e| e.to_string())?).map_err(|e| crate::services::fsx::io_err(&e, "open", &file))
  })();
  match r {
    Ok(()) => json!({ "ok": true, "output": "" }),
    Err(e) => json!({ "ok": false, "output": e }),
  }
}

// ---- profiles share the user's plugins ----------------------------------------------

/// A profile riven created starts with no plugins (they live under the config
/// dir): link the user's plugin store and seed enabledPlugins once.
pub async fn ensure_profile_plugins(config_dir: &str) {
  let config_dir = PathBuf::from(config_dir);
  let _ = tokio::task::spawn_blocking(move || {
    let home = util::home().join(".claude");
    let resolve = |p: &Path| crate::services::fsx::resolve(Path::new("/"), p);
    if resolve(&config_dir) == resolve(&home) {
      return;
    }
    if std::fs::create_dir_all(&config_dir).is_err() {
      return;
    }
    let link = config_dir.join("plugins");
    if std::fs::symlink_metadata(&link).is_err() {
      let _ = std::os::unix::fs::symlink(home.join("plugins"), &link);
    }
    let file = config_dir.join("settings.json");
    let read = |p: &Path| read_json(p).filter(Value::is_object).unwrap_or_else(|| json!({}));
    let mut settings = read(&file);
    if truthy_key(&settings, "enabledPlugins") {
      return;
    }
    let enabled = read(&home.join("settings.json")).get("enabledPlugins").cloned();
    let Some(enabled) = enabled.filter(|e| super::util::truthy(Some(e))) else { return };
    settings.as_object_mut().unwrap().insert("enabledPlugins".into(), enabled);
    let _ = std::fs::write(&file, serde_json::to_string_pretty(&settings).unwrap_or_default());
  })
  .await;
}

fn truthy_key(v: &Value, k: &str) -> bool {
  super::util::truthy(v.get(k))
}

// ---- the environment probe (slash commands + MCP status) -------------------------------

pub const PROBE_INIT: &str = "riven-probe-init";
pub const PROBE_STATUS: &str = "riven-probe-mcp-";

#[derive(Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
  pub slash_commands: Vec<String>,
  pub mcp_servers: Vec<Value>,
}

enum Probe {
  Commands(Vec<String>),
  Mcp(Vec<Value>),
}

fn parse_probe_line(line: &str) -> Option<Probe> {
  if line.trim().is_empty() {
    return None;
  }
  let j: Value = util::parse(line)?;
  if j.get("type").and_then(Value::as_str) != Some("control_response") {
    return None;
  }
  let id = j.get("response").and_then(|r| r.get("request_id")).and_then(Value::as_str).unwrap_or("");
  let body = j.get("response").and_then(|r| r.get("response")).cloned().unwrap_or(json!({}));
  if id == PROBE_INIT {
    let cmds = body.get("commands").and_then(Value::as_array).cloned().unwrap_or_default();
    return Some(Probe::Commands(cmds.iter().filter_map(|c| c.get("name").and_then(Value::as_str).map(str::to_string)).collect()));
  }
  if id.starts_with(PROBE_STATUS) {
    let list = body.get("mcpServers").and_then(Value::as_array).cloned().unwrap_or_default();
    return Some(Probe::Mcp(
      list
        .iter()
        .filter_map(|s| {
          let name = s.get("name")?.as_str()?;
          Some(json!({ "name": name, "status": s.get("status").and_then(Value::as_str).unwrap_or("unknown") }))
        })
        .collect(),
    ));
  }
  None
}

#[derive(Default)]
struct InfoCache {
  map: HashMap<String, SessionInfo>,
  inflight: HashMap<String, Arc<tokio::sync::OnceCell<SessionInfo>>>,
}

fn info_cache() -> &'static Mutex<InfoCache> {
  static C: OnceLock<Mutex<InfoCache>> = OnceLock::new();
  C.get_or_init(Default::default)
}

/// The session's real command list + MCP servers, cached per cwd/profile, one
/// probe per key at a time. `fresh` re-probes.
pub async fn fetch_session_info(cwd: String, config_dir: Option<String>, fresh: bool) -> SessionInfo {
  let k = key(&cwd, config_dir.as_deref());
  let cell = {
    let mut c = info_cache().lock().unwrap();
    if let Some(hit) = c.map.get(&k).filter(|_| !fresh) {
      return hit.clone();
    }
    c.inflight.entry(k.clone()).or_default().clone()
  };
  let k2 = k.clone();
  let out = cell.get_or_init(|| probe_session_info(cwd, config_dir, k2)).await.clone();
  let mut c = info_cache().lock().unwrap();
  if c.inflight.get(&k).is_some_and(|x| Arc::ptr_eq(x, &cell)) {
    c.inflight.remove(&k);
  }
  out
}

async fn probe_session_info(cwd: String, config_dir: Option<String>, k: String) -> SessionInfo {
  use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
  let Some(cmd) = util::resolve_bin("claude").await else { return SessionInfo::default() };
  let mcp_config = super::node_env("probe", "", &[]).await.and_then(|v| v.get("mcpConfig").and_then(Value::as_str).map(str::to_string));
  let mut args: Vec<String> = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--no-session-persistence"].iter().map(|s| s.to_string()).collect();
  if let Some(c) = mcp_config {
    args.push("--mcp-config".into());
    args.push(c);
  }
  let mut c = tokio::process::Command::new(&cmd);
  c.args(&args).current_dir(&cwd).env("PATH", util::login_path()).stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::null());
  if let Some(d) = config_dir.as_deref().filter(|d| !d.is_empty()) {
    c.env("CLAUDE_CONFIG_DIR", d);
    ensure_profile_plugins(d).await;
  }
  let Ok(mut child) = c.spawn() else { return SessionInfo::default() };
  let pid = child.id().unwrap_or(0);
  let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
  let mut stdin = child.stdin.take();
  tauri::async_runtime::spawn(async move {
    while let Some(line) = rx.recv().await {
      let Some(s) = stdin.as_mut() else { break };
      if s.write_all(line.as_bytes()).await.is_err() {
        break;
      }
    }
  });
  let send = |tx: &tokio::sync::mpsc::UnboundedSender<String>, id: &str, subtype: &str| {
    let _ = tx.send(json!({ "type": "control_request", "request_id": id, "request": { "subtype": subtype } }).to_string() + "\n");
  };
  let mut slash: Option<Vec<String>> = None;
  let mut asks = 0u32;
  send(&tx, PROBE_INIT, "initialize");
  let deadline = Instant::now() + Duration::from_secs(25);
  let mut out = tokio::io::BufReader::new(child.stdout.take().unwrap());
  let mut buf = Vec::new();
  let result: Option<SessionInfo> = loop {
    buf.clear();
    let read = tokio::time::timeout_at(deadline.into(), out.read_until(b'\n', &mut buf)).await;
    let n = match read {
      Err(_) => break None, // 25s: plugins and servers can be slow
      Ok(Err(_)) | Ok(Ok(0)) => break None,
      Ok(Ok(n)) => n,
    };
    let line = String::from_utf8_lossy(&buf[..n]);
    match parse_probe_line(line.trim_end_matches('\n')) {
      Some(Probe::Commands(names)) => {
        slash = Some(names);
        asks += 1;
        send(&tx, &format!("{PROBE_STATUS}{asks}"), "mcp_status");
      }
      Some(Probe::Mcp(servers)) if slash.is_some() => {
        let pending = servers.iter().any(|s| s["status"] == "pending");
        if pending && asks < 10 {
          asks += 1;
          let (tx2, id) = (tx.clone(), format!("{PROBE_STATUS}{asks}"));
          tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_millis(700)).await;
            let _ = tx2.send(json!({ "type": "control_request", "request_id": id, "request": { "subtype": "mcp_status" } }).to_string() + "\n");
          });
        } else {
          break Some(SessionInfo { slash_commands: slash.clone().unwrap_or_default(), mcp_servers: servers });
        }
      }
      _ => {}
    }
  };
  util::sigterm(pid);
  drop(tx);
  tauri::async_runtime::spawn(async move {
    let _ = child.wait().await;
  });
  let v = result.unwrap_or_else(|| SessionInfo { slash_commands: slash.unwrap_or_default(), mcp_servers: Vec::new() });
  if !v.slash_commands.is_empty() {
    info_cache().lock().unwrap().map.insert(k, v.clone());
  }
  v
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn list_and_prefix() {
    let out = "Checking MCP server health...\n\nclaude.ai Notion: https://mcp.notion.com/mcp - ✔ Connected\nplugin:figma:figma: https://mcp.figma.com/mcp (HTTP) - ! Needs authentication\n";
    assert_eq!(parse_mcp_list(out), vec!["claude.ai Notion", "plugin:figma:figma"]);
    assert_eq!(tool_prefix("claude.ai Notion"), "mcp__claude_ai_Notion");
    let v = allowed_tools_value("Read", "mcp__riven", &["riven".into(), "devhub".into(), "x".into()], &["x".into()]);
    assert_eq!(v, "Read,mcp__riven,mcp__devhub");
  }
}
