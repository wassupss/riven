// The CLIs themselves: which are installed, their accounts, and updating a
// CLI in the background (agentChat.ts).

use crate::services::util::{self, cli_version, resolve_bin, run, Run};
use base64::Engine;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

// ---- chat:detectClis ----------------------------------------------------------------

pub async fn detect_clis() -> Vec<Value> {
  let mut out = Vec::new();
  for (name, cmd) in [("Claude Code", "claude"), ("Codex", "codex")] {
    let Some(p) = resolve_bin(cmd).await else { continue };
    let version = cli_version(&p).await;
    out.push(json!({ "name": name, "cmd": cmd, "path": p, "version": version }));
  }
  out
}

// ---- accounts ------------------------------------------------------------------------

pub fn profile_dir(id: &str) -> String {
  let clean: String = id.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-').collect();
  crate::services::paths::user_data().join("claude-profiles").join(clean).to_string_lossy().into_owned()
}

/// Claude Code: `claude auth status --json`, under the profile's config dir.
async fn claude_account(config_dir: Option<&str>) -> Option<Value> {
  let cmd = resolve_bin("claude").await?;
  let mut base = json!({ "id": "claude", "name": "Claude Code", "loggedIn": null });
  if let Some(d) = config_dir {
    base["configDir"] = json!(d);
  }
  let mut env = HashMap::new();
  if let Some(d) = config_dir.filter(|d| !d.is_empty()) {
    env.insert("CLAUDE_CONFIG_DIR".to_string(), d.to_string());
  }
  let r = run(Run { bin: &cmd, args: vec!["auth".into(), "status".into(), "--json".into()], cwd: None, login: false, env, stderr: false, timeout: Duration::from_secs(8) }).await;
  let Ok(j) = serde_json::from_str::<Value>(&r.out) else { return Some(base) };
  let Some(logged) = j.get("loggedIn").and_then(Value::as_bool) else { return Some(base) };
  let nonempty = |k: &str| j.get(k).and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string);
  base["loggedIn"] = json!(logged);
  if let Some(e) = nonempty("email") {
    base["email"] = json!(e);
  }
  if let Some(o) = nonempty("orgName") {
    base["org"] = json!(o);
  }
  if let Some(p) = nonempty("subscriptionType") {
    base["plan"] = json!(p);
  }
  if logged {
    base["mode"] = json!(if j.get("authMethod").and_then(Value::as_str) == Some("claude.ai") { "subscription" } else { "apikey" });
  }
  Some(base)
}

/// Codex: ~/.codex/auth.json. The OAuth id_token (a JWT) carries the email
/// and ChatGPT plan; tokens never leave this process.
async fn codex_account() -> Option<Value> {
  resolve_bin("codex").await?;
  let base = json!({ "id": "codex", "name": "Codex", "loggedIn": null });
  let file = util::home().join(".codex").join("auth.json");
  let with = |extra: Value| {
    let mut b = base.clone();
    if let (Some(o), Value::Object(e)) = (b.as_object_mut(), extra) {
      o.extend(e);
    }
    b
  };
  let Some(j) = crate::services::fsx::read_utf8(&file).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()) else {
    return Some(with(json!({ "loggedIn": false })));
  };
  if let Some(tok) = j.get("tokens").and_then(|t| t.get("id_token")).and_then(Value::as_str).filter(|t| !t.is_empty()) {
    let payload = tok.split('.').nth(1).and_then(decode_b64).and_then(|b| serde_json::from_slice::<Value>(&b).ok());
    let Some(p) = payload else { return Some(with(json!({ "loggedIn": true, "mode": "subscription" }))) };
    let prof = p.get("https://api.openai.com/profile").cloned().unwrap_or(json!({}));
    let auth = p.get("https://api.openai.com/auth").cloned().unwrap_or(json!({}));
    let pick = |v: Option<&Value>| v.and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string);
    let mut out = with(json!({ "loggedIn": true }));
    if let Some(e) = pick(p.get("email")).or_else(|| pick(prof.get("email"))) {
      out["email"] = json!(e);
    }
    if let Some(pl) = pick(auth.get("chatgpt_plan_type")) {
      out["plan"] = json!(pl);
    }
    out["mode"] = json!("subscription");
    return Some(out);
  }
  if util::truthy(j.get("OPENAI_API_KEY")) {
    return Some(with(json!({ "loggedIn": true, "mode": "apikey" })));
  }
  Some(with(json!({ "loggedIn": false })))
}

