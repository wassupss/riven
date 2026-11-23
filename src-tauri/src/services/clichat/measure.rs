// A live measurement, not a unit test: run the real interactive `claude` the
// way a CLI chat session does (pty, wide screen, http hooks, bracketed-paste
// input, transcript tail, screen preview), then the old headless driver's
// way (-p, stream-json), with the same three trivial prompts on haiku, and
// print the per-turn usage both transcripts record.
//
//   RIVEN_CLICHAT_CWD=/some/scratch/dir cargo test clichat::measure -- --ignored --nocapture
//
// It costs real tokens (a few cents on haiku) and runs `claude` in that
// directory, so it is opt-in twice: #[ignore] and the variable. No MCP
// servers (--strict-mcp-config, empty config). Every process it starts is
// waited for.

use super::hooks;
use super::preview;
use super::transcript::{transcript_path, turn_usage, Chunk, Item, Store, Tail};
use crate::services::pty::vt::Vt;
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const PROMPTS: [&str; 3] = [
  "Reply with exactly: alpha",
  "Use the Bash tool to run: python3 -c 'print(6*7)' and reply with just the number.",
  "Reply with exactly: gamma",
];
// RIVEN_CLICHAT_PROMPTS="a|b" replaces the default three (e.g. one long
// reply, to watch the preview stream).
fn prompts() -> Vec<String> {
  match std::env::var("RIVEN_CLICHAT_PROMPTS") {
    Ok(p) if !p.is_empty() => p.split('|').map(str::to_string).collect(),
    _ => PROMPTS.iter().map(|s| s.to_string()).collect(),
  }
}
const EMPTY_MCP: &str = r#"{"mcpServers":{}}"#;

#[derive(Default)]
struct Log {
  events: Vec<(f64, String)>,
  perm_screens: Vec<String>,
}

fn screen(vt: &Mutex<Vt>, rows: usize) -> String {
  let all = vt.lock().unwrap().plain_text();
  let lines: Vec<&str> = all.split('\n').collect();
  lines[lines.len().saturating_sub(rows)..].join("\n")
}

// The loopback hook server, as riven's /clichat route answers it: 204 for
// everything, and an "allow" for a permission request (after looking at the
// screen while the CLI waits on it).
fn hook_server(log: Arc<Mutex<Log>>, vt: Arc<Mutex<Vt>>, t0: Instant) -> u16 {
  let l = TcpListener::bind("127.0.0.1:0").unwrap();
  let port = l.local_addr().unwrap().port();
  std::thread::spawn(move || {
    for s in l.incoming().flatten() {
      let log = log.clone();
      let vt = vt.clone();
      std::thread::spawn(move || {
        let mut r = BufReader::new(s.try_clone().unwrap());
        let mut out = s;
        loop {
          let mut line = String::new();
          if r.read_line(&mut line).unwrap_or(0) == 0 {
            return;
          }
          let target = line.split_whitespace().nth(1).unwrap_or("").to_string();
          let mut len = 0usize;
          let mut pane = String::new();
          loop {
            let mut h = String::new();
            if r.read_line(&mut h).unwrap_or(0) == 0 {
              return;
            }
            let h = h.trim_end().to_string();
            if h.is_empty() {
              break;
            }
            let low = h.to_ascii_lowercase();
            if let Some(v) = low.strip_prefix("content-length:") {
              len = v.trim().parse().unwrap_or(0);
            }
            if low.starts_with("x-riven-pane:") {
              pane = h[13..].trim().to_string();
            }
          }
          let mut body = vec![0u8; len];
          if r.read_exact(&mut body).is_err() {
            return;
          }
          let event = target.split("event=").nth(1).unwrap_or("").to_string();
          log.lock().unwrap().events.push((t0.elapsed().as_secs_f64(), format!("{event}{}", if pane == "measure" { "" } else { " (pane header missing)" })));
          let answer = if event == "PermissionRequest" {
            std::thread::sleep(Duration::from_millis(1500));
            log.lock().unwrap().perm_screens.push(screen(&vt, 50));
            hooks::permission_answer(hooks::Decision::Allow)
          } else {
            None
          };
          let res = match answer {
            Some(v) => {
              let b = v.to_string();
              format!("HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{b}", b.len())
            }
            None => "HTTP/1.1 204 No Content\r\n\r\n".to_string(),
          };
          if out.write_all(res.as_bytes()).is_err() {
            return;
          }
        }
      });
    }
  });
  port
}

fn scrubbed(cmd: &mut CommandBuilder) {
  for (k, _) in std::env::vars() {
    if k.starts_with("CLAUDE") || k.starts_with("RIVEN_") {
      cmd.env_remove(&k);
    }
  }
}

