// Small main-process features that only read the machine:
//   cli:list          which dev / AI CLIs are installed (src/main/cli.ts)
//   ports:list/kill   this workspace's listening ports (src/main/ports.ts)
//   models:claude     the account's Claude models, from the CLI (src/main/modelCatalog.ts)
//   diagnostics:run   the workspace's own tsc / eslint (src/main/diagnostics.ts)
// Same answers as the Node modules; executables come from the login PATH.

use crate::services::git::exec;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

/// resolveBin: the first executable `cmd` on the login PATH (X_OK, as fs.access).
pub fn resolve_bin(cmd: &str) -> Option<String> {
  use std::os::unix::ffi::OsStrExt;
  crate::services::shell_env::login_path()
    .split(':')
    .filter(|d| !d.is_empty())
    .map(|d| Path::new(d).join(cmd))
    .find(|p| {
      std::ffi::CString::new(p.as_os_str().as_bytes()).is_ok_and(|c| unsafe { libc::access(c.as_ptr(), libc::X_OK) == 0 })
    })
    .map(|p| p.to_string_lossy().into_owned())
}

// ---- cli:list ------------------------------------------------------------------------------

const CLIS: &[(&str, &str, &str)] = &[
  ("Claude Code", "claude", "AI"),
  ("Codex", "codex", "AI"),
  ("Aider", "aider", "AI"),
  ("Gemini", "gemini", "AI"),
  ("opencode", "opencode", "AI"),
  ("Cursor Agent", "cursor-agent", "AI"),
  ("Ollama", "ollama", "AI"),
  ("Amp", "amp", "AI"),
  ("Goose", "goose", "AI"),
  ("Crush", "crush", "AI"),
  ("GitHub CLI", "gh", "Dev"),
  ("lazygit", "lazygit", "Dev"),
  ("Docker", "docker", "Dev"),
  ("kubectl", "kubectl", "Dev"),
  ("npm", "npm", "Dev"),
  ("pnpm", "pnpm", "Dev"),
  ("yarn", "yarn", "Dev"),
  ("Node", "node", "Runtime"),
  ("Bun", "bun", "Runtime"),
  ("Deno", "deno", "Runtime"),
  ("Python", "python3", "Runtime"),
  ("cargo", "cargo", "Runtime"),
  ("go", "go", "Runtime"),
  ("psql", "psql", "DB"),
  ("sqlite3", "sqlite3", "DB"),
  ("redis-cli", "redis-cli", "DB"),
  ("htop", "htop", "System"),
];

pub fn cli_list() -> Value {
  Value::Array(
    CLIS
      .iter()
      .filter_map(|(name, cmd, group)| resolve_bin(cmd).map(|p| json!({ "name": name, "cmd": cmd, "group": group, "path": p })))
      .collect(),
  )
}

// ---- ports ---------------------------------------------------------------------------------

