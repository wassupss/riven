// A scripted live probe, not a unit test: run the real interactive `claude`
// in a pty the way a CLI chat session does (wide screen, http hooks to a
// local server), play a small script of keystrokes against it and record
// every hook body and the screens asked for. Used to learn how the TUI of a
// given CLI version answers (menus, attachments, resume/fork) before the
// chat view drives it.
//
//   RIVEN_CLICHAT_CWD=/scratch/ws RIVEN_PROBE_SCRIPT=/scratch/x.txt \
//   RIVEN_PROBE_OUT=/scratch/out cargo test clichat::probe -- --ignored --nocapture
//
// Script, one step per line (# comments):
//   args <extra CLI args, space separated>   (first, before anything runs)
//   ready <secs>          wait for the input box
//   paste <text>          bracketed paste (\n escapes allowed)
//   type <text>           raw text
//   key <enter|esc|up|down|left|right|tab|btab|space|ctrlc|bs|1..9>
//   sleep <ms>
//   stop <secs>           wait for the next Stop hook
//   until <secs> <text>   wait until the screen contains text
//   perm none|ask:<n>|<json>  answer to the next PermissionRequest (none = 204)
//   permdelay <ms>        hold that answer this long
//   send <text>|<img>...  a message as the service types it
//   menu <n> [text]       pick option n of the menu on screen, as the card does
//   screen <label>        dump the screen
//
// Always opt-in (#[ignore] and the variables), haiku, no MCP servers, and
// the CLI is ended (Ctrl+C twice, then a kill) before the test returns.

use super::hooks;
use super::preview;
use crate::services::pty::vt::Vt;
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const EMPTY_MCP: &str = r#"{"mcpServers":{}}"#;

#[derive(Default)]
struct Shared {
  events: Vec<String>,
  stops: usize,
  perm: Option<String>,
  perm_delay_ms: u64,
}

// `ask:<n>`: allow an AskUserQuestion with option n of every question as
// the answer, built by the same code the chat view's card goes through.
fn perm_body(spec: &str, body: &str) -> String {
  let Some(n) = spec.strip_prefix("ask:") else { return spec.to_string() };
  let n: usize = n.parse().unwrap_or(0);
  let v: serde_json::Value = serde_json::from_str(body).unwrap_or_default();
  let input = v.get("tool_input").cloned().unwrap_or_default();
  let mut answers = serde_json::Map::new();
  for q in input.get("questions").and_then(|q| q.as_array()).into_iter().flatten() {
    let label = q.pointer(&format!("/options/{n}/label")).and_then(|l| l.as_str()).unwrap_or("");
    answers.insert(q.get("question").and_then(|x| x.as_str()).unwrap_or("").to_string(), label.into());
  }
  let d = hooks::Decision::AllowWith(hooks::question_input(&input, &answers));
  hooks::permission_answer(d).map(|v| v.to_string()).unwrap_or_default()
}

fn screen(vt: &Mutex<Vt>, rows: usize) -> String {
  let all = vt.lock().unwrap().plain_text();
  let lines: Vec<&str> = all.split('\n').collect();
  lines[lines.len().saturating_sub(rows)..].join("\n")
}

