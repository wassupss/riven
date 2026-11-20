// Databases (src/main/db): saved data sources, the PostgreSQL, MySQL/MariaDB
// and SQLite drivers, their catalogs, and everything the DB panels and the
// riven_db_* MCP tools do with them (engine.rs has the channel table).
//
// Values come back the way the Node drivers gave them, because the panels and
// agents were written against those: PostgreSQL rows are the server's text
// except bool, int2/int4/oid and float4/float8 (node-pg with riven's type
// parsers); MySQL rows are mysql2's text-protocol reading under dateStrings,
// bigNumberStrings and jsonStrings, bytes as 0x-hex; SQLite rows are
// node:sqlite's with 64-bit integers as text when they don't fit a JS number.
// Both network protocols are spoken here (pgwire.rs, mywire.rs) so the text
// a server sends is the text a panel sees.

pub mod dump;
pub mod engine;
pub mod export;
#[cfg(debug_assertions)]
pub mod harness;
pub mod import;
pub mod js;
pub mod my;
pub mod mymeta;
pub mod mywire;
pub mod pg;
pub mod pgmeta;
pub mod pgwire;
pub mod sl;
pub mod slmeta;
pub mod sqltext;
pub mod store;
pub mod tableids;

use serde::{Serialize, Serializer};
use serde_json::{Map, Value};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kind {
  Postgres,
  Mysql,
  Sqlite,
  Redis,
}

impl Kind {
  pub fn parse(s: &str) -> Option<Kind> {
    match s {
      "postgres" => Some(Kind::Postgres),
      "mysql" => Some(Kind::Mysql),
      "sqlite" => Some(Kind::Sqlite),
      "redis" => Some(Kind::Redis),
      _ => None,
    }
  }
  pub fn label(self) -> &'static str {
    match self {
      Kind::Postgres => "PostgreSQL",
      Kind::Mysql => "MySQL / MariaDB",
      Kind::Sqlite => "SQLite",
      Kind::Redis => "Redis",
    }
  }
  /// engines.ts defaultDb.
  pub fn default_db(self) -> &'static str {
    match self {
      Kind::Postgres => "postgres",
      Kind::Mysql => "",
      _ => "main",
    }
  }
  /// engines.ts caps().databases.
  pub fn has_databases(self) -> bool {
    matches!(self, Kind::Postgres | Kind::Mysql)
  }
}

// ---- errors ----------------------------------------------------------------------

/// A failed call: the message the page shows, and MySQL's errno when there is one.
#[derive(Debug, Clone)]
pub struct DbErr {
  pub msg: String,
  pub errno: Option<u32>,
}

impl DbErr {
  pub fn new(msg: impl Into<String>) -> DbErr {
    DbErr { msg: msg.into(), errno: None }
  }
}

impl std::fmt::Display for DbErr {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    f.write_str(&self.msg)
  }
}

impl From<String> for DbErr {
  fn from(s: String) -> DbErr {
    DbErr::new(s)
  }
}
impl From<&str> for DbErr {
  fn from(s: &str) -> DbErr {
    DbErr::new(s)
  }
}
impl From<std::io::Error> for DbErr {
  fn from(e: std::io::Error) -> DbErr {
    DbErr::new(e.to_string())
  }
}

pub type R<T> = Result<T, DbErr>;

pub fn err<T>(msg: impl Into<String>) -> R<T> {
  Err(DbErr::new(msg))
}

// ---- values ----------------------------------------------------------------------

/// One result cell: string | number | boolean | null.
#[derive(Clone, Debug, PartialEq)]
pub enum Cell {
  Null,
  Bool(bool),
  Num(f64),
  Str(String),
}

impl Cell {
  /// String(v), with null as 'null'.
  pub fn js_string(&self) -> String {
    match self {
      Cell::Null => "null".into(),
      Cell::Bool(b) => b.to_string(),
      Cell::Num(f) => js::num_str(*f),
      Cell::Str(s) => s.clone(),
    }
  }
  /// The meta modules' str(): '' for null.
  pub fn s(&self) -> String {
    match self {
      Cell::Null => String::new(),
      other => other.js_string(),
    }
  }
  pub fn opt(&self) -> Option<String> {
    match self {
      Cell::Null => None,
      other => Some(other.js_string()),
    }
  }
  pub fn is_null(&self) -> bool {
    matches!(self, Cell::Null)
  }
  pub fn is_true(&self) -> bool {
    matches!(self, Cell::Bool(true))
  }
  /// JS truthiness (!!v).
  pub fn truthy(&self) -> bool {
    match self {
      Cell::Null => false,
      Cell::Bool(b) => *b,
      Cell::Num(f) => *f != 0.0 && !f.is_nan(),
      Cell::Str(s) => !s.is_empty(),
    }
  }
  /// Number(v): null is 0.
  pub fn number(&self) -> f64 {
    match self {
      Cell::Null => 0.0,
      Cell::Bool(b) => f64::from(u8::from(*b)),
      Cell::Num(f) => *f,
      Cell::Str(s) => js::number(s),
    }
  }
  pub fn from_value(v: &Value) -> Cell {
    match v {
      Value::Null => Cell::Null,
      Value::Bool(b) => Cell::Bool(*b),
      Value::Number(n) => Cell::Num(n.as_f64().unwrap_or(0.0)),
      Value::String(s) => Cell::Str(s.clone()),
      other => Cell::Str(js::string(other)),
    }
  }
}