/// Listening TCP ports whose owning process's cwd is inside `folder`.
async fn list_ports(folder: &str) -> Vec<(u16, i64, String)> {
  let args = |a: &[&str]| a.iter().map(|s| s.to_string()).collect::<Vec<_>>();
  let r = exec("lsof", &args(&["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpcn"]), None, Some(Duration::from_millis(4000)), crate::services::git::DEFAULT_MAX_BUFFER).await;
  if !r.ok {
    return Vec::new();
  }
  // insertion-ordered: pid -> ports (a Set: first-seen order)
  let mut by_pid: Vec<(String, Vec<u16>)> = Vec::new();
  let mut name_by_pid: HashMap<String, String> = HashMap::new();
  let mut pid = String::new();
  for line in r.stdout.split('\n') {
    let Some(c) = line.chars().next() else { continue };
    let rest = &line[c.len_utf8()..];
    match c {
      'p' => pid = rest.to_string(),
      'c' if !pid.is_empty() => {
        name_by_pid.insert(pid.clone(), rest.to_string());
      }
      'n' if !pid.is_empty() => {
        // /:(\d+)$/
        let digits: String = rest.chars().rev().take_while(|c| c.is_ascii_digit()).collect::<Vec<_>>().into_iter().rev().collect();
        if !digits.is_empty() && rest[..rest.len() - digits.len()].ends_with(':') {
          let Ok(port) = digits.parse::<u16>() else { continue };
          match by_pid.iter_mut().find(|(p, _)| *p == pid) {
            Some((_, set)) => {
              if !set.contains(&port) {
                set.push(port)
              }
            }
            None => by_pid.push((pid.clone(), vec![port])),
          }
        }
      }
      _ => {}
    }
  }
  if by_pid.is_empty() {
    return Vec::new();
  }
  let pids: Vec<String> = by_pid.iter().map(|(p, _)| p.clone()).collect();
  let cwd_out = exec("lsof", &args(&["-a", "-d", "cwd", "-Fn", "-p", &pids.join(",")]), None, Some(Duration::from_millis(4000)), crate::services::git::DEFAULT_MAX_BUFFER).await;
  // .catch(() => ({ stdout: '' })): a failing lsof (one pid gone) reads as no cwds.
  let cwd_text = if cwd_out.ok { cwd_out.stdout } else { String::new() };
  let mut cwd_by_pid: HashMap<String, String> = HashMap::new();
  let mut cp = String::new();
  for line in cwd_text.split('\n') {
    let Some(c) = line.chars().next() else { continue };
    let rest = &line[c.len_utf8()..];
    match c {
      'p' => cp = rest.to_string(),
      'n' if !cp.is_empty() => {
        cwd_by_pid.insert(cp.clone(), rest.to_string());
      }
      _ => {}
    }
  }
  let mut out = Vec::new();
  let mut seen = std::collections::HashSet::new();
  for (p, set) in &by_pid {
    let Some(cwd) = cwd_by_pid.get(p) else { continue };
    if !(cwd == folder || cwd.starts_with(&format!("{folder}/"))) {
      continue;
    }
    for port in set {
      if !seen.insert(*port) {
        continue;
      }
      // Number(p)
      let pid = p.trim().parse::<i64>().unwrap_or(0);
      out.push((*port, pid, name_by_pid.get(p).filter(|n| !n.is_empty()).cloned().unwrap_or_else(|| "unknown".into())));
    }
  }
  out.sort_by_key(|(port, _, _)| *port);
  out
}

pub async fn ports_list(folder: &str) -> Value {
  Value::Array(list_ports(folder).await.into_iter().map(|(port, pid, name)| json!({ "port": port, "pid": pid, "name": name })).collect())
}

fn alive(pid: i64) -> bool {
  unsafe { libc::kill(pid as libc::pid_t, 0) == 0 }
}

/// process.kill's error message ("kill ESRCH", "kill EPERM").
fn kill(pid: i64, sig: libc::c_int) -> Result<(), String> {
  if unsafe { libc::kill(pid as libc::pid_t, sig) } == 0 {
    return Ok(());
  }
  let e = std::io::Error::last_os_error().raw_os_error().unwrap_or(0);
  let code = match e {
    libc::ESRCH => "ESRCH",
    libc::EPERM => "EPERM",
    libc::EINVAL => "EINVAL",
    _ => "EUNKNOWN",
  };
  Err(format!("kill {code}"))
}

/// Stop what listens on one of THIS workspace's ports. The pid is checked
/// against a fresh scan (never trusted from the page), SIGTERM first, SIGKILL
/// after 3 seconds.
pub async fn ports_kill(folder: &str, port: f64, pid: f64) -> Value {
  let current = list_ports(folder).await;
  if !current.iter().any(|(p, id, _)| f64::from(*p) == port && (*id as f64) == pid) {
    return json!({ "ok": false, "error": "that port is no longer held by that process" });
  }
  let pid = pid as i64;
  // riven's own loopback servers listen too, with a cwd inside a dev checkout.
  if pid == std::process::id() as i64 {
    return json!({ "ok": false, "error": "that is riven itself" });
  }
  if let Err(e) = kill(pid, libc::SIGTERM) {
    return json!({ "ok": false, "error": e });
  }
  for _ in 0..12 {
    if !alive(pid) {
      break;
    }
    tokio::time::sleep(Duration::from_millis(250)).await;
  }
  if !alive(pid) {
    return json!({ "ok": true });
  }
  if let Err(e) = kill(pid, libc::SIGKILL) {
    return json!({ "ok": false, "error": e });
  }
  tokio::time::sleep(Duration::from_millis(200)).await;
  if alive(pid) {
    json!({ "ok": false, "error": "process would not exit" })
  } else {
    json!({ "ok": true, "forced": true })
  }
}

