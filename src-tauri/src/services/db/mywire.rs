// The MySQL / MariaDB client protocol, as much as riven uses, the way mysql2
// uses it: text protocol (COM_QUERY) only, client-side parameter escaping
// (mysql2's sql-escaper), the same client flags (FOUND_ROWS: an UPDATE reports
// matched rows; IGNORE_SPACE), connection charset utf8mb4_unicode_ci,
// mysql_native_password and caching_sha2_password (RSA over plain TCP), TLS.
// Rows are pulled one at a time so a reader can stop (close the socket) after
// the rows it wants, which is how mysql2's destroy() ends a big read.

use super::pgwire::{tcp, tls, Io};
use super::{DbErr, R};
use bytes::{Buf, BufMut, BytesMut};
use sha1::{Digest, Sha1};
use sha2::Sha256;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const LONG_PASSWORD: u32 = 1;
const FOUND_ROWS: u32 = 2;
const LONG_FLAG: u32 = 4;
const CONNECT_WITH_DB: u32 = 8;
const ODBC: u32 = 64;
const LOCAL_FILES: u32 = 128;
const IGNORE_SPACE: u32 = 256;
const PROTOCOL_41: u32 = 512;
const SSL: u32 = 2048;
const IGNORE_SIGPIPE: u32 = 4096;
const TRANSACTIONS: u32 = 8192;
const RESERVED: u32 = 16384;
const SECURE_CONNECTION: u32 = 32768;
const MULTI_RESULTS: u32 = 1 << 17;
const PLUGIN_AUTH: u32 = 1 << 19;
const CONNECT_ATTRS: u32 = 1 << 20;
const PLUGIN_AUTH_LENENC: u32 = 1 << 21;

pub const STATUS_IN_TRANS: u16 = 1;
const STATUS_MORE_RESULTS: u16 = 8;

#[derive(Clone, Debug)]
pub struct Field {
  pub schema: String,
  pub org_table: String,
  pub name: String,
  pub org_name: String,
  pub charset: u16,
  pub column_type: u8,
  pub flags: u16,
}

#[derive(Clone, Debug, Default)]
pub struct Header {
  pub affected_rows: f64,
  pub insert_id: f64,
  pub status: u16,
}

pub type Row = Vec<Option<Vec<u8>>>;

/// What a statement started with.
pub enum Start {
  Ok(Header),
  Rows(Vec<Field>),
}

pub struct MyConn {
  io: Box<dyn Io>,
  buf: BytesMut,
  seq: u8,
  pub thread_id: u32,
  pub server_version: String,
  pub status: u16,
  pub broken: bool,
  /// Rows of the current result set are still being read.
  reading: bool,
  /// After the current result, more follow (CALL).
  more: bool,
}

fn lenenc_int(b: &mut &[u8]) -> Option<u64> {
  let f = *b.first()?;
  b.advance(1);
  Some(match f {
    0xfb => return None,
    0xfc => b.get_u16_le() as u64,
    0xfd => {
      let x = b.get_uint_le(3);
      x
    }
    0xfe => b.get_u64_le(),
    x => x as u64,
  })
}

fn lenenc_bytes(b: &mut &[u8]) -> Option<Vec<u8>> {
  if b.first() == Some(&0xfb) {
    b.advance(1);
    return None;
  }
  let n = lenenc_int(b).unwrap_or(0) as usize;
  let n = n.min(b.len());
  let v = b[..n].to_vec();
  b.advance(n);
  Some(v)
}

fn lenenc_str(b: &mut &[u8]) -> String {
  String::from_utf8_lossy(&lenenc_bytes(b).unwrap_or_default()).into_owned()
}

fn put_lenenc(out: &mut BytesMut, n: usize) {
  if n < 251 {
    out.put_u8(n as u8);
  } else if n < 1 << 16 {
    out.put_u8(0xfc);
    out.put_u16_le(n as u16);
  } else if n < 1 << 24 {
    out.put_u8(0xfd);
    out.put_uint_le(n as u64, 3);
  } else {
    out.put_u8(0xfe);
    out.put_u64_le(n as u64);
  }
}

