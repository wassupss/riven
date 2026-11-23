// One-shot AI help for the pet maker and the decoration layout (lib/petAi.ts):
// the page builds the prompt and checks the answer, this runs the CLI once
// with the person's own login and hands back what it said.
//
// Claude Code: `claude -p` with the prompt (and pictures, as base64 image
// blocks) on stdin as one stream-json user message, stream-json out, no
// tools, no MCP servers, no settings, no slash commands, nothing saved
// (--no-session-persistence: no transcript, so the usage panel and the pet's
// XP never see these tokens). Codex, when installed: `codex exec` with the
// prompt on stdin and the pictures as files, read-only sandbox, ephemeral,
// the last message written to a file.
//
// Each run has an id the page can cancel by. It runs in an empty temp
// directory (no project CLAUDE.md or AGENTS.md is read) that is removed after.

use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use super::util::{login_path, resolve_bin, sigterm};

/// A parent Claude Code session leaves these in the environment (riven itself
/// started from a Claude session, in development). A CLI that sees them
/// thinks it is a child session and misbehaves, so they are removed.
pub const SCRUB: &[&str] = &[
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

/// The Claude models the maker offers (aliases the CLI resolves itself).
pub const CLAUDE_MODELS: &[&str] = &["sonnet", "haiku", "opus"];

const DEFAULT_TIMEOUT_MS: u64 = 180_000;
const MAX_OUT: usize = 4 * 1024 * 1024;
const MAX_IMAGES: usize = 3;

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Req {
  pub id: String,
  /// "claude" or "codex".
  pub engine: String,
  /// For claude: sonnet, haiku or opus. Codex uses its own default.
  pub model: Option<String>,
  pub system: String,
  pub prompt: String,
  /// PNGs, base64 without the data: prefix.
  #[serde(default)]
  pub images: Vec<String>,
  pub timeout_ms: Option<u64>,
}

// ---- argument building (pure, tested) ----------------------------------------------

/// The model a request may use: one of CLAUDE_MODELS, sonnet otherwise.
pub fn claude_model(m: Option<&str>) -> &'static str {
  let m = m.unwrap_or("").trim().to_ascii_lowercase();
  CLAUDE_MODELS.iter().copied().find(|x| *x == m).unwrap_or("sonnet")
}

pub fn claude_args(model: &str, system: &str) -> Vec<String> {
  [
    "-p",
    "--model",
    model,
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--system-prompt",
    system,
    "--tools",
    "",
    "--strict-mcp-config",
    "--mcp-config",
    r#"{"mcpServers":{}}"#,
    "--disable-slash-commands",
    "--setting-sources",
    "",
    "--no-session-persistence",
  ]
  .iter()
  .map(|s| s.to_string())
  .collect()
}

/// The one user message claude reads from stdin: the text, then the pictures.
pub fn stream_input(prompt: &str, images: &[String]) -> String {
  let mut content = vec![json!({ "type": "text", "text": prompt })];
  for b64 in images.iter().take(MAX_IMAGES) {
    content.push(json!({ "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": b64 } }));
  }
  let msg = json!({ "type": "user", "message": { "role": "user", "content": content } });
  format!("{msg}\n")
}

pub fn codex_args(dir: &Path, out: &Path, images: &[PathBuf]) -> Vec<String> {
  let mut a: Vec<String> = [
    "exec",
    "--skip-git-repo-check",
    "--ephemeral",
    "--sandbox",
    "read-only",
    "--color",
    "never",
    "-c",
    "mcp_servers={}",
  ]
  .iter()
  .map(|s| s.to_string())
  .collect();
  a.push("-C".into());
  a.push(dir.to_string_lossy().into_owned());
  a.push("-o".into());
  a.push(out.to_string_lossy().into_owned());
  // No PROMPT argument: codex reads it from stdin. The pictures go last, so
  // the variadic -i takes nothing else.
  for p in images {
    a.push("-i".into());
    a.push(p.to_string_lossy().into_owned());
  }
  a
}

/// Which of `env`'s variables the child must not inherit.
pub fn scrubbed<'a>(env: impl Iterator<Item = &'a str>) -> Vec<String> {
  env.filter(|k| SCRUB.contains(k)).map(str::to_string).collect()
}