// ---- models:claude -------------------------------------------------------------------------

const PROBE_ID: &str = "riven-models";

/// The model list out of one line of the CLI's stream-json output (parseModelsLine).
pub fn parse_models_line(line: &str) -> Option<Value> {
  let m: Value = serde_json::from_str(line).ok()?;
  let resp = m.get("response");
  if m.get("type").and_then(Value::as_str) != Some("control_response")
    || resp.and_then(|r| r.get("request_id")).and_then(Value::as_str) != Some(PROBE_ID)
  {
    return None;
  }
  let Some(raw) = resp.and_then(|r| r.get("response")).and_then(|r| r.get("models")).and_then(Value::as_array) else {
    return Some(json!([]));
  };
  Some(Value::Array(
    raw
      .iter()
      .filter(|x| x.is_object())
      .filter(|x| x.get("value").is_some_and(Value::is_string) && x.get("displayName").is_some_and(Value::is_string))
      .map(|x| {
        let mut o = Map::new();
        o.insert("value".into(), x["value"].clone());
        o.insert("displayName".into(), x["displayName"].clone());
        if let Some(r) = x.get("resolvedModel").filter(|v| v.is_string()) {
          o.insert("resolvedModel".into(), r.clone());
        }
        if let Some(d) = x.get("description").filter(|v| v.is_string()) {
          o.insert("description".into(), d.clone());
        }
        Value::Object(o)
      })
      .collect(),
  ))
}

async fn probe(config_dir: Option<String>) -> Option<Value> {
  use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
  let cmd = crate::services::util::resolve_bin("claude").await?;
  let mut c = crate::services::shell_env::tokio_command(&cmd);
  c.args(["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--no-session-persistence"])
    .stdin(std::process::Stdio::piped())
    .stdout(std::process::Stdio::piped())
    .stderr(std::process::Stdio::null())
    .kill_on_drop(true);
  if let Some(d) = &config_dir {
    c.env("CLAUDE_CONFIG_DIR", d);
  }
  let mut child = c.spawn().ok()?;
  let mut stdin = child.stdin.take()?;
  let stdout = child.stdout.take()?;
  let req = json!({ "type": "control_request", "request_id": PROBE_ID, "request": { "subtype": "initialize" } }).to_string() + "\n";
  let _ = stdin.write_all(req.as_bytes()).await;
  let read = async {
    let mut lines = tokio::io::BufReader::new(stdout).lines();
    while let Ok(Some(l)) = lines.next_line().await {
      let l = l.trim();
      if l.is_empty() {
        continue;
      }
      if let Some(m) = parse_models_line(l) {
        return Some(m);
      }
    }
    None // exited without an answer
  };
  let r = tokio::time::timeout(Duration::from_secs(20), read).await.ok().flatten();
  let _ = child.start_kill();
  drop(stdin);
  r
}

type Shared = Arc<tokio::sync::OnceCell<Option<Value>>>;
static MODELS: OnceLock<Mutex<HashMap<String, Shared>>> = OnceLock::new();

/// Cached per config dir; a failed probe is forgotten so the next picker asks again.
pub async fn claude_models(config_dir: Option<String>) -> Value {
  let config_dir = config_dir.filter(|d| !d.is_empty());
  let key = config_dir.clone().unwrap_or_default();
  let cell: Shared = MODELS.get_or_init(Default::default).lock().unwrap().entry(key.clone()).or_default().clone();
  let v = cell.get_or_init(|| probe(config_dir)).await.clone();
  if v.is_none() {
    let mut m = MODELS.get().unwrap().lock().unwrap();
    if m.get(&key).is_some_and(|c| Arc::ptr_eq(c, &cell)) {
      m.remove(&key);
    }
  }
  v.unwrap_or(Value::Null)
}

// ---- diagnostics:run -----------------------------------------------------------------------

fn local_bin(root: &str, name: &str) -> Option<String> {
  let p = Path::new(root).join("node_modules").join(".bin").join(name);
  p.exists().then(|| p.to_string_lossy().into_owned())
}

fn fail(error: &str, log: String) -> Value {
  json!({ "ok": false, "diagnostics": [], "log": log, "error": error })
}

