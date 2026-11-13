// PostgreSQL driver (src/main/db/pg.ts). One pool per (connection, database)
// of at most 4 connections; idle ones close after 5 minutes so an unused pool
// holds no sockets. Reads go through a cursor and stop at limit+1 rows, so
// `select * from big_table` never lands in memory. A manual-commit console tab
// owns one dedicated connection (a session) whose transaction spans runs.

use super::pgwire::{Field, PgConn, PgResult, Row};
use super::sqltext::{self, quote_ident};
use super::{err, js, Cell, Cfg, Column, DbErr, Exec, Kind, QueryResult, R};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::Duration;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

const POOL_MAX: usize = 4;
const CONNECT_MS: u64 = 10_000;
const DDL_LOCK_TIMEOUT_MS: u64 = 10_000;

// ---- values ------------------------------------------------------------------------

// Only types that map losslessly to JS stay parsed; everything else (int8,
// numeric, dates, json, arrays, bytea) is the server's text.
pub fn cell(type_oid: u32, v: &Option<Vec<u8>>) -> Cell {
  let Some(b) = v else { return Cell::Null };
  let s = String::from_utf8_lossy(b);
  match type_oid {
    16 => Cell::Bool(s == "t"),
    21 | 23 | 26 | 700 | 701 => {
      let n = js::number(&s);
      if n.is_finite() {
        Cell::Num(n)
      } else {
        Cell::Str(s.into_owned())
      }
    }
    _ => Cell::Str(s.into_owned()),
  }
}

pub fn cells(fields: &[Field], r: &Row) -> Vec<Cell> {
  r.iter().enumerate().map(|(i, v)| cell(fields.get(i).map(|f| f.type_oid).unwrap_or(25), v)).collect()
}

fn rows_of(r: &PgResult) -> Vec<Vec<Cell>> {
  r.rows.iter().map(|x| cells(&r.fields, x)).collect()
}

fn type_name(oid: u32) -> Option<&'static str> {
  Some(match oid {
    16 => "boolean",
    17 => "bytea",
    18 => "char",
    19 => "name",
    20 => "bigint",
    21 => "smallint",
    23 => "integer",
    25 => "text",
    26 => "oid",
    114 => "json",
    700 => "real",
    701 => "double precision",
    1042 => "character",
    1043 => "character varying",
    1082 => "date",
    1083 => "time",
    1114 => "timestamp",
    1184 => "timestamptz",
    1186 => "interval",
    1700 => "numeric",
    2950 => "uuid",
    3802 => "jsonb",
    _ => return None,
  })
}

// ---- pools -------------------------------------------------------------------------

struct Idle {
  conn: PgConn,
  id: u64,
}

pub struct Pool {
  key: String,
  cfg: Cfg,
  db: String,
  sem: Arc<Semaphore>,
  idle: Mutex<Vec<Idle>>,
  type_names: Mutex<HashMap<u32, String>>,
  closed: AtomicBool,
}

fn pools() -> MutexGuard<'static, HashMap<String, Arc<Pool>>> {
  static P: OnceLock<Mutex<HashMap<String, Arc<Pool>>>> = OnceLock::new();
  P.get_or_init(Default::default).lock().unwrap_or_else(|e| e.into_inner())
}

// queryId -> (pool key, backend pid), for cancel.
fn running() -> MutexGuard<'static, HashMap<String, (String, i32)>> {
  static R: OnceLock<Mutex<HashMap<String, (String, i32)>>> = OnceLock::new();
  R.get_or_init(Default::default).lock().unwrap_or_else(|e| e.into_inner())
}

fn next_id() -> u64 {
  static N: AtomicU64 = AtomicU64::new(1);
  N.fetch_add(1, Ordering::Relaxed)
}

pub fn db_of(cfg: &Cfg, database: Option<&str>) -> String {
  match database.filter(|d| !d.is_empty()) {
    Some(d) => d.to_string(),
    None if !cfg.database.is_empty() => cfg.database.clone(),
    None => "postgres".into(),
  }
}

