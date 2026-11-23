// The app's pages, served by this process on its own scheme: riven://localhost.
//
// Before phase 8 Node served them over http://127.0.0.1:47391 (tauri/shim/
// server.ts). Now the renderer build is Tauri's frontendDist (embedded in a
// packaged binary; read from out-tauri/renderer on disk in a dev build, see
// tauri.conf.json devUrl) and this handler answers every request:
//
//   /<file>                 the renderer build. HTML gets the preload script
//                           (except popout.html, which is only a host for DOM
//                           dockview moves in) and the CSP fix below.
//   /__riven/preload.js     the preload bundle (tauri/build.mjs puts it there)
//   /__riven/media/<path>   a workspace file as media (src/main/media.ts's
//                           riven-media scheme): confined to the open
//                           workspaces, Range for video seeking, HEAD from a stat.
//   /__riven/bg/<name>      the panel background image: one file name of the
//                           shape services/backgrounds.rs hands out, read from
//                           userData/backgrounds and nowhere else.
//   /__riven/blank.html     an empty page (the localStorage move, lsmigrate.rs)
//
// A page on a scheme registered here is "local" to Tauri, so its IPC needs no
// remote-URL capability, and Tauri's ipc:// fetch is same-process. Only the
// app's own webviews get an answer: the browser panel's pages (bv-*) share
// the scheme registration and must not read workspace files through it.

use std::io::{Read, Seek, SeekFrom};
use tauri::http::{header, Request, Response, StatusCode};
use tauri::AppHandle;

pub const SCHEME: &str = "riven";
pub const ORIGIN: &str = "riven://localhost";

/// The page's URL for a renderer file ("index.html", "pet.html").
pub fn url(file: &str) -> String {
  format!("{ORIGIN}/{file}")
}

pub fn handle(app: &AppHandle, label: &str, req: &Request<Vec<u8>>) -> Response<Vec<u8>> {
  let path = req.uri().path();
  let app_page = crate::commands::app_page(label);
  if path == "/__riven/blank.html" && (app_page || label == crate::lsmigrate::LABEL) {
    return ok("text/html; charset=utf-8", b"<!doctype html><meta charset=utf-8><title>riven</title>".to_vec());
  }
  if !app_page {
    return status(StatusCode::FORBIDDEN);
  }
  if let Some(enc) = path.strip_prefix("/__riven/media/") {
    return media(req, enc);
  }
  if let Some(name) = path.strip_prefix("/__riven/bg/") {
    return background(name);
  }
  asset(app, path)
}

fn asset(app: &AppHandle, path: &str) -> Response<Vec<u8>> {
  let rel = decode(path.trim_start_matches('/'));
  let rel = if rel.is_empty() { "index.html".to_string() } else { rel };
  if rel.split('/').any(|c| c == "..") {
    return status(StatusCode::FORBIDDEN);
  }
  let Some(a) = app.asset_resolver().get(rel.clone()) else { return status(StatusCode::NOT_FOUND) };
  let mime = mime_of(&rel).map(String::from).unwrap_or(a.mime_type);
  let body = if rel.ends_with(".html") { html(&rel, a.bytes) } else { a.bytes };
  Response::builder()
    .status(StatusCode::OK)
    .header(header::CONTENT_TYPE, mime)
    .header(header::CACHE_CONTROL, "no-cache")
    .body(body)
    .unwrap_or_else(|_| status(StatusCode::INTERNAL_SERVER_ERROR))
}

