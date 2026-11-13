// SQLite driver (src/main/db/sqlite.ts + sqliteCore.ts). Each handle lives on
// its own thread ("worker"), as node:sqlite's did in a worker_thread: a small
// pool per connection for one-off work, one worker per manual-commit session.
// A query that runs too long or is cancelled ends its worker: the caller gets
// the reason at once, sqlite3_interrupt stops the statement, and the thread
// closes the handle (an open transaction rolls back with it). The next call
// opens a fresh one.
//
// The handle is opened the way node:sqlite's DatabaseSync opens it: no
// double-quoted string literals, defensive mode, foreign keys on; 64-bit
// integers come back as numbers when they fit a JS number and as text
// otherwise, blobs as 0x-hex.

use super::sqltext::{command_of, is_tx_control, statements};
use super::tableids::{column_id, table_id};
use super::{err, js, Cell, Cfg, Column, DbErr, Exec, Kind, QueryResult, R};
use libsqlite3_sys as ffi;
use std::collections::{HashMap, VecDeque};
use std::ffi::{c_char, c_int, CStr, CString};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, Weak};
use std::time::Duration;
use tokio::sync::{oneshot, watch};

const POOL_MAX: usize = 4;
const BUSY_TIMEOUT_MS: u32 = 5000;

/// The file a connection points at (`host`), with ~ expanded and relative paths under home.
pub fn sqlite_file(cfg: &Cfg) -> String {
  let f = js::trim(&cfg.host);
  if f.is_empty() || f == ":memory:" {
    return f.to_string();
  }
  let home = crate::services::paths::home();
  let expanded = if f == "~" || f.starts_with("~/") { format!("{}{}", home.to_string_lossy(), &f[1..]) } else { f.to_string() };
  resolve(&home.to_string_lossy(), &expanded)
}

/// path.resolve(base, p) for POSIX paths.
fn resolve(base: &str, p: &str) -> String {
  let joined = if p.starts_with('/') { p.to_string() } else { format!("{base}/{p}") };
  let mut out: Vec<&str> = vec![];
  for part in joined.split('/') {
    match part {
      "" | "." => {}
      ".." => {
        out.pop();
      }
      x => out.push(x),
    }
  }
  format!("/{}", out.join("/"))
}

#[derive(Clone)]
struct OpenOpts {
  file: String,
  read_only: bool,
  startup_script: Option<String>,
}

fn open_opts(cfg: &Cfg) -> OpenOpts {
  OpenOpts { file: sqlite_file(cfg), read_only: cfg.read_only, startup_script: cfg.startup_script.clone() }
}

// ---- the handle (runs on its worker thread) --------------------------------------------

struct Raw(*mut ffi::sqlite3);
unsafe impl Send for Raw {}

pub enum SlParam {
  Null,
  #[allow(dead_code)] // bound as a double; no caller sends one yet
  Num(f64),
  Str(String),
}

struct RawColumn {
  name: String,
  ty: String,
  origin: Option<(String, String, String)>,
}

struct RawResult {
  columns: Vec<RawColumn>,
  rows: Vec<Vec<Cell>>,
  truncated: bool,
  row_count: Option<f64>,
  command: String,
}

struct Stmt {
  p: *mut ffi::sqlite3_stmt,
}
impl Drop for Stmt {
  fn drop(&mut self) {
    unsafe { ffi::sqlite3_finalize(self.p) };
  }
}

pub struct Core {
  db: *mut ffi::sqlite3,
  stream: Option<Stmt>,
}

fn cstr_text(sql: &str) -> CString {
  // A JS string with NUL in it reached SQLite cut at the NUL.
  let cut = sql.split('\0').next().unwrap_or("");
  CString::new(cut).unwrap_or_default()
}

unsafe fn opt_str(p: *const c_char) -> Option<String> {
  if p.is_null() {
    None
  } else {
    Some(CStr::from_ptr(p).to_string_lossy().into_owned())
  }
}