fn entry(cfg: &Cfg, database: Option<&str>) -> Arc<Pool> {
  let db = db_of(cfg, database);
  let key = format!("{}::{db}", cfg.id);
  pools()
    .entry(key.clone())
    .or_insert_with(|| {
      Arc::new(Pool {
        key,
        cfg: cfg.clone(),
        db,
        sem: Arc::new(Semaphore::new(POOL_MAX)),
        idle: Mutex::new(vec![]),
        type_names: Mutex::new(HashMap::new()),
        closed: AtomicBool::new(false),
      })
    })
    .clone()
}

/// A pooled connection on loan.
pub struct Lease {
  conn: Option<PgConn>,
  pool: Arc<Pool>,
  _permit: OwnedSemaphorePermit,
}

impl Lease {
  pub fn c(&mut self) -> &mut PgConn {
    self.conn.as_mut().expect("lease")
  }
  /// client.release(): back to the pool, unless it broke.
  pub fn release(mut self) {
    let Some(conn) = self.conn.take() else { return };
    if conn.broken || self.pool.closed.load(Ordering::SeqCst) {
      super::runtime().spawn(conn.terminate());
      return;
    }
    let id = next_id();
    self.pool.idle.lock().unwrap().push(Idle { conn, id });
    let weak = Arc::downgrade(&self.pool);
    super::runtime().spawn(async move {
      tokio::time::sleep(Duration::from_millis(super::POOL_IDLE_MS)).await;
      let Some(p) = weak.upgrade() else { return };
      let gone = {
        let mut idle = p.idle.lock().unwrap();
        idle.iter().position(|x| x.id == id).map(|i| idle.remove(i))
      };
      if let Some(x) = gone {
        x.conn.terminate().await;
      }
    });
  }
  /// client.release(true): close it instead.
  pub fn destroy(mut self) {
    if let Some(conn) = self.conn.take() {
      super::runtime().spawn(conn.terminate());
    }
  }
}

impl Drop for Lease {
  fn drop(&mut self) {
    if let Some(conn) = self.conn.take() {
      super::runtime().spawn(conn.terminate());
    }
  }
}

async fn connect_client(cfg: &Cfg, db: &str, password: Option<String>, setup: bool) -> R<PgConn> {
  let o = super::pgwire::opts(cfg, db, password);
  let mut c = PgConn::connect(&o, Duration::from_millis(CONNECT_MS), "Connection terminated due to connection timeout").await?;
  if setup {
    on_connect(cfg, &mut c).await;
  }
  Ok(c)
}

// Session setup the connection asks for (time zone, startup script), run
// ahead of the first query on a fresh client; failures are ignored.
async fn on_connect(cfg: &Cfg, c: &mut PgConn) {
  let tz = cfg.time_zone.as_deref().map(js::trim).unwrap_or("");
  let script = cfg.startup_script.as_deref().map(js::trim).unwrap_or("");
  if !tz.is_empty() {
    let _ = c.simple(&format!("set time zone '{}'", tz.replace('\'', "''"))).await;
  }
  if !script.is_empty() {
    for s in sqltext::statements(script, Kind::Postgres) {
      let _ = c.simple(&s).await;
    }
  }
}

async fn acquire(p: &Arc<Pool>) -> R<Lease> {
  let permit = match tokio::time::timeout(Duration::from_millis(CONNECT_MS), p.sem.clone().acquire_owned()).await {
    Ok(Ok(x)) => x,
    _ => return err("timeout exceeded when trying to connect"),
  };
  let reuse = p.idle.lock().unwrap().pop();
  let conn = match reuse {
    Some(x) => x.conn,
    None => connect_client(&p.cfg, &p.db, None, true).await?,
  };
  Ok(Lease { conn: Some(conn), pool: p.clone(), _permit: permit })
}

