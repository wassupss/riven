// The PostgreSQL frontend/backend protocol, as much as riven uses, the way
// node-pg and pg-cursor use it: text results only, startup parameters user,
// database, application_name, options and client_encoding=UTF8 (pg-protocol
// always adds it, so a SQL_ASCII/LATIN1 server still sends UTF-8), SCRAM-SHA-256,
// md5 and cleartext passwords, SSL modes require / verify-ca / verify-full.
// A connection answers one call at a time (callers hold it exclusively).

use super::{expand_home, Cfg, DbErr, R};
use bytes::{Buf, BufMut, BytesMut};
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpStream;

pub trait Io: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Io for T {}

#[derive(Clone, Debug)]
pub struct Field {
  pub name: String,
  pub table: u32,
  pub column: i16,
  pub type_oid: u32,
}

pub type Row = Vec<Option<Vec<u8>>>;

/// One statement's result (node-pg's Result: rows, fields, command, rowCount).
#[derive(Default, Debug)]
pub struct PgResult {
  pub fields: Vec<Field>,
  pub rows: Vec<Row>,
  pub command: Option<String>,
  pub row_count: Option<f64>,
}

impl PgResult {
  // Result.addCommandComplete: /^([A-Za-z]+)(?: (\d+))?(?: (\d+))?/
  fn complete(&mut self, tag: &str) {
    let word: String = tag.chars().take_while(|c| c.is_ascii_alphabetic()).collect();
    if word.is_empty() {
      return;
    }
    let mut rest = &tag[word.len()..];
    let mut nums = vec![];
    for _ in 0..2 {
      let Some(r) = rest.strip_prefix(' ') else { break };
      let d: String = r.chars().take_while(|c| c.is_ascii_digit()).collect();
      if d.is_empty() {
        break;
      }
      rest = &r[d.len()..];
      nums.push(d);
    }
    self.command = Some(word);
    if nums.len() == 2 {
      self.row_count = Some(super::js::number(&nums[1]));
    } else if nums.len() == 1 {
      self.row_count = Some(super::js::number(&nums[0]));
    }
  }
}

pub struct PgConn {
  io: Box<dyn Io>,
  buf: BytesMut,
  pub pid: i32,
  /// ReadyForQuery status: b'I' idle, b'T' in a transaction, b'E' failed one.
  pub tx: u8,
  pub server_version: String,
  pub broken: bool,
}

enum Msg {
  Auth(i32, Vec<u8>),
  KeyData(i32),
  Param(String, String),
  Ready(u8),
  RowDesc(Vec<Field>),
  NoData,
  Data(Row),
  Complete(String),
  Empty,
  Suspended,
  Error(DbErr),
  Other,
}

fn cstr(b: &mut &[u8]) -> String {
  let end = b.iter().position(|&c| c == 0).unwrap_or(b.len());
  let s = String::from_utf8_lossy(&b[..end]).into_owned();
  *b = &b[(end + 1).min(b.len())..];
  s
}

fn error_of(mut body: &[u8]) -> DbErr {
  let mut msg = String::new();
  while !body.is_empty() && body[0] != 0 {
    let code = body[0];
    body = &body[1..];
    let v = cstr(&mut body);
    if code == b'M' {
      msg = v;
    }
  }
  DbErr::new(msg)
}