impl Core {
  fn open(o: &OpenOpts, shared: &Mutex<Option<Raw>>) -> R<Core> {
    if o.file.is_empty() {
      return err("No database file");
    }
    let flags = if o.read_only { ffi::SQLITE_OPEN_READONLY } else { ffi::SQLITE_OPEN_READWRITE | ffi::SQLITE_OPEN_CREATE };
    let path = cstr_text(&o.file);
    let mut db: *mut ffi::sqlite3 = std::ptr::null_mut();
    let r = unsafe { ffi::sqlite3_open_v2(path.as_ptr(), &mut db, flags, std::ptr::null()) };
    if r != ffi::SQLITE_OK {
      let msg = if db.is_null() { "out of memory".to_string() } else { unsafe { opt_str(ffi::sqlite3_errmsg(db)) }.unwrap_or_default() };
      unsafe { ffi::sqlite3_close(db) };
      return err(msg);
    }
    unsafe {
      let mut out: c_int = 0;
      ffi::sqlite3_db_config(db, ffi::SQLITE_DBCONFIG_DQS_DML, 0 as c_int, &mut out as *mut c_int);
      ffi::sqlite3_db_config(db, ffi::SQLITE_DBCONFIG_DQS_DDL, 0 as c_int, &mut out as *mut c_int);
      ffi::sqlite3_db_config(db, ffi::SQLITE_DBCONFIG_ENABLE_FKEY, 1 as c_int, &mut out as *mut c_int);
      ffi::sqlite3_db_config(db, ffi::SQLITE_DBCONFIG_DEFENSIVE, 1 as c_int, &mut out as *mut c_int);
      ffi::sqlite3_busy_timeout(db, 0);
    }
    *shared.lock().unwrap() = Some(Raw(db));
    let mut c = Core { db, stream: None };
    c.exec(&format!("pragma busy_timeout = {BUSY_TIMEOUT_MS}"))?;
    if let Some(script) = o.startup_script.as_deref().map(js::trim).filter(|s| !s.is_empty()) {
      for s in statements(script, Kind::Sqlite) {
        c.exec(&s)?;
      }
    }
    Ok(c)
  }

  fn errmsg(&self) -> DbErr {
    DbErr::new(unsafe { opt_str(ffi::sqlite3_errmsg(self.db)) }.unwrap_or_default())
  }

  fn exec(&mut self, sql: &str) -> R<()> {
    let s = cstr_text(sql);
    let r = unsafe { ffi::sqlite3_exec(self.db, s.as_ptr(), None, std::ptr::null_mut(), std::ptr::null_mut()) };
    if r != ffi::SQLITE_OK {
      return Err(self.errmsg());
    }
    Ok(())
  }

  fn in_tx(&self) -> bool {
    unsafe { ffi::sqlite3_get_autocommit(self.db) == 0 }
  }

  fn prepare(&self, sql: &str) -> R<Stmt> {
    let s = cstr_text(sql);
    let mut p: *mut ffi::sqlite3_stmt = std::ptr::null_mut();
    let r = unsafe { ffi::sqlite3_prepare_v2(self.db, s.as_ptr(), -1, &mut p, std::ptr::null_mut()) };
    if r != ffi::SQLITE_OK {
      return Err(self.errmsg());
    }
    if p.is_null() {
      return err("The SQL query contains no statements.");
    }
    Ok(Stmt { p })
  }

  /// node:sqlite's positional binding: anonymous slots in order, named ones skipped.
  fn bind(&self, st: &Stmt, params: &[SlParam]) -> R<()> {
    unsafe { ffi::sqlite3_reset(st.p) };
    let mut idx: c_int = 1;
    for v in params {
      while !unsafe { ffi::sqlite3_bind_parameter_name(st.p, idx) }.is_null() {
        idx += 1;
      }
      let r = unsafe {
        match v {
          SlParam::Null => ffi::sqlite3_bind_null(st.p, idx),
          SlParam::Num(f) => ffi::sqlite3_bind_double(st.p, idx, *f),
          SlParam::Str(s) => ffi::sqlite3_bind_text(st.p, idx, s.as_ptr() as *const c_char, s.len() as c_int, ffi::SQLITE_TRANSIENT()),
        }
      };
      if r != ffi::SQLITE_OK {
        return Err(self.errmsg());
      }
      idx += 1;
    }
    Ok(())
  }

  fn column_count(st: &Stmt) -> usize {
    unsafe { ffi::sqlite3_column_count(st.p) as usize }
  }

  fn row(st: &Stmt) -> Vec<Cell> {
    (0..Self::column_count(st) as c_int).map(|i| unsafe { value(st.p, i) }).collect()
  }

  /// One step: Some(row), None at the end, or the error.
  fn step(&self, st: &Stmt) -> R<Option<Vec<Cell>>> {
    match unsafe { ffi::sqlite3_step(st.p) } {
      ffi::SQLITE_ROW => Ok(Some(Self::row(st))),
      ffi::SQLITE_DONE => Ok(None),
      _ => {
        let e = self.errmsg();
        unsafe { ffi::sqlite3_reset(st.p) };
        Err(e)
      }
    }
  }

  fn run(&self, st: &Stmt) -> R<f64> {
    while self.step(st)?.is_some() {}
    unsafe { ffi::sqlite3_reset(st.p) };
    Ok(unsafe { ffi::sqlite3_changes64(self.db) } as f64)
  }

  fn all(&self, st: &Stmt) -> R<Vec<Vec<Cell>>> {
    let mut out = vec![];
    while let Some(r) = self.step(st)? {
      out.push(r);
    }
    unsafe { ffi::sqlite3_reset(st.p) };
    Ok(out)
  }