async fn end_pool(p: Arc<Pool>) {
  p.closed.store(true, Ordering::SeqCst);
  let idle: Vec<Idle> = std::mem::take(&mut *p.idle.lock().unwrap());
  for x in idle {
    x.conn.terminate().await;
  }
}

/// Close every pool and session of a connection (its config changed or it was deleted).
pub async fn close_connection(id: &str) {
  let prefix = format!("{id}::");
  let gone: Vec<Arc<Pool>> = {
    let mut ps = pools();
    let keys: Vec<String> = ps.keys().filter(|k| k.starts_with(&prefix)).cloned().collect();
    keys.iter().filter_map(|k| ps.remove(k)).collect()
  };
  for p in gone {
    end_pool(p).await;
  }
  let sids: Vec<String> = sessions().iter().filter(|(_, s)| s.key.starts_with(&prefix)).map(|(k, _)| k.clone()).collect();
  for sid in sids {
    drop_session(&sid, None).await;
  }
}

/// Close a connection's pool and sessions on one database (before dropping or renaming it).
pub async fn close_database(id: &str, db: &str) {
  let key = format!("{id}::{db}");
  let p = pools().remove(&key);
  if let Some(p) = p {
    end_pool(p).await;
  }
  let sids: Vec<String> = sessions().iter().filter(|(_, s)| s.key == key).map(|(k, _)| k.clone()).collect();
  for sid in sids {
    drop_session(&sid, None).await;
  }
}

pub async fn close_all() {
  let all: Vec<Arc<Pool>> = pools().drain().map(|(_, p)| p).collect();
  for p in all {
    end_pool(p).await;
  }
  let sids: Vec<String> = sessions().keys().cloned().collect();
  for sid in sids {
    drop_session(&sid, None).await;
  }
}

/// A metadata query (rows as arrays). Like pg-pool's query(): a failed one
/// closes its connection.
pub async fn rows(cfg: &Cfg, database: Option<&str>, sql: &str, params: &[Option<String>]) -> R<Vec<Vec<Cell>>> {
  let p = entry(cfg, database);
  let mut l = acquire(&p).await?;
  match l.c().query(sql, params).await {
    Ok(r) => {
      l.release();
      Ok(rows_of(&r))
    }
    Err(e) => {
      l.destroy();
      Err(e)
    }
  }
}

pub fn params(v: &[serde_json::Value]) -> Vec<Option<String>> {
  v.iter().map(js::pg_param).collect()
}

/// pgRows with string parameters.
pub async fn rows_s(cfg: &Cfg, database: Option<&str>, sql: &str, ps: &[&str]) -> R<Vec<Vec<Cell>>> {
  let p: Vec<Option<String>> = ps.iter().map(|s| Some(s.to_string())).collect();
  rows(cfg, database, sql, &p).await
}

async fn column_types(p: &Pool, c: &mut PgConn, oids: &[u32]) {
  let mut missing: Vec<u32> = vec![];
  for o in oids {
    if !missing.contains(o) && type_name(*o).is_none() && !p.type_names.lock().unwrap().contains_key(o) {
      missing.push(*o);
    }
  }
  if missing.is_empty() {
    return;
  }
  let arr = serde_json::Value::Array(missing.iter().map(|o| serde_json::Value::from(*o)).collect());
  // Names are cosmetic; an aborted transaction just leaves them blank.
  if let Ok(r) = c.query("select oid::int, format_type(oid, null) from pg_type where oid = any($1)", &[js::pg_param(&arr)]).await {
    for row in rows_of(&r) {
      if let (Some(o), Some(n)) = (row.first(), row.get(1)) {
        p.type_names.lock().unwrap().insert(o.number() as u32, n.s());
      }
    }
  }
}

fn columns_of(p: &Pool, fields: &[Field]) -> Vec<Column> {
  let names = p.type_names.lock().unwrap();
  fields
    .iter()
    .map(|f| Column {
      name: f.name.clone(),
      ty: type_name(f.type_oid).map(str::to_string).or_else(|| names.get(&f.type_oid).cloned()).unwrap_or_default(),
      table: (f.table != 0).then_some(f.table),
      attnum: (f.table != 0).then_some(f.column as i64),
    })
    .collect()
}