fn err_packet(mut b: &[u8]) -> DbErr {
  b.advance(1);
  let errno = if b.len() >= 2 { b.get_u16_le() } else { 0 };
  if b.first() == Some(&b'#') && b.len() >= 6 {
    b.advance(6);
  }
  DbErr { msg: String::from_utf8_lossy(b).into_owned(), errno: Some(errno as u32) }
}

fn ok_packet(mut b: &[u8]) -> Header {
  b.advance(1);
  let affected = lenenc_int(&mut b).unwrap_or(0) as f64;
  let insert = lenenc_int(&mut b).unwrap_or(0) as f64;
  let status = if b.len() >= 2 { b.get_u16_le() } else { 0 };
  Header { affected_rows: affected, insert_id: insert, status }
}

fn xor(a: &[u8], b: &[u8]) -> Vec<u8> {
  a.iter().zip(b.iter().cycle()).map(|(x, y)| x ^ y).collect()
}

fn native_password(pw: &str, scramble: &[u8]) -> Vec<u8> {
  if pw.is_empty() {
    return vec![];
  }
  let s1 = Sha1::digest(pw.as_bytes());
  let s2 = Sha1::digest(s1);
  let mut h = Sha1::new();
  h.update(scramble);
  h.update(s2);
  xor(&s1, &h.finalize())
}

fn sha2_password(pw: &str, scramble: &[u8]) -> Vec<u8> {
  if pw.is_empty() {
    return vec![];
  }
  let s1 = Sha256::digest(pw.as_bytes());
  let s2 = Sha256::digest(s1);
  let mut h = Sha256::new();
  h.update(s2);
  h.update(scramble);
  xor(&s1, &h.finalize())
}

pub struct Opts {
  pub host: String,
  pub port: u16,
  pub user: String,
  pub password: Option<String>,
  pub database: String,
  pub ssl: Option<super::Ssl>,
}

impl MyConn {
  pub async fn connect(o: &Opts, timeout: Duration) -> R<MyConn> {
    match tokio::time::timeout(timeout, Self::connect_now(o)).await {
      Ok(r) => r,
      Err(_) => Err(DbErr::new("connect ETIMEDOUT")),
    }
  }