  fn columns_of(st: &Stmt, rows: &[Vec<Cell>]) -> Vec<RawColumn> {
    (0..Self::column_count(st))
      .map(|i| unsafe {
        let ci = i as c_int;
        let name = opt_str(ffi::sqlite3_column_name(st.p, ci)).unwrap_or_default();
        let decl = opt_str(ffi::sqlite3_column_decltype(st.p, ci)).unwrap_or_default();
        let db = opt_str(ffi::sqlite3_column_database_name(st.p, ci)).unwrap_or_default();
        let table = opt_str(ffi::sqlite3_column_table_name(st.p, ci)).unwrap_or_default();
        let column = opt_str(ffi::sqlite3_column_origin_name(st.p, ci)).unwrap_or_default();
        RawColumn {
          name,
          ty: if decl.is_empty() { value_type(rows, i) } else { decl.to_lowercase() },
          origin: (!table.is_empty() && !column.is_empty() && !db.is_empty()).then_some((db, table, column)),
        }
      })
      .collect()
  }

  fn query(&mut self, sql: &str, limit: usize, skip: usize, read_only: bool) -> R<RawResult> {
    if read_only {
      self.exec("pragma query_only = 1")?;
    }
    let r = self.read(sql, limit, skip);
    if read_only {
      self.exec("pragma query_only = 0")?;
    }
    r
  }

  fn read(&self, sql: &str, limit: usize, mut skip: usize) -> R<RawResult> {
    let st = self.prepare(sql)?;
    let command = command_of(sql);
    if Self::column_count(&st) == 0 {
      let n = self.run(&st)?;
      return Ok(RawResult { columns: vec![], rows: vec![], truncated: false, row_count: Some(n), command });
    }
    let mut rows = vec![];
    let mut truncated = false;
    unsafe { ffi::sqlite3_reset(st.p) };
    while let Some(r) = self.step(&st)? {
      if skip > 0 {
        skip -= 1;
        continue;
      }
      if rows.len() >= limit {
        truncated = true;
        break;
      }
      rows.push(r);
    }
    unsafe { ffi::sqlite3_reset(st.p) };
    Ok(RawResult { columns: Self::columns_of(&st, &rows), rows, truncated, row_count: None, command })
  }

  fn effect(&self, sql: &str) -> R<Exec> {
    let st = self.prepare(sql)?;
    if Self::column_count(&st) == 0 {
      return Ok(Exec { command: Some(command_of(sql)), row_count: Some(self.run(&st)?) });
    }
    let mut n = 0.0;
    while self.step(&st)?.is_some() {
      n += 1.0;
    }
    Ok(Exec { command: Some(command_of(sql)), row_count: Some(n) })
  }

  fn in_transaction<T>(&mut self, f: impl FnOnce(&mut Core) -> R<T>) -> R<T> {
    self.exec("begin")?;
    match f(self) {
      Ok(v) => {
        self.exec("commit")?;
        Ok(v)
      }
      Err(e) => {
        if self.in_tx() {
          self.exec("rollback")?;
        }
        Err(e)
      }
    }
  }

  fn execute(&mut self, stmts: &[String]) -> R<Vec<Exec>> {
    self.in_transaction(|c| stmts.iter().map(|s| c.effect(s)).collect())
  }

  fn ddl(&mut self, stmts: &[String], atomic: bool) -> R<usize> {
    let run = |c: &mut Core| {
      for s in stmts {
        c.exec(s)?;
      }
      Ok(stmts.len())
    };
    if atomic {
      self.in_transaction(run)
    } else {
      run(self)
    }
  }

  fn rows(&self, sql: &str, params: &[SlParam]) -> R<Vec<Vec<Cell>>> {
    let st = self.prepare(sql)?;
    self.bind(&st, params)?;
    self.all(&st)
  }

  fn apply(&mut self, stmts: &[(String, Vec<Option<String>>)]) -> R<Vec<Option<Vec<Cell>>>> {
    let exec = |c: &mut Core| -> R<Vec<Option<Vec<Cell>>>> {
      let mut out = vec![];
      for (text, values) in stmts {
        let st = c.prepare(text)?;
        let params: Vec<SlParam> = values.iter().map(|v| v.clone().map(SlParam::Str).unwrap_or(SlParam::Null)).collect();
        c.bind(&st, &params)?;
        // DELETE has no RETURNING: its row count is the change count.
        let returns = Self::column_count(&st) > 0;
        let got = if returns { Some(c.all(&st)?) } else { None };
        let n = match &got {
          Some(g) => g.len() as f64,
          None => c.run(&st)?,
        };
        if n != 1.0 {
          let verb = match text.find(' ') {
            Some(i) => &text[..i],
            None => &text[..text.len().saturating_sub(1)],
          };
          return err(format!("{verb} matched {} rows instead of 1; nothing was applied", js::num_str(n)));
        }
        out.push(got.map(|mut g| g.swap_remove(0)));
      }
      Ok(out)
    };
    if !self.in_tx() {
      return self.in_transaction(exec);
    }
    self.exec("savepoint riven_apply")?;
    match exec(self) {
      Ok(v) => {
        self.exec("release riven_apply")?;
        Ok(v)
      }
      Err(e) => {
        self.exec("rollback to riven_apply")?;
        self.exec("release riven_apply")?;
        Err(e)
      }
    }
  }

