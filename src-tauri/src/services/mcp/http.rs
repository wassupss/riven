// The loopback HTTP/1.1 server: /mcp (Streamable-HTTP MCP, JSON responses
// only) and /hook (agent hooks), behind one per-run token. A thread per
// connection: there are a handful of agents, and a tools/call may sit for
// minutes on a person (ask_user), which a blocking thread waits out simply.
//
// Same answers as the Node server: 401 before anything else, 404 for an
// unknown path, 413 over 1MB, 405 for anything but POST/DELETE on /mcp,
// one Mcp-Session-Id for the whole run. Node's timeouts: none on a request
// in progress (requestTimeout 0), 60s to send the headers, 65s keep-alive.

use super::{call_tool, hooks, rpc_key, server, tool_defs, Call};
use crate::services::chat::util;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::time::Duration;

const MAX_BODY_BYTES: usize = 1024 * 1024;
const MAX_HEAD_BYTES: usize = 16 * 1024;
const HEADERS_TIMEOUT: Duration = Duration::from_secs(60);
const KEEP_ALIVE: Duration = Duration::from_secs(65);

pub fn listen() -> Option<u16> {
  let l = TcpListener::bind("127.0.0.1:0").ok()?;
  let port = l.local_addr().ok()?.port();
  std::thread::Builder::new()
    .name("mcp-http".into())
    .spawn(move || {
      for s in l.incoming().flatten() {
        let _ = std::thread::Builder::new().name("mcp-conn".into()).spawn(move || serve(s));
      }
    })
    .ok()?;
  Some(port)
}

pub struct Response {
  pub status: u16,
  pub headers: Vec<(&'static str, String)>,
  pub body: Vec<u8>,
}

impl Response {
  pub fn empty(status: u16) -> Self {
    Response { status, headers: Vec::new(), body: Vec::new() }
  }
  fn json(status: u16, v: &Value) -> Self {
    Response {
      status,
      headers: vec![("content-type", "application/json".into()), ("mcp-session-id", server().session.clone())],
      body: v.to_string().into_bytes(),
    }
  }
}

fn reason(status: u16) -> &'static str {
  match status {
    100 => "Continue",
    200 => "OK",
    202 => "Accepted",
    204 => "No Content",
    400 => "Bad Request",
    401 => "Unauthorized",
    404 => "Not Found",
    405 => "Method Not Allowed",
    413 => "Payload Too Large",
    431 => "Request Header Fields Too Large",
    _ => "Internal Server Error",
  }
}

struct Request {
  method: String,
  target: String,
  headers: Vec<(String, String)>,
  keep_alive: bool,
}

impl Request {
  fn header(&self, name: &str) -> Option<&str> {
    self.headers.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
  }
}

// None: the connection ended (or sent garbage) before a whole head.
fn read_head(r: &mut BufReader<TcpStream>) -> Result<Option<Request>, u16> {
  let mut line = String::new();
  // Idle keep-alive connection: wait for the next request this long.
  let _ = r.get_ref().set_read_timeout(Some(KEEP_ALIVE));
  loop {
    line.clear();
    match r.read_line(&mut line) {
      Ok(0) | Err(_) => return Ok(None),
      Ok(_) if line.trim().is_empty() => continue,
      Ok(_) => break,
    }
  }
  let _ = r.get_ref().set_read_timeout(Some(HEADERS_TIMEOUT));
  let mut parts = line.split_whitespace();
  let (Some(method), Some(target), version) = (parts.next(), parts.next(), parts.next().unwrap_or("HTTP/1.0")) else { return Ok(None) };
  let mut req = Request { method: method.to_string(), target: target.to_string(), headers: Vec::new(), keep_alive: version != "HTTP/1.0" };
  let mut size = line.len();
  loop {
    line.clear();
    match r.read_line(&mut line) {
      Ok(0) | Err(_) => return Ok(None),
      Ok(n) => size += n,
    }
    if size > MAX_HEAD_BYTES {
      return Err(431);
    }
    let l = line.trim_end_matches(['\r', '\n']);
    if l.is_empty() {
      break;
    }
    if let Some((k, v)) = l.split_once(':') {
      req.headers.push((k.trim().to_ascii_lowercase(), v.trim().to_string()));
    }
  }
  match req.header("connection").map(str::to_ascii_lowercase) {
    Some(c) if c.contains("close") => req.keep_alive = false,
    Some(c) if c.contains("keep-alive") => req.keep_alive = true,
    _ => {}
  }
  Ok(Some(req))
}