  async fn connect_now(o: &Opts) -> R<MyConn> {
    let mut tcp = tcp(&o.host, o.port).await?;
    // The greeting is read on the plain socket, which TLS may then wrap.
    let mut head = [0u8; 4];
    tcp.read_exact(&mut head).await.map_err(|e| super::pgwire::net_error(&e, &o.host, o.port, None))?;
    let len = (head[0] as usize) | (head[1] as usize) << 8 | (head[2] as usize) << 16;
    let mut hs = vec![0u8; len];
    tcp.read_exact(&mut hs).await.map_err(|e| super::pgwire::net_error(&e, &o.host, o.port, None))?;
    if hs.first() == Some(&0xff) {
      return Err(err_packet(&hs));
    }
    let mut b: &[u8] = &hs;
    b.advance(1);
    let end = b.iter().position(|&x| x == 0).unwrap_or(b.len());
    let server_version = String::from_utf8_lossy(&b[..end]).into_owned();
    b.advance((end + 1).min(b.len()));
    let thread_id = b.get_u32_le();
    let mut scramble = b[..8].to_vec();
    b.advance(9);
    let caps_lo = b.get_u16_le() as u32;
    let _charset = b.get_u8();
    let status = b.get_u16_le();
    let caps_hi = b.get_u16_le() as u32;
    let server_caps = caps_lo | (caps_hi << 16);
    let auth_len = b.get_u8() as usize;
    b.advance(10);
    let part2 = auth_len.saturating_sub(8).max(13).min(b.len());
    scramble.extend_from_slice(&b[..part2.saturating_sub(1)]);
    b.advance(part2);
    let end = b.iter().position(|&x| x == 0).unwrap_or(b.len());
    let mut plugin = String::from_utf8_lossy(&b[..end]).into_owned();
    if plugin.is_empty() {
      plugin = "mysql_native_password".into();
    }

    let mut flags = LONG_PASSWORD | FOUND_ROWS | LONG_FLAG | ODBC | LOCAL_FILES | IGNORE_SPACE | PROTOCOL_41 | IGNORE_SIGPIPE | TRANSACTIONS | RESERVED | SECURE_CONNECTION | MULTI_RESULTS | PLUGIN_AUTH | CONNECT_ATTRS | PLUGIN_AUTH_LENENC;
    if !o.database.is_empty() {
      flags |= CONNECT_WITH_DB;
    }
    let use_tls = o.ssl.is_some();
    if use_tls {
      flags |= SSL;
    }
    flags &= server_caps | SSL;
    let mut seq = head[3].wrapping_add(1);
    let io: Box<dyn Io> = if use_tls {
      if server_caps & SSL == 0 {
        return Err(DbErr::new("Server does not support secure connection"));
      }
      let mut p = BytesMut::new();
      p.put_uint_le(32, 3);
      p.put_u8(seq);
      p.put_u32_le(flags);
      p.put_u32_le(0);
      p.put_u8(224);
      p.put_slice(&[0u8; 23]);
      tcp.write_all(&p).await?;
      seq = seq.wrapping_add(1);
      tls(tcp, &o.host, o.ssl.as_ref().expect("ssl")).await?
    } else {
      Box::new(tcp)
    };
    let mut c = MyConn { io, buf: BytesMut::with_capacity(16 * 1024), seq, thread_id, server_version, status, broken: false, reading: false, more: false };
    let pw = o.password.clone().unwrap_or_default();
    let auth = match plugin.as_str() {
      "caching_sha2_password" => sha2_password(&pw, &scramble),
      _ => native_password(&pw, &scramble),
    };
    let mut p = BytesMut::new();
    p.put_u32_le(flags);
    p.put_u32_le(0);
    p.put_u8(224);
    p.put_slice(&[0u8; 23]);
    p.put_slice(o.user.as_bytes());
    p.put_u8(0);
    put_lenenc(&mut p, auth.len());
    p.put_slice(&auth);
    if flags & CONNECT_WITH_DB != 0 {
      p.put_slice(o.database.as_bytes());
      p.put_u8(0);
    }
    p.put_slice(plugin.as_bytes());
    p.put_u8(0);
    let mut attrs = BytesMut::new();
    for (k, v) in [("_client_name", "riven"), ("_client_version", env!("CARGO_PKG_VERSION"))] {
      put_lenenc(&mut attrs, k.len());
      attrs.put_slice(k.as_bytes());
      put_lenenc(&mut attrs, v.len());
      attrs.put_slice(v.as_bytes());
    }
    put_lenenc(&mut p, attrs.len());
    p.put_slice(&attrs);
    c.write_packet(&p).await?;
    c.auth(&pw, plugin, scramble, use_tls).await?;
    Ok(c)
  }

  async fn auth(&mut self, pw: &str, mut plugin: String, mut scramble: Vec<u8>, secure: bool) -> R<()> {
    loop {
      let p = self.read_packet().await?;
      match p.first() {
        Some(0x00) => {
          self.status = ok_packet(&p).status;
          return Ok(());
        }
        Some(0xff) => return Err(err_packet(&p)),
        Some(0xfe) => {
          // Auth switch: plugin name, new scramble.
          let mut b: &[u8] = &p[1..];
          let end = b.iter().position(|&x| x == 0).unwrap_or(b.len());
          plugin = String::from_utf8_lossy(&b[..end]).into_owned();
          b.advance((end + 1).min(b.len()));
          scramble = b.strip_suffix(&[0]).unwrap_or(b).to_vec();
          let resp = match plugin.as_str() {
            "caching_sha2_password" => sha2_password(pw, &scramble),
            "mysql_clear_password" => {
              let mut v = pw.as_bytes().to_vec();
              v.push(0);
              v
            }
            _ => native_password(pw, &scramble),
          };
          self.write_packet(&resp).await?;
        }
        Some(0x01) if plugin == "caching_sha2_password" => match p.get(1) {
          Some(3) => {} // fast auth: OK follows
          Some(4) => {
            // Full authentication: the password itself, in TLS or RSA-sealed.
            let mut clear = pw.as_bytes().to_vec();
            clear.push(0);
            if secure {
              self.write_packet(&clear).await?;
            } else {
              self.write_packet(&[2]).await?;
              let key = self.read_packet().await?;
              let pem = String::from_utf8_lossy(key.get(1..).unwrap_or_default()).into_owned();
              let sealed = rsa_seal(&pem, &xor(&clear, &scramble))?;
              self.write_packet(&sealed).await?;
            }
          }
          _ => return Err(DbErr::new("Unexpected caching_sha2_password response")),
        },
        _ => return Err(DbErr::new("Unexpected packet during authentication")),
      }
    }
  }