impl Serialize for Cell {
  fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
    match self {
      Cell::Null => s.serialize_unit(),
      Cell::Bool(b) => s.serialize_bool(*b),
      // JSON.stringify: an integral number prints without ".0"; NaN and
      // Infinity print as null.
      Cell::Num(f) if !f.is_finite() => s.serialize_unit(),
      Cell::Num(f) if f.fract() == 0.0 && f.abs() < 9.0e15 => s.serialize_i64(*f as i64),
      Cell::Num(f) => s.serialize_f64(*f),
      Cell::Str(x) => s.serialize_str(x),
    }
  }
}

/// A JS number for JSON (integral values without ".0").
pub fn num(f: f64) -> Value {
  crate::services::chat::util::jnum(f)
}

#[derive(Serialize, Clone, Debug)]
pub struct Column {
  pub name: String,
  #[serde(rename = "type")]
  pub ty: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub table: Option<u32>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub attnum: Option<i64>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct QueryResult {
  pub columns: Vec<Column>,
  pub rows: Vec<Vec<Cell>>,
  pub truncated: bool,
  pub row_count: Option<f64>,
  pub command: String,
  pub time_ms: f64,
}

/// One statement's outcome in an all-or-nothing batch.
#[derive(Clone, Debug)]
pub struct Exec {
  pub command: Option<String>,
  pub row_count: Option<f64>,
}

impl Serialize for Exec {
  fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
    use serde::ser::SerializeMap;
    let mut m = s.serialize_map(None)?;
    // A multi-statement simple query gave node-pg an array: both undefined.
    if let Some(c) = &self.command {
      m.serialize_entry("command", c)?;
      m.serialize_entry("rowCount", &self.row_count.map(num))?;
    }
    m.end()
  }
}

// ---- connection config -------------------------------------------------------------

#[derive(Clone, Debug, Default)]
pub struct Ssl {
  pub mode: String,
  pub ca: Option<String>,
  pub cert: Option<String>,
  pub key: Option<String>,
}

/// A saved data source as the drivers read it.
#[derive(Clone, Debug)]
pub struct Cfg {
  pub id: String,
  pub name: String,
  pub kind_str: String,
  pub kind: Option<Kind>,
  pub host: String,
  pub port: f64,
  pub user: String,
  pub database: String,
  pub read_only: bool,
  pub ssl: Option<Ssl>,
  pub time_zone: Option<String>,
  pub isolation: Option<String>,
  pub startup_script: Option<String>,
}

fn sv(m: &Map<String, Value>, k: &str) -> String {
  match m.get(k) {
    None | Some(Value::Null) => String::new(),
    Some(Value::String(s)) => s.clone(),
    Some(v) => js::string(v),
  }
}

fn so(m: Option<&Map<String, Value>>, k: &str) -> Option<String> {
  match m?.get(k)? {
    Value::Null => None,
    Value::String(s) => Some(s.clone()),
    v => Some(js::string(v)),
  }
}

impl Cfg {
  pub fn from_value(v: &Value) -> Cfg {
    let empty = Map::new();
    let m = v.as_object().unwrap_or(&empty);
    let ssl = m.get("ssl").and_then(Value::as_object).map(|s| Ssl {
      mode: sv(s, "mode"),
      ca: so(Some(s), "ca"),
      cert: so(Some(s), "cert"),
      key: so(Some(s), "key"),
    });
    let opts = m.get("options").and_then(Value::as_object);
    let kind_str = sv(m, "kind");
    Cfg {
      id: sv(m, "id"),
      name: sv(m, "name"),
      kind: Kind::parse(&kind_str),
      kind_str,
      host: sv(m, "host"),
      port: m.get("port").and_then(Value::as_f64).unwrap_or(0.0),
      user: sv(m, "user"),
      database: sv(m, "database"),
      read_only: js::truthy(m.get("readOnly")),
      ssl,
      time_zone: so(opts, "timeZone"),
      isolation: so(opts, "isolation"),
      startup_script: so(opts, "startupScript"),
    }
  }

  pub fn kind(&self) -> Kind {
    self.kind.unwrap_or(Kind::Redis)
  }

  /// `cfg.port || dflt`
  pub fn port_or(&self, dflt: u16) -> u16 {
    if self.port > 0.0 && self.port <= 65535.0 {
      self.port as u16
    } else {
      dflt
    }
  }

  /// `cfg.host || 'localhost'`
  pub fn host_or_localhost(&self) -> String {
    if self.host.is_empty() {
      "localhost".into()
    } else {
      self.host.clone()
    }
  }
}

/// `p.startsWith('~') ? homedir() + p.slice(1) : p`
pub fn expand_home(p: &str) -> String {
  match p.strip_prefix('~') {
    Some(rest) => format!("{}{rest}", crate::services::paths::home().to_string_lossy()),
    None => p.to_string(),
  }
}

/// Idle pool connections close after this long (pg idleTimeoutMillis, mysql2 idleTimeout).
pub const POOL_IDLE_MS: u64 = 5 * 60_000;
/// A manual-commit session with no open transaction disconnects after this long unused.
pub const SESSION_IDLE_MS: u64 = 10 * 60_000;

/// The runtime every pool, session and timer lives on: Tauri's, whichever
/// thread asks (the MCP server's threads have none of their own).
pub fn runtime() -> tokio::runtime::Handle {
  tauri::async_runtime::handle().inner().clone()
}

/// Closes every pool and session (app exit).
pub async fn close_all() {
  pg::close_all().await;
  my::close_all().await;
  sl::close_all().await;
}