fn interactive(cwd: &str, scratch: &std::path::Path) -> Value {
  let t0 = Instant::now();
  let log = Arc::new(Mutex::new(Log::default()));
  let vt = Arc::new(Mutex::new(Vt::new(super::COLS, super::ROWS, 2000).unwrap()));
  let port = hook_server(log.clone(), vt.clone(), t0);
  let settings = scratch.join("clichat-measure-settings.json");
  std::fs::write(&settings, hooks::settings(&format!("http://127.0.0.1:{port}")).to_string()).unwrap();
  let sid = crate::services::chat::util::uuid();

  let pair = native_pty_system().openpty(PtySize { rows: super::ROWS, cols: super::COLS, pixel_width: 0, pixel_height: 0 }).unwrap();
  let mut cmd = CommandBuilder::new("claude");
  cmd.args(["--strict-mcp-config", "--mcp-config", EMPTY_MCP, "--settings", &settings.to_string_lossy(), "--model", "haiku", "--permission-mode", "acceptEdits", "--session-id", &sid]);
  cmd.cwd(cwd);
  scrubbed(&mut cmd);
  cmd.env("TERM", "xterm-256color");
  cmd.env("RIVEN_PANE", "measure");
  cmd.env("RIVEN_HOOK_TOKEN", "measure-token");
  let mut child = pair.slave.spawn_command(cmd).unwrap();
  drop(pair.slave);
  let mut reader = pair.master.try_clone_reader().unwrap();
  let mut writer = pair.master.take_writer().unwrap();
  let vt2 = vt.clone();
  let rd = std::thread::spawn(move || {
    let mut buf = [0u8; 65536];
    while let Ok(n) = reader.read(&mut buf) {
      if n == 0 {
        break;
      }
      vt2.lock().unwrap().write(&buf[..n]);
    }
  });
  let scr = || screen(&vt, super::ROWS as usize);

  // Up: the input box, or the trust dialog (answered "yes": a scratch dir).
  let up = Instant::now();
  let mut trusted = false;
  while up.elapsed() < Duration::from_secs(30) {
    let s = scr();
    if preview::blocked(&s) == Some("trust") && !trusted {
      writer.write_all(b"\x1b[B").unwrap();
      std::thread::sleep(Duration::from_millis(300));
      writer.write_all(b"\r").unwrap();
      trusted = true;
    }
    if preview::input_ready(&s) {
      break;
    }
    std::thread::sleep(Duration::from_millis(100));
  }
  let ready_ms = up.elapsed().as_millis();

  let path = transcript_path(cwd, None, &sid);
  let mut tail = Tail::new(path.clone());
  let mut store = Store::default();
  let mut turns = Vec::new();
  for (i, p) in prompts().iter().enumerate() {
    let sent = Instant::now();
    writer.write_all(format!("\x1b[200~{p}\x1b[201~").as_bytes()).unwrap();
    std::thread::sleep(Duration::from_millis(120));
    writer.write_all(b"\r").unwrap();
    let mut previews: Vec<String> = Vec::new();
    let mut stop_at = None;
    let mut text_at = None;
    while sent.elapsed() < Duration::from_secs(120) {
      if let Some(pv) = preview::extract(&scr()) {
        if previews.last() != Some(&pv) {
          previews.push(pv);
        }
      }
      if path.is_file() {
        if let Ok(Chunk::Lines(lines)) = tail.read() {
          for l in lines {
            store.ingest(&l);
          }
        }
      }
      let stops = log.lock().unwrap().events.iter().filter(|(_, e)| e.starts_with("Stop")).count();
      if stop_at.is_none() && stops > i {
        stop_at = Some(sent.elapsed().as_millis());
      }
      let texts = store.branch().iter().filter(|it| matches!(it, Item::Text { .. })).count();
      if text_at.is_none() && texts > i {
        text_at = Some(sent.elapsed().as_millis());
      }
      if stop_at.is_some() && text_at.is_some() {
        break;
      }
      std::thread::sleep(Duration::from_millis(50));
    }
    turns.push(json!({ "prompt": p, "stopHookMs": stop_at, "textInJsonlMs": text_at, "screenPreviews": previews }));
  }
  // Leave the way a person does: Ctrl+C twice.
  let _ = writer.write_all(b"\x03");
  std::thread::sleep(Duration::from_millis(400));
  let _ = writer.write_all(b"\x03");
  let gone = Instant::now();
  let mut exited = false;
  while gone.elapsed() < Duration::from_secs(8) {
    if child.try_wait().ok().flatten().is_some() {
      exited = true;
      break;
    }
    std::thread::sleep(Duration::from_millis(100));
  }
  if !exited {
    let _ = child.kill();
    let _ = child.wait();
  }
  drop(writer);
  drop(pair.master);
  let _ = rd.join();
  if let Ok(Chunk::Lines(lines)) = tail.read() {
    for l in lines {
      store.ingest(&l);
    }
  }
  let lg = log.lock().unwrap();
  json!({
    "sessionId": sid,
    "readyMs": ready_ms,
    "trustDialog": trusted,
    "exitedCleanly": exited,
    "turns": turns,
    "usagePerTurn": turn_usage(&store.branch()),
    "hookEvents": lg.events.iter().map(|(t, e)| format!("{t:.1}s {e}")).collect::<Vec<_>>(),
    "screenDuringPermissionHook": lg.perm_screens.first().map(|s| s.lines().filter(|l| !l.trim().is_empty()).collect::<Vec<_>>().join("\n")),
  })
}