  async fn fill(&mut self, n: usize) -> R<()> {
    while self.buf.len() < n {
      self.buf.reserve(n - self.buf.len());
      let r = match self.io.read_buf(&mut self.buf).await {
        Ok(r) => r,
        Err(e) => {
          self.broken = true;
          return Err(super::pgwire::net_error(&e, "", 0, None));
        }
      };
      if r == 0 {
        self.broken = true;
        return Err(DbErr::new("Connection lost: The server closed the connection."));
      }
    }
    Ok(())
  }

  async fn read_packet(&mut self) -> R<Vec<u8>> {
    let mut out = Vec::new();
    loop {
      self.fill(4).await?;
      let len = (self.buf[0] as usize) | (self.buf[1] as usize) << 8 | (self.buf[2] as usize) << 16;
      self.seq = self.buf[3].wrapping_add(1);
      self.fill(4 + len).await?;
      self.buf.advance(4);
      out.extend_from_slice(&self.buf.split_to(len));
      if len < 0xffffff {
        return Ok(out);
      }
    }
  }

  async fn write_packet(&mut self, payload: &[u8]) -> R<()> {
    let mut out = BytesMut::with_capacity(payload.len() + 8);
    let mut rest = payload;
    loop {
      let n = rest.len().min(0xffffff);
      out.put_uint_le(n as u64, 3);
      out.put_u8(self.seq);
      self.seq = self.seq.wrapping_add(1);
      out.put_slice(&rest[..n]);
      rest = &rest[n..];
      if n < 0xffffff {
        break;
      }
    }
    if let Err(e) = self.io.write_all(&out).await {
      self.broken = true;
      return Err(e.into());
    }
    Ok(())
  }

  /// Skip whatever is left of a statement (rows, further results).
  pub async fn finish(&mut self) -> R<()> {
    while self.reading || self.more {
      if self.reading {
        while self.next_row().await?.is_some() {}
      } else if let Some(Start::Rows(_)) = self.next_result().await? {
      }
    }
    Ok(())
  }

  /// Send a statement and read how it starts: an OK header or a result set's columns.
  pub async fn start(&mut self, sql: &str) -> R<Start> {
    self.finish().await?;
    self.seq = 0;
    let mut p = Vec::with_capacity(sql.len() + 1);
    p.push(0x03);
    p.extend_from_slice(sql.as_bytes());
    self.write_packet(&p).await?;
    self.read_start().await
  }

  async fn read_start(&mut self) -> R<Start> {
    let p = self.read_packet().await?;
    match p.first() {
      Some(0x00) => {
        let h = ok_packet(&p);
        self.status = h.status;
        self.more = h.status & STATUS_MORE_RESULTS != 0;
        Ok(Start::Ok(h))
      }
      Some(0xff) => {
        self.more = false;
        Err(err_packet(&p))
      }
      Some(0xfb) => {
        // LOCAL INFILE: no file is ever sent.
        self.write_packet(&[]).await?;
        let r = Box::pin(self.read_start()).await;
        let name = String::from_utf8_lossy(&p[1..]).into_owned();
        match r {
          Err(e) => Err(e),
          Ok(_) => Err(DbErr::new(format!("As a result of LOCAL INFILE command server wants to read {name} file, but as of v2.0 you must provide streamFactory option returning ReadStream."))),
        }
      }
      _ => {
        let mut b: &[u8] = &p;
        let n = lenenc_int(&mut b).unwrap_or(0) as usize;
        let mut fields = Vec::with_capacity(n);
        for _ in 0..n {
          let d = self.read_packet().await?;
          let mut b: &[u8] = &d;
          let _catalog = lenenc_str(&mut b);
          let schema = lenenc_str(&mut b);
          let _table = lenenc_str(&mut b);
          let org_table = lenenc_str(&mut b);
          let name = lenenc_str(&mut b);
          let org_name = lenenc_str(&mut b);
          let _len = lenenc_int(&mut b);
          let charset = b.get_u16_le();
          let _length = b.get_u32_le();
          let column_type = b.get_u8();
          let flags = b.get_u16_le();
          fields.push(Field { schema, org_table, name, org_name, charset, column_type, flags });
        }
        // EOF after the column definitions.
        let _ = self.read_packet().await?;
        self.reading = true;
        Ok(Start::Rows(fields))
      }
    }
  }

