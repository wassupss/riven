// usage:limits (src/main/usage.ts usageLimits): the plan windows (session 5h,
// weekly 7d) from Claude's OAuth usage endpoint, with Claude Code's own token.
//
// The token is where Claude Code keeps it: a profile's <configDir>/.credentials.json
// first, then its keychain item (service "Claude Code-credentials-<8 hex of
// sha256(dir)>"); for the default login every keychain item under the bare
// service (the OS user, no account, "unknown"), the newest unexpired one,
// then ~/.claude/.credentials.json. A good answer is kept for an hour and
// served (marked stale) while the endpoint or the token is not there.
//
// The background test mode (RIVEN_TAURI_BACKGROUND=1) never reads the
// keychain: a read can raise a keychain prompt on the user's screen.

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

const LIMITS_TTL_MS: f64 = 60.0 * 60_000.0;
pub const KEYCHAIN_SERVICE: &str = "Claude Code-credentials";
const ENDPOINT: &str = "https://api.anthropic.com/api/oauth/usage";

fn now_ms() -> f64 {
  std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as f64).unwrap_or(0.0)
}

/// keychainService(): the bare service for the default login, the dir-keyed one for a profile.
pub fn keychain_service(config_dir: Option<&str>) -> String {
  match config_dir {
    None => KEYCHAIN_SERVICE.to_string(),
    Some(d) => {
      let h = Sha256::digest(d.as_bytes());
      let hex: String = h.iter().map(|b| format!("{b:02x}")).collect();
      format!("{KEYCHAIN_SERVICE}-{}", &hex[..8])
    }
  }
}

#[derive(Debug, PartialEq)]
pub struct Oauth {
  pub token: String,
  pub expires_at: Option<f64>,
}

/// oauthFrom(): claudeAiOauth.accessToken (non-blank) and expiresAt (a number).
pub fn oauth_from(blob: &str) -> Option<Oauth> {
  let v: Value = serde_json::from_str(blob).ok()?;
  let o = v.get("claudeAiOauth")?;
  let tok = o.get("accessToken")?.as_str()?;
  if tok.trim().is_empty() {
    return None;
  }
  Some(Oauth { token: tok.to_string(), expires_at: o.get("expiresAt").and_then(Value::as_f64) })
}

/// The newest live token among the keychain candidates (no expiry = forever).
pub fn best_token(cands: &[Oauth], now: f64) -> Option<String> {
  let mut best: Option<(&str, f64)> = None;
  for c in cands {
    let exp = c.expires_at.unwrap_or(9007199254740991.0);
    if exp <= now {
      continue;
    }
    if best.is_none_or(|(_, b)| exp > b) {
      best = Some((&c.token, exp));
    }
  }
  best.map(|(t, _)| t.to_string())
}

/// The endpoint's answer as {session, weekly} (null where a window has no
/// numeric utilization).
pub fn parse_limits(body: &Value) -> Value {
  let win = |k: &str| match body.get(k) {
    Some(o) if o.get("utilization").is_some_and(Value::is_number) => {
      json!({ "usedPct": o["utilization"], "resetsAt": o.get("resets_at").cloned().filter(|v| !v.is_null()).unwrap_or(Value::Null) })
    }
    _ => Value::Null,
  };
  json!({ "session": win("five_hour"), "weekly": win("seven_day") })
}

fn cache() -> &'static Mutex<HashMap<String, (f64, Value)>> {
  static C: OnceLock<Mutex<HashMap<String, (f64, Value)>>> = OnceLock::new();
  C.get_or_init(Default::default)
}

/// cachedLimits(): the last good answer within the hour, marked stale, or nothing.
pub fn cached(key: &str, now: f64) -> Value {
  if let Some((at, val)) = cache().lock().unwrap().get(key) {
    if now - at < LIMITS_TTL_MS {
      let mut v = val.clone();
      v["stale"] = json!(true);
      v["at"] = json!(at);
      return v;
    }
  }
  json!({ "session": null, "weekly": null })
}