fn parse(tag: u8, mut b: &[u8]) -> Msg {
  match tag {
    b'R' => {
      let code = b.get_i32();
      Msg::Auth(code, b.to_vec())
    }
    b'K' => Msg::KeyData(b.get_i32()),
    b'S' => {
      let k = cstr(&mut b);
      let v = cstr(&mut b);
      Msg::Param(k, v)
    }
    b'Z' => Msg::Ready(b.first().copied().unwrap_or(b'I')),
    b'T' => {
      let n = b.get_i16().max(0) as usize;
      let mut f = Vec::with_capacity(n);
      for _ in 0..n {
        let name = cstr(&mut b);
        let table = b.get_u32();
        let column = b.get_i16();
        let type_oid = b.get_u32();
        b.advance(2 + 4 + 2);
        f.push(Field { name, table, column, type_oid });
      }
      Msg::RowDesc(f)
    }
    b'n' => Msg::NoData,
    b'D' => {
      let n = b.get_i16().max(0) as usize;
      let mut row = Vec::with_capacity(n);
      for _ in 0..n {
        let len = b.get_i32();
        if len < 0 {
          row.push(None);
        } else {
          let l = (len as usize).min(b.len());
          row.push(Some(b[..l].to_vec()));
          b.advance(l);
        }
      }
      Msg::Data(row)
    }
    b'C' => Msg::Complete(cstr(&mut b)),
    b'I' => Msg::Empty,
    b's' => Msg::Suspended,
    b'E' => Msg::Error(error_of(b)),
    _ => Msg::Other,
  }
}

fn put_msg(out: &mut BytesMut, tag: u8, body: impl FnOnce(&mut BytesMut)) {
  out.put_u8(tag);
  let at = out.len();
  out.put_i32(0);
  body(out);
  let len = (out.len() - at) as i32;
  out[at..at + 4].copy_from_slice(&len.to_be_bytes());
}

fn put_cstr(out: &mut BytesMut, s: &str) {
  out.put_slice(s.as_bytes());
  out.put_u8(0);
}

pub struct Opts {
  pub host: String,
  pub port: u16,
  pub user: String,
  pub password: Option<String>,
  pub database: String,
  pub options: Option<String>,
  pub ssl: Option<super::Ssl>,
}

/// pg.ts clientConfig: what a client to `database` connects with.
pub fn opts(cfg: &Cfg, database: &str, password: Option<String>) -> Opts {
  let mut o = vec![];
  if cfg.read_only {
    o.push("-c default_transaction_read_only=on".to_string());
  }
  if let Some(iso) = cfg.isolation.as_deref().filter(|i| ["read committed", "repeatable read", "serializable"].contains(i)) {
    o.push(format!("-c default_transaction_isolation={}", iso.replacen(' ', "\\ ", 1)));
  }
  Opts {
    host: cfg.host_or_localhost(),
    port: cfg.port_or(5432),
    user: cfg.user.clone(),
    password: password.or_else(|| super::store::password(&cfg.id)),
    database: if database.is_empty() { if cfg.database.is_empty() { "postgres".into() } else { cfg.database.clone() } } else { database.into() },
    options: (!o.is_empty()).then(|| o.join(" ")),
    ssl: cfg.ssl.clone().filter(|s| s.mode != "disable"),
  }
}

/// Node's socket errors read as `connect ECONNREFUSED 127.0.0.1:5432` and so on.
pub fn net_error(e: &std::io::Error, host: &str, port: u16, addr: Option<std::net::SocketAddr>) -> DbErr {
  use std::io::ErrorKind::*;
  let at = addr.map(|a| format!("{}:{}", a.ip(), a.port())).unwrap_or_else(|| format!("{host}:{port}"));
  let m = match e.kind() {
    ConnectionRefused => format!("connect ECONNREFUSED {at}"),
    TimedOut => format!("connect ETIMEDOUT {at}"),
    ConnectionReset => "read ECONNRESET".into(),
    UnexpectedEof => "Connection terminated unexpectedly".into(),
    _ if e.raw_os_error() == Some(libc::EHOSTUNREACH) => format!("connect EHOSTUNREACH {at}"),
    _ if e.raw_os_error() == Some(libc::ENETUNREACH) => format!("connect ENETUNREACH {at}"),
    _ => e.to_string(),
  };
  DbErr::new(m)
}