/// The preload goes first in <head>, before the page's own scripts, as
/// Electron's preload ran. The renderer's CSP (written for Electron) gets
/// Tauri's IPC: without `ipc:` WebKit refuses invoke's fetch to
/// ipc://localhost and Tauri falls back to postMessage + eval, whose result
/// strings stayed charged to this process (phase 7-1).
pub fn html(rel: &str, bytes: Vec<u8>) -> Vec<u8> {
  let mut s = String::from_utf8_lossy(&bytes).into_owned();
  if rel != "popout.html" {
    if let Some(i) = find_ci(&s, "<head>") {
      s.insert_str(i + "<head>".len(), r#"<script src="/__riven/preload.js"></script>"#);
    }
  }
  s.replacen("connect-src 'self'", "connect-src 'self' ipc: http://ipc.localhost", 1).into_bytes()
}

fn find_ci(hay: &str, needle: &str) -> Option<usize> {
  hay.to_ascii_lowercase().find(needle)
}

fn decode(s: &str) -> String {
  url::form_urlencoded::parse(format!("x={}", s.replace('+', "%2B")).as_bytes())
    .next()
    .map(|(_, v)| v.into_owned())
    .unwrap_or_default()
}

fn status(code: StatusCode) -> Response<Vec<u8>> {
  Response::builder().status(code).body(Vec::new()).unwrap()
}

fn ok(mime: &str, body: Vec<u8>) -> Response<Vec<u8>> {
  Response::builder().status(StatusCode::OK).header(header::CONTENT_TYPE, mime).body(body).unwrap()
}

// ---- background ----------------------------------------------------------------

/// The name is the content hash, so the answer never changes: cache it for good.
fn background(name: &str) -> Response<Vec<u8>> {
  let Some(file) = crate::services::backgrounds::file_for(name) else { return status(StatusCode::NOT_FOUND) };
  let Ok(body) = std::fs::read(&file) else { return status(StatusCode::NOT_FOUND) };
  Response::builder()
    .status(StatusCode::OK)
    .header(header::CONTENT_TYPE, mime_of(name).unwrap_or("application/octet-stream"))
    .header(header::CACHE_CONTROL, "max-age=31536000, immutable")
    .header("X-Content-Type-Options", "nosniff")
    .body(body)
    .unwrap_or_else(|_| status(StatusCode::INTERNAL_SERVER_ERROR))
}

// ---- media --------------------------------------------------------------------

/// The most one ranged answer carries. A <video> asks for "bytes=0-" and then
/// for the rest as it plays; answering a bounded piece (206 with the true
/// Content-Range) keeps a large file from being read into memory whole.
const RANGE_CAP: u64 = 4 * 1024 * 1024;

fn media(req: &Request<Vec<u8>>, enc: &str) -> Response<Vec<u8>> {
  let file = decode(enc);
  if file.is_empty() || !file.starts_with('/') {
    return text(StatusCode::BAD_REQUEST, "bad path");
  }
  if !crate::services::workspace::is_confined(&file) {
    return text(StatusCode::FORBIDDEN, "forbidden");
  }
  let Ok(mut f) = std::fs::File::open(&file) else { return text(StatusCode::NOT_FOUND, "not found") };
  let size = match f.metadata() {
    Ok(m) if m.is_file() => m.len(),
    _ => return text(StatusCode::NOT_FOUND, "not found"),
  };
  let mime = mime_of(&file).unwrap_or("application/octet-stream");
  if req.method() == tauri::http::Method::HEAD {
    return Response::builder()
      .status(StatusCode::OK)
      .header(header::CONTENT_LENGTH, size.to_string())
      .header(header::CONTENT_TYPE, mime)
      .header(header::ACCEPT_RANGES, "bytes")
      .body(Vec::new())
      .unwrap();
  }
  let range = req.headers().get(header::RANGE).and_then(|v| v.to_str().ok()).map(|r| parse_range(r, size));
  match range {
    Some(Some((start, end))) => {
      let mut buf = vec![0u8; (end - start + 1) as usize];
      if f.seek(SeekFrom::Start(start)).and_then(|_| f.read_exact(&mut buf)).is_err() {
        return text(StatusCode::NOT_FOUND, "not found");
      }
      Response::builder()
        .status(StatusCode::PARTIAL_CONTENT)
        .header(header::CONTENT_TYPE, mime)
        .header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{size}"))
        .header(header::ACCEPT_RANGES, "bytes")
        .body(buf)
        .unwrap()
    }
    Some(None) => Response::builder()
      .status(StatusCode::RANGE_NOT_SATISFIABLE)
      .header(header::CONTENT_RANGE, format!("bytes */{size}"))
      .body(Vec::new())
      .unwrap(),
    None => {
      let mut buf = Vec::with_capacity(size as usize);
      if f.read_to_end(&mut buf).is_err() {
        return text(StatusCode::NOT_FOUND, "not found");
      }
      Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, mime)
        .header(header::ACCEPT_RANGES, "bytes")
        .body(buf)
        .unwrap()
    }
  }
}

