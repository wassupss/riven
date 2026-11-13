// Debug builds only: the DB engine without a window, for comparing it with the
// Node one (docs/tauri-rust-main.md, stage 6). RIVEN_DB_HARNESS=1 makes the
// binary read JSON lines from stdin and answer each on stdout:
//   {"ch": "db:query", "args": [..]}        -> {"ok": value} | {"err": message}
//   {"tool": "riven_db_query", "args": {..}, "answer": "실행"}
//                                           -> {"ok": text, "asked": [question, options] | null}
// Positional args use {"$undefined": true} for undefined. Events the channel
// sends come first as {"event": ch, "args": [..]}. Dialogs answer with
// RIVEN_DEV_SAVE_FILE / RIVEN_DEV_PICK_FILE.

use super::engine::{self, BoxFut, Ctx, Dialog};
use serde_json::{json, Value};
use std::io::{BufRead, Write};
use std::sync::{Arc, Mutex};

fn out(v: Value) {
  let mut o = std::io::stdout().lock();
  let _ = writeln!(o, "{v}");
  let _ = o.flush();
}

pub fn run() {
  crate::services::shell_env::start();
  let rt = super::runtime();
  let ctx = Ctx {
    emit: Arc::new(|ch: &str, args: Vec<Value>| out(json!({ "event": ch, "args": args }))),
    dialog: Arc::new(|d: Dialog| -> BoxFut<Option<String>> {
      Box::pin(async move {
        match d {
          Dialog::Save { .. } => std::env::var("RIVEN_DEV_SAVE_FILE").ok(),
          Dialog::Open { .. } => std::env::var("RIVEN_DEV_PICK_FILE").ok(),
        }
      })
    }),
  };
  for line in std::io::stdin().lock().lines() {
    let Ok(line) = line else { break };
    let Ok(req) = serde_json::from_str::<Value>(&line) else { continue };
    let args = req.get("args").cloned().unwrap_or(Value::Null);
    if let Some(env) = req.get("env").and_then(Value::as_object) {
      for (k, v) in env {
        // The harness's own variables, set between calls.
        match v.as_str() {
          Some(v) => unsafe { std::env::set_var(k, v) },
          None => unsafe { std::env::remove_var(k) },
        }
      }
    }
    if let Some(tool) = req.get("tool").and_then(Value::as_str) {
      let answer = req.get("answer").and_then(Value::as_str).unwrap_or("").to_string();
      let asked = Arc::new(Mutex::new(Value::Null));
      let a2 = asked.clone();
      let ask: engine::Ask = Box::new(move |q, o| {
        *a2.lock().unwrap() = json!([q, o]);
        Box::pin(async move { answer })
      });
      let tool = tool.to_string();
      let text = rt.block_on(async move { engine::run_db_tool(&tool, &args, ask).await });
      let asked = asked.lock().unwrap().clone();
      out(json!({ "ok": text, "asked": asked }));
      continue;
    }
    let ch = req.get("ch").and_then(Value::as_str).unwrap_or("").to_string();
    let pos: Vec<Option<Value>> = args
      .as_array()
      .cloned()
      .unwrap_or_default()
      .into_iter()
      .map(|v| if v.get("$undefined").is_some() { None } else { Some(v) })
      .collect();
    let c = ctx.clone();
    // Background calls (a cancel racing a query) are tagged and answered when done.
    let tag = req.get("tag").cloned();
    if req.get("bg").and_then(Value::as_bool) == Some(true) {
      rt.spawn(async move {
        let r = engine::call(&ch, pos, c).await;
        out(match r {
          Ok(v) => json!({ "ok": v, "tag": tag }),
          Err(e) => json!({ "err": e.msg, "tag": tag }),
        });
      });
      continue;
    }
    let r = rt.block_on(async move { engine::call(&ch, pos, c).await });
    out(match r {
      Ok(v) => json!({ "ok": v, "tag": tag }),
      Err(e) => json!({ "err": e.msg, "tag": tag }),
    });
  }
  rt.block_on(async {
    let _ = tokio::time::timeout(std::time::Duration::from_secs(2), super::close_all()).await;
  });
}
