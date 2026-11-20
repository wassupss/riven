// MySQL / MariaDB driver (src/main/db/mysql.ts). One pool per (connection,
// database) of at most 4 connections; idle ones close after 5 minutes. Reads
// stream row by row and stop at limit+1, so a big table never lands in memory:
// past the limit a pool connection is closed (the server stops sending), a
// session's is read to the end without keeping rows.

use super::mywire::{self, Field, Header, MyConn, Param, Start};
use super::sqltext::{self, literal};
use super::tableids::{column_id, table_id};
use super::{err, js, Cell, Cfg, Column, DbErr, Exec, Kind, QueryResult, R};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::Duration;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

const POOL_MAX: usize = 4;
const CONNECT_MS: u64 = 10_000;
const DDL_LOCK_WAIT_S: u32 = 10;

pub fn db_of(cfg: &Cfg, database: Option<&str>) -> String {
  match database.filter(|d| !d.is_empty()) {
    Some(d) => d.to_string(),
    None => cfg.database.clone(),
  }
}

fn opts(cfg: &Cfg, db: &str, password: Option<String>) -> mywire::Opts {
  mywire::Opts {
    host: cfg.host_or_localhost(),
    port: cfg.port_or(3306),
    user: cfg.user.clone(),
    password: password.or_else(|| super::store::password(&cfg.id)),
    database: db.to_string(),
    ssl: cfg.ssl.clone().filter(|s| s.mode != "disable"),
  }
}

async fn connect(cfg: &Cfg, db: &str, password: Option<String>, setup_after: bool) -> R<MyConn> {
  let mut c = MyConn::connect(&opts(cfg, db, password), Duration::from_millis(CONNECT_MS)).await?;
  if setup_after {
    setup(cfg, &mut c).await;
  }
  Ok(c)
}

// Session setup the connection asks for, ahead of the first query; failures are ignored.
async fn setup(cfg: &Cfg, c: &mut MyConn) {
  let tz = cfg.time_zone.as_deref().map(js::trim).unwrap_or("");
  if !tz.is_empty() {
    let _ = run(c, &format!("set time_zone = {}", literal(Kind::Mysql, Some(tz))), &[]).await;
  }
  if let Some(iso) = cfg.isolation.as_deref().filter(|i| ["read committed", "repeatable read", "serializable"].contains(i)) {
    let _ = run(c, &format!("set session transaction isolation level {iso}"), &[]).await;
  }
  if cfg.read_only {
    let _ = run(c, "set session transaction read only", &[]).await;
  }
  let script = cfg.startup_script.as_deref().map(js::trim).unwrap_or("");
  if !script.is_empty() {
    for s in sqltext::statements(script, Kind::Mysql) {
      let _ = run(c, &s, &[]).await;
    }
  }
}

/// What a buffered statement gave: rows of the first result set, or its header.
pub enum Ran {
  #[allow(dead_code)] // the header is kept for symmetry with Header; callers read rows only
  Rows(Vec<Field>, Vec<Vec<Cell>>),
  Header(Header),
}

/// One statement, buffered (catalog reads, control statements).
pub async fn run(c: &mut MyConn, sql: &str, values: &[Param]) -> R<Ran> {
  let text = if values.is_empty() { sql.to_string() } else { mywire::format(sql, values) };
  let out = match c.start(&text).await? {
    Start::Ok(h) => Ran::Header(h),
    Start::Rows(fields) => {
      let mut rows = vec![];
      while let Some(r) = c.next_row().await? {
        rows.push(r.iter().enumerate().map(|(i, v)| fields.get(i).map(|f| mywire::cell(f, v)).unwrap_or(Cell::Null)).collect());
      }
      Ran::Rows(fields, rows)
    }
  };
  c.finish().await?;
  Ok(out)
}

fn header(r: Ran) -> Header {
  match r {
    Ran::Header(h) => h,
    Ran::Rows(..) => Header::default(),
  }
}

