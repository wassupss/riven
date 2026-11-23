// A chat title from a cheap one-off call (the headless chat pane's tab).

use crate::services::util::{self, resolve_bin, run, Run};
use std::collections::HashMap;
use std::time::Duration;

// ---- chat:title ------------------------------------------------------------------

/// A short AI title for a chat from its first message; '' on any failure.
/// Everything a title does not need is switched off (measured 436 in / 18 out
/// in the Node build). Not --bare: that skips OAuth, so a subscription login
/// would get no titles.
pub async fn title(message: &str) -> String {
  let Some(cmd) = resolve_bin("claude").await else { return String::new() };
  let prompt = format!("다음 요청을 한국어로 2~5단어의 짧은 제목으로 요약해. 따옴표·마침표 없이 제목만 한 줄로 출력:\n\n{}", util::slice(message, 800));
  let args = vec![
    "-p".into(),
    prompt,
    "--model".into(),
    "haiku".into(),
    "--output-format".into(),
    "text".into(),
    "--system-prompt".into(),
    "You write short titles. Reply with the title only.".into(),
    "--tools".into(),
    "".into(),
    "--strict-mcp-config".into(),
    "--disable-slash-commands".into(),
    "--setting-sources".into(),
    "".into(),
    "--no-session-persistence".into(),
  ];
  let env = HashMap::from([("MAX_THINKING_TOKENS".to_string(), "0".to_string())]);
  let r = run(Run { bin: &cmd, args, cwd: None, login: false, env, stderr: false, timeout: Duration::from_secs(12) }).await;
  if r.timed_out || !r.spawned {
    return String::new();
  }
  let line = r.out.trim().split('\n').next().unwrap_or("").to_string();
  let line = line.strip_prefix(['"', '\'', '`']).unwrap_or(&line);
  let line = line.strip_suffix(['"', '\'', '`']).unwrap_or(line);
  util::slice(line, 40)
}

