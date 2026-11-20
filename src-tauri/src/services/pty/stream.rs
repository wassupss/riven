// The binary line from the terminals to the page: one loopback WebSocket per
// page (window label), carrying output, snapshots, exit, bell and title as
// binary frames, in order (see frame() in mod.rs, decoded by
// tauri/shim/pty-stream.ts).
//
// Why not a Tauri Channel: measured again in phase 8, with the page on
// riven://localhost where Channel is a real binary path (each message one
// eval, plus an ipc:// fetch above 1KB). Release build, flow control acked
// on receipt: 300MB without newlines 11.1s / CPU 17% here vs 11.3s / 21%,
// `yes` 200MB 63.9s / 99% vs 67.8s / 102%, footprint the same (50 vs 51MB
// after), keystroke echo the same (median 7ms). The socket stays: a little
// lighter, and no script per message. (Phase 2, with the page on
// http://127.0.0.1, a Channel fell back to postMessage + eval and a 300MB
// flood left 441MB here.)
//
// Only what the app's own pages need: the handshake (RFC 6455, sha1 +
// base64), unmasked binary frames out, and reading the page's frames only to
// notice a close. A token (handed out by the pty_stream command, which only
// the app's pages may call) guards the door.

use base64::Engine;
use sha1::{Digest, Sha1};
use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Mutex, OnceLock};

struct Conn {
  id: u64,
  tx: mpsc::Sender<Vec<u8>>,
}

struct Server {
  port: u16,
  token: String,
}

static SERVER: OnceLock<Option<Server>> = OnceLock::new();
static CONNS: OnceLock<Mutex<HashMap<String, Conn>>> = OnceLock::new();
static NEXT: AtomicU64 = AtomicU64::new(1);

fn conns() -> std::sync::MutexGuard<'static, HashMap<String, Conn>> {
  CONNS.get_or_init(Default::default).lock().unwrap()
}

fn token() -> String {
  let mut b = [0u8; 16];
  if File::open("/dev/urandom").and_then(|mut f| f.read_exact(&mut b)).is_err() {
    let t = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos();
    b = (t ^ ((std::process::id() as u128) << 64)).to_le_bytes();
  }
  b.iter().map(|x| format!("{x:02x}")).collect()
}

/// (port, token) for the page, starting the listener on first use.
pub fn endpoint() -> Option<(u16, String)> {
  SERVER
    .get_or_init(|| {
      let l = TcpListener::bind("127.0.0.1:0").ok()?;
      let port = l.local_addr().ok()?.port();
      let token = token();
      let t = token.clone();
      std::thread::Builder::new()
        .name("pty-stream".into())
        .spawn(move || {
          for s in l.incoming().flatten() {
            let t = t.clone();
            let _ = std::thread::Builder::new().name("pty-stream-conn".into()).spawn(move || serve(s, &t));
          }
        })
        .ok()?;
      Some(Server { port, token })
    })
    .as_ref()
    .map(|s| (s.port, s.token.clone()))
}

/// Queue a frame for the page; dropped (false) if that page has no connection
/// yet. A page that connects later is resynced from the model (see below).
pub fn send(label: &str, frame: Vec<u8>) -> bool {
  match conns().get(label) {
    Some(c) => c.tx.send(frame).is_ok(),
    None => false,
  }
}

fn query<'a>(q: &'a str, k: &str) -> Option<&'a str> {
  q.split('&').find_map(|kv| kv.strip_prefix(k).and_then(|r| r.strip_prefix('=')))
}