fn headless(cwd: &str) -> Value {
  let sid = crate::services::chat::util::uuid();
  let mut cmd = std::process::Command::new("claude");
  cmd.args([
    "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
    "--include-hook-events", "--strict-mcp-config", "--mcp-config", EMPTY_MCP, "--model", "haiku", "--permission-mode",
    "acceptEdits", "--allowedTools", "Bash(python3:*)", "--session-id", &sid,
  ]);
  cmd.current_dir(cwd);
  for (k, _) in std::env::vars() {
    if k.starts_with("CLAUDE") || k.starts_with("RIVEN_") {
      cmd.env_remove(&k);
    }
  }
  cmd.stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::null());
  let mut child = cmd.spawn().unwrap();
  let mut stdin = child.stdin.take().unwrap();
  let mut out = BufReader::new(child.stdout.take().unwrap());
  let mut results = Vec::new();
  for p in prompts() {
    let msg = json!({ "type": "user", "message": { "role": "user", "content": [{ "type": "text", "text": &p }] } });
    writeln!(stdin, "{msg}").unwrap();
    stdin.flush().unwrap();
    let mut line = String::new();
    loop {
      line.clear();
      if out.read_line(&mut line).unwrap_or(0) == 0 {
        break;
      }
      let v: Value = serde_json::from_str(&line).unwrap_or(Value::Null);
      if v["type"] == "result" {
        results.push(json!({ "costUSD": v["total_cost_usd"], "usage": v["usage"] }));
        break;
      }
    }
  }
  drop(stdin);
  let _ = child.wait();
  let mut store = Store::default();
  let mut tail = Tail::new(transcript_path(cwd, None, &sid));
  if let Ok(Chunk::Lines(lines)) = tail.read() {
    for l in lines {
      store.ingest(&l);
    }
  }
  json!({ "sessionId": sid, "usagePerTurn": turn_usage(&store.branch()), "resultEvents": results })
}

#[test]
#[ignore]
fn measure() {
  let Ok(cwd) = std::env::var("RIVEN_CLICHAT_CWD") else {
    eprintln!("set RIVEN_CLICHAT_CWD to a scratch directory");
    return;
  };
  let scratch = std::path::PathBuf::from(&cwd).parent().unwrap().to_path_buf();
  let only = std::env::var("RIVEN_CLICHAT_ONLY").unwrap_or_default();
  let mut report = json!({});
  if only != "headless" {
    report["interactive"] = interactive(&cwd, &scratch);
  }
  if only != "interactive" {
    report["headless"] = headless(&cwd);
  }
  println!("{}", serde_json::to_string_pretty(&report).unwrap());
}

// The rest of the input path, cheaply: a slash command typed (no model
// call), an interrupt (Esc) of a reply in progress, then a resume of the
// same session in a new process (no prompt sent).
//
//   RIVEN_CLICHAT_CWD=... cargo test clichat::measure::probe -- --ignored --nocapture
struct Cli {
  child: Box<dyn portable_pty::Child + Send + Sync>,
  writer: Box<dyn Write + Send>,
  master: Box<dyn portable_pty::MasterPty + Send>,
  vt: Arc<Mutex<Vt>>,
  rd: std::thread::JoinHandle<()>,
}

fn launch(cwd: &str, settings: &std::path::Path, session: &[&str]) -> Cli {
  let vt = Arc::new(Mutex::new(Vt::new(super::COLS, super::ROWS, 2000).unwrap()));
  let pair = native_pty_system().openpty(PtySize { rows: super::ROWS, cols: super::COLS, pixel_width: 0, pixel_height: 0 }).unwrap();
  let mut cmd = CommandBuilder::new("claude");
  cmd.args(["--strict-mcp-config", "--mcp-config", EMPTY_MCP, "--settings", &settings.to_string_lossy(), "--model", "haiku"]);
  cmd.args(session);
  cmd.cwd(cwd);
  scrubbed(&mut cmd);
  cmd.env("TERM", "xterm-256color");
  cmd.env("RIVEN_PANE", "measure");
  cmd.env("RIVEN_HOOK_TOKEN", "measure-token");
  let child = pair.slave.spawn_command(cmd).unwrap();
  drop(pair.slave);
  let mut reader = pair.master.try_clone_reader().unwrap();
  let writer = pair.master.take_writer().unwrap();
  let vt2 = vt.clone();
  let rd = std::thread::spawn(move || {
    let mut buf = [0u8; 65536];
    while let Ok(n) = reader.read(&mut buf) {
      if n == 0 {
        break;
      }
      vt2.lock().unwrap().write(&buf[..n]);
    }
  });
  let c = Cli { child, writer, master: pair.master, vt, rd };
  let up = Instant::now();
  while up.elapsed() < Duration::from_secs(30) && !preview::input_ready(&screen(&c.vt, super::ROWS as usize)) {
    std::thread::sleep(Duration::from_millis(100));
  }
  c
}