  /// The next row of the current result set, or None at its end.
  pub async fn next_row(&mut self) -> R<Option<Row>> {
    if !self.reading {
      return Ok(None);
    }
    let p = self.read_packet().await?;
    match p.first() {
      Some(0xfe) if p.len() < 9 => {
        let mut b: &[u8] = &p[1..];
        let _warnings = if b.len() >= 2 { b.get_u16_le() } else { 0 };
        let status = if b.len() >= 2 { b.get_u16_le() } else { 0 };
        self.status = status;
        self.reading = false;
        self.more = status & STATUS_MORE_RESULTS != 0;
        Ok(None)
      }
      Some(0xff) => {
        self.reading = false;
        self.more = false;
        Err(err_packet(&p))
      }
      _ => {
        let mut b: &[u8] = &p;
        let mut row = vec![];
        while !b.is_empty() {
          row.push(lenenc_bytes(&mut b));
        }
        Ok(Some(row))
      }
    }
  }

  /// The next result of a multi-result statement (CALL), if one follows.
  pub async fn next_result(&mut self) -> R<Option<Start>> {
    if self.reading {
      while self.next_row().await?.is_some() {}
    }
    if !self.more {
      return Ok(None);
    }
    self.read_start().await.map(Some)
  }

  pub async fn close(mut self) {
    let _ = tokio::time::timeout(Duration::from_secs(2), async {
      if !self.reading && !self.more && !self.broken {
        self.seq = 0;
        let _ = self.write_packet(&[0x01]).await;
      }
      let _ = self.io.shutdown().await;
    })
    .await;
  }

  /// Close the socket now (mysql2's destroy()): the server stops sending.
  pub fn destroy(self) {
    drop(self);
  }

  pub fn is_mariadb(&self) -> bool {
    self.server_version.to_lowercase().contains("mariadb")
  }
}

fn rsa_seal(pem: &str, data: &[u8]) -> R<Vec<u8>> {
  use rsa::pkcs1::DecodeRsaPublicKey;
  use rsa::pkcs8::DecodePublicKey;
  let key = rsa::RsaPublicKey::from_public_key_pem(pem.trim())
    .or_else(|_| rsa::RsaPublicKey::from_pkcs1_pem(pem.trim()))
    .map_err(|e| DbErr::new(format!("caching_sha2_password: bad server key ({e})")))?;
  let mut rng = rsa::rand_core::OsRng;
  key.encrypt(&mut rng, rsa::Oaep::new::<Sha1>(), data).map_err(|e| DbErr::new(e.to_string()))
}

// ---- parameters (mysql2's sql-escaper format) -------------------------------------------

pub fn escape_string(v: &str) -> String {
  let mut o = String::with_capacity(v.len() + 2);
  o.push('\'');
  for c in v.chars() {
    match c {
      '\0' => o.push_str("\\0"),
      '\u{8}' => o.push_str("\\b"),
      '\t' => o.push_str("\\t"),
      '\n' => o.push_str("\\n"),
      '\r' => o.push_str("\\r"),
      '\u{1a}' => o.push_str("\\Z"),
      '"' => o.push_str("\\\""),
      '\'' => o.push_str("\\'"),
      '\\' => o.push_str("\\\\"),
      c => o.push(c),
    }
  }
  o.push('\'');
  o
}

fn escape_id(v: &str) -> String {
  v.split('.').map(|p| format!("`{}`", p.replace('`', "``"))).collect::<Vec<_>>().join(".")
}