fn serve(stream: TcpStream, token: &str) {
  let _ = stream.set_nodelay(true);
  let Ok(mut out) = stream.try_clone() else { return };
  let mut r = BufReader::new(stream);
  let mut line = String::new();
  if r.read_line(&mut line).is_err() {
    return;
  }
  // GET /pty?t=TOKEN&w=LABEL HTTP/1.1
  let target = line.split(' ').nth(1).unwrap_or("");
  let q = target.split_once('?').map(|(_, q)| q).unwrap_or("");
  let (Some(t), Some(label)) = (query(q, "t"), query(q, "w")) else { return };
  let label = label.to_string();
  let mut key = None;
  let mut origin_ok = true;
  let mut total = 0;
  loop {
    let mut h = String::new();
    match r.read_line(&mut h) {
      Ok(0) | Err(_) => return,
      Ok(n) => total += n,
    }
    if total > 16 * 1024 {
      return;
    }
    let h = h.trim_end();
    if h.is_empty() {
      break;
    }
    if let Some((k, v)) = h.split_once(':') {
      let (k, v) = (k.trim().to_ascii_lowercase(), v.trim());
      if k == "sec-websocket-key" {
        key = Some(v.to_string());
      } else if k == "origin" {
        origin_ok = v == crate::page::ORIGIN;
      }
    }
  }
  let ok = t.len() == token.len() && t.bytes().zip(token.bytes()).fold(0u8, |a, (x, y)| a | (x ^ y)) == 0;
  let Some(key) = key.filter(|_| ok && origin_ok) else {
    let _ = out.write_all(b"HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\n\r\n");
    return;
  };
  let accept = base64::engine::general_purpose::STANDARD
    .encode(Sha1::digest(format!("{key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11").as_bytes()));
  if out
    .write_all(format!("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\n\r\n").as_bytes())
    .is_err()
  {
    return;
  }

  // A reload brings a new connection for the same window; it replaces the old.
  let id = NEXT.fetch_add(1, Ordering::Relaxed);
  let (tx, rx) = mpsc::channel::<Vec<u8>>();
  conns().insert(label.clone(), Conn { id, tx });
  // Frames sent before this connection existed (page load, reload) were
  // dropped, the first snapshot among them, which left terminals on
  // "Restoring session" forever. Resend every terminal of this page from the model.
  super::resync_page(label.clone());
  let w = std::thread::Builder::new().name("pty-stream-write".into()).spawn(move || {
    for f in rx {
      let mut h = Vec::with_capacity(10);
      h.push(0x82); // FIN + binary
      match f.len() {
        n if n < 126 => h.push(n as u8),
        n if n <= 0xFFFF => {
          h.push(126);
          h.extend_from_slice(&(n as u16).to_be_bytes());
        }
        n => {
          h.push(127);
          h.extend_from_slice(&(n as u64).to_be_bytes());
        }
      }
      if out.write_all(&h).and_then(|_| out.write_all(&f)).is_err() {
        break;
      }
    }
    let _ = out.shutdown(std::net::Shutdown::Both);
  });

  // The page only ever closes. Read its frames until it does (or goes away).
  read_until_close(&mut r);
  {
    let mut m = conns();
    if m.get(&label).is_some_and(|c| c.id == id) {
      m.remove(&label); // drops the sender: the writer thread ends
    }
  }
  drop(w);
}

fn read_until_close(r: &mut impl Read) {
  let mut hdr = [0u8; 2];
  loop {
    if r.read_exact(&mut hdr).is_err() {
      return;
    }
    let op = hdr[0] & 0x0F;
    let masked = hdr[1] & 0x80 != 0;
    let mut len = (hdr[1] & 0x7F) as u64;
    if len == 126 {
      let mut b = [0u8; 2];
      if r.read_exact(&mut b).is_err() {
        return;
      }
      len = u16::from_be_bytes(b) as u64;
    } else if len == 127 {
      let mut b = [0u8; 8];
      if r.read_exact(&mut b).is_err() {
        return;
      }
      len = u64::from_be_bytes(b);
    }
    let skip = len + if masked { 4 } else { 0 };
    if std::io::copy(&mut r.by_ref().take(skip), &mut std::io::sink()).map(|n| n != skip).unwrap_or(true) || op == 8 {
      return;
    }
  }
}
