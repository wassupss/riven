// Dev-only driving hook (was Node's /__riven/test in tauri/shim/server.ts).
// Off unless RIVEN_TAURI_TEST_KEY is set when launching; listens on loopback
// only (127.0.0.1:47391, or RIVEN_TAURI_TEST_PORT), every request carries the key:
//
//   POST /__riven/test?k=KEY&w=w1&op=eval     body = JS (statements; the last value,
//                                             awaited if a promise) -> {ok, val|err}
//   POST /__riven/test?k=KEY&w=w1&op=wv       body = one JS expression, awaited -> {ok, val|err}
//   GET  /__riven/test?k=KEY&w=w1&op=shot     the window (or a pop-* popout) as PNG
//   GET  /__riven/test?k=KEY&w=w1&op=front    show the window (behind everything in
//                                             the background test mode, as ever)
//   GET  /__riven/test?k=KEY&w=LABEL&op=close as its close button does
//   GET  /__riven/test?k=KEY&op=busy          what the quit confirmation would count {chat, terminal}
//   GET  /__riven/test?k=KEY&op=displays      {count, primaryWorkArea}
//   GET  /__riven/test?k=KEY&w=w1&op=reload   flush the page's saves, then reload
//   GET  /__riven/test?k=KEY&op=quit          flush and quit; refused (409) while agents
//                                             work, so it can never raise the confirmation
//   GET  /__riven/test?k=KEY&op=windows       the window labels

use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use tauri::{AppHandle, Manager};