/// The answer in claude's stream-json output: the last `result` event.
pub fn claude_result(out: &str) -> Value {
  let mut last: Option<Value> = None;
  for line in out.lines() {
    let t = line.trim();
    if !t.starts_with('{') {
      continue;
    }
    if let Some(v) = super::util::parse(t) {
      if v.get("type").and_then(Value::as_str) == Some("result") {
        last = Some(v);
      }
    }
  }
  let Some(r) = last else { return json!({ "ok": false, "error": "failed", "detail": tail(out) }) };
  let text = r.get("result").and_then(Value::as_str).unwrap_or("").to_string();
  let err = r.get("is_error").and_then(Value::as_bool).unwrap_or(false);
  let u = r.get("usage").cloned().unwrap_or(json!({}));
  let n = |k: &str| u.get(k).and_then(Value::as_f64).unwrap_or(0.0);
  let usage = json!({
    "input": n("input_tokens"),
    "output": n("output_tokens"),
    "cacheRead": n("cache_read_input_tokens"),
    "cacheWrite": n("cache_creation_input_tokens"),
  });
  if err {
    return json!({ "ok": false, "error": "failed", "detail": clip(&text, 300), "usage": usage });
  }
  json!({ "ok": true, "text": text, "usage": usage })
}

fn clip(s: &str, n: usize) -> String {
  if s.chars().count() <= n {
    s.to_string()
  } else {
    format!("{}…", s.chars().take(n).collect::<String>())
  }
}

/// The last few lines of what a failed run printed, for the reason shown.
fn tail(out: &str) -> String {
  let lines: Vec<&str> = out.lines().filter(|l| !l.trim().is_empty()).collect();
  let from = lines.len().saturating_sub(3);
  clip(&lines[from..].join("\n"), 300)
}

// ---- running ---------------------------------------------------------------------------

#[derive(Default)]
struct Live {
  pids: HashMap<String, u32>,
  cancelled: Vec<String>,
}

fn live() -> &'static Mutex<Live> {
  static L: OnceLock<Mutex<Live>> = OnceLock::new();
  L.get_or_init(Default::default)
}

fn clean_id(id: &str) -> String {
  id.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').take(64).collect()
}

/// Stop a run; it answers {error: "cancelled"}.
pub fn cancel(id: &str) {
  let mut l = live().lock().unwrap();
  if let Some(pid) = l.pids.get(id).copied() {
    l.cancelled.push(id.to_string());
    sigterm(pid);
  }
}

/// Which engines are installed.
pub async fn engines() -> Value {
  json!({ "claude": resolve_bin("claude").await.is_some(), "codex": resolve_bin("codex").await.is_some() })
}

struct Out {
  code: Option<i32>,
  timed_out: bool,
  stdout: String,
  stderr: String,
}

async fn spawn(bin: &str, args: &[String], dir: &Path, stdin: String, id: &str, timeout: Duration) -> Result<Out, String> {
  let mut c = tokio::process::Command::new(bin);
  c.args(args).current_dir(dir).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
  c.env("PATH", login_path());
  let present: Vec<String> = std::env::vars_os().filter_map(|(k, _)| k.into_string().ok()).collect();
  for k in scrubbed(present.iter().map(String::as_str)) {
    c.env_remove(k);
  }
  let mut child = c.spawn().map_err(|e| e.to_string())?;
  let pid = child.id().unwrap_or(0);
  live().lock().unwrap().pids.insert(id.to_string(), pid);
  if let Some(mut w) = child.stdin.take() {
    tokio::spawn(async move {
      let _ = w.write_all(stdin.as_bytes()).await;
      let _ = w.shutdown().await;
    });
  }
  let read = |r: Option<Box<dyn tokio::io::AsyncRead + Unpin + Send>>| {
    tokio::spawn(async move {
      let mut buf = Vec::new();
      if let Some(r) = r {
        let _ = r.take(MAX_OUT as u64).read_to_end(&mut buf).await;
      }
      String::from_utf8_lossy(&buf).into_owned()
    })
  };
  let so = read(child.stdout.take().map(|s| Box::new(s) as Box<dyn tokio::io::AsyncRead + Unpin + Send>));
  let se = read(child.stderr.take().map(|s| Box::new(s) as Box<dyn tokio::io::AsyncRead + Unpin + Send>));
  let (code, timed_out) = match tokio::time::timeout(timeout, child.wait()).await {
    Ok(s) => (s.ok().and_then(|s| s.code()), false),
    Err(_) => {
      sigterm(pid);
      let _ = child.kill().await;
      (None, true)
    }
  };
  let stdout = so.await.unwrap_or_default();
  let stderr = se.await.unwrap_or_default();
  Ok(Out { code, timed_out, stdout, stderr })
}

