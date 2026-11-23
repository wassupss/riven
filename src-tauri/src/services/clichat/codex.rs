// The CLI chat over the interactive `codex` (0.158). Pure parts: hooks, the
// command line, the rollout translator and the screen heuristics; mod.rs
// runs the session the same way it runs Claude's (a hidden pty, state from
// hooks, the conversation from the session's file).
//
// What a live probe of 0.158 showed (scratch cwd, cheapest model, hooks as
// -c overrides, nothing persisted):
//
// - Codex's hooks take Claude Code's schema: SessionStart carries session_id
//   and transcript_path (the rollout), Stop carries last_assistant_message,
//   PreToolUse/PostToolUse/PermissionRequest carry tool_name "Bash" and
//   tool_input { command, description }. A PermissionRequest hook that
//   prints {"hookSpecificOutput":{"decision":{"behavior":"allow"}}} runs
//   the command without the TUI's own approval menu; printing nothing
//   leaves that menu up ("Would you like to run the following command?").
// - There is no --session-id: a new conversation's id arrives with
//   SessionStart. `codex resume <id>` and `codex fork <id>` continue one.
// - Hooks given with -c are new to Codex's trust list the first time: it
//   shows "Hooks need review" (a menu the chat draws as a card). Trust is
//   keyed by event + position + the command's hash, so the commands never
//   change between runs (everything variable comes from the environment).
// - Esc interrupts a turn; no Stop hook follows.
//
// The rollout (~/.codex/sessions/YYYY/MM/DD/rollout-*-<id>.jsonl) is turned
// into records of the shape transcript::Store reads, so the chat view, the
// turn grouping and the delta logic are shared with Claude.

use serde_json::{json, Value};

/// The hooks a Codex CLI chat runs with. Codex has no Notification or
/// MessageDisplay hook; PermissionRequest is answered through the hook.
pub const EVENTS: &[&str] = &["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PermissionRequest", "Stop"];

fn toml_string(s: &str) -> String {
  serde_json::to_string(s).unwrap_or_default()
}

/// A command hook that POSTs the event to `url` (a shell expression) and
/// prints the answer, which is how a Codex hook answers (stdout).
fn hook_command(url: &str, event: &str, timeout: u64, auth: bool) -> String {
  let headers = if auth { " -H \"Authorization: Bearer $RIVEN_HOOK_TOKEN\" -H \"X-Riven-Pane: $RIVEN_PANE\"" } else { "" };
  format!("curl -s -m {timeout} -X POST -H 'content-type: application/json'{headers} --data-binary @- \"{url}?event={event}&agent=codex\" 2>/dev/null; exit 0")
}

fn overrides_for(url: &str, auth: bool) -> Vec<String> {
  EVENTS
    .iter()
    .map(|ev| {
      let timeout = if *ev == "PermissionRequest" { super::hooks::PERMISSION_TIMEOUT_SECS } else { 5 };
      let cmd = hook_command(url, ev, timeout, auth);
      format!("hooks.{ev}=[{{hooks=[{{type=\"command\",command={},timeout={}}}]}}]", toml_string(&cmd), timeout + 5)
    })
    .collect()
}

/// The CLI chat's hook overrides: to riven's /clichat route, the pane and
/// the token from the environment (RIVEN_CLICHAT_URL, RIVEN_PANE,
/// RIVEN_HOOK_TOKEN), so the commands are the same for every pane and run.
pub fn hook_overrides() -> Vec<String> {
  overrides_for("$RIVEN_CLICHAT_URL", true)
}

/// The probe's hooks: straight to its own server.
#[cfg(test)]
pub fn probe_overrides(base: &str) -> Vec<String> {
  overrides_for(&format!("{base}/clichat"), false)
}

/// The permission modes the chat offers, as Codex's sandbox and approval
/// policy (the headless chat's mapping, services/chat/codex.rs).
pub fn policy(mode: Option<&str>) -> (&'static str, &'static str) {
  match mode {
    Some("plan") => ("read-only", "never"),
    Some("bypassPermissions") => ("danger-full-access", "never"),
    _ => ("workspace-write", "on-request"),
  }
}