fn quit(mut c: Cli) -> bool {
  let _ = c.writer.write_all(b"\x03");
  std::thread::sleep(Duration::from_millis(400));
  let _ = c.writer.write_all(b"\x03");
  let t = Instant::now();
  let mut clean = false;
  while t.elapsed() < Duration::from_secs(8) {
    if c.child.try_wait().ok().flatten().is_some() {
      clean = true;
      break;
    }
    std::thread::sleep(Duration::from_millis(100));
  }
  if !clean {
    let _ = c.child.kill();
    let _ = c.child.wait();
  }
  drop(c.writer);
  drop(c.master);
  let _ = c.rd.join();
  clean
}

fn branch_of(path: &std::path::Path) -> Vec<Value> {
  let mut store = Store::default();
  let mut tail = Tail::new(path.to_path_buf());
  if let Ok(Chunk::Lines(lines)) = tail.read() {
    for l in lines {
      store.ingest(&l);
    }
  }
  store.branch().iter().map(|i| serde_json::to_value(i).unwrap()).collect()
}

#[test]
#[ignore]
fn probe() {
  let Ok(cwd) = std::env::var("RIVEN_CLICHAT_CWD") else { return };
  let scratch = std::path::PathBuf::from(&cwd).parent().unwrap().to_path_buf();
  let t0 = Instant::now();
  let log = Arc::new(Mutex::new(Log::default()));
  let dummy = Arc::new(Mutex::new(Vt::new(10, 5, 10).unwrap()));
  let port = hook_server(log.clone(), dummy, t0);
  let settings = scratch.join("clichat-probe-settings.json");
  std::fs::write(&settings, hooks::settings(&format!("http://127.0.0.1:{port}")).to_string()).unwrap();
  let sid = crate::services::chat::util::uuid();
  let path = transcript_path(&cwd, None, &sid);
  let mut report = json!({});

  let mut c = launch(&cwd, &settings, &["--session-id", &sid]);
  // 1. A slash command, typed. Not /model: in 2.1.330 it saves the model as
  // the user's default in ~/.claude/settings.json. Not /cost: it opens a
  // full-screen dialog (Esc to close).
  c.writer.write_all(std::env::var("RIVEN_CLICHAT_SLASH").unwrap_or("/rename clichat-probe".into()).as_bytes()).unwrap();
  std::thread::sleep(Duration::from_millis(120));
  c.writer.write_all(b"\r").unwrap();
  std::thread::sleep(Duration::from_secs(3));
  report["afterSlash"] = json!({ "items": branch_of(&path), "screenTail": screen(&c.vt, 12) });
  // 2. Interrupt a reply in progress.
  c.writer.write_all(b"\x1b[200~Count from 1 to 300, one number per line.\x1b[201~").unwrap();
  std::thread::sleep(Duration::from_millis(120));
  c.writer.write_all(b"\r").unwrap();
  let t = Instant::now();
  while t.elapsed() < Duration::from_secs(20) && !log.lock().unwrap().events.iter().any(|(_, e)| e == "MessageDisplay") {
    std::thread::sleep(Duration::from_millis(50));
  }
  c.writer.write_all(b"\x1b").unwrap();
  std::thread::sleep(Duration::from_secs(4));
  report["afterInterrupt"] = json!({ "items": branch_of(&path), "screenTail": screen(&c.vt, 10) });
  report["firstExitClean"] = json!(quit(c));
  // 3. Resume the same session in a new process.
  let r0 = Instant::now();
  let c = launch(&cwd, &settings, &["--resume", &sid]);
  report["resumeReadyMs"] = json!(r0.elapsed().as_millis());
  report["resumeScreenHasHistory"] = json!(screen(&c.vt, super::ROWS as usize).contains("Count from 1 to 300"));
  report["secondExitClean"] = json!(quit(c));
  report["sameFileAfterResume"] = json!(path.is_file());
  report["hookEvents"] = json!(log.lock().unwrap().events.iter().map(|(t, e)| format!("{t:.1}s {e}")).collect::<Vec<_>>());
  println!("{}", serde_json::to_string_pretty(&report).unwrap());
}