/// TCP to host:port the way Node's net.connect does for a name: every
/// address in order, the last error wins.
pub async fn tcp(host: &str, port: u16) -> R<TcpStream> {
  let addrs: Vec<std::net::SocketAddr> = match tokio::net::lookup_host((host, port)).await {
    Ok(a) => a.collect(),
    Err(_) => return Err(DbErr::new(format!("getaddrinfo ENOTFOUND {host}"))),
  };
  let mut last = None;
  for a in &addrs {
    match TcpStream::connect(a).await {
      Ok(s) => {
        let _ = s.set_nodelay(true);
        return Ok(s);
      }
      Err(e) => last = Some(net_error(&e, host, port, Some(*a))),
    }
  }
  Err(last.unwrap_or_else(|| DbErr::new(format!("getaddrinfo ENOTFOUND {host}"))))
}

fn read_pem(p: &str) -> R<Vec<u8>> {
  let path = expand_home(p);
  std::fs::read(&path).map_err(|e| DbErr::new(format!("{}, open '{path}'", node_fs_error(&e))))
}

/// "ENOENT: no such file or directory" etc. (Node's fs message head).
pub fn node_fs_error(e: &std::io::Error) -> String {
  match e.raw_os_error() {
    Some(libc::ENOENT) => "ENOENT: no such file or directory".into(),
    Some(libc::EACCES) => "EACCES: permission denied".into(),
    Some(libc::EISDIR) => "EISDIR: illegal operation on a directory".into(),
    _ => e.to_string(),
  }
}

/// TLS over `tcp` for an ssl mode: require (no verification), verify-ca
/// (chain only), verify-full (chain and host name).
pub async fn tls(tcp: TcpStream, host: &str, ssl: &super::Ssl) -> R<Box<dyn Io>> {
  let mut b = native_tls::TlsConnector::builder();
  let (ca, cert, key) = (
    ssl.ca.as_deref().map(read_pem).transpose()?,
    ssl.cert.as_deref().map(read_pem).transpose()?,
    ssl.key.as_deref().map(read_pem).transpose()?,
  );
  if let (Some(c), Some(k)) = (&cert, &key) {
    let id = native_tls::Identity::from_pkcs8(c, k).map_err(|e| DbErr::new(e.to_string()))?;
    b.identity(id);
  }
  match ssl.mode.as_str() {
    "require" => {
      b.danger_accept_invalid_certs(true);
      b.danger_accept_invalid_hostnames(true);
    }
    mode => {
      if let Some(ca) = &ca {
        let c = native_tls::Certificate::from_pem(ca).map_err(|e| DbErr::new(e.to_string()))?;
        b.add_root_certificate(c);
      }
      if mode == "verify-ca" {
        b.danger_accept_invalid_hostnames(true);
      }
    }
  }
  let conn = b.build().map_err(|e| DbErr::new(e.to_string()))?;
  let s = tokio_native_tls::TlsConnector::from(conn).connect(host, tcp).await.map_err(|e| DbErr::new(e.to_string()))?;
  Ok(Box::new(s))
}

impl PgConn {
  pub async fn connect(o: &Opts, timeout: Duration, timeout_msg: &str) -> R<PgConn> {
    match tokio::time::timeout(timeout, Self::connect_now(o)).await {
      Ok(r) => r,
      Err(_) => Err(DbErr::new(timeout_msg)),
    }
  }