/// A parameter value: what mysql2 would have been handed.
#[derive(Clone, Debug)]
pub enum Param {
  Null,
  Num(f64),
  Str(String),
}

impl Param {
  fn escaped(&self) -> String {
    match self {
      Param::Null => "NULL".into(),
      Param::Num(f) => super::js::num_str(*f),
      Param::Str(s) => escape_string(s),
    }
  }
  fn id(&self) -> String {
    match self {
      Param::Str(s) => escape_id(s),
      Param::Num(f) => escape_id(&super::js::num_str(*f)),
      Param::Null => "``".into(),
    }
  }
}

fn skip_context(t: &[char], i: usize) -> Option<usize> {
  let c = t[i];
  let n = t.get(i + 1).copied();
  if c == '\'' {
    let mut k = i + 1;
    while k < t.len() {
      if t[k] == '\\' {
        k += 1;
      } else if t[k] == '\'' {
        return Some(k + 1);
      }
      k += 1;
    }
    return Some(t.len());
  }
  if c == '`' {
    let mut k = i + 1;
    while k < t.len() {
      if t[k] == '`' {
        if t.get(k + 1) == Some(&'`') {
          k += 2;
          continue;
        }
        return Some(k + 1);
      }
      k += 1;
    }
    return Some(t.len());
  }
  if c == '-' && n == Some('-') {
    let after = t.get(i + 2).copied();
    if after.is_none_or(|a| (a as u32) <= 32) {
      return Some((i + 2..t.len()).find(|&k| t[k] == '\n').map(|k| k + 1).unwrap_or(t.len()));
    }
    return None;
  }
  if c == '/' && n == Some('*') {
    if matches!(t.get(i + 2), Some('!') | Some('+')) {
      return None;
    }
    return Some((i + 2..t.len().saturating_sub(1)).find(|&k| t[k] == '*' && t[k + 1] == '/').map(|k| k + 2).unwrap_or(t.len()));
  }
  None
}

fn next_placeholder(t: &[char], start: usize) -> Option<usize> {
  let mut i = start;
  while i < t.len() {
    if t[i] == '?' {
      return Some(i);
    }
    if matches!(t[i], '\'' | '`' | '-' | '/') {
      if let Some(end) = skip_context(t, i) {
        i = end;
        continue;
      }
    }
    i += 1;
  }
  None
}

/// sql-escaper format(sql, values).
pub fn format(sql: &str, values: &[Param]) -> String {
  let t: Vec<char> = sql.chars().collect();
  let mut out = String::new();
  let mut chunk = 0;
  let mut vi = 0;
  let mut pos = next_placeholder(&t, 0);
  while vi < values.len() {
    let Some(p) = pos else { break };
    let mut end = p + 1;
    while t.get(end) == Some(&'?') {
      end += 1;
    }
    if end - p > 2 {
      pos = next_placeholder(&t, end);
      continue;
    }
    let v = if end - p == 2 { values[vi].id() } else { values[vi].escaped() };
    out.extend(t[chunk..p].iter());
    out.push_str(&v);
    chunk = end;
    vi += 1;
    pos = next_placeholder(&t, end);
  }
  if chunk == 0 {
    return sql.to_string();
  }
  out.extend(t[chunk..].iter());
  out
}

// ---- values ---------------------------------------------------------------------------------

pub const BINARY_CHARSET: u16 = 63;

fn ascii(b: &[u8]) -> String {
  b.iter().map(|x| (x & 0x7f) as char).collect()
}
fn latin1(b: &[u8]) -> String {
  b.iter().map(|x| *x as char).collect()
}