async fn cursor_query(p: &Pool, c: &mut PgConn, sql: &str, limit: usize, started: f64) -> R<QueryResult> {
  let n = (limit + 1).min(i32::MAX as usize) as i32;
  let res = c.cursor_open(sql, n).await;
  let res = match res {
    Ok(r) => {
      if !r.done {
        let _ = c.cursor_close().await;
      }
      r
    }
    Err(e) => return Err(e),
  };
  let fields = res.fields.clone().unwrap_or_default();
  column_types(p, c, &fields.iter().map(|f| f.type_oid).collect::<Vec<_>>()).await;
  let columns = columns_of(p, &fields);
  let truncated = res.rows.len() > limit;
  let rows: Vec<Vec<Cell>> = res.rows.iter().take(limit).map(|r| cells(&fields, r)).collect();
  Ok(QueryResult {
    columns,
    rows,
    truncated,
    row_count: if fields.is_empty() { res.result.row_count } else { None },
    command: res.result.command.clone().unwrap_or_default(),
    time_ms: js::now_ms() - started,
  })
}

pub struct QOpts<'a> {
  pub limit: usize,
  pub read_only: bool,
  pub timeout_ms: Option<f64>,
  pub query_id: Option<&'a str>,
}

/// One statement through a cursor; stops after `limit` rows.
pub async fn query(cfg: &Cfg, database: Option<&str>, sql: &str, o: &QOpts<'_>) -> R<QueryResult> {
  let p = entry(cfg, database);
  let started = js::now_ms();
  let mut l = acquire(&p).await?;
  if let Some(q) = o.query_id {
    running().insert(q.to_string(), (p.key.clone(), l.c().pid));
  }
  let r = async {
    if o.read_only {
      l.c().simple("begin read only").await?;
    }
    if let Some(t) = o.timeout_ms.filter(|t| *t != 0.0) {
      l.c().simple(&format!("set {}statement_timeout = {}", if o.read_only { "local " } else { "" }, js::num_str(t.floor()))).await?;
    }
    cursor_query(&p, l.c(), sql, o.limit, started).await
  }
  .await;
  if let Some(q) = o.query_id {
    running().remove(q);
  }
  let after = async {
    if o.read_only {
      l.c().simple("rollback").await?;
    } else if o.timeout_ms.is_some_and(|t| t != 0.0) {
      l.c().simple("set statement_timeout = default").await?;
    }
    Ok::<_, DbErr>(())
  }
  .await;
  match after {
    Ok(()) => l.release(),
    Err(_) => l.destroy(),
  }
  r
}

/// A read in batches (export): at most `max` rows, never all in memory.
pub async fn stream<F, Fut>(cfg: &Cfg, database: Option<&str>, sql: &str, query_id: Option<&str>, max: usize, batch: usize, mut on_rows: F) -> R<usize>
where
  F: FnMut(Vec<Vec<Cell>>) -> Fut,
  Fut: std::future::Future<Output = R<()>>,
{
  let p = entry(cfg, database);
  let mut l = acquire(&p).await?;
  if let Some(q) = query_id {
    running().insert(q.to_string(), (p.key.clone(), l.c().pid));
  }
  let mut n = 0usize;
  let r = async {
    l.c().simple("begin read only").await?;
    let mut fields: Vec<Field> = vec![];
    let mut done = false;
    let mut opened = false;
    let res = async {
      while n < max {
        let want = batch.min(max - n) as i32;
        if done {
          break;
        }
        let rd = if opened { l.c().cursor_next(want).await? } else { l.c().cursor_open(sql, want).await? };
        opened = true;
        if let Some(f) = rd.fields {
          fields = f;
        }
        done = rd.done;
        if rd.rows.is_empty() {
          break;
        }
        n += rd.rows.len();
        on_rows(rd.rows.iter().map(|r| cells(&fields, r)).collect()).await?;
      }
      Ok::<_, DbErr>(())
    }
    .await;
    if opened && !done && !l.c().broken {
      let _ = l.c().cursor_close().await;
    }
    res
  }
  .await;
  if let Some(q) = query_id {
    running().remove(q);
  }
  match l.c().simple("rollback").await {
    Ok(_) => l.release(),
    Err(_) => l.destroy(),
  }
  r.map(|_| n)
}