/// Run one request to its end. The answer: {ok, text, usage?} or {ok: false,
/// error: notInstalled | timeout | cancelled | failed, detail?}, with `ms`.
pub async fn run(req: Req) -> Value {
  let started = Instant::now();
  let id = clean_id(&req.id);
  if id.is_empty() {
    return json!({ "ok": false, "error": "failed", "detail": "no id" });
  }
  let codex = req.engine == "codex";
  let Some(bin) = resolve_bin(if codex { "codex" } else { "claude" }).await else {
    return json!({ "ok": false, "error": "notInstalled" });
  };
  let dir = std::env::temp_dir().join(format!("riven-petai-{id}"));
  if std::fs::create_dir_all(&dir).is_err() {
    return json!({ "ok": false, "error": "failed", "detail": "temp dir" });
  }
  let timeout = Duration::from_millis(req.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS).clamp(20_000, 600_000));
  let mut answer = if codex {
    let mut files = Vec::new();
    for (i, b64) in req.images.iter().take(MAX_IMAGES).enumerate() {
      let Ok(bytes) = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, b64) else { continue };
      let p = dir.join(format!("picture-{i}.png"));
      if std::fs::write(&p, bytes).is_ok() {
        files.push(p);
      }
    }
    let out_file = dir.join("answer.txt");
    let args = codex_args(&dir, &out_file, &files);
    let stdin = format!("{}\n\n{}", req.system, req.prompt);
    match spawn(&bin, &args, &dir, stdin, &id, timeout).await {
      Err(e) => json!({ "ok": false, "error": "failed", "detail": clip(&e, 200) }),
      Ok(o) if o.timed_out => json!({ "ok": false, "error": "timeout" }),
      Ok(o) => match std::fs::read_to_string(&out_file) {
        Ok(text) if !text.trim().is_empty() => json!({ "ok": true, "text": text }),
        _ => json!({ "ok": false, "error": "failed", "detail": tail(&format!("{}\n{}", o.stdout, o.stderr)), "code": o.code }),
      },
    }
  } else {
    let args = claude_args(claude_model(req.model.as_deref()), &req.system);
    let stdin = stream_input(&req.prompt, &req.images);
    match spawn(&bin, &args, &dir, stdin, &id, timeout).await {
      Err(e) => json!({ "ok": false, "error": "failed", "detail": clip(&e, 200) }),
      Ok(o) if o.timed_out => json!({ "ok": false, "error": "timeout" }),
      Ok(o) => {
        let r = claude_result(&o.stdout);
        if r["ok"] == json!(false) && r.get("detail").and_then(Value::as_str).is_none_or(str::is_empty) {
          json!({ "ok": false, "error": "failed", "detail": tail(&o.stderr) })
        } else {
          r
        }
      }
    }
  };
  let _ = std::fs::remove_dir_all(&dir);
  let was_cancelled = {
    let mut l = live().lock().unwrap();
    l.pids.remove(&id);
    let had = l.cancelled.iter().any(|c| c == &id);
    l.cancelled.retain(|c| c != &id);
    had
  };
  if was_cancelled {
    answer = json!({ "ok": false, "error": "cancelled" });
  }
  answer["ms"] = json!(started.elapsed().as_millis() as u64);
  answer
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn claude_args_switch_everything_off() {
    let a = claude_args("haiku", "SYS");
    let has = |f: &str| a.iter().any(|x| x == f);
    for f in ["-p", "--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence", "--verbose"] {
      assert!(has(f), "{f}");
    }
    let after = |f: &str| a[a.iter().position(|x| x == f).unwrap() + 1].clone();
    assert_eq!(after("--model"), "haiku");
    assert_eq!(after("--tools"), "");
    assert_eq!(after("--setting-sources"), "");
    assert_eq!(after("--input-format"), "stream-json");
    assert_eq!(after("--output-format"), "stream-json");
    assert_eq!(after("--system-prompt"), "SYS");
    let mcp: Value = serde_json::from_str(&after("--mcp-config")).unwrap();
    assert_eq!(mcp, json!({ "mcpServers": {} }));
    // Nothing that would let it act or write settings.
    for bad in ["--dangerously-skip-permissions", "--allowedTools", "--add-dir", "--settings"] {
      assert!(!has(bad), "{bad}");
    }
  }

  #[test]
  fn models_are_an_allowlist() {
    assert_eq!(claude_model(Some("haiku")), "haiku");
    assert_eq!(claude_model(Some(" Opus ")), "opus");
    assert_eq!(claude_model(Some("claude-3-x; rm -rf")), "sonnet");
    assert_eq!(claude_model(None), "sonnet");
  }

  #[test]
  fn stream_input_is_one_user_message_with_pictures() {
    let s = stream_input("hi", &["AAA".into(), "BBB".into(), "C".into(), "D".into()]);
    assert!(s.ends_with('\n'));
    assert_eq!(s.trim().lines().count(), 1);
    let v: Value = serde_json::from_str(s.trim()).unwrap();
    assert_eq!(v["type"], "user");
    let c = v["message"]["content"].as_array().unwrap();
    assert_eq!(c[0], json!({ "type": "text", "text": "hi" }));
    assert_eq!(c.len(), 1 + MAX_IMAGES);
    assert_eq!(c[1]["source"]["media_type"], "image/png");
    assert_eq!(c[2]["source"]["data"], "BBB");
  }

  #[test]
  fn codex_args_read_only_and_pictures_last() {
    let a = codex_args(Path::new("/tmp/x"), Path::new("/tmp/x/answer.txt"), &[PathBuf::from("/tmp/x/p0.png")]);
    assert_eq!(a[0], "exec");
    let after = |f: &str| a[a.iter().position(|x| x == f).unwrap() + 1].clone();
    assert_eq!(after("--sandbox"), "read-only");
    assert_eq!(after("-o"), "/tmp/x/answer.txt");
    assert_eq!(after("-C"), "/tmp/x");
    assert!(a.contains(&"--ephemeral".to_string()));
    assert_eq!(&a[a.len() - 2..], &["-i".to_string(), "/tmp/x/p0.png".to_string()]);
    assert!(!a.iter().any(|x| x.contains("dangerously")));
  }

  #[test]
  fn parent_session_vars_are_stripped() {
    let env = ["PATH", "HOME", "CLAUDECODE", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CONFIG_DIR", "CLAUDE_PID"];
    let gone = scrubbed(env.iter().copied());
    assert_eq!(gone, vec!["CLAUDECODE", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_PID"]);
    // The login and its config dir are the person's own: kept.
    assert!(!gone.contains(&"CLAUDE_CONFIG_DIR".to_string()));
  }

  #[test]
  fn result_event_is_read() {
    let out = concat!(
      "{\"type\":\"system\",\"subtype\":\"init\"}\n",
      "{\"type\":\"assistant\",\"message\":{}}\n",
      "{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"result\":\"{\\\"grid\\\":[]}\",\"usage\":{\"input_tokens\":10,\"output_tokens\":5,\"cache_read_input_tokens\":2,\"cache_creation_input_tokens\":1}}\n"
    );
    let r = claude_result(out);
    assert_eq!(r["ok"], true);
    assert_eq!(r["text"], "{\"grid\":[]}");
    assert_eq!(r["usage"]["output"], 5.0);
    let bad = claude_result("{\"type\":\"result\",\"is_error\":true,\"result\":\"Not logged in\"}");
    assert_eq!(bad["ok"], false);
    assert_eq!(bad["detail"], "Not logged in");
    let none = claude_result("Error: something\n");
    assert_eq!(none["ok"], false);
    assert_eq!(none["detail"], "Error: something");
  }

  #[test]
  fn ids_are_cleaned() {
    assert_eq!(clean_id("ab-1_C/../x"), "ab-1_Cx");
  }
}