  async fn connect_now(o: &Opts) -> R<PgConn> {
    let mut tcp = tcp(&o.host, o.port).await?;
    let io: Box<dyn Io> = match &o.ssl {
      None => Box::new(tcp),
      Some(ssl) => {
        let mut req = BytesMut::new();
        req.put_i32(8);
        req.put_i32(80877103);
        tcp.write_all(&req).await?;
        let mut a = [0u8; 1];
        tcp.read_exact(&mut a).await.map_err(|_| DbErr::new("Connection terminated unexpectedly"))?;
        if a[0] != b'S' {
          return Err(DbErr::new("The server does not support SSL connections"));
        }
        tls(tcp, &o.host, ssl).await?
      }
    };
    let mut c = PgConn { io, buf: BytesMut::with_capacity(16 * 1024), pid: 0, tx: b'I', server_version: String::new(), broken: false };
    let mut m = BytesMut::new();
    let at = m.len();
    m.put_i32(0);
    m.put_i32(196608);
    for (k, v) in [("user", Some(o.user.as_str())), ("database", Some(o.database.as_str())), ("application_name", Some("riven")), ("options", o.options.as_deref())] {
      if let Some(v) = v {
        put_cstr(&mut m, k);
        put_cstr(&mut m, v);
      }
    }
    put_cstr(&mut m, "client_encoding");
    put_cstr(&mut m, "UTF8");
    m.put_u8(0);
    let len = (m.len() - at) as i32;
    m[at..at + 4].copy_from_slice(&len.to_be_bytes());
    c.send(&m).await?;
    let mut scram: Option<postgres_protocol::authentication::sasl::ScramSha256> = None;
    let pw = o.password.clone();
    loop {
      match c.recv().await? {
        Msg::Auth(0, _) => {}
        Msg::Auth(3, _) => {
          let mut out = BytesMut::new();
          put_msg(&mut out, b'p', |b| put_cstr(b, pw.as_deref().unwrap_or("")));
          c.send(&out).await?;
        }
        Msg::Auth(5, salt) => {
          let s: [u8; 4] = salt.get(..4).and_then(|x| x.try_into().ok()).unwrap_or([0; 4]);
          let h = postgres_protocol::authentication::md5_hash(o.user.as_bytes(), pw.as_deref().unwrap_or("").as_bytes(), s);
          let mut out = BytesMut::new();
          put_msg(&mut out, b'p', |b| put_cstr(b, &h));
          c.send(&out).await?;
        }
        Msg::Auth(10, mechs) => {
          let mut b: &[u8] = &mechs;
          let mut names = vec![];
          while !b.is_empty() && b[0] != 0 {
            names.push(cstr(&mut b));
          }
          if !names.iter().any(|n| n == "SCRAM-SHA-256") {
            return Err(DbErr::new("SASL: Only mechanism(s) \"SCRAM-SHA-256\" are supported"));
          }
          let Some(p) = pw.as_deref() else {
            return Err(DbErr::new("SASL: SCRAM-SERVER-FIRST-MESSAGE: client password must be a string"));
          };
          let s = postgres_protocol::authentication::sasl::ScramSha256::new(p.as_bytes(), postgres_protocol::authentication::sasl::ChannelBinding::unsupported());
          let mut out = BytesMut::new();
          let first = s.message().to_vec();
          put_msg(&mut out, b'p', |b| {
            put_cstr(b, "SCRAM-SHA-256");
            b.put_i32(first.len() as i32);
            b.put_slice(&first);
          });
          scram = Some(s);
          c.send(&out).await?;
        }
        Msg::Auth(11, data) => {
          let s = scram.as_mut().ok_or_else(|| DbErr::new("SASL: unexpected continue"))?;
          s.update(&data).map_err(|e| DbErr::new(format!("SASL: {e}")))?;
          let msg = s.message().to_vec();
          let mut out = BytesMut::new();
          put_msg(&mut out, b'p', |b| b.put_slice(&msg));
          c.send(&out).await?;
        }
        Msg::Auth(12, data) => {
          let s = scram.as_mut().ok_or_else(|| DbErr::new("SASL: unexpected final"))?;
          s.finish(&data).map_err(|e| DbErr::new(format!("SASL: {e}")))?;
        }
        Msg::Auth(code, _) => return Err(DbErr::new(format!("Unknown authenticationOk message type {code}"))),
        Msg::KeyData(pid) => c.pid = pid,
        Msg::Ready(t) => {
          c.tx = t;
          return Ok(c);
        }
        Msg::Error(e) => return Err(e),
        _ => {}
      }
    }
  }

  async fn send(&mut self, b: &[u8]) -> R<()> {
    if let Err(e) = self.io.write_all(b).await {
      self.broken = true;
      return Err(e.into());
    }
    Ok(())
  }