// The body, or Ok(None) when it was over the limit (read and dropped, as
// Node did, so the 413 is not a reset).
fn read_body(r: &mut BufReader<TcpStream>, req: &Request) -> std::io::Result<Option<Vec<u8>>> {
  let mut body = Vec::new();
  let mut over = false;
  let take = |r: &mut BufReader<TcpStream>, n: usize, body: &mut Vec<u8>, over: &mut bool| -> std::io::Result<()> {
    let mut left = n;
    let mut buf = [0u8; 16 * 1024];
    while left > 0 {
      let want = left.min(buf.len());
      let k = r.read(&mut buf[..want])?;
      if k == 0 {
        return Err(std::io::ErrorKind::UnexpectedEof.into());
      }
      if !*over {
        body.extend_from_slice(&buf[..k]);
        if body.len() > MAX_BODY_BYTES {
          *over = true;
          body.clear();
        }
      }
      left -= k;
    }
    Ok(())
  };
  if req.header("transfer-encoding").is_some_and(|t| t.to_ascii_lowercase().contains("chunked")) {
    let mut line = String::new();
    loop {
      line.clear();
      r.read_line(&mut line)?;
      let n = usize::from_str_radix(line.trim().split(';').next().unwrap_or("").trim(), 16).map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidData))?;
      if n == 0 {
        // Trailers, then the empty line.
        loop {
          line.clear();
          if r.read_line(&mut line)? == 0 || line.trim().is_empty() {
            break;
          }
        }
        break;
      }
      take(r, n, &mut body, &mut over)?;
      line.clear();
      r.read_line(&mut line)?;
    }
  } else {
    let n = req.header("content-length").and_then(|v| v.parse::<usize>().ok()).unwrap_or(0);
    take(r, n, &mut body, &mut over)?;
  }
  Ok((!over).then_some(body))
}

fn write(s: &mut TcpStream, res: &Response, keep_alive: bool) -> std::io::Result<()> {
  let mut head = format!("HTTP/1.1 {} {}\r\n", res.status, reason(res.status));
  for (k, v) in &res.headers {
    head.push_str(&format!("{k}: {v}\r\n"));
  }
  if res.status != 204 && res.status != 100 {
    head.push_str(&format!("content-length: {}\r\n", res.body.len()));
  }
  head.push_str(if keep_alive { "connection: keep-alive\r\nkeep-alive: timeout=65\r\n\r\n" } else { "connection: close\r\n\r\n" });
  s.write_all(head.as_bytes())?;
  s.write_all(&res.body)?;
  s.flush()
}

fn serve(stream: TcpStream) {
  let _ = stream.set_nodelay(true);
  let Ok(mut out) = stream.try_clone() else { return };
  let mut r = BufReader::new(stream);
  loop {
    let req = match read_head(&mut r) {
      Ok(Some(q)) => q,
      Ok(None) => return,
      Err(status) => {
        let _ = write(&mut out, &Response::empty(status), false);
        return;
      }
    };
    if req.header("expect").is_some_and(|e| e.eq_ignore_ascii_case("100-continue")) && out.write_all(b"HTTP/1.1 100 Continue\r\n\r\n").is_err() {
      return;
    }
    // No limit on a request in progress: a tools/call may wait on a person.
    let _ = r.get_ref().set_read_timeout(None);
    let body = match read_body(&mut r, &req) {
      Ok(b) => b,
      Err(_) => return,
    };
    let url = url::Url::parse(&format!("http://127.0.0.1{}", req.target)).ok();
    let res = match url {
      None => Some((Response::empty(404), None)),
      Some(url) => route(&req, &url, body, r.get_ref()),
    };
    // None: the client hung up while its call was waiting.
    let Some((res, after)) = res else { return };
    let sent = write(&mut out, &res, req.keep_alive);
    // A hook is answered first: it must never make the agent wait on riven.
    // Run here, after the answer, so one connection's hooks keep their order.
    if let Some(after) = after {
      after();
    }
    if sent.is_err() || !req.keep_alive {
      return;
    }
  }
}

fn authorized(req: &Request, url: &url::Url) -> bool {
  let token = server().token.as_str();
  if req.header("authorization").is_some_and(|h| h.strip_prefix("Bearer ") == Some(token)) {
    return true;
  }
  // Hook commands are shell one-liners; a query token keeps them dependency-free.
  query(url, "token").as_deref() == Some(token)
}

pub fn query(url: &url::Url, k: &str) -> Option<String> {
  url.query_pairs().find(|(n, _)| n == k).map(|(_, v)| v.into_owned())
}

type After = Option<Box<dyn FnOnce()>>;

