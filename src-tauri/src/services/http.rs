// An HTTP client that answers like Node's fetch (undici) for what riven uses
// it for: the API client panel (api:request, src/main/apiclient.ts) and the
// riven_api_request MCP tool (src/main/apiRequest.ts). HTTP/1.1 over a plain
// or TLS (native-tls, the system's trust store) socket, one request per
// connection.
//
// fetch's behavior kept: redirects followed (up to 20; 303, and 301/302 after
// a POST, become GET without a body; authorization, proxy-authorization and
// cookie are dropped when the origin changes), gzip/deflate bodies decoded,
// text() as UTF-8 with the BOM removed, header names lower case and sorted,
// repeated headers joined with ", " (set-cookie kept apart), the default
// request headers, a string body sent as text/plain;charset=UTF-8, and the
// error texts ("fetch failed", "Failed to parse URL from ...").
//
// Not covered: brotli bodies (not asked for: accept-encoding is gzip, deflate),
// data: and file: URLs, HTTP/2, proxies from the environment (undici ignores
// them too by default).

use serde_json::{json, Map, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::time::{Duration, Instant};

const TIMEOUT: Duration = Duration::from_secs(300);

pub struct Response {
  pub status: u16,
  pub status_text: String,
  /// fetch's Headers iteration order: (name, value), sorted, joined.
  pub headers: Vec<(String, String)>,
  pub body: String,
}

trait Stream: Read + Write {}
impl<T: Read + Write> Stream for T {}

fn connect(u: &url::Url) -> Result<Box<dyn Stream>, String> {
  let host = u.host_str().ok_or("fetch failed")?.to_string();
  let port = u.port_or_known_default().ok_or("fetch failed")?;
  let addrs = (host.trim_start_matches('[').trim_end_matches(']'), port).to_socket_addrs().map_err(|_| "fetch failed".to_string())?;
  let mut last = None;
  let mut sock = None;
  for a in addrs {
    match TcpStream::connect_timeout(&a, Duration::from_secs(10)) {
      Ok(s) => {
        sock = Some(s);
        break;
      }
      Err(e) => last = Some(e),
    }
  }
  let _ = last;
  let sock = sock.ok_or("fetch failed")?;
  let _ = sock.set_read_timeout(Some(TIMEOUT));
  let _ = sock.set_write_timeout(Some(TIMEOUT));
  let _ = sock.set_nodelay(true);
  if u.scheme() == "https" {
    let tls = native_tls::TlsConnector::new().map_err(|_| "fetch failed".to_string())?;
    let s = tls.connect(host.trim_start_matches('[').trim_end_matches(']'), sock).map_err(|_| "fetch failed".to_string())?;
    Ok(Box::new(s))
  } else {
    Ok(Box::new(sock))
  }
}

fn read_chunked(r: &mut impl BufRead) -> Result<Vec<u8>, String> {
  let mut out = Vec::new();
  loop {
    let mut line = String::new();
    r.read_line(&mut line).map_err(|_| "fetch failed")?;
    let size = usize::from_str_radix(line.trim().split(';').next().unwrap_or("").trim(), 16).map_err(|_| "fetch failed")?;
    if size == 0 {
      // trailers until the empty line
      loop {
        let mut t = String::new();
        if r.read_line(&mut t).map_err(|_| "fetch failed")? == 0 || t.trim().is_empty() {
          return Ok(out);
        }
      }
    }
    let start = out.len();
    out.resize(start + size, 0);
    r.read_exact(&mut out[start..]).map_err(|_| "fetch failed")?;
    let mut crlf = String::new();
    r.read_line(&mut crlf).map_err(|_| "fetch failed")?;
  }
}

fn decode(enc: &str, body: Vec<u8>) -> Result<Vec<u8>, String> {
  let mut out = Vec::new();
  for e in enc.split(',').map(|e| e.trim().to_ascii_lowercase()).rev() {
    match e.as_str() {
      "gzip" | "x-gzip" => {
        flate2::read::MultiGzDecoder::new(&body[..]).read_to_end(&mut out).map_err(|_| "fetch failed")?;
      }
      "deflate" => {
        if flate2::read::ZlibDecoder::new(&body[..]).read_to_end(&mut out).is_err() {
          out.clear();
          flate2::read::DeflateDecoder::new(&body[..]).read_to_end(&mut out).map_err(|_| "fetch failed")?;
        }
      }
      _ => return Ok(body),
    }
    return Ok(out);
  }
  Ok(body)
}

struct Raw {
  status: u16,
  reason: String,
  headers: Vec<(String, String)>,
  body: Vec<u8>,
}

fn once(u: &url::Url, method: &str, headers: &[(String, String)], body: Option<&[u8]>) -> Result<Raw, String> {
  let mut s = connect(u)?;
  let mut path = u.path().to_string();
  if let Some(q) = u.query() {
    path.push('?');
    path.push_str(q);
  }
  let host = match (u.host_str(), u.port()) {
    (Some(h), Some(p)) => format!("{h}:{p}"),
    (Some(h), None) => h.to_string(),
    _ => String::new(),
  };
  // undici: keep-alive, except HEAD (whose reply it cannot reuse a socket after).
  let conn = if method == "HEAD" { "close" } else { "keep-alive" };
  let mut req = format!("{method} {path} HTTP/1.1\r\nhost: {host}\r\nconnection: {conn}\r\n");
  for (k, v) in headers {
    req.push_str(&format!("{k}: {v}\r\n"));
  }
  if let Some(b) = body {
    req.push_str(&format!("content-length: {}\r\n", b.len()));
  } else if matches!(method, "POST" | "PUT") {
    req.push_str("content-length: 0\r\n");
  }
  req.push_str("\r\n");
  s.write_all(req.as_bytes()).map_err(|_| "fetch failed")?;
  if let Some(b) = body {
    s.write_all(b).map_err(|_| "fetch failed")?;
  }
  s.flush().map_err(|_| "fetch failed")?;
  let mut r = BufReader::new(s);
  loop {
    let mut status_line = String::new();
    if r.read_line(&mut status_line).map_err(|_| "fetch failed")? == 0 {
      return Err("fetch failed".into());
    }
    let sl = status_line.trim_end_matches(['\r', '\n']);
    let mut parts = sl.splitn(3, ' ');
    let proto = parts.next().unwrap_or("");
    if !proto.starts_with("HTTP/") {
      return Err("fetch failed".into());
    }
    let status: u16 = parts.next().and_then(|c| c.parse().ok()).ok_or("fetch failed")?;
    let reason = parts.next().unwrap_or("").to_string();
    let mut hs = Vec::new();
    loop {
      let mut h = String::new();
      if r.read_line(&mut h).map_err(|_| "fetch failed")? == 0 {
        return Err("fetch failed".into());
      }
      let h = h.trim_end_matches(['\r', '\n']);
      if h.is_empty() {
        break;
      }
      if let Some((k, v)) = h.split_once(':') {
        hs.push((k.trim().to_ascii_lowercase(), v.trim().to_string()));
      }
    }
    if (100..200).contains(&status) {
      continue; // 100 Continue and friends: the real answer follows
    }
    let get = |n: &str| hs.iter().find(|(k, _)| k == n).map(|(_, v)| v.clone());
    let mut body = Vec::new();
    if method != "HEAD" && status != 204 && status != 304 {
      if get("transfer-encoding").is_some_and(|t| t.to_ascii_lowercase().contains("chunked")) {
        body = read_chunked(&mut r)?;
      } else if let Some(n) = get("content-length").and_then(|n| n.parse::<usize>().ok()) {
        body.resize(n, 0);
        r.read_exact(&mut body).map_err(|_| "fetch failed")?;
      } else {
        r.read_to_end(&mut body).map_err(|_| "fetch failed")?;
      }
      if let Some(enc) = get("content-encoding") {
        body = decode(&enc, body)?;
      }
    }
    return Ok(Raw { status, reason, headers: hs, body });
  }
}

/// fetch's Headers: lower-case names, sorted, repeats joined with ", ";
/// each set-cookie its own entry.
fn headers_view(hs: &[(String, String)]) -> Vec<(String, String)> {
  let mut names: Vec<&str> = hs.iter().map(|(k, _)| k.as_str()).collect();
  names.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
  names.dedup();
  let mut out = Vec::new();
  for n in names {
    let vals: Vec<&str> = hs.iter().filter(|(k, _)| k == n).map(|(_, v)| v.as_str()).collect();
    if n == "set-cookie" {
      out.extend(vals.into_iter().map(|v| (n.to_string(), v.to_string())));
    } else {
      out.push((n.to_string(), vals.join(", ")));
    }
  }
  out
}

pub fn fetch(url: &str, method: &str, headers: &[(String, String)], body: Option<String>) -> Result<Response, String> {
  let mut u = url::Url::parse(url).map_err(|_| format!("Failed to parse URL from {url}"))?;
  if !matches!(u.scheme(), "http" | "https") {
    return Err("fetch failed".into());
  }
  let mut method = method.to_string();
  // The request headers: the caller's, lower-cased, then fetch's defaults.
  let mut hs: Vec<(String, String)> = Vec::new();
  for (k, v) in headers {
    let k = k.to_ascii_lowercase();
    match hs.iter_mut().find(|(n, _)| *n == k) {
      Some(e) => e.1 = format!("{}, {}", e.1, v),
      None => hs.push((k, v.clone())),
    }
  }
  let mut body = body.map(String::into_bytes);
  if body.is_some() && !hs.iter().any(|(k, _)| k == "content-type") {
    hs.push(("content-type".into(), "text/plain;charset=UTF-8".into()));
  }
  for (k, v) in [("accept", "*/*"), ("accept-language", "*"), ("sec-fetch-mode", "cors"), ("user-agent", "node"), ("accept-encoding", "gzip, deflate")] {
    if !hs.iter().any(|(n, _)| n == k) {
      hs.push((k.into(), v.into()));
    }
  }
  let deadline = Instant::now() + TIMEOUT;
  for _ in 0..=20 {
    if Instant::now() > deadline {
      return Err("fetch failed".into());
    }
    let raw = once(&u, &method, &hs, body.as_deref())?;
    let location = raw.headers.iter().find(|(k, _)| k == "location").map(|(_, v)| v.clone());
    if matches!(raw.status, 301 | 302 | 303 | 307 | 308) {
      if let Some(loc) = location {
        let next = u.join(&loc).map_err(|_| "fetch failed".to_string())?;
        if !matches!(next.scheme(), "http" | "https") {
          return Err("fetch failed".into());
        }
        if (raw.status == 303 && method != "GET" && method != "HEAD") || (matches!(raw.status, 301 | 302) && method == "POST") {
          method = "GET".into();
          body = None;
          hs.retain(|(k, _)| !matches!(k.as_str(), "content-type" | "content-encoding" | "content-language" | "content-location"));
        }
        if next.origin() != u.origin() {
          hs.retain(|(k, _)| !matches!(k.as_str(), "authorization" | "proxy-authorization" | "cookie"));
        }
        u = next;
        continue;
      }
    }
    let mut text = String::from_utf8_lossy(&raw.body).into_owned();
    if text.starts_with('\u{feff}') {
      text.drain(..3);
    }
    return Ok(Response { status: raw.status, status_text: raw.reason, headers: headers_view(&raw.headers), body: text });
  }
  Err("fetch failed".into())
}

fn header_pairs(v: Option<&Value>) -> Vec<(String, String)> {
  match v.and_then(Value::as_object) {
    Some(o) => o.iter().map(|(k, v)| (k.clone(), crate::services::db::js::string(v))).collect(),
    None => Vec::new(),
  }
}

/// api:request (runRequest): status, headers, body and timing.
pub fn api_request(opts: &Value) -> Value {
  let started = crate::services::chat::util::now_ms();
  let method = opts.get("method").and_then(Value::as_str).filter(|m| !m.is_empty()).unwrap_or("GET").to_uppercase();
  let url = opts.get("url").map(crate::services::db::js::string).unwrap_or_else(|| "undefined".into());
  let body = if method == "GET" || method == "HEAD" { None } else { opts.get("body").filter(|b| !b.is_null()).map(crate::services::db::js::string) };
  let elapsed = || (crate::services::chat::util::now_ms() - started).round() as i64;
  match fetch(&url, &method, &header_pairs(opts.get("headers")), body) {
    Ok(r) => {
      let mut h = Map::new();
      for (k, v) in &r.headers {
        h.insert(k.clone(), Value::String(v.clone())); // the last set-cookie wins, as headers[k] = v
      }
      let ct = r.headers.iter().find(|(k, _)| k == "content-type").map(|(_, v)| v.clone()).unwrap_or_default();
      json!({
        "ok": (200..300).contains(&r.status),
        "status": r.status,
        "statusText": r.status_text,
        "headers": h,
        "body": r.body,
        "timeMs": elapsed(),
        "contentType": ct,
      })
    }
    Err(e) => json!({
      "ok": false, "status": 0, "statusText": "", "headers": {}, "body": "", "timeMs": elapsed(), "contentType": "", "error": e
    }),
  }
}

/// riven_api_request (runApiRequest): a compact text for the agent.
pub fn api_request_text(args: &Value) -> String {
  let method = args.get("method").filter(|m| !m.is_null()).map(crate::services::db::js::string).unwrap_or_else(|| "GET".into()).to_uppercase();
  let url = args.get("url").filter(|u| !u.is_null()).map(crate::services::db::js::string).unwrap_or_default();
  if url.is_empty() {
    return "error: url is required".into();
  }
  let body = if method == "GET" || method == "HEAD" { None } else { args.get("body").filter(|b| !b.is_null()).map(crate::services::db::js::string) };
  match fetch(&url, &method, &header_pairs(args.get("headers")), body) {
    Ok(r) => {
      let hdrs: Vec<String> = r.headers.iter().map(|(k, v)| format!("{k}: {v}")).collect();
      let js = &crate::services::db::js::utf16_len(&r.body);
      let clipped = if *js > 8000 { format!("{}\n… (truncated)", crate::services::db::js::utf16_slice(&r.body, 8000)) } else { r.body.clone() };
      format!("HTTP {} {}\n{}\n\n{}", r.status, r.status_text, hdrs.join("\n"), clipped)
    }
    Err(e) => format!("error: {e}"),
  }
}

#[cfg(test)]
mod tests {
  // Comparison run (not part of the normal suite):
  //   RIVEN_HTTP_REQS=reqs.json RIVEN_HTTP_OUT=out.json cargo test http::tests::compare -- --ignored
  #[test]
  #[ignore]
  fn compare() {
    let reqs: Vec<serde_json::Value> = serde_json::from_slice(&std::fs::read(std::env::var("RIVEN_HTTP_REQS").unwrap()).unwrap()).unwrap();
    let mut api = Vec::new();
    let mut text = Vec::new();
    for q in &reqs {
      let mut v = super::api_request(q);
      v.as_object_mut().unwrap().remove("timeMs");
      api.push(v);
    }
    for q in &reqs {
      text.push(serde_json::Value::String(super::api_request_text(q)));
    }
    std::fs::write(std::env::var("RIVEN_HTTP_OUT").unwrap(), serde_json::to_vec_pretty(&serde_json::json!({ "api": api, "text": text })).unwrap()).unwrap();
  }
}