/// mysql2's text-protocol reading of a field under riven's options and typeCast.
pub fn cell(f: &Field, v: &Option<Vec<u8>>) -> super::Cell {
  use super::Cell;
  let Some(b) = v else { return Cell::Null };
  let hex = |b: &[u8]| Cell::Str(format!("0x{}", b.iter().map(|x| format!("{x:02x}")).collect::<String>()));
  match f.column_type {
    // GEOMETRY, VECTOR: the raw bytes
    255 | 242 => hex(b),
    // TINY SHORT LONG INT24 YEAR
    1 | 2 | 3 | 9 | 13 => Cell::Num(parse_int_no_big_check(b)),
    // LONGLONG: text
    8 => Cell::Str(latin1(b)),
    // FLOAT DOUBLE
    4 | 5 => Cell::Num(parse_float(b)),
    // NULL
    6 => Cell::Null,
    // DECIMAL NEWDECIMAL DATE DATETIME TIMESTAMP TIME (NEWDATE never reaches a client)
    0 | 246 | 10 | 12 | 7 | 11 => Cell::Str(ascii(b)),
    // JSON
    245 => Cell::Str(String::from_utf8_lossy(b).into_owned()),
    _ if f.charset == BINARY_CHARSET => hex(b),
    _ => Cell::Str(String::from_utf8_lossy(b).into_owned()),
  }
}

fn parse_int_no_big_check(b: &[u8]) -> f64 {
  if b.is_empty() {
    return 0.0;
  }
  let mut i = 0;
  let mut sign = 1.0;
  if b[0] == b'-' {
    i += 1;
    sign = -1.0;
  }
  if b.get(i) == Some(&b'+') {
    i += 1;
  }
  let mut r = 0.0f64;
  while i < b.len() {
    r *= 10.0;
    r += (b[i] as f64) - 48.0;
    i += 1;
  }
  r * sign
}

// mysql2 Packet.parseFloat: short texts are accumulated digit by digit.
fn parse_float(b: &[u8]) -> f64 {
  if b.is_empty() {
    return 0.0;
  }
  if b.len() > 17 || b.iter().any(|&c| c == b'e' || c == b'E') {
    return super::js::parse_float(&String::from_utf8_lossy(b));
  }
  let mut i = 0;
  let mut factor = 1.0f64;
  let mut past_dot = false;
  if b[0] == b'-' {
    i += 1;
    factor = -1.0;
  }
  if b.get(i) == Some(&b'+') {
    i += 1;
  }
  let mut r = 0.0f64;
  while i < b.len() {
    if b[i] == b'.' {
      past_dot = true;
    } else {
      r *= 10.0;
      r += (b[i] as f64) - 48.0;
      if past_dot {
        factor *= 10.0;
      }
    }
    i += 1;
  }
  r / factor
}

pub fn type_name(f: &Field) -> String {
  if f.flags & 256 != 0 {
    return "enum".into();
  }
  if f.flags & 2048 != 0 {
    return "set".into();
  }
  let mut t = match f.column_type {
    0 | 246 => "decimal",
    1 => "tinyint",
    2 => "smallint",
    3 => "int",
    9 => "mediumint",
    8 => "bigint",
    4 => "float",
    5 => "double",
    7 => "timestamp",
    10 | 14 => "date",
    11 => "time",
    12 => "datetime",
    13 => "year",
    15 | 253 => "varchar",
    254 => "char",
    16 => "bit",
    245 => "json",
    247 => "enum",
    248 => "set",
    249..=252 => "blob",
    255 => "geometry",
    6 => "null",
    242 => "vector",
    _ => "",
  }
  .to_string();
  let bin = f.charset == BINARY_CHARSET;
  if t == "blob" && !bin {
    t = "text".into();
  } else if t == "varchar" && bin {
    t = "varbinary".into();
  } else if t == "char" && bin {
    t = "binary".into();
  }
  if f.flags & 32 != 0 && ["int", "decimal", "float", "double"].iter().any(|x| t.contains(x)) {
    t += " unsigned";
  }
  t
}

#[cfg(test)]
mod tests {
  use super::*;
  #[test]
  fn formats_like_sql_escaper() {
    assert_eq!(format("select ? , '?', `?`, ??", &[Param::Str("a'b\n".into()), Param::Str("t.c".into())]), "select 'a\\'b\\n' , '?', `?`, `t`.`c`");
    assert_eq!(format("kill query ?", &[Param::Num(42.0)]), "kill query 42");
    assert_eq!(format("x = ?", &[Param::Null]), "x = NULL");
    assert_eq!(parse_float(b"1.1"), 1.1);
    assert_eq!(parse_float(b"-0.5"), -0.5);
    assert_eq!(parse_int_no_big_check(b"-12"), -12.0);
  }
}