  fn session_query(&mut self, sql: &str, limit: usize, skip: usize, aux: bool) -> R<RawResult> {
    let control = is_tx_control(sql, true);
    let mut began = false;
    if !aux && !control && !self.in_tx() {
      self.exec("begin")?;
      began = true;
    }
    let guard = !control && self.in_tx();
    let r = (|| {
      if guard {
        self.exec("savepoint riven_stmt")?;
      }
      let r = self.read(sql, limit, skip)?;
      if guard && self.in_tx() {
        self.exec("release riven_stmt")?;
      }
      Ok(r)
    })();
    if r.is_err() {
      if began {
        if self.in_tx() {
          self.exec("rollback")?;
        }
      } else if guard && self.in_tx() {
        self.exec("rollback to riven_stmt")?;
        self.exec("release riven_stmt")?;
      }
    }
    r
  }

  fn session_end(&mut self, action: &str) -> R<bool> {
    if self.in_tx() {
      self.exec(action)?;
    }
    Ok(self.in_tx())
  }

  fn stream_open(&mut self, sql: &str) -> R<()> {
    let st = self.prepare(sql)?;
    unsafe { ffi::sqlite3_reset(st.p) };
    self.stream = Some(st);
    Ok(())
  }

  fn stream_next(&mut self, n: usize) -> R<Vec<Vec<Cell>>> {
    let Some(st) = self.stream.take() else { return Ok(vec![]) };
    let mut out = vec![];
    while out.len() < n {
      match self.step(&st)? {
        Some(r) => out.push(r),
        None => {
          unsafe { ffi::sqlite3_reset(st.p) };
          return Ok(out);
        }
      }
    }
    self.stream = Some(st);
    Ok(out)
  }

  fn stream_close(&mut self) {
    self.stream = None;
  }

  fn version(&self) -> R<String> {
    let r = self.rows("select sqlite_version()", &[])?;
    Ok(r.first().and_then(|x| x.first()).map(|c| if c.is_null() { String::new() } else { c.js_string() }).unwrap_or_default())
  }
}

impl Drop for Core {
  fn drop(&mut self) {
    self.stream = None;
    unsafe { ffi::sqlite3_close(self.db) };
  }
}

/// node:sqlite's reading of a column with readBigInts, through riven's cell().
unsafe fn value(st: *mut ffi::sqlite3_stmt, i: c_int) -> Cell {
  match ffi::sqlite3_column_type(st, i) {
    ffi::SQLITE_INTEGER => {
      let v = ffi::sqlite3_column_int64(st, i);
      if (-9007199254740991..=9007199254740991).contains(&v) {
        Cell::Num(v as f64)
      } else {
        Cell::Str(v.to_string())
      }
    }
    ffi::SQLITE_FLOAT => Cell::Num(ffi::sqlite3_column_double(st, i)),
    ffi::SQLITE_TEXT => {
      let p = ffi::sqlite3_column_text(st, i);
      let n = ffi::sqlite3_column_bytes(st, i) as usize;
      if p.is_null() {
        return Cell::Str(String::new());
      }
      Cell::Str(String::from_utf8_lossy(std::slice::from_raw_parts(p, n)).into_owned())
    }
    ffi::SQLITE_BLOB => {
      let p = ffi::sqlite3_column_blob(st, i) as *const u8;
      let n = ffi::sqlite3_column_bytes(st, i) as usize;
      let b = if p.is_null() { &[][..] } else { std::slice::from_raw_parts(p, n) };
      let mut s = String::with_capacity(2 + n * 2);
      s.push_str("0x");
      for x in b {
        s.push_str(&format!("{x:02x}"));
      }
      Cell::Str(s)
    }
    _ => Cell::Null,
  }
}