fn timeout_sql(c: &MyConn, ms: f64) -> String {
  if c.is_mariadb() {
    format!("set session max_statement_time = {}", js::num_str((ms / 1000.0).max(0.001)))
  } else {
    format!("set session max_execution_time = {}", js::num_str(ms.floor().max(1.0)))
  }
}
fn timeout_reset(c: &MyConn) -> &'static str {
  if c.is_mariadb() {
    "set session max_statement_time = default"
  } else {
    "set session max_execution_time = default"
  }
}

async fn in_tx(c: &mut MyConn) -> R<bool> {
  let h = header(run(c, "do 0", &[]).await?);
  Ok(h.status & mywire::STATUS_IN_TRANS != 0)
}

// ---- pools --------------------------------------------------------------------------

struct Idle {
  conn: MyConn,
  id: u64,
}

pub struct Pool {
  key: String,
  cfg: Cfg,
  db: String,
  sem: Arc<Semaphore>,
  idle: Mutex<Vec<Idle>>,
  closed: AtomicBool,
}

fn pools() -> MutexGuard<'static, HashMap<String, Arc<Pool>>> {
  static P: OnceLock<Mutex<HashMap<String, Arc<Pool>>>> = OnceLock::new();
  P.get_or_init(Default::default).lock().unwrap_or_else(|e| e.into_inner())
}

// queryId -> (pool key, server thread), for KILL QUERY.
fn running() -> MutexGuard<'static, HashMap<String, (String, u32)>> {
  static R: OnceLock<Mutex<HashMap<String, (String, u32)>>> = OnceLock::new();
  R.get_or_init(Default::default).lock().unwrap_or_else(|e| e.into_inner())
}

fn next_id() -> u64 {
  static N: AtomicU64 = AtomicU64::new(1);
  N.fetch_add(1, Ordering::Relaxed)
}

fn entry(cfg: &Cfg, database: Option<&str>) -> Arc<Pool> {
  let db = db_of(cfg, database);
  let key = format!("{}::{db}", cfg.id);
  pools()
    .entry(key.clone())
    .or_insert_with(|| Arc::new(Pool { key, cfg: cfg.clone(), db, sem: Arc::new(Semaphore::new(POOL_MAX)), idle: Mutex::new(vec![]), closed: AtomicBool::new(false) }))
    .clone()
}

pub struct Lease {
  conn: Option<MyConn>,
  pool: Arc<Pool>,
  _permit: OwnedSemaphorePermit,
}

impl Lease {
  fn c(&mut self) -> &mut MyConn {
    self.conn.as_mut().expect("lease")
  }
  fn release(mut self) {
    let Some(conn) = self.conn.take() else { return };
    if conn.broken || self.pool.closed.load(Ordering::SeqCst) {
      super::runtime().spawn(conn.close());
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
        x.conn.close().await;
      }
    });
  }
  /// mysql2's destroy(): the socket closes now.
  fn destroy(mut self) {
    if let Some(c) = self.conn.take() {
      c.destroy();
    }
  }
}

impl Drop for Lease {
  fn drop(&mut self) {
    if let Some(c) = self.conn.take() {
      c.destroy();
    }
  }
}

async fn acquire(p: &Arc<Pool>) -> R<Lease> {
  let permit = p.sem.clone().acquire_owned().await.map_err(|_| DbErr::new("Pool is closed."))?;
  let reuse = p.idle.lock().unwrap().pop();
  let conn = match reuse {
    Some(x) => x.conn,
    None => connect(&p.cfg, &p.db, None, true).await?,
  };
  Ok(Lease { conn: Some(conn), pool: p.clone(), _permit: permit })
}

async fn end_pool(p: Arc<Pool>) {
  p.closed.store(true, Ordering::SeqCst);
  let idle: Vec<Idle> = std::mem::take(&mut *p.idle.lock().unwrap());
  for x in idle {
    x.conn.close().await;
  }
}

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