pub fn start(app: &AppHandle) {
  let key = std::env::var("RIVEN_TAURI_TEST_KEY").unwrap_or_default();
  if key.is_empty() {
    return;
  }
  let port: u16 = std::env::var("RIVEN_TAURI_TEST_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(47391);
  let l = match TcpListener::bind(("127.0.0.1", port)) {
    Ok(l) => l,
    Err(e) => return eprintln!("[test] hook not started on {port}: {e}"),
  };
  eprintln!("[test] hook on 127.0.0.1:{port}");
  let app = app.clone();
  let _ = std::thread::Builder::new().name("test-hook".into()).spawn(move || {
    for s in l.incoming().flatten() {
      let (app, key) = (app.clone(), key.clone());
      let _ = std::thread::Builder::new().name("test-hook-conn".into()).spawn(move || serve(&app, s, &key));
    }
  });
}

struct Req {
  method: String,
  path: String,
  query: Vec<(String, String)>,
  host: String,
  body: Vec<u8>,
}

impl Req {
  fn q(&self, k: &str) -> Option<&str> {
    self.query.iter().find(|(n, _)| n == k).map(|(_, v)| v.as_str())
  }
}

fn read_req(s: &TcpStream) -> Option<Req> {
  let mut r = BufReader::new(s.try_clone().ok()?);
  let mut line = String::new();
  r.read_line(&mut line).ok()?;
  let mut parts = line.split_whitespace();
  let method = parts.next()?.to_string();
  let target = parts.next()?.to_string();
  let (mut len, mut host) = (0usize, String::new());
  loop {
    let mut h = String::new();
    if r.read_line(&mut h).ok()? == 0 {
      return None;
    }
    let h = h.trim_end();
    if h.is_empty() {
      break;
    }
    if let Some((k, v)) = h.split_once(':') {
      match k.trim().to_ascii_lowercase().as_str() {
        "content-length" => len = v.trim().parse().ok()?,
        "host" => host = v.trim().to_string(),
        _ => {}
      }
    }
  }
  if len > 64 * 1024 * 1024 {
    return None;
  }
  let mut body = vec![0u8; len];
  r.read_exact(&mut body).ok()?;
  let u = url::Url::parse(&format!("http://h{target}")).ok()?;
  Some(Req { method, path: u.path().to_string(), query: u.query_pairs().map(|(a, b)| (a.into_owned(), b.into_owned())).collect(), host, body })
}

fn respond(mut s: &TcpStream, code: u16, ctype: &str, body: &[u8]) {
  let reason = match code {
    200 => "OK",
    202 => "Accepted",
    204 => "No Content",
    403 => "Forbidden",
    404 => "Not Found",
    409 => "Conflict",
    _ => "Error",
  };
  let head = format!("HTTP/1.1 {code} {reason}\r\ncontent-type: {ctype}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n", body.len());
  let _ = s.write_all(head.as_bytes()).and_then(|_| s.write_all(body));
}

fn json_out(s: &TcpStream, code: u16, v: Value) {
  respond(s, code, "application/json", v.to_string().as_bytes());
}

fn same(a: &str, b: &str) -> bool {
  a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// wv.exec answers {"v": value} or {"u": 1} (undefined) as text.
fn exec(app: &AppHandle, label: &str, code: String) -> Value {
  match crate::browser::dispatch(app, "wv.exec", &json!({ "label": label, "code": code, "expr": true })) {
    Ok(Value::String(t)) => {
      let r: Value = serde_json::from_str(&t).unwrap_or(Value::Null);
      json!({ "ok": true, "val": r.get("v").cloned().unwrap_or(Value::Null) })
    }
    Ok(_) => json!({ "ok": true, "val": null }),
    Err(e) => json!({ "ok": false, "err": e }),
  }
}

fn serve(app: &AppHandle, s: TcpStream, key: &str) {
  let Some(req) = read_req(&s) else { return };
  // Loopback only, and no DNS rebinding: the Host must be the address itself.
  if !req.host.starts_with("127.0.0.1:") || req.path != "/__riven/test" || !same(req.q("k").unwrap_or(""), key) {
    return respond(&s, 403, "text/plain", b"");
  }
  let label = req.q("w").filter(|w| !w.is_empty()).unwrap_or("w1").to_string();
  let body = String::from_utf8_lossy(&req.body).into_owned();
  match req.q("op").unwrap_or("eval") {
    "busy" => {
      let (chat, terminal) = crate::lifecycle::busy();
      json_out(&s, 200, json!({ "chat": chat, "terminal": terminal }))
    }
    "displays" => {
      let all = crate::displays(app).unwrap_or(json!([]));
      let n = all.as_array().map(|a| a.len()).unwrap_or(0);
      json_out(&s, 200, json!({ "count": n, "primaryWorkArea": all.get(0).and_then(|d| d.get("workArea")).cloned() }))
    }
    "windows" => {
      let mut ws: Vec<String> = app.windows().into_keys().collect();
      ws.sort();
      json_out(&s, 200, json!(ws))
    }
    "close" => {
      if let Some(w) = app.get_window(&label) {
        let _ = w.close();
      }
      respond(&s, 204, "text/plain", b"")
    }
    "front" => {
      if let Some(w) = app.get_window(&label) {
        if crate::background() {
          crate::order_back(app, w);
        } else {
          let _ = w.show();
          let _ = w.set_focus();
        }
      }
      respond(&s, 204, "text/plain", b"")
    }
    "shot" => match crate::browser::capture(app, &json!({ "label": label })) {
      Ok(Value::String(b64)) => {
        use base64::Engine;
        let png = base64::engine::general_purpose::STANDARD.decode(b64).unwrap_or_default();
        respond(&s, 200, "image/png", &png)
      }
      _ => respond(&s, 404, "text/plain", b""),
    },
    "reload" => {
      crate::lifecycle::reload(app, &label);
      respond(&s, 204, "text/plain", b"")
    }
    "quit" => {
      let (chat, terminal) = crate::lifecycle::busy();
      if chat + terminal > 0 {
        return json_out(&s, 409, json!({ "chat": chat, "terminal": terminal }));
      }
      respond(&s, 202, "text/plain", b"");
      crate::lifecycle::quit_now(app);
    }
    "wv" if req.method == "POST" => json_out(&s, 200, exec(app, &label, body)),
    // Indirect eval: statements allowed, the completion value comes back
    // (awaited), as the page socket's eval did.
    "eval" if req.method == "POST" => json_out(&s, 200, exec(app, &label, format!("(0, eval)({})", Value::String(body)))),
    _ => respond(&s, 404, "text/plain", b""),
  }
}