// An expression column has no declared type: name it after its first value.
fn value_type(rows: &[Vec<Cell>], i: usize) -> String {
  for r in rows {
    match r.get(i) {
      None | Some(Cell::Null) => continue,
      Some(Cell::Num(f)) => return if f.is_finite() && f.fract() == 0.0 { "integer" } else { "real" }.into(),
      Some(Cell::Str(s)) => {
        let hex = s.strip_prefix("0x").is_some_and(|h| h.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)));
        return if hex { "blob" } else { "text" }.into();
      }
      Some(Cell::Bool(_)) => return "text".into(),
    }
  }
  String::new()
}

// ---- workers ---------------------------------------------------------------------------

type Job = Box<dyn FnOnce(&mut Result<Core, DbErr>) + Send>;

struct Worker {
  tx: std::sync::mpsc::Sender<Option<Job>>,
  dead: AtomicBool,
  killed: watch::Sender<Option<String>>,
  handle: Arc<Mutex<Option<Raw>>>,
  on_death: Mutex<Option<Box<dyn FnOnce(&Arc<Worker>) + Send>>>,
  idle_gen: AtomicU64,
  me: Weak<Worker>,
}

impl Worker {
  fn new(o: OpenOpts, on_death: Box<dyn FnOnce(&Arc<Worker>) + Send>) -> Arc<Worker> {
    let (tx, rx) = std::sync::mpsc::channel::<Option<Job>>();
    let handle: Arc<Mutex<Option<Raw>>> = Arc::new(Mutex::new(None));
    let h2 = handle.clone();
    let _ = std::thread::Builder::new().name("riven-sqlite".into()).spawn(move || {
      let mut core = Core::open(&o, &h2);
      while let Ok(Some(job)) = rx.recv() {
        job(&mut core);
      }
      // Interrupts may no longer reach the handle once it is closing.
      *h2.lock().unwrap() = None;
      drop(core);
    });
    let (killed, _) = watch::channel(None);
    Arc::new_cyclic(|me| Worker { tx, dead: AtomicBool::new(false), killed, handle, on_death: Mutex::new(Some(on_death)), idle_gen: AtomicU64::new(0), me: me.clone() })
  }

  fn is_dead(&self) -> bool {
    self.dead.load(Ordering::SeqCst)
  }

  async fn call<T: Send + 'static>(&self, f: impl FnOnce(&mut Core) -> R<T> + Send + 'static) -> R<T> {
    if self.is_dead() {
      return err("The SQLite worker stopped");
    }
    let mut killed = self.killed.subscribe();
    let (otx, orx) = oneshot::channel::<R<T>>();
    let job: Job = Box::new(move |core| {
      let r = match core {
        Ok(c) => f(c),
        Err(e) => Err(e.clone()),
      };
      let _ = otx.send(r);
    });
    if self.tx.send(Some(job)).is_err() {
      return err("The SQLite worker stopped");
    }
    let r = tokio::select! {
      biased;
      _ = killed.wait_for(|v| v.is_some()) => return err(self.killed.borrow().clone().unwrap_or_default()),
      r = orx => r.unwrap_or_else(|_| err("The SQLite worker stopped")),
    };
    // A kill wins over what the interrupted statement answered ("interrupted"),
    // as the Node worker's termination rejected the call with the reason.
    match (&r, self.killed.borrow().clone()) {
      (Err(_), Some(reason)) => err(reason),
      _ => r,
    }
  }

  /// Stop the worker; whatever it was running fails with `reason`.
  fn kill(&self, reason: &str) {
    if self.dead.swap(true, Ordering::SeqCst) {
      return;
    }
    self.killed.send_replace(Some(reason.to_string()));
    if let Some(Raw(db)) = &*self.handle.lock().unwrap() {
      unsafe { ffi::sqlite3_interrupt(*db) };
    }
    let _ = self.tx.send(None);
    let cb = self.on_death.lock().unwrap().take();
    if let (Some(cb), Some(me)) = (cb, self.me.upgrade()) {
      cb(&me);
    }
  }
}

// ---- pool ------------------------------------------------------------------------------

struct PoolInner {
  idle: Vec<Arc<Worker>>,
  size: usize,
  waiters: VecDeque<oneshot::Sender<Arc<Worker>>>,
}

struct Pool {
  id: String,
  open: OpenOpts,
  inner: Mutex<PoolInner>,
}

fn pools() -> MutexGuard<'static, HashMap<String, Arc<Pool>>> {
  static P: OnceLock<Mutex<HashMap<String, Arc<Pool>>>> = OnceLock::new();
  P.get_or_init(Default::default).lock().unwrap_or_else(|e| e.into_inner())
}

// queryId -> the worker running it, for cancel.
fn running() -> MutexGuard<'static, HashMap<String, Arc<Worker>>> {
  static R: OnceLock<Mutex<HashMap<String, Arc<Worker>>>> = OnceLock::new();
  R.get_or_init(Default::default).lock().unwrap_or_else(|e| e.into_inner())
}