/// Statements in one transaction; all or nothing.
pub async fn execute(cfg: &Cfg, database: Option<&str>, stmts: &[String], timeout_ms: f64) -> R<Vec<Exec>> {
  let p = entry(cfg, database);
  let mut l = acquire(&p).await?;
  let r = async {
    l.c().simple("begin").await?;
    l.c().simple(&format!("set local statement_timeout = {}", js::num_str(timeout_ms.floor()))).await?;
    let mut out = vec![];
    for s in stmts {
      let mut rs = l.c().simple(s).await?;
      out.push(if rs.len() == 1 {
        let r = rs.pop().unwrap_or_default();
        Exec { command: Some(r.command.unwrap_or_default()), row_count: r.row_count }
      } else {
        Exec { command: None, row_count: None }
      });
    }
    l.c().simple("commit").await?;
    Ok::<_, DbErr>(out)
  }
  .await;
  if r.is_err() {
    let _ = l.c().simple("rollback").await;
  }
  l.release();
  r
}

/// Designer / object-action DDL. Atomic plans run in one transaction; the rest
/// one by one outside a transaction, stopping at the first error.
pub async fn ddl(cfg: &Cfg, database: Option<&str>, stmts: &[String], atomic: bool, timeout_ms: f64, search_path: Option<&str>) -> R<usize> {
  let p = entry(cfg, database);
  let mut l = acquire(&p).await?;
  if atomic {
    let r = async {
      l.c().simple("begin").await?;
      l.c().simple(&format!("set local statement_timeout = {}", js::num_str(timeout_ms.floor()))).await?;
      l.c().simple(&format!("set local lock_timeout = {DDL_LOCK_TIMEOUT_MS}")).await?;
      if let Some(sp) = search_path {
        l.c().extended("select set_config('search_path', $1, true)", &[Some(quote_ident(Kind::Postgres, sp))]).await?;
        l.c().simple("set local check_function_bodies = off").await?;
      }
      for s in stmts {
        l.c().simple(s).await?;
      }
      l.c().simple("commit").await?;
      Ok::<_, DbErr>(stmts.len())
    }
    .await;
    if r.is_err() {
      let _ = l.c().simple("rollback").await;
    }
    l.release();
    return r;
  }
  let r = async {
    l.c().simple(&format!("set statement_timeout = {}", js::num_str(timeout_ms.floor()))).await?;
    let mut n = 0;
    for s in stmts {
      l.c().simple(s).await?;
      n += 1;
    }
    Ok::<_, DbErr>(n)
  }
  .await;
  let _ = l.c().simple("reset statement_timeout").await;
  l.release();
  r
}

// ---- sessions ------------------------------------------------------------------------

pub struct Session {
  key: String,
  pool: Arc<Pool>,
  conn: tokio::sync::Mutex<Option<PgConn>>,
  dead: AtomicBool,
  /// The connection's transaction status, readable while a call runs.
  tx: AtomicU8,
  gen: AtomicU64,
}

fn sessions() -> MutexGuard<'static, HashMap<String, Arc<Session>>> {
  static S: OnceLock<Mutex<HashMap<String, Arc<Session>>>> = OnceLock::new();
  S.get_or_init(Default::default).lock().unwrap_or_else(|e| e.into_inner())
}

fn tx_name(t: u8) -> &'static str {
  match t {
    b'T' => "active",
    b'E' => "failed",
    _ => "idle",
  }
}