async fn run_eslint(root: &str) -> Value {
  let Some(bin) = local_bin(root, "eslint") else { return fail("eslint not installed in this project", String::new()) };
  let args: Vec<String> = [".", "--format", "json", "--ext", ".js,.jsx,.ts,.tsx"].iter().map(|s| s.to_string()).collect();
  let r = exec(&bin, &args, Some(root), Some(Duration::from_secs(180)), 64 * 1024 * 1024).await;
  let (stdout, stderr) = (r.stdout, r.stderr);
  let files: Value = match serde_json::from_str(if stdout.is_empty() { "[]" } else { &stdout }) {
    Ok(v) => v,
    Err(_) => return fail("failed to parse eslint output", stdout + &stderr),
  };
  let mut diags = Vec::new();
  let empty = Vec::new();
  for f in files.as_array().unwrap_or(&empty) {
    for m in f.get("messages").and_then(Value::as_array).unwrap_or(&empty) {
      let mut d = Map::new();
      d.insert("path".into(), f.get("filePath").cloned().unwrap_or(Value::Null));
      d.insert("line".into(), js_or_one(m.get("line")));
      d.insert("column".into(), js_or_one(m.get("column")));
      d.insert("severity".into(), json!(if m.get("severity").and_then(Value::as_f64) == Some(2.0) { "error" } else { "warning" }));
      d.insert("message".into(), m.get("message").cloned().unwrap_or(Value::Null));
      d.insert("source".into(), json!("eslint"));
      if let Some(rule) = m.get("ruleId").filter(|v| !v.is_null()) {
        d.insert("code".into(), rule.clone());
      }
      diags.push(Value::Object(d));
    }
  }
  let log = format!("$ eslint . --format json\n{stderr}\n{} problem(s) found.", diags.len());
  json!({ "ok": true, "diagnostics": diags, "log": log })
}

/// `x || 1` for a JSON number.
fn js_or_one(v: Option<&Value>) -> Value {
  match v {
    Some(n @ Value::Number(x)) if x.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()) => n.clone(),
    _ => json!(1),
  }
}

/// tsc --noEmit --pretty false: path(line,col): error TSxxxx: message
fn tsc_line(raw: &str) -> Option<(String, String, String, String, String, String)> {
  static RE: OnceLock<regex::Regex> = OnceLock::new();
  let re = RE.get_or_init(|| regex::Regex::new(r"^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.*)$").unwrap());
  let c = re.captures(raw)?;
  Some((c[1].into(), c[2].into(), c[3].into(), c[4].into(), c[5].into(), c[6].into()))
}

/// Number(digits) || 1, as a JSON number.
fn num_or_one(s: &str) -> Value {
  let f = crate::services::db::js::number(s);
  if f == 0.0 || f.is_nan() {
    json!(1)
  } else if f.fract() == 0.0 && f.abs() < 9.0e15 {
    json!(f as i64)
  } else {
    json!(f)
  }
}

async fn run_tsc(root: &str) -> Value {
  let Some(bin) = local_bin(root, "tsc") else { return fail("typescript (tsc) not installed in this project", String::new()) };
  let args: Vec<String> = ["--noEmit", "--pretty", "false"].iter().map(|s| s.to_string()).collect();
  let r = exec(&bin, &args, Some(root), Some(Duration::from_secs(300)), 64 * 1024 * 1024).await;
  let (stdout, stderr) = (r.stdout, r.stderr);
  let mut diags = Vec::new();
  for raw in stdout.split('\n') {
    // .trim(): JS trims all whitespace (and the BOM)
    let t = raw.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}');
    let Some((p, line, col, sev, code, msg)) = tsc_line(t) else { continue };
    let path = if p.starts_with('/') { p } else { crate::services::git::join(root, &p) };
    diags.push(json!({
      "path": path,
      "line": num_or_one(&line),
      "column": num_or_one(&col),
      "severity": if sev == "warning" { "warning" } else { "error" },
      "message": msg,
      "source": "tsc",
      "code": code,
    }));
  }
  let log = format!("$ tsc --noEmit\n{stdout}{stderr}\n{} problem(s) found.", diags.len());
  json!({ "ok": true, "diagnostics": diags, "log": log })
}

pub async fn diagnostics_run(root: &str, kind: &str) -> Value {
  if root.is_empty() {
    return fail("no workspace", String::new());
  }
  if kind == "eslint" {
    run_eslint(root).await
  } else {
    run_tsc(root).await
  }
}
