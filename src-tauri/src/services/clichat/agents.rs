// Subagent progress for the tool card of the Agent/Task call that started it.
//
// 2.1.330 keeps a subagent's conversation out of the session transcript: it
// is <session dir>/subagents/agent-<id>.jsonl, next to agent-<id>.meta.json
// which names the parent call (toolUseId) and says when it is finished. Both
// are read here, the transcript by offset like the main one, and summarised
// as: how many tools it ran, the last one, the last line it wrote.
//
// Pure apart from reading those files; tested with a temp dir.

use super::transcript::{Chunk, Tail};
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;

const MAX_LINE: usize = 160;

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
  pub agent_id: String,
  pub tool_id: String,
  pub description: String,
  pub agent_type: String,
  pub tools: u32,
  pub last_tool: Option<String>,
  pub last_text: Option<String>,
  pub done: bool,
}

struct Sub {
  p: Progress,
  tail: Tail,
}

pub struct Agents {
  dir: PathBuf,
  subs: HashMap<String, Sub>,
}

fn one_line(s: &str) -> String {
  let l = s.lines().find(|l| !l.trim().is_empty()).unwrap_or("").trim();
  if l.chars().count() > MAX_LINE {
    format!("{}…", l.chars().take(MAX_LINE).collect::<String>())
  } else {
    l.to_string()
  }
}

/// "Bash: echo hi" for a tool_use block: the argument a person knows it by.
pub fn tool_line(name: &str, input: &Value) -> String {
  let keys: &[&str] = if name == "Bash" { &["command"] } else { &["file_path", "path", "pattern", "url", "query", "description", "command"] };
  let arg = keys.iter().find_map(|k| input.get(*k).and_then(Value::as_str)).map(one_line).unwrap_or_default();
  if arg.is_empty() { name.to_string() } else { format!("{name}: {arg}") }
}

/// Fold one subagent transcript line into its progress.
pub fn ingest(p: &mut Progress, line: &str) {
  let Ok(v) = serde_json::from_str::<Value>(line) else { return };
  if v.get("type").and_then(Value::as_str) != Some("assistant") {
    return;
  }
  for b in v.pointer("/message/content").and_then(Value::as_array).into_iter().flatten() {
    match b.get("type").and_then(Value::as_str) {
      Some("tool_use") => {
        p.tools += 1;
        p.last_tool = Some(tool_line(b.get("name").and_then(Value::as_str).unwrap_or("?"), b.get("input").unwrap_or(&Value::Null)));
      }
      Some("text") => {
        let t = one_line(b.get("text").and_then(Value::as_str).unwrap_or(""));
        if !t.is_empty() {
          p.last_text = Some(t);
        }
      }
      _ => {}
    }
  }
}

impl Agents {
  /// `transcript` is the session's own JSONL; its subagents live in the
  /// folder of the same name.
  pub fn new(transcript: &std::path::Path) -> Agents {
    let dir = transcript.with_extension("").join("subagents");
    Agents { dir, subs: HashMap::new() }
  }

  pub fn any_running(&self) -> bool {
    self.subs.values().any(|s| !s.p.done)
  }