async fn drop_session(id: &str, only: Option<&Arc<Session>>) {
  let s = {
    let mut m = sessions();
    match m.get(id) {
      Some(s) if only.is_none_or(|o| Arc::ptr_eq(o, s)) => m.remove(id),
      _ => None,
    }
  };
  let Some(s) = s else { return };
  s.dead.store(true, Ordering::SeqCst);
  // A call in flight keeps the lock; the connection ends when it is done.
  let s2 = s.clone();
  super::runtime().spawn(async move {
    if let Some(c) = s2.conn.lock().await.take() {
      c.terminate().await;
    }
  });
}

pub fn has_session(id: &str) -> bool {
  sessions().contains_key(id)
}

fn arm_idle(id: &str, s: &Arc<Session>) {
  let g = s.gen.fetch_add(1, Ordering::SeqCst) + 1;
  let (id, s) = (id.to_string(), s.clone());
  super::runtime().spawn(async move {
    tokio::time::sleep(Duration::from_millis(super::SESSION_IDLE_MS)).await;
    if s.gen.load(Ordering::SeqCst) == g && !s.dead.load(Ordering::SeqCst) && s.tx.load(Ordering::SeqCst) == b'I' {
      drop_session(&id, Some(&s)).await;
    }
  });
}

/// Run `f` on the session's connection, one call at a time.
async fn on_session<T, F>(id: &str, s: &Arc<Session>, cfg: Option<&Cfg>, f: F) -> R<T>
where
  F: for<'c> FnOnce(&'c mut PgConn, &'c Pool) -> std::pin::Pin<Box<dyn std::future::Future<Output = R<T>> + Send + 'c>>,
{
  let mut slot = s.conn.lock().await;
  if s.dead.load(Ordering::SeqCst) {
    return err("The session was closed");
  }
  if slot.is_none() {
    let Some(cfg) = cfg else { return err("The session was closed") };
    match connect_client(cfg, &s.pool.db, None, true).await {
      Ok(c) => *slot = Some(c),
      Err(e) => {
        drop(slot);
        drop_session(id, Some(s)).await;
        return Err(e);
      }
    }
  }
  let c = slot.as_mut().expect("session conn");
  let r = f(c, &s.pool).await;
  s.tx.store(c.tx, Ordering::SeqCst);
  let broken = c.broken;
  drop(slot);
  if broken {
    // The server or network dropped it: the transaction is gone either way.
    drop_session(id, Some(s)).await;
  } else if !s.dead.load(Ordering::SeqCst) {
    arm_idle(id, s);
  }
  r
}

fn with_session(cfg: &Cfg, database: Option<&str>, id: &str) -> R<Arc<Session>> {
  let db = db_of(cfg, database);
  let key = format!("{}::{db}", cfg.id);
  let mut m = sessions();
  if let Some(s) = m.get(id) {
    if s.key == key {
      return Ok(s.clone());
    }
    if s.tx.load(Ordering::SeqCst) != b'I' {
      return err("Commit or roll back the open transaction before switching connection or database");
    }
    let old = m.remove(id).expect("session");
    old.dead.store(true, Ordering::SeqCst);
    super::runtime().spawn(async move {
      if let Some(c) = old.conn.lock().await.take() {
        c.terminate().await;
      }
    });
  }
  let s = Arc::new(Session {
    key,
    pool: entry(cfg, database),
    conn: tokio::sync::Mutex::new(None),
    dead: AtomicBool::new(false),
    tx: AtomicU8::new(b'I'),
    gen: AtomicU64::new(0),
  });
  m.insert(id.to_string(), s.clone());
  Ok(s)
}

pub struct SOpts<'a> {
  pub limit: usize,
  pub query_id: Option<&'a str>,
  pub aux: bool,
}