fn server(sh: Arc<Mutex<Shared>>) -> u16 {
  let l = TcpListener::bind("127.0.0.1:0").unwrap();
  let port = l.local_addr().unwrap().port();
  std::thread::spawn(move || {
    for s in l.incoming().flatten() {
      let sh = sh.clone();
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
          loop {
            let mut h = String::new();
            if r.read_line(&mut h).unwrap_or(0) == 0 {
              return;
            }
            let h = h.trim_end().to_ascii_lowercase();
            if h.is_empty() {
              break;
            }
            if let Some(v) = h.strip_prefix("content-length:") {
              len = v.trim().parse().unwrap_or(0);
            }
          }
          let mut body = vec![0u8; len];
          if r.read_exact(&mut body).is_err() {
            return;
          }
          let event = target.split("event=").nth(1).unwrap_or("").to_string();
          let body = String::from_utf8_lossy(&body).into_owned();
          let answer = {
            let mut g = sh.lock().unwrap();
            g.events.push(format!("{{\"event\":\"{event}\",\"body\":{}}}", if body.trim().is_empty() { "null".into() } else { body.clone() }));
            if event == "Stop" {
              g.stops += 1;
            }
            if event == "PermissionRequest" { g.perm.take().map(|p| (perm_body(&p, &body), g.perm_delay_ms)) } else { None }
          };
          if let Some((_, d)) = &answer {
            std::thread::sleep(Duration::from_millis(*d));
          }
          let answer = answer.map(|(b, _)| b);
          let res = match answer {
            Some(b) => format!("HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{b}", b.len()),
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

fn key_bytes(k: &str) -> Vec<u8> {
  match k {
    "enter" => b"\r".to_vec(),
    "esc" => b"\x1b".to_vec(),
    "up" => b"\x1b[A".to_vec(),
    "down" => b"\x1b[B".to_vec(),
    "right" => b"\x1b[C".to_vec(),
    "left" => b"\x1b[D".to_vec(),
    "tab" => b"\t".to_vec(),
    "btab" => b"\x1b[Z".to_vec(),
    "space" => b" ".to_vec(),
    "ctrlc" => b"\x03".to_vec(),
    "bs" => b"\x7f".to_vec(),
    other => other.as_bytes().to_vec(),
  }
}

#[test]
#[ignore]
fn probe() {
  let (Ok(cwd), Ok(script), Ok(out)) = (std::env::var("RIVEN_CLICHAT_CWD"), std::env::var("RIVEN_PROBE_SCRIPT"), std::env::var("RIVEN_PROBE_OUT")) else {
    eprintln!("set RIVEN_CLICHAT_CWD, RIVEN_PROBE_SCRIPT and RIVEN_PROBE_OUT");
    return;
  };
  let out = std::path::PathBuf::from(out);
  std::fs::create_dir_all(&out).unwrap();
  let steps: Vec<String> = std::fs::read_to_string(&script).unwrap().lines().map(str::to_string).collect();
  let sh = Arc::new(Mutex::new(Shared::default()));
  let port = server(sh.clone());
  let settings = out.join("settings.json");
  std::fs::write(&settings, hooks::settings(&format!("http://127.0.0.1:{port}")).to_string()).unwrap();

  let mut extra: Vec<String> = Vec::new();
  for s in &steps {
    if let Some(a) = s.strip_prefix("args ") {
      extra.extend(a.split_whitespace().map(str::to_string));
    }
  }
  if !extra.iter().any(|a| a == "--resume" || a == "--session-id") {
    extra.push("--session-id".into());
    extra.push(crate::services::chat::util::uuid());
  }
  let vt = Arc::new(Mutex::new(Vt::new(super::COLS, super::ROWS, 2000).unwrap()));
  let pair = native_pty_system().openpty(PtySize { rows: super::ROWS, cols: super::COLS, pixel_width: 0, pixel_height: 0 }).unwrap();
  let mut cmd = CommandBuilder::new("claude");
  cmd.args(["--strict-mcp-config", "--mcp-config", EMPTY_MCP, "--settings", &settings.to_string_lossy(), "--model", "haiku"]);
  cmd.args(&extra);
  cmd.cwd(&cwd);
  for (k, _) in std::env::vars() {
    if k.starts_with("CLAUDE") || k.starts_with("RIVEN_") {
      cmd.env_remove(&k);
    }
  }
  cmd.env("TERM", "xterm-256color");
  cmd.env("RIVEN_PANE", "probe");
  cmd.env("RIVEN_HOOK_TOKEN", "probe-token");
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
  let mut screens = String::new();
  let t0 = Instant::now();
  for s in &steps {
    let s = s.trim();
    if s.is_empty() || s.starts_with('#') || s.starts_with("args ") {
      continue;
    }
    let (op, arg) = s.split_once(' ').unwrap_or((s, ""));
    match op {
      "ready" => {
        let w = Instant::now();
        while w.elapsed() < Duration::from_secs(arg.parse().unwrap_or(30)) && !preview::has_input_box(&scr()) {
          std::thread::sleep(Duration::from_millis(100));
        }
      }
      "paste" => {
        let t = arg.replace("\\n", "\n");
        writer.write_all(format!("\x1b[200~{t}\x1b[201~").as_bytes()).unwrap();
      }
      "type" => writer.write_all(arg.as_bytes()).unwrap(),
      "key" => writer.write_all(&key_bytes(arg)).unwrap(),
      "sleep" => std::thread::sleep(Duration::from_millis(arg.parse().unwrap_or(500))),
      "stop" => {
        let before = sh.lock().unwrap().stops;
        let w = Instant::now();
        while w.elapsed() < Duration::from_secs(arg.parse().unwrap_or(60)) && sh.lock().unwrap().stops == before {
          std::thread::sleep(Duration::from_millis(100));
        }
      }
      "until" => {
        let (secs, text) = arg.split_once(' ').unwrap_or((arg, ""));
        let w = Instant::now();
        while w.elapsed() < Duration::from_secs(secs.parse().unwrap_or(30)) && !scr().contains(text) {
          std::thread::sleep(Duration::from_millis(100));
        }
      }
      "permdelay" => sh.lock().unwrap().perm_delay_ms = arg.parse().unwrap_or(0),
      // A message the way the service types it (text|image path|...).
      "send" => {
        let mut parts = arg.split('|').map(str::to_string);
        let m = super::Outgoing { text: parts.next().unwrap_or_default(), images: parts.collect() };
        for (i, w) in super::message_writes(&m).0.into_iter().enumerate() {
          if i > 0 {
            std::thread::sleep(Duration::from_millis(120));
          }
          writer.write_all(w.as_bytes()).unwrap();
          writer.flush().ok();
        }
        std::thread::sleep(Duration::from_millis(120));
        writer.write_all(b"\r").unwrap();
      }
      // Pick option <n> (0-based) of the menu on screen the way the card
      // does: parsed from the screen, arrows, optional text, Enter.
      "menu" => {
        let (n, text) = arg.split_once(' ').map(|(a, b)| (a, Some(b))).unwrap_or((arg, None));
        let s = scr();
        let Some(m) = preview::menu(&s) else {
          screens.push_str("===== menu: none parsed\n");
          continue;
        };
        screens.push_str(&format!("===== menu parsed: {}\n", serde_json::to_string(&m).unwrap()));
        let n: usize = n.parse().unwrap_or(0);
        let keys = preview::menu_keys(m.selected, n, text.filter(|_| m.options[n].input));
        writer.write_all(keys.as_bytes()).unwrap();
        writer.flush().ok();
        std::thread::sleep(Duration::from_millis(120));
        writer.write_all(b"\r").unwrap();
      }
      "perm" => sh.lock().unwrap().perm = if arg == "none" { None } else { Some(arg.to_string()) },
      "screen" => {
        let body: Vec<String> = scr().lines().map(|l| l.trim_end().to_string()).collect();
        screens.push_str(&format!("===== {arg} @{:.1}s\n{}\n", t0.elapsed().as_secs_f64(), body.join("\n").trim_end()));
      }
      _ => eprintln!("unknown step {s}"),
    }
    writer.flush().ok();
  }
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
  std::fs::write(out.join("screens.txt"), screens).unwrap();
  std::fs::write(out.join("events.jsonl"), sh.lock().unwrap().events.join("\n") + "\n").unwrap();
  println!("probe done, exited cleanly: {exited}, args: {}", extra.join(" "));
}
