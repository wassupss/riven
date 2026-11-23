// How a tool call reads in the pane: the one-line detail, the file it is
// about, and the code/diff shown when the line is expanded (agentChat.ts
// toolDetail / toolPath / toolCode, which mirror the native app).

use crate::services::util::{clamp, s, shorten, truthy};
use serde_json::Value;

/// Per-tool one-line detail, clamped to 120 UTF-16 units.
pub fn tool_detail(name: &str, input: &Value) -> String {
  let d = match name {
    "Read" | "Edit" | "Write" | "MultiEdit" | "NotebookEdit" => shorten(s(input, "file_path")),
    "Bash" => or(s(input, "description"), s(input, "command")).to_string(),
    "BashOutput" => s(input, "command").to_string(),
    "Grep" => {
      let mut d = s(input, "pattern").to_string();
      if truthy(input.get("path")) {
        d.push_str(&format!(" in {}", shorten(s(input, "path"))));
      }
      d
    }
    "Glob" => s(input, "pattern").to_string(),
    "LS" => shorten(s(input, "path")),
    "WebFetch" => s(input, "url").to_string(),
    "WebSearch" => s(input, "query").to_string(),
    // Subagent: its type + task description ("Agent" now, "Task" in older builds).
    "Task" | "Agent" => [s(input, "subagent_type"), or(s(input, "description"), s(input, "prompt"))]
      .into_iter()
      .filter(|x| !x.is_empty())
      .collect::<Vec<_>>()
      .join(" · "),
    _ => [s(input, "file_path"), s(input, "path"), s(input, "command"), s(input, "pattern"), s(input, "query")]
      .into_iter()
      .find(|x| !x.is_empty())
      .unwrap_or("")
      .to_string(),
  };
  clamp(&d, 120)
}

fn or<'a>(a: &'a str, b: &'a str) -> &'a str {
  if a.is_empty() {
    b
  } else {
    a
  }
}

pub fn tool_path(name: &str, input: &Value) -> Option<String> {
  if ["Read", "Edit", "Write", "MultiEdit", "NotebookEdit", "LS"].contains(&name) {
    // input.file_path ?? input.path
    let p = match input.get("file_path") {
      None | Some(Value::Null) => input.get("path"),
      v => v,
    };
    return p.and_then(Value::as_str).map(str::to_string);
  }
  None
}

pub const EDIT_TOOLS: [&str; 4] = ["Edit", "Write", "MultiEdit", "NotebookEdit"];

fn split_lines(s: &str) -> Vec<&str> {
  if s.is_empty() {
    Vec::new()
  } else {
    s.split('\n').collect()
  }
}

/// A compact LCS line diff as a unified body (" ctx", "-removed", "+added").
pub fn line_diff(before: &str, after: &str) -> String {
  let a = split_lines(before);
  let b = split_lines(after);
  let (m, n) = (a.len(), b.len());
  if m > 800 || n > 800 {
    return a.iter().map(|l| format!("-{l}")).chain(b.iter().map(|l| format!("+{l}"))).collect::<Vec<_>>().join("\n");
  }
  let w = n + 1;
  let mut dp = vec![0u32; (m + 1) * w];
  for i in (0..m).rev() {
    for j in (0..n).rev() {
      dp[i * w + j] = if a[i] == b[j] { dp[(i + 1) * w + j + 1] + 1 } else { dp[(i + 1) * w + j].max(dp[i * w + j + 1]) };
    }
  }
  let mut out: Vec<String> = Vec::new();
  let (mut i, mut j) = (0, 0);
  while i < m && j < n {
    if a[i] == b[j] {
      out.push(format!(" {}", a[i]));
      i += 1;
      j += 1;
    } else if dp[(i + 1) * w + j] >= dp[i * w + j + 1] {
      out.push(format!("-{}", a[i]));
      i += 1;
    } else {
      out.push(format!("+{}", b[j]));
      j += 1;
    }
  }
  while i < m {
    out.push(format!("-{}", a[i]));
    i += 1;
  }
  while j < n {
    out.push(format!("+{}", b[j]));
    j += 1;
  }
  out.join("\n")
}

pub fn count_diff(diff: &str) -> (usize, usize) {
  let (mut added, mut removed) = (0, 0);
  for l in diff.split('\n') {
    if l.starts_with('+') {
      added += 1;
    } else if l.starts_with('-') {
      removed += 1;
    }
  }
  (added, removed)
}

/// The code/diff body shown when a tool line is expanded.
pub fn tool_code(name: &str, input: &Value) -> Option<String> {
  let nonempty = |x: &str| (!x.is_empty()).then(|| x.to_string());
  match name {
    "Edit" => match input.get("old_string") {
      None => None,
      Some(_) => Some(line_diff(s(input, "old_string"), s(input, "new_string"))),
    },
    "Write" => nonempty(s(input, "content")),
    "NotebookEdit" => nonempty(s(input, "new_source")),
    "MultiEdit" => {
      let edits = input.get("edits").and_then(Value::as_array).cloned().unwrap_or_default();
      let body = edits.iter().map(|e| line_diff(s(e, "old_string"), s(e, "new_string"))).collect::<Vec<_>>().join("\n");
      nonempty(&body)
    }
    "Bash" => nonempty(s(input, "command")),
    _ => None,
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn diff_matches_node() {
    assert_eq!(line_diff("a\nb\nc", "a\nx\nc"), " a\n-b\n+x\n c");
    assert_eq!(line_diff("", "x"), "+x");
    assert_eq!(count_diff(" a\n-b\n+x\n c"), (1, 1));
  }

  #[test]
  fn details() {
    let v = serde_json::json!({"subagent_type": "Explore", "prompt": "find it"});
    assert_eq!(tool_detail("Agent", &v), "Explore · find it");
    let long = "x".repeat(130);
    assert_eq!(tool_detail("Bash", &serde_json::json!({ "command": long })), format!("{}…", "x".repeat(120)));
  }
}