  async fn recv(&mut self) -> R<Msg> {
    loop {
      if self.buf.len() >= 5 {
        let len = i32::from_be_bytes([self.buf[1], self.buf[2], self.buf[3], self.buf[4]]) as usize;
        if self.buf.len() > len {
          let tag = self.buf[0];
          let frame = self.buf.split_to(len + 1);
          let m = parse(tag, &frame[5..]);
          match &m {
            Msg::Param(k, v) if k == "server_version" => self.server_version = v.clone(),
            Msg::Ready(t) => self.tx = *t,
            _ => {}
          }
          return Ok(m);
        }
        self.buf.reserve(len + 1 - self.buf.len());
      }
      let n = match self.io.read_buf(&mut self.buf).await {
        Ok(n) => n,
        Err(e) => {
          self.broken = true;
          return Err(net_error(&e, "", 0, None));
        }
      };
      if n == 0 {
        self.broken = true;
        return Err(DbErr::new("Connection terminated unexpectedly"));
      }
    }
  }

  /// Read up to ReadyForQuery, keeping the first error.
  async fn drain(&mut self, mut first: Option<DbErr>) -> R<()> {
    loop {
      match self.recv().await? {
        Msg::Ready(_) => return first.map_or(Ok(()), Err),
        Msg::Error(e) => {
          first.get_or_insert(e);
        }
        _ => {}
      }
    }
  }

  /// A simple-protocol query (node-pg's client.query(text) with no values):
  /// one result per statement.
  pub async fn simple(&mut self, sql: &str) -> R<Vec<PgResult>> {
    let mut out = BytesMut::new();
    put_msg(&mut out, b'Q', |b| put_cstr(b, sql));
    self.send(&out).await?;
    let mut results = vec![];
    let mut cur = PgResult::default();
    let mut err: Option<DbErr> = None;
    loop {
      match self.recv().await? {
        Msg::RowDesc(f) => cur.fields = f,
        Msg::Data(r) => cur.rows.push(r),
        Msg::Complete(tag) => {
          cur.complete(&tag);
          results.push(std::mem::take(&mut cur));
        }
        Msg::Empty => results.push(std::mem::take(&mut cur)),
        Msg::Error(e) => {
          err.get_or_insert(e);
        }
        Msg::Ready(_) => break,
        _ => {}
      }
    }
    match err {
      Some(e) => Err(e),
      None => Ok(results),
    }
  }

  /// One statement with parameters (extended protocol, all text).
  pub async fn extended(&mut self, sql: &str, params: &[Option<String>]) -> R<PgResult> {
    let mut out = BytesMut::new();
    put_msg(&mut out, b'P', |b| {
      put_cstr(b, "");
      put_cstr(b, sql);
      b.put_i16(0);
    });
    put_bind(&mut out, params);
    put_msg(&mut out, b'D', |b| {
      b.put_u8(b'P');
      put_cstr(b, "");
    });
    put_msg(&mut out, b'E', |b| {
      put_cstr(b, "");
      b.put_i32(0);
    });
    put_msg(&mut out, b'S', |_| {});
    self.send(&out).await?;
    let mut cur = PgResult::default();
    let mut err: Option<DbErr> = None;
    loop {
      match self.recv().await? {
        Msg::RowDesc(f) => cur.fields = f,
        Msg::Data(r) => cur.rows.push(r),
        Msg::Complete(tag) => cur.complete(&tag),
        Msg::Error(e) => {
          err.get_or_insert(e);
        }
        Msg::Ready(_) => break,
        _ => {}
      }
    }
    match err {
      Some(e) => Err(e),
      None => Ok(cur),
    }
  }

  /// `client.query(text, values)`: simple protocol without values, extended with.
  pub async fn query(&mut self, sql: &str, params: &[Option<String>]) -> R<PgResult> {
    if params.is_empty() {
      let mut r = self.simple(sql).await?;
      return Ok(match r.len() {
        1 => r.pop().unwrap_or_default(),
        // node-pg resolves an array: no command, no rowCount, no rows.
        _ => PgResult::default(),
      });
    }
    self.extended(sql, params).await
  }