fn text(code: StatusCode, msg: &str) -> Response<Vec<u8>> {
  Response::builder().status(code).header(header::CONTENT_TYPE, "text/plain").body(msg.as_bytes().to_vec()).unwrap()
}

/// "bytes=a-b" | "bytes=a-" | "bytes=-n" -> the inclusive span to send (capped
/// at RANGE_CAP), None when it cannot be satisfied. Like the shim's net.fetch.
pub fn parse_range(h: &str, size: u64) -> Option<(u64, u64)> {
  let spec = h.trim().strip_prefix("bytes=")?.split(',').next()?.trim();
  let (a, b) = spec.split_once('-')?;
  let (start, end) = if a.is_empty() {
    let n: u64 = b.parse().ok()?;
    (size.saturating_sub(n), size.checked_sub(1)?)
  } else {
    let start: u64 = a.parse().ok()?;
    let end = if b.is_empty() { size.checked_sub(1)? } else { b.parse::<u64>().ok()?.min(size.checked_sub(1)?) };
    (start, end)
  };
  if start > end || start >= size {
    return None;
  }
  Some((start, end.min(start + RANGE_CAP - 1)))
}

pub fn mime_of(file: &str) -> Option<&'static str> {
  let ext = file.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase())?;
  Some(match ext.as_str() {
    "png" => "image/png",
    "jpg" | "jpeg" => "image/jpeg",
    "gif" => "image/gif",
    "webp" => "image/webp",
    "svg" => "image/svg+xml",
    "bmp" => "image/bmp",
    "ico" => "image/x-icon",
    "avif" => "image/avif",
    "mp4" | "m4v" => "video/mp4",
    "mov" => "video/quicktime",
    "webm" => "video/webm",
    "mp3" => "audio/mpeg",
    "m4a" => "audio/mp4",
    "wav" => "audio/wav",
    "ogg" => "audio/ogg",
    "flac" => "audio/flac",
    "pdf" => "application/pdf",
    "html" => "text/html; charset=utf-8",
    "js" | "mjs" => "text/javascript; charset=utf-8",
    "css" => "text/css; charset=utf-8",
    "json" => "application/json",
    "wasm" => "application/wasm",
    "woff" => "font/woff",
    "woff2" => "font/woff2",
    "ttf" => "font/ttf",
    "otf" => "font/otf",
    "txt" => "text/plain; charset=utf-8",
    _ => return None,
  })
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn ranges() {
    assert_eq!(parse_range("bytes=0-1", 100), Some((0, 1)));
    assert_eq!(parse_range("bytes=10-", 100), Some((10, 99)));
    assert_eq!(parse_range("bytes=-10", 100), Some((90, 99)));
    assert_eq!(parse_range("bytes=50-500", 100), Some((50, 99)));
    assert_eq!(parse_range("bytes=100-", 100), None);
    assert_eq!(parse_range("bytes=5-2", 100), None);
    assert_eq!(parse_range("bytes=0-", 0), None);
    assert_eq!(parse_range("items=0-1", 100), None);
    let big = 100 * 1024 * 1024;
    assert_eq!(parse_range("bytes=0-", big), Some((0, RANGE_CAP - 1)));
    assert_eq!(parse_range("bytes=7-", big), Some((7, 7 + RANGE_CAP - 1)));
  }

  #[test]
  fn html_gets_preload_and_ipc() {
    let src = br#"<!doctype html><html><HEAD><meta http-equiv="Content-Security-Policy" content="default-src 'self'; connect-src 'self' ws: http: https:"></HEAD></html>"#;
    let out = String::from_utf8(html("index.html", src.to_vec())).unwrap();
    assert!(out.contains(r#"<HEAD><script src="/__riven/preload.js"></script><meta"#));
    assert!(out.contains("connect-src 'self' ipc: http://ipc.localhost ws: http: https:"));
    let pop = String::from_utf8(html("popout.html", src.to_vec())).unwrap();
    assert!(!pop.contains("preload.js"));
  }

  #[test]
  fn decodes_paths() {
    assert_eq!(decode("%2Fa%20b%2Fc%23d.png"), "/a b/c#d.png");
    assert_eq!(decode("a+b"), "a+b");
    assert_eq!(decode("%ED%95%9C.png"), "한.png");
  }
}