fn keychain_blob(service: &str, account: Option<&str>) -> Option<String> {
  let mut cmd = std::process::Command::new("/usr/bin/security");
  cmd.args(["find-generic-password", "-s", service]);
  if let Some(a) = account {
    cmd.args(["-a", a]);
  }
  cmd.arg("-w").stdin(std::process::Stdio::null()).stderr(std::process::Stdio::null());
  let out = output_timeout(cmd, Duration::from_secs(5))?;
  out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// A command's output, or None if it fails to start or outlives `limit` (then killed).
pub(crate) fn output_timeout(mut cmd: std::process::Command, limit: Duration) -> Option<std::process::Output> {
  let child = cmd.stdout(std::process::Stdio::piped()).spawn().ok()?;
  let pid = child.id();
  let (tx, rx) = std::sync::mpsc::channel();
  std::thread::spawn(move || {
    let _ = tx.send(child.wait_with_output());
  });
  match rx.recv_timeout(limit) {
    Ok(r) => r.ok(),
    Err(_) => {
      unsafe { libc::kill(pid as i32, libc::SIGKILL) };
      None
    }
  }
}

fn file_token(dir: &std::path::Path) -> Option<String> {
  oauth_from(&std::fs::read_to_string(dir.join(".credentials.json")).ok()?).map(|o| o.token)
}

fn claude_token(config_dir: Option<&str>) -> Option<String> {
  let keychain = cfg!(target_os = "macos") && !crate::background();
  if let Some(d) = config_dir {
    if let Some(t) = file_token(std::path::Path::new(d)) {
      return Some(t);
    }
    if keychain {
      if let Some(o) = keychain_blob(&keychain_service(Some(d)), None).and_then(|b| oauth_from(&b)) {
        return Some(o.token);
      }
    }
    return None;
  }
  if keychain {
    let user = std::env::var("USER").ok().filter(|u| !u.is_empty());
    let mut accounts: Vec<Option<String>> = Vec::new();
    for a in [user, None, Some("unknown".to_string())] {
      if !accounts.contains(&a) {
        accounts.push(a);
      }
    }
    let cands: Vec<Oauth> =
      accounts.iter().filter_map(|a| keychain_blob(KEYCHAIN_SERVICE, a.as_deref()).and_then(|b| oauth_from(&b))).collect();
    if let Some(t) = best_token(&cands, now_ms()) {
      return Some(t);
    }
  }
  file_token(&super::paths::home().join(".claude"))
}

/// usage:limits
pub fn usage_limits(config_dir: Option<&str>) -> Value {
  let key = config_dir.unwrap_or("<default>").to_string();
  // An empty dir is the default login (usage.ts tests it for truthiness) but keeps its own cache key.
  let Some(token) = claude_token(config_dir.filter(|d| !d.is_empty())) else { return cached(&key, now_ms()) };
  let (tx, rx) = std::sync::mpsc::channel();
  std::thread::spawn(move || {
    let headers: Vec<(String, String)> = [
      ("Authorization", format!("Bearer {token}")),
      ("Accept", "application/json".into()),
      ("Content-Type", "application/json".into()),
      ("anthropic-beta", "oauth-2025-04-20".into()),
      ("User-Agent", "claude-code/2.1.69".into()),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_string(), v))
    .collect();
    let _ = tx.send(super::http::fetch(ENDPOINT, "GET", &headers, None));
  });
  let res = match rx.recv_timeout(Duration::from_secs(10)) {
    Ok(Ok(r)) if (200..300).contains(&r.status) => r,
    _ => return cached(&key, now_ms()),
  };
  let Ok(body) = serde_json::from_str::<Value>(&res.body) else { return cached(&key, now_ms()) };
  let val = parse_limits(&body);
  if !val["session"].is_null() || !val["weekly"].is_null() {
    cache().lock().unwrap().insert(key, (now_ms(), val.clone()));
  }
  val
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn service_names_match_usage_ts() {
    assert_eq!(keychain_service(None), "Claude Code-credentials");
    // Node: createHash('sha256').update(dir).digest('hex').slice(0, 8)
    assert_eq!(keychain_service(Some("/Users/x/.claude-work")), "Claude Code-credentials-74ed04d5");
    assert_eq!(keychain_service(Some("")), "Claude Code-credentials-e3b0c442");
  }

  #[test]
  fn tokens() {
    assert_eq!(oauth_from(r#"{"claudeAiOauth":{"accessToken":"t1","expiresAt":5}}"#), Some(Oauth { token: "t1".into(), expires_at: Some(5.0) }));
    assert_eq!(oauth_from(r#"{"claudeAiOauth":{"accessToken":"  "}}"#), None);
    assert_eq!(oauth_from(r#"{"other":1}"#), None);
    assert_eq!(oauth_from("nope"), None);
    let c = vec![
      Oauth { token: "old".into(), expires_at: Some(100.0) },
      Oauth { token: "new".into(), expires_at: Some(300.0) },
      Oauth { token: "mid".into(), expires_at: Some(200.0) },
    ];
    assert_eq!(best_token(&c, 150.0).as_deref(), Some("new"));
    assert_eq!(best_token(&c, 400.0), None);
    let forever = vec![Oauth { token: "f".into(), expires_at: None }, Oauth { token: "n".into(), expires_at: Some(500.0) }];
    assert_eq!(best_token(&forever, 1.0).as_deref(), Some("f"));
  }

  #[test]
  fn limits_shape() {
    let b = json!({ "five_hour": { "utilization": 12.5, "resets_at": "2026-11-19T10:00:00Z" }, "seven_day": { "utilization": "x" } });
    assert_eq!(parse_limits(&b), json!({ "session": { "usedPct": 12.5, "resetsAt": "2026-11-19T10:00:00Z" }, "weekly": null }));
    let b = json!({ "seven_day": { "utilization": 3 } });
    assert_eq!(parse_limits(&b), json!({ "session": null, "weekly": { "usedPct": 3, "resetsAt": null } }));
    assert_eq!(cached("nothing-here", 0.0), json!({ "session": null, "weekly": null }));
    cache().lock().unwrap().insert("k".into(), (1000.0, json!({ "session": null, "weekly": { "usedPct": 1 } })));
    assert_eq!(cached("k", 2000.0), json!({ "session": null, "weekly": { "usedPct": 1 }, "stale": true, "at": 1000.0 }));
    assert_eq!(cached("k", 1000.0 + LIMITS_TTL_MS), json!({ "session": null, "weekly": null }));
  }
}