  // ---- cursor (pg-cursor) ----------------------------------------------------------

  /// Open a cursor on `sql` and read its first `n` rows.
  pub async fn cursor_open(&mut self, sql: &str, n: i32) -> R<CursorRead> {
    let mut out = BytesMut::new();
    put_msg(&mut out, b'P', |b| {
      put_cstr(b, "");
      put_cstr(b, sql);
      b.put_i16(0);
    });
    put_bind(&mut out, &[]);
    put_msg(&mut out, b'D', |b| {
      b.put_u8(b'P');
      put_cstr(b, "");
    });
    put_execute(&mut out, n);
    put_msg(&mut out, b'H', |_| {});
    self.send(&out).await?;
    self.cursor_read().await
  }

  /// The next `n` rows of an open cursor.
  pub async fn cursor_next(&mut self, n: i32) -> R<CursorRead> {
    let mut out = BytesMut::new();
    put_execute(&mut out, n);
    put_msg(&mut out, b'H', |_| {});
    self.send(&out).await?;
    self.cursor_read().await
  }

  async fn cursor_read(&mut self) -> R<CursorRead> {
    let mut r = CursorRead::default();
    loop {
      match self.recv().await? {
        Msg::RowDesc(f) => r.fields = Some(f),
        Msg::NoData => r.fields = Some(vec![]),
        Msg::Data(row) => r.rows.push(row),
        Msg::Suspended => return Ok(r),
        Msg::Complete(tag) => {
          r.result.complete(&tag);
          r.done = true;
          let mut out = BytesMut::new();
          put_msg(&mut out, b'S', |_| {});
          self.send(&out).await?;
          self.drain(None).await?;
          return Ok(r);
        }
        Msg::Empty => {
          r.done = true;
          let mut out = BytesMut::new();
          put_msg(&mut out, b'S', |_| {});
          self.send(&out).await?;
          self.drain(None).await?;
          return Ok(r);
        }
        Msg::Error(e) => {
          let mut out = BytesMut::new();
          put_msg(&mut out, b'S', |_| {});
          self.send(&out).await?;
          return Err(self.drain(Some(e)).await.err().unwrap_or_else(|| DbErr::new("")));
        }
        _ => {}
      }
    }
  }

  /// Close a cursor that still has rows.
  pub async fn cursor_close(&mut self) -> R<()> {
    let mut out = BytesMut::new();
    put_msg(&mut out, b'C', |b| {
      b.put_u8(b'P');
      put_cstr(b, "");
    });
    put_msg(&mut out, b'S', |_| {});
    self.send(&out).await?;
    self.drain(None).await
  }

  pub async fn terminate(mut self) {
    let mut out = BytesMut::new();
    put_msg(&mut out, b'X', |_| {});
    let _ = tokio::time::timeout(Duration::from_secs(2), async {
      let _ = self.io.write_all(&out).await;
      let _ = self.io.shutdown().await;
    })
    .await;
  }
}

#[derive(Default)]
pub struct CursorRead {
  /// Set when this read saw the row description (the first one).
  pub fields: Option<Vec<Field>>,
  pub rows: Vec<Row>,
  pub done: bool,
  pub result: PgResult,
}

fn put_bind(out: &mut BytesMut, params: &[Option<String>]) {
  put_msg(out, b'B', |b| {
    put_cstr(b, "");
    put_cstr(b, "");
    b.put_i16(0);
    b.put_i16(params.len() as i16);
    for p in params {
      match p {
        None => b.put_i32(-1),
        Some(s) => {
          b.put_i32(s.len() as i32);
          b.put_slice(s.as_bytes());
        }
      }
    }
    b.put_i16(0);
  });
}

fn put_execute(out: &mut BytesMut, n: i32) {
  put_msg(out, b'E', |b| {
    put_cstr(b, "");
    b.put_i32(n);
  });
}