// Buffer.from(x, 'base64') accepts the URL alphabet and missing padding.
fn decode_b64(s: &str) -> Option<Vec<u8>> {
  let std: String = s.chars().filter(|c| !c.is_whitespace()).map(|c| match c {
    '-' => '+',
    '_' => '/',
    c => c,
  }).collect();
  let trimmed = std.trim_end_matches('=');
  base64::engine::general_purpose::STANDARD_NO_PAD.decode(trimmed).ok()
}

pub async fn accounts(config_dir: Option<String>) -> Vec<Value> {
  let codex = tauri::async_runtime::spawn(codex_account());
  let c = claude_account(config_dir.as_deref()).await;
  let x = codex.await.ok().flatten();
  [c, x].into_iter().flatten().collect()
}

// ---- updating a CLI ---------------------------------------------------------------------

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateState {
  pub cmd: String,
  pub status: String,
  pub from: Option<String>,
  pub to: Option<String>,
  pub output: String,
  pub restarted: u32,
  pub deferred: u32,
  pub open: u32,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub answered: Option<String>,
  pub at: Value,
}

fn updates() -> &'static Mutex<Vec<UpdateState>> {
  static U: OnceLock<Mutex<Vec<UpdateState>>> = OnceLock::new();
  U.get_or_init(Default::default)
}

pub fn update_status() -> Vec<UpdateState> {
  updates().lock().unwrap().clone()
}

pub fn current(cmd: &str) -> Option<UpdateState> {
  updates().lock().unwrap().iter().find(|u| u.cmd == cmd).cloned()
}

/// Remember it and tell every app window ('cli:update-changed').
pub fn publish(state: UpdateState) {
  {
    let mut u = updates().lock().unwrap();
    match u.iter_mut().find(|x| x.cmd == state.cmd) {
      Some(x) => *x = state.clone(),
      None => u.push(state.clone()),
    }
  }
  super::broadcast("cli:update-changed", serde_json::to_value(&state).unwrap_or(Value::Null));
}

fn tail(s: &str, n: usize) -> String {
  let t = s.trim();
  let len = util::utf16_len(t);
  if len <= n {
    return t.to_string();
  }
  // .slice(-n) in UTF-16 units
  let skip = len - n;
  let mut units = 0;
  for (i, c) in t.char_indices() {
    if units >= skip {
      return t[i..].to_string();
    }
    units += c.len_utf16();
  }
  String::new()
}

pub async fn run_update(cmd: &str) -> UpdateState {
  if let Some(r) = current(cmd).filter(|u| u.status == "running") {
    return r;
  }
  let base = UpdateState { cmd: cmd.into(), status: "running".into(), from: None, to: None, output: String::new(), restarted: 0, deferred: 0, open: 0, answered: None, at: util::jnum(util::now_ms().floor()) };
  let Some(bin) = resolve_bin(cmd).await else {
    let failed = UpdateState { status: "failed".into(), output: format!("{cmd} CLI not found on PATH"), ..base };
    publish(failed.clone());
    return failed;
  };
  let from = cli_version(&bin).await;
  publish(UpdateState { from: from.clone(), ..base.clone() });
  // The login PATH, so an npm-installed CLI can find node.
  let r = run(Run { bin: &bin, args: vec!["update".into()], cwd: None, login: true, env: HashMap::new(), stderr: true, timeout: Duration::from_secs(600) }).await;
  let mut output = tail(&r.out, 20_000);
  let code = if r.timed_out {
    output.push_str("\n(10분이 지나 중단했습니다)");
    -1
  } else if !r.spawned {
    -1
  } else {
    r.code.unwrap_or(-1)
  };
  let to = cli_version(&resolve_bin(cmd).await.unwrap_or(bin)).await;
  if code != 0 {
    let failed = UpdateState { status: "failed".into(), from, to, output: tail(&output, 2000), ..base };
    publish(failed.clone());
    return failed;
  }
  let open = super::open_agents(cmd);
  let done = UpdateState { status: "done".into(), from, to, output: tail(&output, 2000), open, ..base };
  publish(done.clone());
  done
}

pub fn defer_update(cmd: &str) {
  if let Some(cur) = current(cmd).filter(|u| u.status == "done") {
    publish(UpdateState { answered: Some("later".into()), ..cur });
  }
}