fn route(req: &Request, url: &url::Url, body: Option<Vec<u8>>, conn: &TcpStream) -> Option<(Response, After)> {
  if !authorized(req, url) {
    return Some((Response::empty(401), None));
  }
  let path = url.path();
  if path == "/clichat" {
    // A CLI chat session's hook (services/clichat). May block on a
    // permission card; every connection has its own thread.
    let body = String::from_utf8_lossy(&body.unwrap_or_default()).into_owned();
    let event = query(url, "event").unwrap_or_default();
    let agent = query(url, "agent");
    let (status, json) = crate::services::clichat::hook(req.header("x-riven-pane"), agent.as_deref(), &event, &body);
    let res = match json {
      Some(b) => Response { status, headers: vec![("content-type", "application/json".into())], body: b.into_bytes() },
      None => Response::empty(status),
    };
    return Some((res, None));
  }
  if path != "/mcp" && path != "/hook" {
    return Some((Response::empty(404), None));
  }
  let Some(body) = body else { return Some((Response::empty(413), None)) };
  let body = String::from_utf8_lossy(&body).into_owned();
  if path == "/hook" {
    return Some(hooks::handle(url, &body));
  }
  mcp(req, url, &body, conn).map(|r| (r, None))
}

fn mcp(req: &Request, url: &url::Url, body: &str, conn: &TcpStream) -> Option<Response> {
  if req.method == "DELETE" {
    return Some(Response::empty(200));
  }
  if req.method != "POST" {
    let mut r = Response::empty(405);
    r.headers.push(("allow", "POST, DELETE".into()));
    return Some(r);
  }
  let Some(msg) = util::parse(body) else {
    return Some(Response::json(400, &json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32700, "message": "parse error" } })));
  };
  let pane = query(url, "pane");
  let id = msg.get("id").filter(|v| !v.is_null()).cloned();
  // Notifications (no id) are acknowledged. One matters: a client that gives
  // up on a request (its own timeout, the user pressing Esc) says so with
  // `notifications/cancelled`, without necessarily closing the request.
  let Some(id) = id else {
    if msg.get("method").and_then(Value::as_str) == Some("notifications/cancelled") {
      if let Some(k) = rpc_key(pane.as_deref(), msg.get("params").and_then(|p| p.get("requestId"))) {
        super::cancel_rpc(&k);
      }
    }
    return Some(Response::empty(202));
  };
  let tools = query(url, "tools").filter(|t| !t.is_empty());
  let enabled: Option<std::collections::HashSet<String>> = tools.map(|t| t.split(',').filter(|s| !s.is_empty()).map(str::to_string).collect());
  let empty = json!({});
  let params = msg.get("params").filter(|p| !p.is_null()).unwrap_or(&empty);
  let method = msg.get("method");
  let ok = |result: Value| Some(Response::json(200, &json!({ "jsonrpc": "2.0", "id": id, "result": result })));
  match method.and_then(Value::as_str) {
    Some("initialize") => {
      let v = params.get("protocolVersion").filter(|v| util::truthy(Some(v))).cloned().unwrap_or_else(|| json!("2025-03-26"));
      ok(json!({ "protocolVersion": v, "capabilities": { "tools": {} }, "serverInfo": { "name": "riven", "version": "2.0" } }))
    }
    Some("ping") => ok(json!({})),
    Some("tools/list") => ok(json!({ "tools": tool_defs(enabled.as_ref()).iter().map(|t| t.def.clone()).collect::<Vec<_>>() })),
    Some("tools/call") => {
      let name = match params.get("name") {
        None | Some(Value::Null) => String::new(),
        Some(v) => util::js_string(v),
      };
      let args = params.get("arguments").filter(|a| !a.is_null()).cloned().unwrap_or_else(|| json!({}));
      // Every agent riven starts carries its pane on the URL, so the page
      // routes the call to that pane's workspace. `cwd` is only for a config
      // built by hand.
      let cwd = query(url, "cwd");
      let call = Call { conn: Some(conn), rpc: rpc_key(pane.as_deref(), Some(&id)) };
      let text = call_tool(&name, &args, cwd.as_deref(), pane.as_deref(), &call)?;
      let text = if text.is_empty() { "(no result)".to_string() } else { text };
      ok(json!({ "content": [{ "type": "text", "text": text }] }))
    }
    _ => {
      let m = match method {
        None => "undefined".to_string(),
        Some(v) => util::js_string(v),
      };
      Some(Response::json(200, &json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32601, "message": format!("unknown method {m}") } })))
    }
  }
}