/// One statement on a session. A user statement opens a transaction when none
/// is open and runs under a savepoint, so a failing statement is undone alone.
/// `aux` (paging, counts) only joins a transaction already open.
pub async fn session_query(cfg: &Cfg, database: Option<&str>, id: &str, sql: &str, o: &SOpts<'_>) -> R<QueryResult> {
  let s = with_session(cfg, database, id)?;
  let (sql, limit, aux, qid, key) = (sql.to_string(), o.limit, o.aux, o.query_id.map(str::to_string), s.key.clone());
  on_session(id, &s, Some(cfg), move |c, pool| {
    Box::pin(async move {
      let started = js::now_ms();
      let control = sqltext::is_tx_control(&sql, false);
      let mut tx = c.tx;
      if aux && tx == b'E' {
        return err("The transaction failed; roll it back first");
      }
      let mut began = false;
      if !aux && !control && tx == b'I' {
        c.simple("begin").await?;
        began = true;
        tx = b'T';
      }
      let guard = !control && tx == b'T';
      if let Some(q) = &qid {
        running().insert(q.clone(), (key.clone(), c.pid));
      }
      let r = async {
        if guard {
          c.simple("savepoint riven_stmt").await?;
        }
        let r = cursor_query(pool, c, &sql, limit, started).await?;
        if guard {
          c.simple("release savepoint riven_stmt").await?;
        }
        Ok::<_, DbErr>(r)
      }
      .await;
      if r.is_err() {
        if began {
          let _ = c.simple("rollback").await;
        } else if guard {
          let _ = c.simple("rollback to savepoint riven_stmt").await;
        }
      }
      if let Some(q) = &qid {
        running().remove(q);
      }
      r
    })
  })
  .await
}

pub async fn session_status(id: &str) -> &'static str {
  let Some(s) = sessions().get(id).cloned() else { return "none" };
  match on_session(id, &s, None, |c, _| Box::pin(async move { Ok(tx_name(c.tx)) })).await {
    Ok(t) => t,
    Err(_) => "none",
  }
}

pub async fn session_end(id: &str, action: &str) -> R<&'static str> {
  let Some(s) = sessions().get(id).cloned() else { return err("No open transaction (the session was closed)") };
  let action = action.to_string();
  on_session(id, &s, None, move |c, _| {
    Box::pin(async move {
      c.simple(&action).await?;
      Ok(tx_name(c.tx))
    })
  })
  .await
}

/// Disconnect a session; whatever it had open is rolled back by the server.
pub async fn session_close(id: &str) {
  drop_session(id, None).await;
}

// ---- grid edits ------------------------------------------------------------------------

pub struct EditStmt {
  pub text: String,
  pub values: Vec<Option<String>>,
}

async fn apply_on(c: &mut PgConn, stmts: &[EditStmt]) -> R<Vec<Option<Vec<Cell>>>> {
  let mut out = vec![];
  for st in stmts {
    let r = c.query(&st.text, &st.values).await?;
    if r.row_count != Some(1.0) {
      let verb = st.text.split(' ').next().unwrap_or("");
      let verb = if st.text.contains(' ') { verb } else { &st.text[..st.text.len().saturating_sub(1)] };
      return err(format!("{verb} matched {} rows instead of 1; nothing was applied", js::num_str(r.row_count.unwrap_or(0.0))));
    }
    out.push(r.rows.first().map(|row| cells(&r.fields, row)));
  }
  Ok(out)
}

/// Grid edits, all or nothing, each required to touch exactly one row.
pub async fn apply(cfg: &Cfg, database: Option<&str>, session: Option<&str>, stmts: Vec<EditStmt>) -> R<Vec<Option<Vec<Cell>>>> {
  if let Some(sid) = session {
    let s = with_session(cfg, database, sid)?;
    return on_session(sid, &s, Some(cfg), move |c, _| {
      Box::pin(async move {
        if c.tx == b'E' {
          return err("The transaction failed; roll it back first");
        }
        let began = c.tx == b'I';
        if began {
          c.simple("begin").await?;
        }
        c.simple("savepoint riven_apply").await?;
        match apply_on(c, &stmts).await {
          Ok(out) => {
            c.simple("release savepoint riven_apply").await?;
            Ok(out)
          }
          Err(e) => {
            let _ = c.simple(if began { "rollback" } else { "rollback to savepoint riven_apply" }).await;
            Err(e)
          }
        }
      })
    })
    .await;
  }
  let p = entry(cfg, database);
  let mut l = acquire(&p).await?;
  let r = async {
    l.c().simple("begin").await?;
    let out = apply_on(l.c(), &stmts).await?;
    l.c().simple("commit").await?;
    Ok::<_, DbErr>(out)
  }
  .await;
  if r.is_err() {
    let _ = l.c().simple("rollback").await;
  }
  l.release();
  r
}