/// riven's MCP server for the pane (its url; the token is read from
/// $RIVEN_MCP_TOKEN) and the developer instructions, as -c values.
pub fn mcp_overrides(url: Option<&str>, timeout_sec: u64, instructions: Option<&str>) -> Vec<String> {
  let mut out = Vec::new();
  if let Some(u) = url {
    out.push(format!("mcp_servers.riven.url={}", toml_string(u)));
    out.push("mcp_servers.riven.bearer_token_env_var=\"RIVEN_MCP_TOKEN\"".into());
    out.push(format!("mcp_servers.riven.tool_timeout_sec={timeout_sec}"));
  }
  if let Some(i) = instructions.filter(|i| !i.trim().is_empty()) {
    out.push(format!("developer_instructions={}", toml_string(i)));
  }
  out
}

fn sq(s: &str) -> String {
  format!("'{}'", s.replace('\'', "'\\''"))
}

/// How a launch picks up a conversation.
#[derive(Debug, Clone, PartialEq)]
pub enum Start<'a> {
  New,
  Resume(&'a str),
  Fork(&'a str),
}

/// The command line the hidden shell execs for a Codex CLI chat. `extra`
/// are -c values (hooks, MCP, instructions). The update check is off (an
/// update prompt is not something to answer from a chat).
pub fn command_line(real: Option<&str>, start: &Start, model: Option<&str>, mode: Option<&str>, extra: &[String]) -> String {
  let mut c = vec![real.map(sq).unwrap_or_else(|| "codex".into())];
  match start {
    Start::New => {}
    Start::Resume(id) => c.push(format!("resume {}", sq(id))),
    Start::Fork(id) => c.push(format!("fork {}", sq(id))),
  }
  for o in extra {
    c.push(format!("-c {}", sq(o)));
  }
  c.push("-c check_for_update_on_startup=false".into());
  if let Some(m) = model.filter(|m| !m.is_empty() && *m != "default") {
    c.push(format!("-m {}", sq(m)));
  }
  let (sandbox, approval) = policy(mode);
  c.push(format!("-s {sandbox} -a {approval}"));
  c.join(" ")
}

// ---- the rollout -------------------------------------------------------------------

/// Turns rollout lines into transcript records (the shape Store reads).
/// Records are chained in file order; ids come from the line number, so a
/// re-read of the same file gives the same keys.
#[derive(Default)]
pub struct Translator {
  line: u64,
  last: Option<String>,
  model: String,
  titled: bool,
}

// Context Codex hands the model as a user message: the environment, the
// AGENTS.md text, IDE context. Not something the person typed.
fn injected(text: &str) -> bool {
  let t = text.trim_start();
  t.starts_with('<') || t.starts_with("# AGENTS.md") || t.starts_with("# Context from my IDE")
}

fn content_text(content: &Value, kinds: &[&str]) -> String {
  content
    .as_array()
    .into_iter()
    .flatten()
    .filter(|c| c.get("type").and_then(Value::as_str).is_some_and(|t| kinds.contains(&t)))
    .filter_map(|c| c.get("text").and_then(Value::as_str))
    .collect::<Vec<_>>()
    .join("\n")
}

fn output_text(v: &Value) -> String {
  match v {
    Value::String(s) => {
      // function_call_output: a JSON string {"output": "...", "metadata": ...}
      // in older versions, plain text in newer ones.
      serde_json::from_str::<Value>(s).ok().and_then(|j| j.get("output").and_then(Value::as_str).map(str::to_string)).unwrap_or_else(|| s.clone())
    }
    // Output chunks carry their own line ends.
    Value::Array(a) => a.iter().filter_map(|c| c.get("text").and_then(Value::as_str)).collect::<Vec<_>>().concat(),
    Value::Object(o) => o.get("output").map(output_text).or_else(|| o.get("content").map(output_text)).unwrap_or_default(),
    _ => String::new(),
  }
}

/// A tool call as the chat view names it: a shell command is Bash with
/// { command } (code mode's `tools.exec_command({cmd: ...})`, a
/// function_call's command array or string), a patch is Edit with the first
/// file it touches; anything else keeps its name and input.
pub fn tool_call(name: &str, input: &Value) -> (String, Value) {
  let raw = input.as_str().unwrap_or("");
  if name == "exec" || name == "code" {
    // Code mode: a script calling tools. The command it runs, if it is one.
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let re = RE.get_or_init(|| regex::Regex::new(r#"exec_command\(\s*\{\s*cmd\s*:\s*"((?:[^"\\]|\\.)*)""#).unwrap());
    if let Some(c) = re.captures(raw) {
      let cmd = serde_json::from_str::<String>(&format!("\"{}\"", &c[1])).unwrap_or_else(|_| c[1].to_string());
      return ("Bash".into(), json!({ "command": cmd }));
    }
    return (name.into(), json!({ "code": raw }));
  }
  if name == "apply_patch" {
    let patch = raw.to_string();
    let file = patch.lines().find_map(|l| l.strip_prefix("*** Update File: ").or_else(|| l.strip_prefix("*** Add File: ")).or_else(|| l.strip_prefix("*** Delete File: "))).map(str::trim);
    return ("Edit".into(), json!({ "file_path": file.unwrap_or(""), "patch": patch }));
  }
  let args: Value = match input {
    Value::String(s) => serde_json::from_str(s).unwrap_or_else(|_| json!({ "input": s })),
    v => v.clone(),
  };
  if matches!(name, "shell" | "exec_command" | "local_shell" | "container.exec" | "shell_command") {
    let cmd = match args.get("command").or_else(|| args.get("cmd")) {
      Some(Value::Array(a)) => {
        let parts: Vec<&str> = a.iter().filter_map(Value::as_str).collect();
        // ["bash", "-lc", "the command"] is the command.
        if parts.len() == 3 && parts[1] == "-lc" { parts[2].to_string() } else { parts.join(" ") }
      }
      Some(Value::String(s)) => s.clone(),
      _ => String::new(),
    };
    return ("Bash".into(), json!({ "command": cmd }));
  }
  (name.into(), args)
}

impl Translator {
  fn id(&self) -> String {
    format!("codex-{}", self.line)
  }

  fn rec(&mut self, mut v: Value) -> String {
    let id = self.id();
    v["uuid"] = json!(id);
    v["parentUuid"] = self.last.clone().map(Value::String).unwrap_or(Value::Null);
    self.last = Some(id);
    v.to_string()
  }

  /// One rollout line in, zero or more transcript lines out.
  pub fn translate(&mut self, line: &str) -> Vec<String> {
    self.line += 1;
    let Ok(v) = serde_json::from_str::<Value>(line) else { return Vec::new() };
    let p = v.get("payload").cloned().unwrap_or(Value::Null);
    let ty = v.get("type").and_then(Value::as_str).unwrap_or("");
    let pty = p.get("type").and_then(Value::as_str).unwrap_or("");
    let mut out = Vec::new();
    match (ty, pty) {
      ("turn_context", _) => {
        if let Some(m) = p.get("model").and_then(Value::as_str) {
          self.model = m.to_string();
        }
      }
      ("event_msg", "thread_settings_applied") => {
        if let Some(m) = p.pointer("/thread_settings/model").and_then(Value::as_str) {
          self.model = m.to_string();
        }
      }
      ("response_item", "message") => {
        let role = p.get("role").and_then(Value::as_str).unwrap_or("");
        let content = p.get("content").cloned().unwrap_or(Value::Null);
        if role == "user" {
          let text = content_text(&content, &["input_text"]);
          if injected(&text) {
            return out;
          }
          let images = content.as_array().map(|c| c.iter().filter(|x| x.get("type").and_then(Value::as_str) == Some("input_image")).count()).unwrap_or(0);
          if text.trim().is_empty() && images == 0 {
            return out;
          }
          let mut blocks = vec![json!({ "type": "text", "text": text })];
          blocks.extend((0..images).map(|_| json!({ "type": "image" })));
          // Codex names a conversation by its first message (no AI title).
          if !self.titled {
            self.titled = true;
            if let Some(first) = text.lines().map(str::trim).find(|l| !l.is_empty()) {
              let t: String = first.chars().take(80).collect();
              out.push(json!({ "type": "ai-title", "aiTitle": t }).to_string());
            }
          }
          out.push(self.rec(json!({ "type": "user", "message": { "role": "user", "content": blocks } })));
        } else if role == "assistant" {
          let text = content_text(&content, &["output_text"]);
          if !text.trim().is_empty() {
            let id = p.get("id").and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| self.id());
            out.push(self.rec(json!({ "type": "assistant", "message": { "id": id, "content": [{ "type": "text", "text": text }] } })));
          }
        }
      }
      ("response_item", "reasoning") => {
        let summary: Vec<&str> = p.get("summary").and_then(Value::as_array).into_iter().flatten().filter_map(|s| s.get("text").and_then(Value::as_str)).collect();
        if !summary.is_empty() {
          out.push(self.rec(json!({ "type": "assistant", "message": { "content": [{ "type": "thinking", "thinking": summary.join("\n\n") }] } })));
        }
      }
      ("response_item", "function_call" | "custom_tool_call" | "local_shell_call") => {
        let name = p.get("name").and_then(Value::as_str).unwrap_or(if pty == "local_shell_call" { "local_shell" } else { "tool" });
        let input = p.get("arguments").or_else(|| p.get("input")).or_else(|| p.get("action")).cloned().unwrap_or(Value::Null);
        let (name, input) = tool_call(name, &input);
        let call = p.get("call_id").and_then(Value::as_str).unwrap_or("").to_string();
        out.push(self.rec(json!({ "type": "assistant", "message": { "content": [{ "type": "tool_use", "id": call, "name": name, "input": input }] } })));
      }
      ("response_item", "function_call_output" | "custom_tool_call_output") => {
        let call = p.get("call_id").and_then(Value::as_str).unwrap_or("").to_string();
        let text = output_text(p.get("output").unwrap_or(&Value::Null));
        out.push(self.rec(json!({ "type": "user", "message": { "role": "user", "content": [{ "type": "tool_result", "tool_use_id": call, "content": text }] } })));
      }
      ("token_usage_record", _) => {
        let u = p.get("usage").cloned().unwrap_or(Value::Null);
        let n = |k: &str| u.get(k).and_then(Value::as_u64).unwrap_or(0);
        let id = p.get("response_id").and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| self.id());
        let cached = n("cached_input_tokens");
        let usage = json!({
          "input_tokens": n("input_tokens").saturating_sub(cached),
          "cache_read_input_tokens": cached,
          "cache_creation_input_tokens": n("cache_write_input_tokens"),
          "output_tokens": n("output_tokens")
        });
        out.push(self.rec(json!({ "type": "assistant", "message": { "id": id, "model": self.model, "content": [], "usage": usage } })));
      }
      ("event_msg", "task_complete") => {
        let ms = p.get("duration_ms").and_then(Value::as_u64).unwrap_or(0);
        out.push(self.rec(json!({ "type": "system", "subtype": "turn_duration", "durationMs": ms })));
      }
      ("event_msg", "turn_aborted") => {
        out.push(self.rec(json!({ "type": "user", "message": { "role": "user", "content": "[Request interrupted by user]" } })));
      }
      ("event_msg", "error" | "stream_error") => {
        let msg = p.get("message").and_then(Value::as_str).unwrap_or("error");
        out.push(self.rec(json!({ "type": "system", "subtype": "api_error", "content": msg })));
      }
      ("compacted", _) | ("event_msg", "context_compacted") => {
        out.push(self.rec(json!({ "type": "system", "subtype": "compact_boundary", "compactMetadata": { "trigger": "auto" } })));
      }
      _ => {}
    }
    out
  }
}

// ---- the screen --------------------------------------------------------------------
//
// Codex 0.158, idle:
//
//   › Reply with the single word pong.      <- echo of a sent message
//   • pong                                  <- agent message / tool lines
//
//   › Ask Codex to do anything              <- the input line
//     GPT-5.6-Luna low · /path · title      <- status
//     ? for shortcuts
//
// Working: "• Working (3s • esc to interrupt)" above the input line. A menu
// (approval, hook review, folder trust) replaces the input line with
// "› 1. ..." rows and "enter ... · esc ..." under them.

const PROMPT: char = '›';

fn option_row(t: &str) -> bool {
  let t = t.trim_start().trim_start_matches(PROMPT).trim_start();
  let d = t.chars().take_while(|c| c.is_ascii_digit()).count();
  d > 0 && t[d..].starts_with(". ")
}

/// The input line is on screen: the last "› " line that is not a menu row,
/// within the last few lines of the screen.
pub fn has_input_box(screen: &str) -> bool {
  let lines: Vec<&str> = screen.lines().map(str::trim_end).filter(|l| !l.trim().is_empty()).collect();
  let tail = &lines[lines.len().saturating_sub(4)..];
  tail.iter().any(|l| l.trim_start().starts_with(PROMPT) && !option_row(l)) && !tail.iter().any(|l| option_row(l))
}

/// A Codex dialog the chat cannot answer as a menu: signing in.
pub fn blocked(screen: &str) -> Option<&'static str> {
  let low = screen.to_lowercase();
  if low.contains("sign in with chatgpt") || low.contains("provide your own api key") {
    return Some("login");
  }
  None
}