fn pool_of(cfg: &Cfg) -> Arc<Pool> {
  pools()
    .entry(cfg.id.clone())
    .or_insert_with(|| Arc::new(Pool { id: cfg.id.clone(), open: open_opts(cfg), inner: Mutex::new(PoolInner { idle: vec![], size: 0, waiters: VecDeque::new() }) }))
    .clone()
}

fn is_current(p: &Arc<Pool>) -> bool {
  pools().get(&p.id).is_some_and(|x| Arc::ptr_eq(x, p))
}

fn spawn(p: &Arc<Pool>) -> Arc<Worker> {
  p.inner.lock().unwrap().size += 1;
  let weak = Arc::downgrade(p);
  Worker::new(
    p.open.clone(),
    Box::new(move |w| {
      let Some(p) = weak.upgrade() else { return };
      let next = {
        let mut i = p.inner.lock().unwrap();
        i.size -= 1;
        i.idle.retain(|x| !Arc::ptr_eq(x, w));
        None::<()>
      };
      let _ = next;
      // A slot freed up: someone waiting gets a fresh worker.
      if is_current(&p) {
        let waiter = p.inner.lock().unwrap().waiters.pop_front();
        if let Some(tx) = waiter {
          let nw = spawn(&p);
          if let Err(nw) = tx.send(nw) {
            release(&p, nw);
          }
        }
      }
    }),
  )
}

async fn acquire(p: &Arc<Pool>) -> Arc<Worker> {
  let rx = {
    let mut i = p.inner.lock().unwrap();
    if let Some(w) = i.idle.pop() {
      w.idle_gen.fetch_add(1, Ordering::SeqCst);
      return w;
    }
    if i.size < POOL_MAX {
      drop(i);
      return spawn(p);
    }
    let (tx, rx) = oneshot::channel();
    i.waiters.push_back(tx);
    rx
  };
  match rx.await {
    Ok(w) => w,
    Err(_) => spawn(p),
  }
}

fn release(p: &Arc<Pool>, w: Arc<Worker>) {
  if w.is_dead() {
    return;
  }
  // The connection was closed (or edited) while this ran.
  if !is_current(p) {
    w.kill("closed");
    return;
  }
  let waiter = p.inner.lock().unwrap().waiters.pop_front();
  if let Some(tx) = waiter {
    if let Err(w) = tx.send(w) {
      release(p, w);
    }
    return;
  }
  let g = w.idle_gen.fetch_add(1, Ordering::SeqCst) + 1;
  p.inner.lock().unwrap().idle.push(w.clone());
  let weak = Arc::downgrade(&w);
  super::runtime().spawn(async move {
    tokio::time::sleep(Duration::from_millis(super::POOL_IDLE_MS)).await;
    if let Some(w) = weak.upgrade() {
      if w.idle_gen.load(Ordering::SeqCst) == g {
        w.kill("idle");
      }
    }
  });
}

/// Run on a pool worker. A timeout or cancel ends the worker, which is the
/// only way to stop a running SQLite statement from outside.
async fn on_pool<T, F, Fut>(cfg: &Cfg, query_id: Option<&str>, timeout_ms: Option<f64>, f: F) -> R<T>
where
  F: FnOnce(Arc<Worker>) -> Fut,
  Fut: std::future::Future<Output = R<T>>,
{
  let p = pool_of(cfg);
  let w = acquire(&p).await;
  if let Some(q) = query_id {
    running().insert(q.to_string(), w.clone());
  }
  let timer = timeout_ms.filter(|t| *t > 0.0).map(|t| {
    let w = Arc::downgrade(&w);
    super::runtime().spawn(async move {
      tokio::time::sleep(Duration::from_millis(t as u64)).await;
      if let Some(w) = w.upgrade() {
        w.kill("canceling statement due to statement timeout");
      }
    })
  });
  let r = f(w.clone()).await;
  if let Some(t) = timer {
    t.abort();
  }
  if let Some(q) = query_id {
    running().remove(q);
  }
  release(&p, w);
  r
}

fn to_result(cfg: &Cfg, r: RawResult, started: f64) -> QueryResult {
  QueryResult {
    columns: r
      .columns
      .into_iter()
      .map(|c| {
        let (table, attnum) = match &c.origin {
          Some((db, t, col)) => {
            let id = table_id(&cfg.id, db, t);
            (Some(id), Some(column_id(id, col)))
          }
          None => (None, None),
        };
        Column { name: c.name, ty: c.ty, table, attnum }
      })
      .collect(),
    rows: r.rows,
    truncated: r.truncated,
    row_count: r.row_count,
    command: r.command,
    time_ms: js::now_ms() - started,
  }
}

// ---- reads and writes --------------------------------------------------------------------