/// Catalog reads in one read-only transaction with `search_path` alone on the
/// search path, so references in it print unqualified (schema diff).
pub async fn read_in(cfg: &Cfg, database: Option<&str>, search_path: &str, sqls: &[(&str, Vec<Option<String>>)]) -> R<Vec<Vec<Vec<Cell>>>> {
  let p = entry(cfg, database);
  let mut l = acquire(&p).await?;
  let r = async {
    l.c().simple("begin read only").await?;
    l.c().extended("select set_config('search_path', $1, true)", &[Some(quote_ident(Kind::Postgres, search_path))]).await?;
    let mut out = vec![];
    for (sql, ps) in sqls {
      let r = l.c().query(sql, ps).await?;
      out.push(rows_of(&r));
    }
    Ok::<_, DbErr>(out)
  }
  .await;
  let _ = l.c().simple("rollback").await;
  l.release();
  r
}

/// A write transaction on its own pooled client (bulk import): commit when
/// `work` succeeds, roll back when it fails. Cancellable by queryId.
pub async fn transaction<T, F>(cfg: &Cfg, database: Option<&str>, query_id: Option<&str>, work: F) -> R<T>
where
  F: for<'c> FnOnce(&'c mut PgConn) -> std::pin::Pin<Box<dyn std::future::Future<Output = R<T>> + Send + 'c>>,
{
  let p = entry(cfg, database);
  let mut l = acquire(&p).await?;
  if let Some(q) = query_id {
    running().insert(q.to_string(), (p.key.clone(), l.c().pid));
  }
  let r = async {
    l.c().simple("begin").await?;
    l.c().simple(&format!("set local lock_timeout = {DDL_LOCK_TIMEOUT_MS}")).await?;
    let out = work(l.c()).await?;
    l.c().simple("commit").await?;
    Ok::<_, DbErr>(out)
  }
  .await;
  if let Some(q) = query_id {
    running().remove(q);
  }
  if r.is_err() {
    let _ = l.c().simple("rollback").await;
  }
  l.release();
  r
}

/// Ask the server to cancel a running query (from a separate connection).
pub async fn cancel(cfg: &Cfg, query_id: &str) -> R<bool> {
  let Some((key, pid)) = running().get(query_id).cloned() else { return Ok(false) };
  let db = key.split_once("::").map(|(_, d)| d.to_string()).unwrap_or_default();
  let mut c = connect_client(cfg, &db, None, false).await?;
  let r = c.extended("select pg_cancel_backend($1)", &[Some(pid.to_string())]).await;
  c.terminate().await;
  let r = r?;
  Ok(rows_of(&r).first().and_then(|x| x.first()).is_some_and(|v| v.is_true()))
}

/// Connect once and report the server version (the "test connection" button).
pub async fn test(cfg: &Cfg, password: Option<String>) -> R<String> {
  let mut c = connect_client(cfg, "", password, false).await?;
  let r = c.simple("show server_version").await;
  c.terminate().await;
  let mut r = r?;
  let v = r.pop().map(|x| rows_of(&x)).and_then(|x| x.into_iter().next()).and_then(|x| x.into_iter().next()).map(|c| c.s()).unwrap_or_default();
  Ok(format!("PostgreSQL {v}").trim().to_string())
}