fn is_tool_line(rest: &str) -> bool {
  ["Ran ", "Running ", "Working", "Explored", "Exploring", "Edited ", "Editing ", "Read ", "Searched ", "Added ", "Deleted ", "Updated ", "Waited", "Called ", "Calling "]
    .iter()
    .any(|p| rest.starts_with(p))
}

/// The reply being streamed: the last "• " block of this turn that is not a
/// tool line, above the input line. None when unsure.
pub fn extract(screen: &str) -> Option<String> {
  let lines: Vec<&str> = screen.lines().map(str::trim_end).collect();
  let input = (0..lines.len()).rev().find(|&i| lines[i].starts_with(PROMPT) && !option_row(lines[i]))?;
  let region = &lines[..input];
  let start = region.iter().rposition(|l| l.starts_with(PROMPT)).map(|i| i + 1).unwrap_or(0);
  let turn = &region[start..];
  let b = turn.iter().rposition(|l| l.starts_with('•'))?;
  let rest = turn[b].trim_start_matches('•').trim_start();
  if is_tool_line(rest) {
    return None;
  }
  let mut out = vec![rest.to_string()];
  for l in &turn[b + 1..] {
    let indent = l.len() - l.trim_start().len();
    if !l.trim().is_empty() && (indent < 2 || l.trim_start().starts_with('└')) {
      break;
    }
    out.push(l.strip_prefix("  ").unwrap_or(l).to_string());
  }
  // The time stamp Codex prints under a finished reply.
  while out.last().is_some_and(|l| l.trim().is_empty() || is_clock(l.trim())) {
    out.pop();
  }
  let text = out.join("\n").trim().to_string();
  (!text.is_empty()).then_some(text)
}