pub async fn query(cfg: &Cfg, sql: &str, limit: usize, read_only: bool, timeout_ms: Option<f64>, query_id: Option<&str>, skip: usize) -> R<QueryResult> {
  let started = js::now_ms();
  let sql = sql.to_string();
  let raw = on_pool(cfg, query_id, timeout_ms, |w| async move { w.call(move |c| c.query(&sql, limit, skip, read_only)).await }).await?;
  Ok(to_result(cfg, raw, started))
}

pub async fn stream<F, Fut>(cfg: &Cfg, sql: &str, query_id: Option<&str>, max: usize, batch: usize, mut on_rows: F) -> R<usize>
where
  F: FnMut(Vec<Vec<Cell>>) -> Fut,
  Fut: std::future::Future<Output = R<()>>,
{
  let sql = sql.to_string();
  on_pool(cfg, query_id, None, |w| async move {
    w.call(move |c| c.stream_open(&sql)).await?;
    let mut n = 0usize;
    // Pulled one batch at a time: the worker never runs ahead of the writer.
    let r = async {
      while n < max {
        let want = batch.min(max - n);
        let rows = w.call(move |c| c.stream_next(want)).await?;
        let got = rows.len();
        if got > 0 {
          on_rows(rows).await?;
        }
        n += got;
        if got < batch {
          break;
        }
      }
      Ok::<_, DbErr>(n)
    }
    .await;
    let _ = w
      .call(|c| {
        c.stream_close();
        Ok(())
      })
      .await;
    r
  })
  .await
}

pub async fn execute(cfg: &Cfg, stmts: &[String], timeout_ms: f64) -> R<Vec<Exec>> {
  let stmts = stmts.to_vec();
  on_pool(cfg, None, Some(timeout_ms), |w| async move { w.call(move |c| c.execute(&stmts)).await }).await
}

pub async fn ddl(cfg: &Cfg, stmts: &[String], atomic: bool, timeout_ms: f64) -> R<usize> {
  let stmts = stmts.to_vec();
  on_pool(cfg, None, Some(timeout_ms), |w| async move { w.call(move |c| c.ddl(&stmts, atomic)).await }).await
}

/// Rows of a catalog query (small results only).
pub async fn rows(cfg: &Cfg, sql: impl Into<String>, params: Vec<SlParam>) -> R<Vec<Vec<Cell>>> {
  let sql = sql.into();
  on_pool(cfg, None, None, |w| async move { w.call(move |c| c.rows(&sql, &params)).await }).await
}

// ---- sessions --------------------------------------------------------------------------

struct Session {
  conn: String,
  serial: u64,
  w: Arc<Worker>,
  chain: tokio::sync::Mutex<()>,
  tx: AtomicBool,
  gen: AtomicU64,
}

fn sessions() -> MutexGuard<'static, HashMap<String, Arc<Session>>> {
  static S: OnceLock<Mutex<HashMap<String, Arc<Session>>>> = OnceLock::new();
  S.get_or_init(Default::default).lock().unwrap_or_else(|e| e.into_inner())
}

fn drop_session(id: &str, only: Option<u64>) {
  let s = {
    let mut m = sessions();
    match m.get(id) {
      Some(s) if only.is_none_or(|o| o == s.serial) => m.remove(id),
      _ => None,
    }
  };
  if let Some(s) = s {
    s.w.kill("The session was closed");
  }
}

fn new_session(cfg: &Cfg, id: &str, m: &mut HashMap<String, Arc<Session>>) -> Arc<Session> {
  static SERIAL: AtomicU64 = AtomicU64::new(1);
  let serial = SERIAL.fetch_add(1, Ordering::Relaxed);
  let sid = id.to_string();
  // Ending the worker (cancel, timeout) ends the session with it: its open transaction is gone.
  let w = Worker::new(open_opts(cfg), Box::new(move |_| drop_session(&sid, Some(serial))));
  let s = Arc::new(Session { conn: cfg.id.clone(), serial, w, chain: tokio::sync::Mutex::new(()), tx: AtomicBool::new(false), gen: AtomicU64::new(0) });
  m.insert(id.to_string(), s.clone());
  s
}

async fn on_session<T, F, Fut>(id: &str, s: &Arc<Session>, f: F) -> R<T>
where
  F: FnOnce() -> Fut,
  Fut: std::future::Future<Output = R<T>>,
{
  let guard = s.chain.lock().await;
  let r = f().await;
  if !s.w.is_dead() {
    if let Ok(t) = s.w.call(|c| Ok(c.in_tx())).await {
      s.tx.store(t, Ordering::SeqCst);
    }
  }
  drop(guard);
  if !s.w.is_dead() {
    let g = s.gen.fetch_add(1, Ordering::SeqCst) + 1;
    let (id, s) = (id.to_string(), s.clone());
    super::runtime().spawn(async move {
      tokio::time::sleep(Duration::from_millis(super::SESSION_IDLE_MS)).await;
      if s.gen.load(Ordering::SeqCst) == g && !s.tx.load(Ordering::SeqCst) {
        drop_session(&id, Some(s.serial));
      }
    });
  }
  r
}

