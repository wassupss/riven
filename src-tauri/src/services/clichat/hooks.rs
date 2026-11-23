// The hooks a CLI chat session runs with: Claude Code's own `http` hook type,
// POSTing each event straight to riven's loopback server (no shell + curl per
// event, which matters for MessageDisplay: it fires several times a second
// while a reply streams and the CLI waits on it).
//
// The settings are the same for every session of a run: the pane and the
// token come from the environment the CLI inherited (RIVEN_PANE,
// RIVEN_HOOK_TOKEN, set by services/mcp for every pty), interpolated by the
// CLI into the headers. Only names listed in allowedEnvVars are expanded.
//
// Pure: the page-facing side is in mod.rs.

use serde_json::{json, Map, Value};

/// Every event the chat view listens to. SessionStart is absent on purpose:
/// 2.1.330 does not run http hooks for it (the session id is known up front
/// anyway, from --session-id / --resume).
pub const EVENTS: &[&str] = &[
  "UserPromptSubmit",
  "Stop",
  "StopFailure",
  "Notification",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PermissionRequest",
  "PermissionDenied",
  "MessageDisplay",
  "PreCompact",
  "PostCompact",
  "SessionEnd",
];

/// How long a permission card may stay unanswered before the CLI falls back
/// to its own dialog (reachable through the terminal view).
pub const PERMISSION_TIMEOUT_SECS: u64 = 600;

/// The --settings JSON for a session. `base` is the loopback server's origin.
pub fn settings(base: &str) -> Value {
  let mut hooks = Map::new();
  for ev in EVENTS {
    let timeout = if *ev == "PermissionRequest" { PERMISSION_TIMEOUT_SECS + 5 } else { 5 };
    hooks.insert(
      ev.to_string(),
      json!([{
        "matcher": "",
        "hooks": [{
          "type": "http",
          "url": format!("{base}/clichat?event={ev}"),
          "headers": { "Authorization": "Bearer $RIVEN_HOOK_TOKEN", "X-Riven-Pane": "$RIVEN_PANE" },
          "allowedEnvVars": ["RIVEN_HOOK_TOKEN", "RIVEN_PANE"],
          "timeout": timeout
        }]
      }]),
    );
  }
  json!({ "hooks": hooks })
}

/// A person's answer to a permission card.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Decision {
  Allow,
  Deny,
  /// Answer it in the CLI's own dialog (terminal view): the hook says
  /// nothing and the CLI asks as usual.
  Terminal,
}

impl Decision {
  pub fn parse(s: &str) -> Decision {
    match s {
      "allow" => Decision::Allow,
      "deny" => Decision::Deny,
      _ => Decision::Terminal,
    }
  }
}

/// The hook's answer body, or None for "no opinion" (an empty 204).
pub fn permission_answer(d: Decision) -> Option<Value> {
  let decision = match d {
    Decision::Allow => json!({ "behavior": "allow" }),
    Decision::Deny => json!({ "behavior": "deny", "message": "The user denied this in riven." }),
    Decision::Terminal => return None,
  };
  Some(json!({ "hookSpecificOutput": { "hookEventName": "PermissionRequest", "decision": decision } }))
}

/// The events services/mcp/hooks.rs already understands (activity, the
/// session id, the reply notification, the changes timeline): forwarded to
/// it so a CLI chat counts like any other agent pane.
pub fn forwarded(event: &str) -> bool {
  matches!(event, "UserPromptSubmit" | "Stop" | "StopFailure" | "SessionEnd" | "Notification" | "PreToolUse" | "PostToolUse")
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn settings_shape() {
    let v = settings("http://127.0.0.1:5555");
    let h = &v["hooks"]["MessageDisplay"][0]["hooks"][0];
    assert_eq!(h["type"], "http");
    assert_eq!(h["url"], "http://127.0.0.1:5555/clichat?event=MessageDisplay");
    assert_eq!(h["headers"]["X-Riven-Pane"], "$RIVEN_PANE");
    assert_eq!(v["hooks"]["PermissionRequest"][0]["hooks"][0]["timeout"], 605);
    assert!(v["hooks"].get("SessionStart").is_none());
  }

  #[test]
  fn answers() {
    assert_eq!(permission_answer(Decision::parse("allow")).unwrap()["hookSpecificOutput"]["decision"]["behavior"], "allow");
    assert_eq!(permission_answer(Decision::parse("deny")).unwrap()["hookSpecificOutput"]["decision"]["behavior"], "deny");
    assert!(permission_answer(Decision::parse("terminal")).is_none());
    assert!(forwarded("Stop") && !forwarded("MessageDisplay"));
  }
}