fn is_clock(s: &str) -> bool {
  let s = s.trim_end_matches(" AM").trim_end_matches(" PM");
  let mut it = s.split(':');
  matches!((it.next(), it.next(), it.next()), (Some(h), Some(m), None) if !h.is_empty() && h.len() <= 2 && m.len() == 2 && h.chars().chain(m.chars()).all(|c| c.is_ascii_digit()))
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::services::clichat::transcript::{Item, Store};

  // Hand-written in the shape 0.158 writes (fields trimmed to the ones read;
  // the text is made up).
  fn fixture() -> Vec<&'static str> {
    vec![
      r#"{"timestamp":"t","type":"session_meta","payload":{"id":"01a20714-ff45-71b2-8530-000000000001","cwd":"/w","originator":"codex-tui"}}"#,
      r#"{"timestamp":"t","type":"event_msg","payload":{"type":"task_started","turn_id":"t1"}}"#,
      r#"{"timestamp":"t","type":"response_item","payload":{"type":"message","id":"m0","role":"developer","content":[{"type":"input_text","text":"<permissions instructions>"}]}}"#,
      r#"{"timestamp":"t","type":"response_item","payload":{"type":"message","id":"m1","role":"user","content":[{"type":"input_text","text":"<environment_context>x</environment_context>"}]}}"#,
      r#"{"timestamp":"t","type":"response_item","payload":{"type":"message","id":"m2","role":"user","content":[{"type":"input_text","text":"Make a file\nplease"}]}}"#,
      r#"{"timestamp":"t","type":"turn_context","payload":{"turn_id":"t1","model":"gpt-5.6-luna","approval_policy":"on-request"}}"#,
      r#"{"timestamp":"t","type":"response_item","payload":{"type":"reasoning","id":"r1","summary":[],"encrypted_content":"x"}}"#,
      r#"{"timestamp":"t","type":"response_item","payload":{"type":"custom_tool_call","id":"c1","status":"completed","call_id":"call_1","name":"exec","input":"const r = await tools.exec_command({cmd:\"touch \\\"a b.txt\\\"\",workdir:\"/w\",yield_time_ms:10000}); text(r.output);"}}"#,
      r#"{"timestamp":"t","type":"token_usage_record","payload":{"response_id":"resp_1","usage":{"input_tokens":1000,"cached_input_tokens":800,"cache_write_input_tokens":0,"output_tokens":20,"total_tokens":1020}}}"#,
      r#"{"timestamp":"t","type":"response_item","payload":{"type":"custom_tool_call_output","id":"o1","call_id":"call_1","output":[{"type":"input_text","text":"Script completed\n"},{"type":"input_text","text":"done\n"}]}}"#,
      r#"{"timestamp":"t","type":"response_item","payload":{"type":"message","id":"m3","role":"assistant","content":[{"type":"output_text","text":"Created it."}],"phase":"final_answer"}}"#,
      r#"{"timestamp":"t","type":"event_msg","payload":{"type":"task_complete","turn_id":"t1","last_agent_message":"Created it.","duration_ms":4200}}"#,
      r#"{"timestamp":"t","type":"response_item","payload":{"type":"function_call","name":"shell","arguments":"{\"command\":[\"bash\",\"-lc\",\"ls -la\"]}","call_id":"call_2"}}"#,
      r#"{"timestamp":"t","type":"response_item","payload":{"type":"function_call_output","call_id":"call_2","output":"{\"output\":\"a b.txt\\n\",\"metadata\":{\"exit_code\":0}}"}}"#,
      r#"{"timestamp":"t","type":"event_msg","payload":{"type":"turn_aborted","reason":"interrupted"}}"#,
      "not json",
    ]
  }

  fn store() -> Store {
    let mut tr = Translator::default();
    let mut st = Store::default();
    for l in fixture() {
      for r in tr.translate(l) {
        st.ingest(&r);
      }
    }
    st
  }

  #[test]
  fn rollout_items() {
    let st = store();
    assert_eq!(st.title(), Some("Make a file"));
    let items = st.branch();
    let kinds: Vec<String> = items
      .iter()
      .map(|i| match i {
        Item::User { text, .. } => format!("user:{text}"),
        Item::Text { text, .. } => format!("text:{text}"),
        Item::Tool { name, input, .. } => format!("tool:{name}:{}", input["command"].as_str().unwrap_or("")),
        Item::ToolResult { text, tool_id, .. } => format!("result:{tool_id}:{}", text.trim()),
        Item::Usage { model, input, cache_read, output, .. } => format!("usage:{model}:{input}:{cache_read}:{output}"),
        Item::TurnEnd { duration_ms, .. } => format!("end:{duration_ms}"),
        Item::Note { level, .. } => format!("note:{level}"),
        other => format!("{other:?}"),
      })
      .collect();
    assert_eq!(
      kinds,
      vec![
        "user:Make a file\nplease",
        "tool:Bash:touch \"a b.txt\"",
        "usage:gpt-5.6-luna:200:800:20",
        "result:call_1:Script completed\ndone",
        "text:Created it.",
        "end:4200",
        "tool:Bash:ls -la",
        "result:call_2:a b.txt",
        "note:interrupted",
      ]
    );
    // The same file read again gives the same keys (a tail restart).
    let again: Vec<String> = store().branch().iter().map(|i| i.key().to_string()).collect();
    assert_eq!(again, items.iter().map(|i| i.key().to_string()).collect::<Vec<_>>());
    assert_eq!(crate::services::clichat::transcript::last_reply(&items[..5]).as_deref(), Some("Created it."));
  }

  #[test]
  fn tool_calls() {
    let (n, i) = tool_call("apply_patch", &json!("*** Begin Patch\n*** Update File: src/a.rs\n@@\n-x\n+y\n*** End Patch"));
    assert_eq!((n.as_str(), i["file_path"].as_str()), ("Edit", Some("src/a.rs")));
    let (n, i) = tool_call("exec", &json!("text(await tools.view_image({path:\"x.png\"}))"));
    assert_eq!(n, "exec");
    assert!(i["code"].as_str().unwrap().contains("view_image"));
    let (n, i) = tool_call("exec_command", &json!("{\"cmd\":\"git status\"}"));
    assert_eq!((n.as_str(), i["command"].as_str()), ("Bash", Some("git status")));
    let (n, i) = tool_call("riven__riven_agents", &json!("{\"x\":1}"));
    assert_eq!((n.as_str(), i["x"].as_u64()), ("riven__riven_agents", Some(1)));
  }

  #[test]
  fn command_lines() {
    let x = vec!["hooks.Stop=[]".to_string()];
    assert_eq!(
      command_line(Some("/b/codex"), &Start::New, Some("gpt-5.6-luna"), Some("acceptEdits"), &x),
      "'/b/codex' -c 'hooks.Stop=[]' -c check_for_update_on_startup=false -m 'gpt-5.6-luna' -s workspace-write -a on-request"
    );
    assert_eq!(command_line(None, &Start::Resume("id-1"), Some("default"), Some("plan"), &[]), "codex resume 'id-1' -c check_for_update_on_startup=false -s read-only -a never");
    assert_eq!(command_line(None, &Start::Fork("id-1"), None, None, &[]), "codex fork 'id-1' -c check_for_update_on_startup=false -s workspace-write -a on-request");
  }

  #[test]
  fn hooks_and_mcp() {
    let h = hook_overrides();
    assert_eq!(h.len(), EVENTS.len());
    let stop = h.iter().find(|o| o.starts_with("hooks.Stop=")).unwrap();
    assert!(stop.contains("$RIVEN_CLICHAT_URL?event=Stop&agent=codex"));
    assert!(stop.contains("X-Riven-Pane: $RIVEN_PANE"));
    // A TOML inline array of matcher groups with one command hook.
    assert!(stop.starts_with("hooks.Stop=[{hooks=[{type=\"command\",command=\"curl -s -m 5 "));
    assert!(stop.ends_with("exit 0\",timeout=10}]}]"));
    let perm = h.iter().find(|o| o.starts_with("hooks.PermissionRequest=")).unwrap();
    assert!(perm.contains("-m 600"));
    let m = mcp_overrides(Some("http://127.0.0.1:1/mcp/x"), 300, Some("be \"brief\""));
    assert_eq!(m[0], "mcp_servers.riven.url=\"http://127.0.0.1:1/mcp/x\"");
    assert_eq!(m[3], "developer_instructions=\"be \\\"brief\\\"\"");
    assert!(mcp_overrides(None, 1, Some(" ")).is_empty());
  }

  // Screens from the live probe (0.158), trimmed.
  const IDLE: &str = "  >_ OpenAI Codex (v0.158.0)\n\n› Reply with the single word pong.\n\n• pong\n  3:20 PM\n\n› Ask Codex to do anything\n\n  GPT-5.6-Luna low · /w · Reply with pong\n  ? for shortcuts";
  const ASKING: &str = "› Same again for: touch c.txt\n\n• Running touch c.txt\n\n  Would you like to run the following command?\n\n  $ touch c.txt\n\n› 1. Yes, proceed (y)\n  2. Yes, and don't ask again for commands that start with `touch c.txt` (p)\n  3. No, and tell Codex what to do differently (esc)\n\n  Press enter to confirm or esc to cancel";
  const HOOKS: &str = "  Hooks need review\n  6 hooks are new or changed.\n  Hooks can run outside the sandbox after you trust them.\n\n› 1. Review hooks\n  2. Trust all and continue\n  3. Continue without trusting (hooks won't run)\n\n  enter confirm · esc skip";

  #[test]
  fn screens() {
    assert!(has_input_box(IDLE));
    assert!(!has_input_box(ASKING));
    assert!(!has_input_box(HOOKS));
    assert_eq!(extract(IDLE).as_deref(), Some("pong"));
    let m = crate::services::clichat::preview::menu(ASKING).unwrap();
    assert_eq!(m.options.len(), 3);
    assert_eq!(m.selected, 0);
    // Codex's "tell Codex what to do differently" cancels: nothing to type.
    assert!(!m.options[2].input);
    let h = crate::services::clichat::preview::menu(HOOKS).unwrap();
    assert_eq!(h.options[1].label, "Trust all and continue");
    assert_eq!(h.title, "6 hooks are new or changed. Hooks can run outside the sandbox after you trust them.");
    assert_eq!(blocked("Sign in with ChatGPT"), Some("login"));
    let working = "› hi\n\n• Working (3s • esc to interrupt)\n\n› Ask Codex to do anything\n  ? for shortcuts";
    assert_eq!(extract(working), None);
  }
}