fn with_session(cfg: &Cfg, id: &str) -> R<Arc<Session>> {
  let mut m = sessions();
  if let Some(s) = m.get(id).cloned() {
    if s.conn == cfg.id {
      return Ok(s);
    }
    if s.tx.load(Ordering::SeqCst) {
      return err("Commit or roll back the open transaction before switching connection or database");
    }
    m.remove(id);
    s.w.kill("The session was closed");
  }
  Ok(new_session(cfg, id, &mut m))
}

pub fn has_session(id: &str) -> bool {
  sessions().contains_key(id)
}

pub async fn session_query(cfg: &Cfg, id: &str, sql: &str, limit: usize, query_id: Option<&str>, aux: bool, skip: usize) -> R<QueryResult> {
  let s = with_session(cfg, id)?;
  let sql = sql.to_string();
  on_session(id, &s, || async {
    let started = js::now_ms();
    if let Some(q) = query_id {
      running().insert(q.to_string(), s.w.clone());
    }
    let r = s.w.call(move |c| c.session_query(&sql, limit, skip, aux)).await;
    if let Some(q) = query_id {
      running().remove(q);
    }
    Ok(to_result(cfg, r?, started))
  })
  .await
}

pub async fn session_status(id: &str) -> &'static str {
  let Some(s) = sessions().get(id).cloned() else { return "none" };
  let w = s.w.clone();
  on_session(id, &s, || async move { Ok(if w.call(|c| Ok(c.in_tx())).await? { "active" } else { "idle" }) }).await.unwrap_or("none")
}

pub async fn session_end(id: &str, action: &str) -> R<&'static str> {
  let Some(s) = sessions().get(id).cloned() else { return err("No open transaction (the session was closed)") };
  let (w, action) = (s.w.clone(), action.to_string());
  on_session(id, &s, || async move { Ok(if w.call(move |c| c.session_end(&action)).await? { "active" } else { "idle" }) }).await
}

pub async fn session_close(id: &str) {
  drop_session(id, None);
}

/// Grid edits, all or nothing, each touching exactly one row (RETURNING gives it back).
pub async fn apply(cfg: &Cfg, session: Option<&str>, stmts: Vec<(String, Vec<Option<String>>)>) -> R<Vec<Option<Vec<Cell>>>> {
  if let Some(sid) = session {
    let s = with_session(cfg, sid)?;
    let w = s.w.clone();
    return on_session(sid, &s, || async move { w.call(move |c| c.apply(&stmts)).await }).await;
  }
  on_pool(cfg, None, None, |w| async move { w.call(move |c| c.apply(&stmts)).await }).await
}

// ---- control -----------------------------------------------------------------------------

pub fn cancel(query_id: &str) -> bool {
  let w = running().get(query_id).cloned();
  match w {
    Some(w) => {
      w.kill("canceling statement due to user request");
      true
    }
    None => false,
  }
}

pub async fn test(cfg: &Cfg) -> R<String> {
  let o = open_opts(cfg);
  if o.file.is_empty() {
    return err("Choose a database file");
  }
  let w = Worker::new(o, Box::new(|_| {}));
  let r = w.call(|c| c.version()).await;
  w.kill("done");
  Ok(format!("SQLite {}", r?))
}

pub async fn close_connection(id: &str) {
  let p = pools().remove(id);
  if let Some(p) = p {
    let idle: Vec<Arc<Worker>> = std::mem::take(&mut p.inner.lock().unwrap().idle);
    for w in idle {
      w.kill("closed");
    }
  }
  let sids: Vec<String> = sessions().iter().filter(|(_, s)| s.conn == id).map(|(k, _)| k.clone()).collect();
  for sid in sids {
    drop_session(&sid, None);
  }
}

pub async fn close_all() {
  let ids: Vec<String> = pools().keys().cloned().collect();
  for id in ids {
    close_connection(&id).await;
  }
  let sids: Vec<String> = sessions().keys().cloned().collect();
  for sid in sids {
    drop_session(&sid, None);
  }
}


#[cfg(test)]
mod tests {
  use super::*;
  #[test]
  fn resolves_like_node() {
    assert_eq!(resolve("/Users/a", "x.db"), "/Users/a/x.db");
    assert_eq!(resolve("/Users/a", "/tmp/../var/x.db"), "/var/x.db");
    assert_eq!(resolve("/Users/a", "./d//x.db"), "/Users/a/d/x.db");
  }
}