  /// Look for new agents and new lines. Returns whether anything changed.
  pub fn poll(&mut self) -> bool {
    let Ok(rd) = std::fs::read_dir(&self.dir) else { return false };
    let mut changed = false;
    for e in rd.flatten() {
      let name = e.file_name().to_string_lossy().into_owned();
      let Some(id) = name.strip_prefix("agent-").and_then(|n| n.strip_suffix(".meta.json")) else { continue };
      let id = id.to_string();
      // Finished and fully read on an earlier poll: nothing more will come.
      if self.subs.get(&id).is_some_and(|s| s.p.done) {
        continue;
      }
      let meta: Value = std::fs::read_to_string(e.path()).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(Value::Null);
      let sub = self.subs.entry(id.clone()).or_insert_with(|| {
        changed = true;
        Sub {
          p: Progress {
            agent_id: id.clone(),
            tool_id: String::new(),
            description: String::new(),
            agent_type: String::new(),
            tools: 0,
            last_tool: None,
            last_text: None,
            done: false,
          },
          tail: Tail::new(self.dir.join(format!("agent-{id}.jsonl"))),
        }
      });
      let get = |k: &str| meta.get(k).and_then(Value::as_str).unwrap_or("").to_string();
      let (tool_id, desc, ty) = (get("toolUseId"), get("description"), get("agentType"));
      let done = meta.get("finished").and_then(Value::as_bool) == Some(true);
      if sub.p.tool_id != tool_id || sub.p.description != desc || sub.p.agent_type != ty {
        sub.p.tool_id = tool_id;
        sub.p.description = desc;
        sub.p.agent_type = ty;
        changed = true;
      }
      if sub.tail.path.is_file() {
        let before = (sub.p.tools, sub.p.last_text.clone());
        match sub.tail.read() {
          Ok(Chunk::Lines(lines)) | Ok(Chunk::Restarted(lines)) => {
            for l in lines {
              ingest(&mut sub.p, &l);
            }
          }
          Err(_) => {}
        }
        changed |= before != (sub.p.tools, sub.p.last_text.clone());
      }
      if done != sub.p.done {
        sub.p.done = done;
        changed = true;
      }
    }
    changed
  }

  pub fn snapshot(&self) -> Vec<Progress> {
    let mut v: Vec<Progress> = self.subs.values().map(|s| s.p.clone()).filter(|p| !p.tool_id.is_empty()).collect();
    v.sort_by(|a, b| a.agent_id.cmp(&b.agent_id));
    v
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn summarises_a_subagent_from_its_files() {
    let base = std::env::temp_dir().join(format!("riven-agents-{}", std::process::id()));
    let transcript = base.join("sess.jsonl");
    let dir = base.join("sess").join("subagents");
    std::fs::create_dir_all(&dir).unwrap();
    let mut a = Agents::new(&transcript);
    assert!(!a.poll());
    // The shapes 2.1.330 wrote for a background general-purpose agent.
    std::fs::write(
      dir.join("agent-a03.meta.json"),
      r#"{"agentType":"general-purpose","description":"Run echo sub-ok","toolUseId":"toolu_01","finished":false}"#,
    )
    .unwrap();
    std::fs::write(
      dir.join("agent-a03.jsonl"),
      concat!(
        r#"{"parentUuid":null,"isSidechain":true,"agentId":"a03","type":"user","message":{"role":"user","content":"Run it"}}"#,
        "\n",
        r#"{"isSidechain":true,"agentId":"a03","type":"assistant","message":{"content":[{"type":"tool_use","id":"t","name":"Bash","input":{"command":"echo sub-ok"}}]}}"#,
        "\n"
      ),
    )
    .unwrap();
    assert!(a.poll());
    let s = a.snapshot();
    assert_eq!(s.len(), 1);
    assert_eq!(s[0].tool_id, "toolu_01");
    assert_eq!(s[0].tools, 1);
    assert_eq!(s[0].last_tool.as_deref(), Some("Bash: echo sub-ok"));
    assert!(a.any_running());
    assert!(!a.poll(), "nothing new");
    use std::io::Write;
    let mut f = std::fs::OpenOptions::new().append(true).open(dir.join("agent-a03.jsonl")).unwrap();
    f.write_all(br#"{"isSidechain":true,"type":"assistant","message":{"content":[{"type":"text","text":"sub-ok\nmore"}]}}"#).unwrap();
    f.write_all(b"\n").unwrap();
    std::fs::write(dir.join("agent-a03.meta.json"), r#"{"agentType":"general-purpose","description":"Run echo sub-ok","toolUseId":"toolu_01","finished":true}"#).unwrap();
    assert!(a.poll());
    let s = a.snapshot();
    assert_eq!(s[0].last_text.as_deref(), Some("sub-ok"));
    assert!(s[0].done && !a.any_running());
    let _ = std::fs::remove_dir_all(&base);
  }

  #[test]
  fn tool_lines() {
    assert_eq!(tool_line("Read", &serde_json::json!({ "file_path": "/a/b.rs" })), "Read: /a/b.rs");
    assert_eq!(tool_line("TodoWrite", &serde_json::json!({})), "TodoWrite");
  }
}