pub async fn close_database(id: &str, db: &str) {
  let key = format!("{id}::{db}");
  let gone = pools().remove(&key);
  if let Some(p) = gone {
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

// ---- reads ------------------------------------------------------------------------------

fn columns_of(cfg: &Cfg, fields: &[Field]) -> Vec<Column> {
  fields
    .iter()
    .map(|f| {
      let t = if !f.org_table.is_empty() && !f.org_name.is_empty() && !f.schema.is_empty() { table_id(&cfg.id, &f.schema, &f.org_table) } else { 0 };
      Column {
        name: f.name.clone(),
        ty: mywire::type_name(f),
        table: (t != 0).then_some(t),
        attnum: (t != 0).then(|| column_id(t, &f.org_name)),
      }
    })
    .collect()
}

/// Stream one statement: keep `limit` rows (after `skip`), note whether more
/// existed. Past the limit the connection is closed unless `drain`. Only the
/// first result set is kept (CALL can return several). Returns (result, closed).
async fn read_query(cfg: &Cfg, c: &mut MyConn, sql: &str, limit: usize, skip: usize, drain: bool, started: f64) -> R<(QueryResult, bool)> {
  let mut fields: Option<Vec<Field>> = None;
  let mut head: Option<Header> = None;
  let mut rows: Vec<Vec<Cell>> = vec![];
  let mut truncated = false;
  let mut skip = skip;
  match c.start(sql).await? {
    Start::Ok(h) => head = Some(h),
    Start::Rows(f) => {
      fields = Some(f.clone());
      while let Some(r) = c.next_row().await? {
        if truncated {
          continue;
        }
        if skip > 0 {
          skip -= 1;
          continue;
        }
        if rows.len() < limit {
          rows.push(r.iter().enumerate().map(|(i, v)| f.get(i).map(|x| mywire::cell(x, v)).unwrap_or(Cell::Null)).collect());
          continue;
        }
        truncated = true;
        if !drain {
          let result = QueryResult { columns: columns_of(cfg, &f), rows, truncated, row_count: None, command: sqltext::command_of(sql), time_ms: js::now_ms() - started };
          return Ok((result, true));
        }
      }
    }
  }
  c.finish().await?;
  let result = QueryResult {
    columns: fields.as_deref().map(|f| columns_of(cfg, f)).unwrap_or_default(),
    rows,
    truncated,
    row_count: if fields.is_some() { None } else { head.map(|h| h.affected_rows) },
    command: sqltext::command_of(sql),
    time_ms: js::now_ms() - started,
  };
  Ok((result, false))
}

pub async fn query(cfg: &Cfg, database: Option<&str>, sql: &str, limit: usize, read_only: bool, timeout_ms: Option<f64>, query_id: Option<&str>, skip: usize) -> R<QueryResult> {
  let p = entry(cfg, database);
  let started = js::now_ms();
  let mut l = acquire(&p).await?;
  if let Some(q) = query_id {
    running().insert(q.to_string(), (p.key.clone(), l.c().thread_id));
  }
  let timeout = timeout_ms.filter(|t| *t != 0.0);
  let r = async {
    if let Some(t) = timeout {
      let s = timeout_sql(l.c(), t);
      run(l.c(), &s, &[]).await?;
    }
    if read_only {
      run(l.c(), "start transaction read only", &[]).await?;
    }
    read_query(cfg, l.c(), sql, limit, skip, false, started).await
  }
  .await;
  if let Some(q) = query_id {
    running().remove(q);
  }
  match r {
    Ok((res, true)) => {
      l.destroy();
      Ok(res)
    }
    other => {
      let after = async {
        if read_only {
          run(l.c(), "rollback", &[]).await?;
        }
        if timeout.is_some() {
          let s = timeout_reset(l.c());
          run(l.c(), s, &[]).await?;
        }
        Ok::<_, DbErr>(())
      }
      .await;
      match after {
        Ok(()) => l.release(),
        Err(_) => l.destroy(),
      }
      other.map(|x| x.0)
    }
  }
}

pub async fn stream<F, Fut>(cfg: &Cfg, database: Option<&str>, sql: &str, query_id: Option<&str>, max: usize, batch: usize, mut on_rows: F) -> R<usize>
where
  F: FnMut(Vec<Vec<Cell>>) -> Fut,
  Fut: std::future::Future<Output = R<()>>,
{
  let p = entry(cfg, database);
  let mut l = acquire(&p).await?;
  if let Some(q) = query_id {
    running().insert(q.to_string(), (p.key.clone(), l.c().thread_id));
  }
  let mut n = 0usize;
  let mut gone = false;
  let r = async {
    run(l.c(), "start transaction read only", &[]).await?;
    let fields = match l.c().start(sql).await? {
      Start::Ok(_) => vec![],
      Start::Rows(f) => f,
    };
    let mut buf: Vec<Vec<Cell>> = vec![];
    while let Some(row) = l.c().next_row().await? {
      if n >= max {
        // One row past the cap: stop the server.
        gone = true;
        break;
      }
      buf.push(row.iter().enumerate().map(|(i, v)| fields.get(i).map(|x| mywire::cell(x, v)).unwrap_or(Cell::Null)).collect());
      n += 1;
      if buf.len() >= batch {
        if let Err(e) = on_rows(std::mem::take(&mut buf)).await {
          gone = true;
          return Err(e);
        }
      }
    }
    if !gone {
      l.c().finish().await?;
    }
    if !buf.is_empty() {
      on_rows(buf).await?;
    }
    Ok::<_, DbErr>(())
  }
  .await;
  if let Some(q) = query_id {
    running().remove(q);
  }
  if gone {
    l.destroy();
  } else {
    match run(l.c(), "rollback", &[]).await {
      Ok(_) => l.release(),
      Err(_) => l.destroy(),
    }
  }
  r.map(|_| n)
}

// ---- writes ------------------------------------------------------------------------------

async fn effect(cfg: &Cfg, c: &mut MyConn, sql: &str) -> R<Exec> {
  let (r, _) = read_query(cfg, c, sql, 0, 0, true, js::now_ms()).await?;
  Ok(Exec { command: Some(r.command), row_count: r.row_count })
}

pub async fn execute(cfg: &Cfg, database: Option<&str>, stmts: &[String], timeout_ms: f64) -> R<Vec<Exec>> {
  let p = entry(cfg, database);
  let mut l = acquire(&p).await?;
  let r = async {
    let s = timeout_sql(l.c(), timeout_ms);
    run(l.c(), &s, &[]).await?;
    run(l.c(), "start transaction", &[]).await?;
    let mut out = vec![];
    for s in stmts {
      out.push(effect(cfg, l.c(), s).await?);
    }
    run(l.c(), "commit", &[]).await?;
    Ok::<_, DbErr>(out)
  }
  .await;
  if r.is_err() {
    let _ = run(l.c(), "rollback", &[]).await;
  }
  let s = timeout_reset(l.c());
  match run(l.c(), s, &[]).await {
    Ok(_) => l.release(),
    Err(_) => l.destroy(),
  }
  r
}

/// DDL one statement at a time (MySQL commits each itself). Session variables
/// change, so the connection is not reused.
pub async fn ddl(cfg: &Cfg, database: Option<&str>, stmts: &[String], timeout_ms: f64) -> R<usize> {
  let p = entry(cfg, database);
  let mut l = acquire(&p).await?;
  let r = async {
    run(l.c(), &format!("set session lock_wait_timeout = {DDL_LOCK_WAIT_S}"), &[]).await?;
    if l.c().is_mariadb() {
      let s = timeout_sql(l.c(), timeout_ms);
      run(l.c(), &s, &[]).await?;
    }
    let mut n = 0;
    for s in stmts {
      run(l.c(), s, &[]).await?;
      n += 1;
    }
    Ok::<_, DbErr>(n)
  }
  .await;
  l.destroy();
  r
}

// ---- sessions -------------------------------------------------------------------------------

pub struct Session {
  key: String,
  cfg_db: String,
  conn: tokio::sync::Mutex<Option<MyConn>>,
  dead: AtomicBool,
  tx: AtomicBool,
  gen: AtomicU64,
}

fn sessions() -> MutexGuard<'static, HashMap<String, Arc<Session>>> {
  static S: OnceLock<Mutex<HashMap<String, Arc<Session>>>> = OnceLock::new();
  S.get_or_init(Default::default).lock().unwrap_or_else(|e| e.into_inner())
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
  let s2 = s.clone();
  super::runtime().spawn(async move {
    if let Some(c) = s2.conn.lock().await.take() {
      c.close().await;
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
    if s.gen.load(Ordering::SeqCst) == g && !s.dead.load(Ordering::SeqCst) && !s.tx.load(Ordering::SeqCst) {
      drop_session(&id, Some(&s)).await;
    }
  });
}

type Work<'c, T> = std::pin::Pin<Box<dyn std::future::Future<Output = R<T>> + Send + 'c>>;

async fn on_session<T, F>(id: &str, s: &Arc<Session>, cfg: Option<&Cfg>, f: F) -> R<T>
where
  F: for<'c> FnOnce(&'c mut MyConn) -> Work<'c, T>,
{
  let mut slot = s.conn.lock().await;
  if s.dead.load(Ordering::SeqCst) {
    return err("The session was closed");
  }
  if slot.is_none() {
    let Some(cfg) = cfg else { return err("The session was closed") };
    match connect(cfg, &s.cfg_db, None, true).await {
      Ok(c) => *slot = Some(c),
      Err(e) => {
        drop(slot);
        drop_session(id, Some(s)).await;
        return Err(e);
      }
    }
  }
  let c = slot.as_mut().expect("session conn");
  let r = f(c).await;
  if !s.dead.load(Ordering::SeqCst) && !c.broken {
    if let Ok(t) = in_tx(c).await {
      s.tx.store(t, Ordering::SeqCst);
    }
  }
  let broken = c.broken;
  drop(slot);
  if broken {
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
    if s.tx.load(Ordering::SeqCst) {
      return err("Commit or roll back the open transaction before switching connection or database");
    }
    let old = m.remove(id).expect("session");
    old.dead.store(true, Ordering::SeqCst);
    super::runtime().spawn(async move {
      if let Some(c) = old.conn.lock().await.take() {
        c.close().await;
      }
    });
  }
  let s = Arc::new(Session { key, cfg_db: db, conn: tokio::sync::Mutex::new(None), dead: AtomicBool::new(false), tx: AtomicBool::new(false), gen: AtomicU64::new(0) });
  m.insert(id.to_string(), s.clone());
  Ok(s)
}

/// One statement on a session (see pg.rs). DDL commits on its own in MySQL:
/// the savepoint is then gone with the transaction.
pub async fn session_query(cfg: &Cfg, database: Option<&str>, id: &str, sql: &str, limit: usize, query_id: Option<&str>, aux: bool, skip: usize) -> R<QueryResult> {
  let s = with_session(cfg, database, id)?;
  let (sql, qid, key, cfg2) = (sql.to_string(), query_id.map(str::to_string), s.key.clone(), cfg.clone());
  on_session(id, &s, Some(cfg), move |c| {
    Box::pin(async move {
      let started = js::now_ms();
      let control = sqltext::is_tx_control(&sql, true);
      let mut tx = in_tx(c).await?;
      let mut began = false;
      if !aux && !control && !tx {
        run(c, "start transaction", &[]).await?;
        began = true;
        tx = true;
      }
      let guard = !control && tx;
      if let Some(q) = &qid {
        running().insert(q.clone(), (key.clone(), c.thread_id));
      }
      let r = async {
        if guard {
          run(c, "savepoint riven_stmt", &[]).await?;
        }
        let (r, _) = read_query(&cfg2, c, &sql, limit, skip, true, started).await?;
        if guard && in_tx(c).await? {
          run(c, "release savepoint riven_stmt", &[]).await?;
        }
        Ok::<_, DbErr>(r)
      }
      .await;
      if r.is_err() {
        if began {
          let _ = run(c, "rollback", &[]).await;
        } else if guard {
          let _ = run(c, "rollback to savepoint riven_stmt", &[]).await;
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
  match on_session(id, &s, None, |c| Box::pin(async move { Ok(if in_tx(c).await? { "active" } else { "idle" }) })).await {
    Ok(t) => t,
    Err(_) => "none",
  }
}

pub async fn session_end(id: &str, action: &str) -> R<&'static str> {
  let Some(s) = sessions().get(id).cloned() else { return err("No open transaction (the session was closed)") };
  let action = action.to_string();
  on_session(id, &s, None, move |c| {
    Box::pin(async move {
      run(c, &action, &[]).await?;
      Ok(if in_tx(c).await? { "active" } else { "idle" })
    })
  })
  .await
}

pub async fn session_close(id: &str) {
  drop_session(id, None).await;
}

// ---- grid edits -------------------------------------------------------------------------------

pub struct EditStmt {
  pub text: String,
  pub values: Vec<Param>,
  pub fetch: Option<(String, Vec<Param>, bool)>,
}

async fn apply_on(c: &mut MyConn, stmts: &[EditStmt]) -> R<Vec<Option<Vec<Cell>>>> {
  let mut out = vec![];
  for st in stmts {
    let h = header(run(c, &st.text, &st.values).await?);
    if h.affected_rows != 1.0 {
      let verb = match st.text.find(' ') {
        Some(i) => &st.text[..i],
        None => &st.text[..st.text.len().saturating_sub(1)],
      };
      return err(format!("{verb} matched {} rows instead of 1; nothing was applied", js::num_str(h.affected_rows)));
    }
    let Some((text, values, insert_id)) = &st.fetch else {
      out.push(None);
      continue;
    };
    let mut vs = values.clone();
    if *insert_id {
      vs.push(Param::Num(h.insert_id));
    }
    match run(c, text, &vs).await? {
      Ran::Rows(_, rows) => out.push(rows.into_iter().next()),
      Ran::Header(_) => out.push(None),
    }
  }
  Ok(out)
}

pub async fn apply(cfg: &Cfg, database: Option<&str>, session: Option<&str>, stmts: Vec<EditStmt>) -> R<Vec<Option<Vec<Cell>>>> {
  if let Some(sid) = session {
    let s = with_session(cfg, database, sid)?;
    return on_session(sid, &s, Some(cfg), move |c| {
      Box::pin(async move {
        let began = !in_tx(c).await?;
        if began {
          run(c, "start transaction", &[]).await?;
        }
        run(c, "savepoint riven_apply", &[]).await?;
        match apply_on(c, &stmts).await {
          Ok(out) => {
            run(c, "release savepoint riven_apply", &[]).await?;
            Ok(out)
          }
          Err(e) => {
            let _ = run(c, if began { "rollback" } else { "rollback to savepoint riven_apply" }, &[]).await;
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
    run(l.c(), "start transaction", &[]).await?;
    let out = apply_on(l.c(), &stmts).await?;
    run(l.c(), "commit", &[]).await?;
    Ok::<_, DbErr>(out)
  }
  .await;
  if r.is_err() {
    let _ = run(l.c(), "rollback", &[]).await;
  }
  l.release();
  r
}

// ---- control ------------------------------------------------------------------------------

/// Stop a running query from a separate connection (KILL QUERY).
pub async fn cancel(cfg: &Cfg, query_id: &str) -> R<bool> {
  let Some((_, thread)) = running().get(query_id).cloned() else { return Ok(false) };
  let mut c = connect(cfg, "", None, false).await?;
  let r = run(&mut c, "kill query ?", &[Param::Num(thread as f64)]).await;
  c.destroy();
  r.map(|_| true)
}

pub async fn test(cfg: &Cfg, password: Option<String>) -> R<String> {
  let mut c = connect(cfg, &db_of(cfg, None), password, false).await?;
  let r = run(&mut c, "select version()", &[]).await;
  c.destroy();
  let v = match r? {
    Ran::Rows(_, rows) => rows.first().and_then(|x| x.first()).map(Cell::s).unwrap_or_default(),
    Ran::Header(_) => String::new(),
  };
  if v.to_lowercase().contains("mariadb") {
    let lower = v.to_lowercase();
    let cut = lower.find("-mariadb").unwrap_or(v.len());
    Ok(format!("MariaDB {}", &v[..cut]))
  } else {
    Ok(format!("MySQL {v}"))
  }
}

/// Rows of a catalog query (small results only).
pub async fn rows(cfg: &Cfg, database: Option<&str>, sql: impl AsRef<str>, params: impl AsRef<[Param]>) -> R<Vec<Vec<Cell>>> {
  let p = entry(cfg, database);
  let mut l = acquire(&p).await?;
  let r = run(l.c(), sql.as_ref(), params.as_ref()).await;
  l.release();
  match r? {
    Ran::Rows(_, rows) => Ok(rows),
    Ran::Header(_) => Ok(vec![]),
  }
}

