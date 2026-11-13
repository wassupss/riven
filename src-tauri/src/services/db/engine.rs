// DB entry points (src/main/db/engine.ts): the db:* channels the panels call
// and the riven_db_* MCP tools agents call. Browsing, querying, editing and
// DDL go through the connection's driver; roles, monitoring, backup and the
// other tools are PostgreSQL-only.
//
// Arguments arrive positionally as the page sent them, with None for
// `undefined` (db:save tells an omitted password from a null one). The page
// side (dialogs, events) comes in through Ctx so the same table runs under the
// app and under the comparison harness.

use super::export::{open_export, safe_name, ExportOptions, XLSX_MAX_ROWS};
use super::js::{self, num_str, utf16_len};
use super::sqltext::{is_ddl, paged_query, read_only_violation, statements, unsafe_statement};
use super::{dump, err, import, my, mymeta, mywire::Param, num, pg, pgmeta, sl, slmeta, store, Cell, Cfg, DbErr, Exec, Kind, QueryResult, R};
use serde_json::{json, Value};
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};

const AGENT_TIMEOUT_MS: f64 = 30_000.0;
const DDL_TIMEOUT_MS: f64 = 10.0 * 60_000.0;
const AGENT_DEFAULT_LIMIT: f64 = 100.0;
const AGENT_MAX_LIMIT: f64 = 1000.0;
const CELL_MAX: usize = 500;
const OUTPUT_MAX: usize = 20_000;

/// Positional argument names per channel (the preload's, for the Tauri commands).
pub const CHANNELS: &[(&str, &[&str])] = &[
  ("db:list", &[]),
  ("db:save", &["cfg", "password"]),
  ("db:delete", &["id"]),
  ("db:test", &["cfg", "password"]),
  ("db:sqlite-pick", &[]),
  ("db:databases", &["id"]),
  ("db:schemas", &["id", "db"]),
  ("db:objects", &["id", "db", "schema"]),
  ("db:table", &["id", "db", "schema", "name"]),
  ("db:ddl", &["id", "db", "schema", "name"]),
  ("db:query", &["id", "db", "sql", "o"]),
  ("db:session-commit", &["session"]),
  ("db:session-rollback", &["session"]),
  ("db:session-status", &["session"]),
  ("db:session-close", &["session"]),
  ("db:editTarget", &["id", "db", "table"]),
  ("db:apply", &["id", "db", "session", "stmts"]),
  ("db:ddl-apply", &["id", "db", "plan"]),
  ("db:roles", &["id"]),
  ("db:privileges", &["id", "db", "target"]),
  ("db:default-acl", &["id", "db"]),
  ("db:rls", &["id", "db", "schema", "table"]),
  ("db:completion-meta", &["id", "db"]),
  ("db:role-grants", &["id", "db", "role"]),
  ("db:mon-overview", &["id", "db"]),
  ("db:mon-sessions", &["id", "db"]),
  ("db:mon-locks", &["id", "db"]),
  ("db:mon-tables", &["id", "db"]),
  ("db:mon-indexes", &["id", "db"]),
  ("db:mon-settings", &["id", "db"]),
  ("db:mon-signal", &["id", "db", "pid", "terminate"]),
  ("db:mon-reload", &["id", "db"]),
  ("db:cancel", &["id", "queryId"]),
  ("db:column", &["id", "db", "table", "attnum"]),
  ("db:erd", &["id", "db", "schema"]),
  ("db:schema-snapshot", &["id", "db", "schema"]),
  ("db:save-text", &["name", "ext", "text"]),
  ("db:import-pick", &[]),
  ("db:search-tables", &["id", "db", "o"]),
  ("db:search-run", &["id", "db", "o", "searchId"]),
  ("db:search-cancel", &["searchId"]),
  ("db:import-preview", &["path", "encoding", "delimiter"]),
  ("db:import-run", &["id", "db", "o", "queryId"]),
  ("db:import-cancel", &["id", "queryId"]),
  ("db:backup-tools", &["extra", "refresh"]),
  ("db:backup-server", &["id", "db"]),
  ("db:backup-run", &["id", "db", "toolDir", "extra", "name", "o", "jobId"]),
  ("db:restore-pick", &["dir"]),
  ("db:restore-inspect", &["path", "toolDir", "extra"]),
  ("db:restore-run", &["id", "db", "toolDir", "extra", "o", "jobId"]),
  ("db:backup-cancel", &["jobId"]),
  ("db:export", &["id", "db", "req"]),
];

pub type BoxFut<T> = Pin<Box<dyn Future<Output = T> + Send>>;

/// A native file dialog request (Electron's showOpenDialog / showSaveDialog options).
#[derive(Clone, Debug)]
pub enum Dialog {
  Open { directory: bool, create_dirs: bool, filters: Vec<(String, Vec<String>)> },
  Save { default_path: String, filters: Vec<(String, Vec<String>)> },
}

/// What a channel needs from the page that called it.
#[derive(Clone)]
pub struct Ctx {
  /// webContents.send to the caller: (channel, args).
  pub emit: Arc<dyn Fn(&str, Vec<Value>) + Send + Sync>,
  /// A dialog on the caller's window: the chosen path, or None when cancelled.
  pub dialog: Arc<dyn Fn(Dialog) -> BoxFut<Option<String>> + Send + Sync>,
}

// ---- argument helpers ------------------------------------------------------------------

struct Args(Vec<Option<Value>>);

impl Args {
  fn v(&self, i: usize) -> Option<&Value> {
    self.0.get(i).and_then(|x| x.as_ref())
  }
  /// A string argument (`string | undefined`), anything else as String(v).
  fn s(&self, i: usize) -> String {
    match self.v(i) {
      None => "undefined".into(),
      Some(Value::String(s)) => s.clone(),
      Some(v) => js::string(v),
    }
  }
  /// `db?: string`: None for undefined/null.
  fn opt(&self, i: usize) -> Option<String> {
    match self.v(i) {
      None | Some(Value::Null) => None,
      Some(Value::String(s)) => Some(s.clone()),
      Some(v) => Some(js::string(v)),
    }
  }
  fn truthy(&self, i: usize) -> bool {
    js::truthy(self.v(i))
  }
  fn num(&self, i: usize) -> f64 {
    self.v(i).and_then(Value::as_f64).unwrap_or(f64::NAN)
  }
}

fn get<'a>(v: Option<&'a Value>, k: &str) -> Option<&'a Value> {
  v.and_then(|v| v.get(k)).filter(|x| !x.is_null())
}

// ---- dispatch on the connection's kind ---------------------------------------------------

fn not_supported(cfg: &Cfg) -> DbErr {
  DbErr::new(format!("{} connections are not supported yet", if cfg.kind_str.is_empty() { "undefined" } else { &cfg.kind_str }))
}

fn check_driver(cfg: &Cfg) -> R<()> {
  match cfg.kind {
    Some(Kind::Postgres | Kind::Mysql | Kind::Sqlite) => Ok(()),
    _ => Err(not_supported(cfg)),
  }
}

fn require_pg(cfg: Cfg) -> R<Cfg> {
  if cfg.kind != Some(Kind::Postgres) {
    return err(format!("Not available for {} (PostgreSQL only)", cfg.kind().label()));
  }
  Ok(cfg)
}

fn by_id(id: &str) -> R<Cfg> {
  let c = store::get(id).ok_or_else(|| DbErr::new("Unknown connection"))?;
  check_driver(&c)?;
  Ok(c)
}

fn pg_by_id(id: &str) -> R<Cfg> {
  require_pg(by_id(id)?)
}

fn db_name(cfg: &Cfg, db: Option<&str>) -> String {
  if let Some(d) = db.filter(|d| !d.is_empty()) {
    return d.into();
  }
  if !cfg.database.is_empty() {
    return cfg.database.clone();
  }
  cfg.kind().default_db().into()
}

async fn close_everywhere(id: &str) {
  pg::close_connection(id).await;
  my::close_connection(id).await;
  sl::close_connection(id).await;
}

fn schemas_value(v: Vec<(String, bool)>) -> Value {
  Value::Array(v.into_iter().map(|(name, sys)| json!({ "name": name, "isSystem": sys })).collect())
}

async fn list_databases(cfg: &Cfg) -> R<Value> {
  match cfg.kind() {
    Kind::Postgres => pgmeta::list_databases(cfg).await,
    Kind::Mysql => mymeta::list_databases(cfg).await,
    Kind::Sqlite => Ok(slmeta::list_databases()),
    Kind::Redis => Err(not_supported(cfg)),
  }
}

async fn list_schemas(cfg: &Cfg, db: Option<&str>) -> R<Vec<(String, bool)>> {
  match cfg.kind() {
    Kind::Postgres => pgmeta::list_schemas(cfg, db).await,
    Kind::Mysql => Ok(mymeta::list_schemas(cfg, db)),
    Kind::Sqlite => slmeta::list_schemas(cfg).await,
    Kind::Redis => Err(not_supported(cfg)),
  }
}

async fn list_objects(cfg: &Cfg, db: Option<&str>, schema: &str) -> R<Vec<Value>> {
  match cfg.kind() {
    Kind::Postgres => pgmeta::list_objects(cfg, db, schema).await,
    Kind::Mysql => mymeta::list_objects(cfg, db, schema).await,
    Kind::Sqlite => slmeta::list_objects(cfg, schema).await,
    Kind::Redis => Err(not_supported(cfg)),
  }
}

async fn find_schema(cfg: &Cfg, db: Option<&str>, name: &str) -> R<Option<String>> {
  match cfg.kind() {
    Kind::Postgres => pgmeta::find_schema(cfg, db, name).await,
    Kind::Mysql => mymeta::find_schema(cfg, db, name).await,
    Kind::Sqlite => slmeta::find_schema(cfg, name).await,
    Kind::Redis => Err(not_supported(cfg)),
  }
}

async fn table_info(cfg: &Cfg, db: Option<&str>, schema: &str, name: &str) -> R<Option<pgmeta::TableInfo>> {
  match cfg.kind() {
    Kind::Postgres => pgmeta::table_info(cfg, db, schema, name).await,
    Kind::Mysql => mymeta::table_info(cfg, db, schema, name).await,
    Kind::Sqlite => slmeta::table_info(cfg, schema, name).await,
    Kind::Redis => Err(not_supported(cfg)),
  }
}

async fn object_ddl(cfg: &Cfg, db: Option<&str>, schema: &str, name: &str) -> R<String> {
  match cfg.kind() {
    Kind::Postgres => pgmeta::object_ddl(cfg, db, schema, name).await,
    Kind::Mysql => mymeta::object_ddl(cfg, db, schema, name).await,
    Kind::Sqlite => slmeta::object_ddl(cfg, schema, name).await,
    Kind::Redis => Err(not_supported(cfg)),
  }
}

async fn run_query(cfg: &Cfg, db: Option<&str>, sql: &str, limit: usize, read_only: bool, timeout_ms: Option<f64>, query_id: Option<&str>, skip: usize) -> R<QueryResult> {
  match cfg.kind() {
    Kind::Postgres => pg::query(cfg, db, sql, &pg::QOpts { limit, read_only, timeout_ms, query_id }).await,
    Kind::Mysql => my::query(cfg, db, sql, limit, read_only, timeout_ms, query_id, skip).await,
    Kind::Sqlite => sl::query(cfg, sql, limit, read_only, timeout_ms, query_id, skip).await,
    Kind::Redis => Err(not_supported(cfg)),
  }
}

async fn session_query(cfg: &Cfg, db: Option<&str>, id: &str, sql: &str, limit: usize, query_id: Option<&str>, aux: bool, skip: usize) -> R<QueryResult> {
  match cfg.kind() {
    Kind::Postgres => pg::session_query(cfg, db, id, sql, &pg::SOpts { limit, query_id, aux }).await,
    Kind::Mysql => my::session_query(cfg, db, id, sql, limit, query_id, aux, skip).await,
    Kind::Sqlite => sl::session_query(cfg, id, sql, limit, query_id, aux, skip).await,
    Kind::Redis => Err(not_supported(cfg)),
  }
}

fn has_session(cfg: &Cfg, id: &str) -> bool {
  match cfg.kind() {
    Kind::Postgres => pg::has_session(id),
    Kind::Mysql => my::has_session(id),
    Kind::Sqlite => sl::has_session(id),
    Kind::Redis => false,
  }
}

async fn execute(cfg: &Cfg, db: Option<&str>, stmts: &[String], timeout_ms: f64) -> R<Vec<Exec>> {
  match cfg.kind() {
    Kind::Postgres => pg::execute(cfg, db, stmts, timeout_ms).await,
    Kind::Mysql => my::execute(cfg, db, stmts, timeout_ms).await,
    Kind::Sqlite => sl::execute(cfg, stmts, timeout_ms).await,
    Kind::Redis => Err(not_supported(cfg)),
  }
}

// A session lives in exactly one driver; an unknown id answers like an idle one.
#[derive(Clone, Copy)]
enum SessionDriver {
  Pg,
  My,
  Sl,
}
fn session_driver(id: &str) -> SessionDriver {
  if pg::has_session(id) {
    SessionDriver::Pg
  } else if my::has_session(id) {
    SessionDriver::My
  } else if sl::has_session(id) {
    SessionDriver::Sl
  } else {
    SessionDriver::Pg
  }
}

async fn session_end(id: &str, action: &str) -> R<&'static str> {
  match session_driver(id) {
    SessionDriver::Pg => pg::session_end(id, action).await,
    SessionDriver::My => my::session_end(id, action).await,
    SessionDriver::Sl => sl::session_end(id, action).await,
  }
}

// ---- text formatting for agents ------------------------------------------------------------

fn slice16(s: &str, n: usize) -> String {
  js::utf16_slice(s, n)
}

fn cell_text(v: &Value) -> String {
  if v.is_null() {
    return "NULL".into();
  }
  let t = js::string(v).replace("\r\n", "\\n").replace('\n', "\\n").replace('\t', " ");
  if utf16_len(&t) > CELL_MAX {
    slice16(&t, CELL_MAX) + "…"
  } else {
    t
  }
}

fn pad_end(s: &str, w: usize) -> String {
  let n = utf16_len(s);
  if n >= w {
    s.to_string()
  } else {
    format!("{s}{}", " ".repeat(w - n))
  }
}

/// Pipe table capped at OUTPUT_MAX chars; says how many rows were cut.
pub fn format_table(headers: &[String], rows: &[Vec<Value>]) -> String {
  if headers.is_empty() {
    return "(no columns)".into();
  }
  let cells: Vec<Vec<String>> = rows.iter().map(|r| r.iter().map(cell_text).collect()).collect();
  let width: Vec<usize> = headers
    .iter()
    .enumerate()
    .map(|(i, h)| {
      let m = cells.iter().map(|r| r.get(i).map(|c| utf16_len(c)).unwrap_or(0)).fold(utf16_len(h), usize::max);
      m.min(60)
    })
    .collect();
  let line = |r: &[String]| -> String {
    // r.map over the row's own cells: a short row has fewer columns.
    r.iter().enumerate().map(|(i, c)| pad_end(c, width.get(i).copied().unwrap_or(0))).collect::<Vec<_>>().join(" | ").trim_end_matches(js::js_space).to_string()
  };
  let mut out = vec![line(headers), width.iter().map(|w| "-".repeat(*w)).collect::<Vec<_>>().join("-+-")];
  let mut len = utf16_len(&out[0]) + utf16_len(&out[1]);
  for (i, r) in cells.iter().enumerate() {
    let l = line(r);
    let ll = utf16_len(&l);
    if len + ll + 1 > OUTPUT_MAX {
      out.push(format!("… {} more row(s) not shown (output limit)", cells.len() - i));
      break;
    }
    out.push(l);
    len += ll + 1;
  }
  out.join("\n")
}

fn cells_to_values(rows: &[Vec<Cell>]) -> Vec<Vec<Value>> {
  rows.iter().map(|r| r.iter().map(|c| serde_json::to_value(c).unwrap_or(Value::Null)).collect()).collect()
}

fn format_result(r: &QueryResult) -> String {
  if r.columns.is_empty() {
    return format!(
      "{}{} ({} ms)",
      if r.command.is_empty() { "OK" } else { &r.command },
      r.row_count.map(|n| format!(" {}", num_str(n))).unwrap_or_default(),
      num_str(r.time_ms)
    );
  }
  let head = format!(
    "{} row(s){}, {} ms",
    r.rows.len(),
    if r.truncated { format!(" (truncated at {}; add LIMIT/WHERE or raise limit)", r.rows.len()) } else { String::new() },
    num_str(r.time_ms)
  );
  let names: Vec<String> = r.columns.iter().map(|c| c.name.clone()).collect();
  format!("{head}\n{}", format_table(&names, &cells_to_values(&r.rows)))
}

// ---- MCP tools -----------------------------------------------------------------------------

fn a(v: Option<&Value>) -> String {
  match v {
    Some(Value::String(s)) => js::trim(s).to_string(),
    None | Some(Value::Null) => String::new(),
    Some(v) => js::string(v),
  }
}

/// schema.table / "Schema"."Table" / table -> (schema|None, table).
fn split_qualified(name: &str) -> (Option<String>, String) {
  static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
  let re = RE.get_or_init(|| regex::Regex::new(r#""((?:[^"]|"")*)"|([^.]+)"#).expect("re"));
  let parts: Vec<String> = re
    .captures_iter(name)
    .map(|m| match m.get(1) {
      Some(q) => q.as_str().replace("\"\"", "\""),
      None => js::trim(&m[2]).to_string(),
    })
    .collect();
  if parts.len() >= 2 {
    (Some(parts[parts.len() - 2].clone()), parts[parts.len() - 1].clone())
  } else {
    (None, parts.first().cloned().unwrap_or_else(|| name.to_string()))
  }
}

fn jstr(v: Option<&Value>) -> String {
  match v {
    None => "undefined".into(),
    Some(v) => js::string(v),
  }
}

async fn tool_connections() -> R<String> {
  let list = store::list();
  if list.is_empty() {
    return Ok("No data sources yet. The user can add one in riven (DB Explorer panel).".into());
  }
  let headers: Vec<String> = ["name", "kind", "host", "database", "user", "read_only", "id"].iter().map(|s| s.to_string()).collect();
  let rows: Vec<Vec<Value>> = list
    .iter()
    .map(|c| {
      let f = |k: &str| c.get(k).cloned().unwrap_or(Value::Null);
      let db = match c.get("database") {
        Some(v) if js::truthy(Some(v)) => v.clone(),
        _ => Value::String(String::new()),
      };
      vec![
        f("name"),
        f("kind"),
        Value::String(format!("{}:{}", jstr(c.get("host")), jstr(c.get("port")))),
        db,
        f("user"),
        Value::String(if js::truthy(c.get("readOnly")) { "yes" } else { "no" }.into()),
        f("id"),
      ]
    })
    .collect();
  Ok(format_table(&headers, &rows))
}

async fn tool_browse(args: &Value) -> R<String> {
  let cfg = store::resolve(&a(args.get("connection")))?;
  check_driver(&cfg)?;
  let dbs = a(args.get("database"));
  let db = (!dbs.is_empty()).then_some(dbs.as_str());
  let schema = a(args.get("schema"));
  if !schema.is_empty() {
    let objs = list_objects(&cfg, db, &schema).await?;
    if objs.is_empty() {
      return Ok(format!("Schema {schema} has no tables, views or routines (or does not exist)."));
    }
    let headers: Vec<String> = ["name", "kind", "rows≈ / signature", "comment"].iter().map(|s| s.to_string()).collect();
    let rows: Vec<Vec<Value>> = objs
      .iter()
      .map(|o| {
        let third = match o.get("args") {
          Some(args) => Value::String(format!("({}) -> {}", js::string(args), jstr(o.get("result")))),
          None => match o.get("rows") {
            None | Some(Value::Null) => Value::String(String::new()),
            Some(r) => r.clone(),
          },
        };
        let comment = match o.get("comment") {
          None | Some(Value::Null) => Value::String(String::new()),
          Some(c) => c.clone(),
        };
        vec![o.get("name").cloned().unwrap_or(Value::Null), o.get("kind").cloned().unwrap_or(Value::Null), third, comment]
      })
      .collect();
    return Ok(format_table(&headers, &rows));
  }
  // No schema: the database's schemas, plus (when no database was named) the
  // other databases on the server, so one call orients the agent.
  let schemas: Vec<String> = list_schemas(&cfg, db).await?.into_iter().filter(|s| !s.1).map(|s| s.0).collect();
  let name = db_name(&cfg, db);
  let mut lines = vec![format!(
    "Database {} schemas: {} (system schemas hidden)",
    if name.is_empty() { "(default)" } else { &name },
    if schemas.is_empty() { "(none)".to_string() } else { schemas.join(", ") }
  )];
  if db.is_none() && cfg.kind().has_databases() {
    let list = list_databases(&cfg).await?;
    let names: Vec<String> = list.as_array().map(|a| a.iter().map(js::string).collect()).unwrap_or_default();
    lines.push(format!("Databases on this server: {}", names.join(", ")));
  }
  Ok(lines.join("\n"))
}

async fn tool_describe(args: &Value) -> R<String> {
  let cfg = store::resolve(&a(args.get("connection")))?;
  check_driver(&cfg)?;
  let dbs = a(args.get("database"));
  let db = (!dbs.is_empty()).then_some(dbs.as_str());
  let (qs, name) = split_qualified(&a(args.get("table")));
  if name.is_empty() {
    return Ok("error: table is required".into());
  }
  let given = a(args.get("schema"));
  let schema = if !given.is_empty() {
    Some(given)
  } else if let Some(q) = qs.filter(|q| !q.is_empty()) {
    Some(q)
  } else {
    find_schema(&cfg, db, &name).await?
  };
  let Some(schema) = schema.filter(|s| !s.is_empty()) else { return Ok(format!("error: no table, view or routine named {name}")) };
  if args.get("ddl") == Some(&Value::Bool(true)) {
    return object_ddl(&cfg, db, &schema, &name).await;
  }
  let Some(t) = table_info(&cfg, db, &schema, &name).await? else { return object_ddl(&cfg, db, &schema, &name).await };
  let mut out = vec![format!("{} {}.{}{}", t.kind, t.schema, t.name, t.comment.as_deref().filter(|c| !c.is_empty()).map(|c| format!(" -- {c}")).unwrap_or_default())];
  let headers: Vec<String> = ["column", "type", "null", "default", "pk", "comment"].iter().map(|s| s.to_string()).collect();
  out.push(format_table(
    &headers,
    &t.columns
      .iter()
      .map(|c| {
        vec![
          Value::String(c.name.clone()),
          Value::String(c.ty.clone()),
          Value::String(if c.nullable { "yes" } else { "no" }.into()),
          Value::String(c.default.clone().unwrap_or_default()),
          Value::String(if c.primary_key { "PK" } else { "" }.into()),
          Value::String(c.comment.clone().unwrap_or_default()),
        ]
      })
      .collect::<Vec<_>>(),
  ));
  if !t.constraints.is_empty() {
    out.push(format!("Constraints:\n{}", t.constraints.iter().map(|(n, _, d)| format!("  {n} {d}")).collect::<Vec<_>>().join("\n")));
  }
  if !t.indexes.is_empty() {
    out.push(format!("Indexes:\n{}", t.indexes.iter().map(|(_, d, _, _)| format!("  {d}")).collect::<Vec<_>>().join("\n")));
  }
  Ok(out.join("\n\n"))
}

fn strip_trailing_semicolon(sql: &str) -> String {
  // sql.replace(/;\s*$/, '')
  let t = sql.trim_end_matches(js::js_space);
  match t.strip_suffix(';') {
    Some(x) if sql[x.len() + 1..].chars().all(js::js_space) => x.to_string(),
    _ => sql.to_string(),
  }
}

async fn tool_query(args: &Value) -> R<String> {
  let cfg = store::resolve(&a(args.get("connection")))?;
  let sql = strip_trailing_semicolon(&a(args.get("sql")));
  if sql.is_empty() {
    return Ok("error: sql is required".into());
  }
  if let Some(bad) = read_only_violation(&sql, cfg.kind(), true) {
    return Ok(format!("refused: {bad}. riven_db_query is read-only; use riven_db_execute for changes."));
  }
  let n = match args.get("limit") {
    Some(Value::Number(n)) => n.as_f64().unwrap_or(AGENT_DEFAULT_LIMIT).floor(),
    _ => AGENT_DEFAULT_LIMIT,
  };
  let limit = n.max(1.0).min(AGENT_MAX_LIMIT) as usize;
  check_driver(&cfg)?;
  let dbs = a(args.get("database"));
  let db = (!dbs.is_empty()).then_some(dbs.as_str());
  let r = run_query(&cfg, db, &sql, limit, true, Some(AGENT_TIMEOUT_MS), None, 0).await?;
  Ok(format_result(&r))
}

pub type Ask = Box<dyn FnOnce(String, Vec<String>) -> BoxFut<String> + Send>;

async fn tool_execute(args: &Value, ask: Ask) -> R<String> {
  let cfg = store::resolve(&a(args.get("connection")))?;
  check_driver(&cfg)?;
  if cfg.read_only {
    return Ok(format!("refused: data source \"{}\" is read-only.", cfg.name));
  }
  let raw: Vec<String> = match args.get("statements") {
    Some(Value::Array(x)) => x.iter().map(|v| a(Some(v))).collect(),
    other => vec![a(match other {
      None | Some(Value::Null) => args.get("sql"),
      o => o,
    })],
  };
  let stmts: Vec<String> = raw.iter().flat_map(|s| statements(s, cfg.kind())).collect();
  if stmts.is_empty() {
    return Ok("error: statements is required".into());
  }
  let db = db_name(&cfg, Some(&a(args.get("database"))));
  let mut warnings: Vec<String> = vec![];
  for w in stmts.iter().filter_map(|s| unsafe_statement(s, cfg.kind())) {
    if !warnings.contains(&w) {
      warnings.push(w);
    }
  }
  let preview = stmts.iter().map(|s| if utf16_len(s) > 300 { slice16(s, 300) + "…" } else { s.clone() }).collect::<Vec<_>>().join(";\n");
  let mut question = format!("{}{} 에 아래 SQL {}개를 한 트랜잭션으로 실행할까요?\n\n{preview}", cfg.name, if db.is_empty() { String::new() } else { format!(" / {db}") }, stmts.len());
  if !warnings.is_empty() {
    question += &format!("\n\n주의: {}", warnings.join(", "));
  }
  let answer = ask(question, vec!["실행".into(), "취소".into()]).await;
  if answer != "실행" {
    if answer.starts_with("riven: ask_user is only available") {
      return Ok("refused: riven_db_execute needs the user to confirm in a riven chat pane. Show the SQL to the user instead.".into());
    }
    return Ok(format!("not executed: the user did not approve ({}).", if answer.is_empty() { "no answer" } else { &answer }));
  }
  let results = execute(&cfg, (!db.is_empty()).then_some(db.as_str()), &stmts, AGENT_TIMEOUT_MS).await?;
  Ok(format!(
    "committed:\n{}",
    results
      .iter()
      .enumerate()
      .map(|(i, r)| match &r.command {
        Some(c) => format!("  {}. {c}{}", i + 1, r.row_count.map(|n| format!(" {}", num_str(n))).unwrap_or_default()),
        // A multi-statement simple query gave node-pg an array: both undefined.
        None => format!("  {}. undefined undefined", i + 1),
      })
      .collect::<Vec<_>>()
      .join("\n")
  ))
}

/// Run a riven_db_* tool; never fails (errors become the result text).
pub async fn run_db_tool(tool: &str, args: &Value, ask: Ask) -> String {
  let r = match tool {
    "riven_db_connections" => tool_connections().await,
    "riven_db_browse" => tool_browse(args).await,
    "riven_db_describe" => tool_describe(args).await,
    "riven_db_query" => tool_query(args).await,
    "riven_db_execute" => tool_execute(args, ask).await,
    _ => return format!("error: unknown tool {tool}"),
  };
  r.unwrap_or_else(|e| format!("error: {}", e.msg))
}

// ---- the panels' channels -------------------------------------------------------------------

fn filters(list: &[(&str, &[&str])]) -> Vec<(String, Vec<String>)> {
  list.iter().map(|(n, e)| (n.to_string(), e.iter().map(|x| x.to_string()).collect())).collect()
}

fn export_filter(ext: &str) -> Option<(&'static str, &'static [&'static str])> {
  Some(match ext {
    "xlsx" => ("Excel", &["xlsx"]),
    "csv" => ("CSV", &["csv"]),
    "tsv" => ("TSV", &["tsv"]),
    "json" => ("JSON", &["json"]),
    "sql" => ("SQL", &["sql"]),
    _ => return None,
  })
}

fn save_text_filter(ext: &str) -> Option<(&'static str, &'static [&'static str])> {
  Some(match ext {
    "svg" => ("SVG", &["svg"]),
    "sql" => ("SQL", &["sql"]),
    "mmd" => ("Mermaid", &["mmd", "md"]),
    "txt" => ("Text", &["txt"]),
    _ => return None,
  })
}

fn dev_env(name: &str) -> Option<String> {
  std::env::var(name).ok().filter(|v| !v.is_empty())
}

fn result_value(r: QueryResult) -> Value {
  serde_json::to_value(r).unwrap_or(Value::Null)
}

fn rows_value(rows: Vec<Option<Vec<Cell>>>) -> Value {
  serde_json::to_value(rows).unwrap_or(Value::Null)
}

/// MySQL can't wrap a result with duplicate column names in a derived table (1060).
fn duplicate_columns(e: &DbErr) -> bool {
  e.errno == Some(1060)
}

fn values_of(v: Option<&Value>) -> Vec<Value> {
  v.and_then(Value::as_array).cloned().unwrap_or_default()
}

fn my_param(v: &Value) -> Param {
  match v {
    Value::Null => Param::Null,
    Value::Number(n) => Param::Num(n.as_f64().unwrap_or(0.0)),
    Value::String(s) => Param::Str(s.clone()),
    v => Param::Str(js::string(v)),
  }
}

fn sl_value(v: &Value) -> Option<String> {
  match v {
    Value::Null => None,
    Value::String(s) => Some(s.clone()),
    v => Some(js::string(v)),
  }
}

async fn tool_at(dir: Option<String>, extra: Option<String>) -> R<dump::ToolInfo> {
  let tools = dump::find_tools(extra.as_deref().filter(|e| !e.is_empty()), false).await;
  let t = match dir.filter(|d| !d.is_empty()) {
    Some(d) => tools.into_iter().find(|x| x.dir == d),
    None => tools.into_iter().next(),
  };
  t.ok_or_else(|| DbErr::new("pg_dump not found. Install the PostgreSQL client tools or pick their folder."))
}

async fn server_version_major(cfg: &Cfg, db: Option<&str>) -> R<f64> {
  let r = pg::rows(cfg, db, "show server_version_num", &[]).await?;
  let n = match r.first().and_then(|x| x.first()) {
    None => f64::NAN,
    Some(c) => c.number(),
  };
  Ok(dump::server_major(n))
}

/// One db:* channel. `args` are positional, None for undefined.
pub async fn call(ch: &str, args: Vec<Option<Value>>, ctx: Ctx) -> R<Value> {
  let a = Args(args);
  let id = || a.s(0);
  let dbo = || a.opt(1);
  match ch {
    "db:list" => Ok(Value::Array(store::list())),
    "db:save" => {
      let password = match a.v(1) {
        None => None,
        Some(Value::Null) => Some(None),
        Some(v) => Some(Some(match v {
          Value::String(s) => s.clone(),
          v => js::string(v),
        })),
      };
      let saved = store::save_connection(a.v(0).unwrap_or(&Value::Null), password)?;
      // config (even kind) may have changed: reconnect lazily
      close_everywhere(saved.get("id").and_then(Value::as_str).unwrap_or("")).await;
      Ok(saved)
    }
    "db:delete" => {
      let id = id();
      close_everywhere(&id).await;
      store::delete_connection(&id)?;
      Ok(Value::Null)
    }
    "db:test" => {
      let cfg = Cfg::from_value(a.v(0).unwrap_or(&Value::Null));
      check_driver(&cfg)?;
      let pw = a.opt(1);
      let v = match cfg.kind() {
        Kind::Postgres => pg::test(&cfg, pw).await?,
        Kind::Mysql => my::test(&cfg, pw).await?,
        _ => sl::test(&cfg).await?,
      };
      Ok(Value::String(v))
    }
    "db:sqlite-pick" => {
      if let Some(f) = dev_env("RIVEN_DEV_SQLITE_FILE") {
        return Ok(Value::String(f));
      }
      let pick = (ctx.dialog)(Dialog::Open {
        directory: false,
        create_dirs: true,
        filters: filters(&[("SQLite", &["db", "sqlite", "sqlite3", "db3"]), ("All files", &["*"])]),
      })
      .await;
      Ok(pick.map(Value::String).unwrap_or(Value::Null))
    }
    "db:databases" => list_databases(&by_id(&id())?).await,
    "db:schemas" => {
      let cfg = by_id(&id())?;
      Ok(schemas_value(list_schemas(&cfg, dbo().as_deref()).await?))
    }
    "db:objects" => {
      let cfg = by_id(&id())?;
      Ok(Value::Array(list_objects(&cfg, dbo().as_deref(), &a.s(2)).await?))
    }
    "db:table" => {
      let cfg = by_id(&id())?;
      Ok(table_info(&cfg, dbo().as_deref(), &a.s(2), &a.s(3)).await?.map(|t| t.to_value()).unwrap_or(Value::Null))
    }
    "db:ddl" => {
      let cfg = by_id(&id())?;
      Ok(Value::String(object_ddl(&cfg, dbo().as_deref(), &a.s(2), &a.s(3)).await?))
    }
    "db:query" => {
      let cfg = by_id(&id())?;
      let db = dbo();
      let original = a.s(2);
      let mut sql = original.clone();
      if cfg.read_only {
        if let Some(bad) = read_only_violation(&sql, cfg.kind(), false) {
          return err(bad);
        }
      }
      let o = a.v(3);
      let offset = get(o, "offset").and_then(Value::as_f64).filter(|x| *x != 0.0 && !x.is_nan());
      // A later page of an earlier result: only plain reads may be re-run.
      if let Some(off) = offset {
        sql = paged_query(&sql, cfg.kind(), off).ok_or_else(|| DbErr::new("This query cannot be paged"))?;
      }
      let limit = get(o, "limit").and_then(Value::as_f64).unwrap_or(1000.0).max(1.0).min(100_000.0) as usize;
      let query_id = get(o, "queryId").map(|v| js::string(v));
      let aux = js::truthy(get(o, "aux"));
      // A manual-commit tab runs on its own connection. Paging and counts join
      // it only while it exists (to see the open transaction's rows).
      let session = get(o, "session").filter(|v| js::truthy(Some(v))).map(js::string).filter(|s| !aux || has_session(&cfg, s));
      let run = |text: String, skip: usize| {
        let (cfg, db, session, query_id) = (cfg.clone(), db.clone(), session.clone(), query_id.clone());
        async move {
          match &session {
            Some(s) => session_query(&cfg, db.as_deref(), s, &text, limit, query_id.as_deref(), aux, skip).await,
            None => run_query(&cfg, db.as_deref(), &text, limit, false, None, query_id.as_deref(), skip).await,
          }
        }
      };
      match run(sql, 0).await {
        Ok(r) => Ok(result_value(r)),
        // Re-read from the start and skip on the client instead.
        Err(e) if offset.is_some() && cfg.kind() == Kind::Mysql && duplicate_columns(&e) => Ok(result_value(run(original, offset.unwrap_or(0.0).max(0.0) as usize).await?)),
        Err(e) => Err(e),
      }
    }
    "db:session-commit" => Ok(Value::String(session_end(&a.s(0), "commit").await?.into())),
    "db:session-rollback" => Ok(Value::String(session_end(&a.s(0), "rollback").await?.into())),
    "db:session-status" => {
      let s = a.s(0);
      Ok(Value::String(
        match session_driver(&s) {
          SessionDriver::Pg => pg::session_status(&s).await,
          SessionDriver::My => my::session_status(&s).await,
          SessionDriver::Sl => sl::session_status(&s).await,
        }
        .into(),
      ))
    }
    "db:session-close" => {
      let s = a.s(0);
      match session_driver(&s) {
        SessionDriver::Pg => pg::session_close(&s).await,
        SessionDriver::My => my::session_close(&s).await,
        SessionDriver::Sl => sl::session_close(&s).await,
      }
      Ok(Value::Null)
    }
    "db:editTarget" => {
      let cfg = by_id(&id())?;
      let t = a.num(2);
      match cfg.kind() {
        Kind::Postgres => pgmeta::edit_target(&cfg, dbo().as_deref(), t).await,
        Kind::Mysql => mymeta::edit_target(&cfg, dbo().as_deref(), t).await,
        _ => slmeta::edit_target(&cfg, t).await,
      }
    }
    "db:apply" => {
      let cfg = by_id(&id())?;
      if cfg.read_only {
        return err("This connection is read-only");
      }
      let stmts = match a.v(3) {
        Some(Value::Array(x)) if !x.is_empty() => x.clone(),
        _ => return Ok(json!([])),
      };
      let session = a.opt(2).filter(|s| !s.is_empty());
      let text = |s: &Value| s.get("text").map(js::string).unwrap_or_else(|| "undefined".into());
      let rows = match cfg.kind() {
        Kind::Postgres => {
          let st = stmts.iter().map(|s| pg::EditStmt { text: text(s), values: pg::params(&values_of(s.get("values"))) }).collect();
          pg::apply(&cfg, dbo().as_deref(), session.as_deref(), st).await?
        }
        Kind::Mysql => {
          let st = stmts
            .iter()
            .map(|s| my::EditStmt {
              text: text(s),
              values: values_of(s.get("values")).iter().map(my_param).collect(),
              fetch: s.get("fetch").filter(|f| f.is_object()).map(|f| (text(f), values_of(f.get("values")).iter().map(my_param).collect(), js::truthy(f.get("insertId")))),
            })
            .collect();
          my::apply(&cfg, dbo().as_deref(), session.as_deref(), st).await?
        }
        _ => {
          let st = stmts.iter().map(|s| (text(s), values_of(s.get("values")).iter().map(sl_value).collect())).collect();
          sl::apply(&cfg, session.as_deref(), st).await?
        }
      };
      Ok(rows_value(rows))
    }
    "db:ddl-apply" => {
      let cfg = by_id(&id())?;
      if cfg.read_only {
        return err("This connection is read-only");
      }
      let plan = a.v(2);
      let stmts: Vec<String> = get(plan, "stmts")
        .and_then(Value::as_array)
        .map(|x| x.iter().filter_map(|s| s.as_str()).filter(|s| !js::trim(s).is_empty()).map(str::to_string).collect())
        .unwrap_or_default();
      if stmts.is_empty() {
        return Ok(json!(0));
      }
      let kind = if cfg.kind() == Kind::Redis { Kind::Postgres } else { cfg.kind() };
      if let Some(bad) = stmts.iter().find(|s| !is_ddl(s, kind)) {
        return err(format!("Not a DDL statement: {}", slice16(bad, 60)));
      }
      let db = dbo();
      // Can't drop the database the statement runs on; ours are closed so they don't block it.
      if let Some(rel) = get(plan, "release").filter(|v| js::truthy(Some(v))).map(js::string) {
        if rel == db_name(&cfg, db.as_deref()) {
          return err("Run this from another database");
        }
        let id = id();
        match cfg.kind() {
          Kind::Postgres => pg::close_database(&id, &rel).await,
          Kind::Mysql => my::close_database(&id, &rel).await,
          _ => sl::close_connection(&id).await,
        }
      }
      let search_path = get(plan, "searchPath").and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string);
      let atomic = get(plan, "atomic") != Some(&Value::Bool(false));
      let n = match cfg.kind() {
        Kind::Postgres => pg::ddl(&cfg, db.as_deref(), &stmts, atomic, DDL_TIMEOUT_MS, search_path.as_deref()).await?,
        Kind::Mysql => my::ddl(&cfg, db.as_deref(), &stmts, DDL_TIMEOUT_MS).await?,
        _ => sl::ddl(&cfg, &stmts, atomic, DDL_TIMEOUT_MS).await?,
      };
      Ok(json!(n))
    }
    "db:roles" => pgmeta::list_roles(&pg_by_id(&id())?).await,
    "db:privileges" => {
      let cfg = pg_by_id(&id())?;
      pgmeta::object_privileges(&cfg, dbo().as_deref(), a.v(2).unwrap_or(&Value::Null)).await
    }
    "db:default-acl" => pgmeta::default_acls(&pg_by_id(&id())?, dbo().as_deref()).await,
    "db:rls" => pgmeta::rls_info(&pg_by_id(&id())?, dbo().as_deref(), &a.s(2), &a.s(3)).await,
    "db:completion-meta" => {
      let cfg = by_id(&id())?;
      match cfg.kind() {
        Kind::Postgres => pgmeta::completion_meta(&cfg, dbo().as_deref()).await,
        Kind::Mysql => mymeta::completion_meta(&cfg, dbo().as_deref()).await,
        _ => slmeta::completion_meta(&cfg).await,
      }
    }
    "db:role-grants" => pgmeta::role_grants(&pg_by_id(&id())?, dbo().as_deref(), &a.s(2)).await,
    "db:mon-overview" => pgmeta::server_overview(&pg_by_id(&id())?, dbo().as_deref()).await,
    "db:mon-sessions" => pgmeta::list_sessions(&pg_by_id(&id())?, dbo().as_deref()).await,
    "db:mon-locks" => pgmeta::list_locks(&pg_by_id(&id())?, dbo().as_deref()).await,
    "db:mon-tables" => pgmeta::table_stats(&pg_by_id(&id())?, dbo().as_deref()).await,
    "db:mon-indexes" => pgmeta::index_stats(&pg_by_id(&id())?, dbo().as_deref()).await,
    "db:mon-settings" => pgmeta::list_settings(&pg_by_id(&id())?, dbo().as_deref()).await,
    "db:mon-signal" => {
      let cfg = pg_by_id(&id())?;
      if cfg.read_only {
        return err("This connection is read-only");
      }
      let pid = a.num(2);
      if !(pid.is_finite() && pid.fract() == 0.0) || pid <= 0.0 {
        return err("Bad pid");
      }
      Ok(Value::Bool(pgmeta::signal_backend(&cfg, dbo().as_deref(), pid, a.v(3) == Some(&Value::Bool(true))).await?))
    }
    "db:mon-reload" => {
      let cfg = pg_by_id(&id())?;
      if cfg.read_only {
        return err("This connection is read-only");
      }
      Ok(Value::Bool(pgmeta::reload_conf(&cfg, dbo().as_deref()).await?))
    }
    "db:cancel" => {
      let cfg = by_id(&id())?;
      let q = a.s(1);
      Ok(Value::Bool(match cfg.kind() {
        Kind::Postgres => pg::cancel(&cfg, &q).await?,
        Kind::Mysql => my::cancel(&cfg, &q).await?,
        _ => sl::cancel(&q),
      }))
    }
    "db:column" => {
      let cfg = by_id(&id())?;
      let (t, n) = (a.num(2), a.num(3));
      match cfg.kind() {
        Kind::Postgres => pgmeta::column_detail(&cfg, dbo().as_deref(), t, n).await,
        Kind::Mysql => mymeta::column_detail(&cfg, dbo().as_deref(), t, n).await,
        _ => slmeta::column_detail(&cfg, t, n).await,
      }
    }
    "db:erd" => pgmeta::erd_model(&pg_by_id(&id())?, dbo().as_deref(), &a.s(2)).await,
    "db:schema-snapshot" => pgmeta::schema_snapshot(&pg_by_id(&id())?, dbo().as_deref(), &a.s(2)).await,
    // Saves page-made text (a diagram, a script) through a save dialog.
    "db:save-text" => {
      let ext = a.s(1);
      let (Some(Value::String(text)), Some(filter)) = (a.v(2), save_text_filter(&ext)) else { return err("Unsupported file type") };
      let name = a.opt(0).unwrap_or_default();
      let pick = match dev_env("RIVEN_DEV_SAVE_FILE") {
        Some(f) => Some(f),
        None => (ctx.dialog)(Dialog::Save { default_path: format!("{}.{ext}", safe_name(&name, "untitled")), filters: filters(&[filter]) }).await,
      };
      let Some(path) = pick.filter(|p| !p.is_empty()) else { return Ok(Value::Null) };
      std::fs::write(&path, text.as_bytes()).map_err(|e| DbErr::new(format!("{}, open '{path}'", super::pgwire::node_fs_error(&e))))?;
      Ok(Value::String(path))
    }
    "db:import-pick" => {
      // Dev-only hook for driving the dialog without the native picker.
      if let Some(f) = dev_env("RIVEN_DEV_PICK_FILE") {
        return Ok(Value::String(f));
      }
      let pick = (ctx.dialog)(Dialog::Open { directory: false, create_dirs: false, filters: filters(&[("CSV / TSV", &["csv", "tsv", "txt"]), ("All files", &["*"])]) }).await;
      Ok(pick.map(Value::String).unwrap_or(Value::Null))
    }
    "db:search-tables" => {
      let cfg = pg_by_id(&id())?;
      let t = pgmeta::search_tables(&cfg, dbo().as_deref(), a.v(2).unwrap_or(&Value::Null)).await?;
      Ok(Value::Array(t.iter().map(|x| x.to_value()).collect()))
    }
    "db:search-run" => {
      let cfg = pg_by_id(&id())?;
      let search_id = a.s(3);
      let (emit, sid) = (ctx.emit.clone(), search_id.clone());
      pgmeta::run_search(&cfg, dbo().as_deref(), a.v(2).unwrap_or(&Value::Null), &search_id, Arc::new(move |p| emit("db:search-progress", vec![Value::String(sid.clone()), p]))).await
    }
    "db:search-cancel" => {
      pgmeta::cancel_search(&a.s(0)).await;
      Ok(Value::Null)
    }
    "db:import-preview" => {
      let (path, enc, delim) = (a.s(0), a.s(1), a.opt(2));
      super::runtime().spawn_blocking(move || import::preview_csv(&path, &enc, delim.as_deref())).await.map_err(|e| DbErr::new(e.to_string()))?
    }
    "db:import-run" => {
      let cfg = pg_by_id(&id())?;
      if cfg.read_only {
        return err("This connection is read-only");
      }
      let query_id = a.opt(3);
      let last = Arc::new(Mutex::new(0.0f64));
      let (emit, qid) = (ctx.emit.clone(), query_id.clone().filter(|q| !q.is_empty()));
      let progress: import::Progress = Arc::new(move |rows, bytes, size| {
        let Some(q) = &qid else { return };
        let now = js::now_ms();
        let mut l = last.lock().unwrap();
        if now - *l < 100.0 && bytes < size {
          return;
        }
        *l = now;
        emit("db:import-progress", vec![Value::String(q.clone()), num(rows), num(bytes), num(size)]);
      });
      import::run_import(&cfg, dbo().as_deref(), import::ImportOptions::from_value(a.v(2).unwrap_or(&Value::Null)), query_id.as_deref(), progress).await
    }
    "db:import-cancel" => {
      let q = a.s(1);
      import::cancel_import(&q);
      let cfg = pg_by_id(&id())?;
      Ok(Value::Bool(pg::cancel(&cfg, &q).await?))
    }
    // Backup and restore through pg_dump / pg_restore / psql.
    "db:backup-tools" => {
      let extra = a.opt(0).filter(|e| !e.is_empty());
      let tools = dump::find_tools(extra.as_deref(), a.v(1) == Some(&Value::Bool(true))).await;
      Ok(Value::Array(tools.iter().map(|t| t.to_value()).collect()))
    }
    "db:backup-server" => {
      let cfg = pg_by_id(&id())?;
      Ok(num(server_version_major(&cfg, dbo().as_deref()).await?))
    }
    "db:backup-run" => {
      let cfg = pg_by_id(&id())?;
      let tool = tool_at(a.opt(2), a.opt(3)).await?;
      let o = a.v(5).cloned().unwrap_or(Value::Null);
      let job_id = a.s(6);
      let file = match dev_env("RIVEN_DEV_SAVE_FILE") {
        Some(f) => f,
        None => {
          let format = o.get("format").map(js::string).unwrap_or_default();
          let safe = safe_name(&a.opt(4).unwrap_or_default(), "backup");
          let ext = dump::dump_ext(&format).filter(|e| !e.is_empty());
          let opts = Dialog::Save {
            default_path: match ext {
              Some(e) => format!("{safe}.{e}"),
              None => safe,
            },
            filters: ext.map(|e| vec![((if format == "plain" { "SQL" } else { "pg_dump archive" }).to_string(), vec![e.to_string()])]).unwrap_or_default(),
          };
          match (ctx.dialog)(opts).await.filter(|p| !p.is_empty()) {
            Some(f) => f,
            None => return Ok(Value::Null),
          }
        }
      };
      let (emit, jid) = (ctx.emit.clone(), job_id.clone());
      let progress: dump::ProgressFn = Arc::new(move |obj, lines| emit("db:backup-progress", vec![Value::String(jid.clone()), obj.map(Value::String).unwrap_or(Value::Null), num(lines)]));
      let (r, size) = dump::run_backup(&cfg, dbo().as_deref(), &tool, &o, &file, &job_id, progress).await?;
      Ok(json!({ "path": file, "size": num(size), "warnings": r.errors.len() }))
    }
    "db:restore-pick" => {
      if let Some(f) = dev_env("RIVEN_DEV_PICK_FILE") {
        return Ok(Value::String(f));
      }
      let opts = if a.truthy(0) {
        Dialog::Open { directory: true, create_dirs: false, filters: vec![] }
      } else {
        Dialog::Open { directory: false, create_dirs: false, filters: filters(&[("Backups", &["dump", "backup", "sql", "tar", "pgdump"]), ("All files", &["*"])]) }
      };
      Ok((ctx.dialog)(opts).await.map(Value::String).unwrap_or(Value::Null))
    }
    "db:restore-inspect" => {
      let tool = tool_at(a.opt(1), a.opt(2)).await.ok();
      dump::inspect_archive(&a.s(0), tool.as_ref()).await
    }
    "db:restore-run" => {
      let cfg = pg_by_id(&id())?;
      if cfg.read_only {
        return err("This connection is read-only");
      }
      let tool = tool_at(a.opt(2), a.opt(3)).await?;
      let server = server_version_major(&cfg, dbo().as_deref()).await?;
      let o = a.v(4).cloned().unwrap_or(Value::Null);
      let job_id = a.s(5);
      let (emit, jid) = (ctx.emit.clone(), job_id.clone());
      let progress: dump::ProgressFn = Arc::new(move |obj, lines| emit("db:backup-progress", vec![Value::String(jid.clone()), obj.map(Value::String).unwrap_or(Value::Null), num(lines)]));
      let r = dump::run_restore(&cfg, dbo().as_deref(), &tool, &o, server, &job_id, progress).await?;
      Ok(json!({ "ignored": num(r.ignored), "errors": r.errors }))
    }
    "db:backup-cancel" => Ok(Value::Bool(dump::cancel_dump(&a.s(0)))),
    "db:export" => export(&a, ctx).await,
    _ => err(format!("No handler registered for '{ch}'")),
  }
}

async fn export(a: &Args, ctx: Ctx) -> R<Value> {
  let cfg = by_id(&a.s(0))?;
  let db = a.opt(1);
  let req = a.v(2).cloned().unwrap_or(Value::Null);
  let ov = req.get("options").cloned().unwrap_or(Value::Null);
  let o = ExportOptions::from_value(&ov);
  if o.columns.is_empty() {
    return err("No columns selected");
  }
  // Rows from the database are re-read through the paging wrapper: plain reads only.
  let mut sql: Option<String> = None;
  if let Some(rs) = req.get("sql") {
    let rs = js::string(rs);
    if cfg.read_only {
      if let Some(bad) = read_only_violation(&rs, cfg.kind(), false) {
        return err(bad);
      }
    }
    let off = req.get("offset").and_then(Value::as_f64).unwrap_or(0.0).floor().max(0.0);
    sql = Some(paged_query(&rs, cfg.kind(), off).ok_or_else(|| DbErr::new("This query cannot be exported in full; export the loaded rows instead"))?);
  }
  let ext = o.format.clone();
  let name = req.get("name").map(js::string).unwrap_or_default();
  let pick = match dev_env("RIVEN_DEV_SAVE_FILE") {
    Some(f) => Some(f),
    None => (ctx.dialog)(Dialog::Save { default_path: format!("{}.{ext}", safe_name(&name, "result")), filters: export_filter(&ext).map(|f| filters(&[f])).unwrap_or_default() }).await,
  };
  let Some(path) = pick.filter(|p| !p.is_empty()) else { return Ok(Value::Null) };
  let xlsx = o.format == "xlsx";
  let mut w = open_export(&path, o)?;
  let cap = if xlsx { XLSX_MAX_ROWS as f64 } else { 9007199254740991.0 };
  let query_id = req.get("queryId").filter(|q| js::truthy(Some(q))).map(js::string);
  let r: R<()> = async {
    if let Some(sql) = &sql {
      let max = req.get("max").and_then(Value::as_f64).unwrap_or(cap).min(cap).max(0.0) as usize;
      let mut n = 0usize;
      let (emit, qid) = (ctx.emit.clone(), query_id.clone());
      let on_rows = |rows: Vec<Vec<Cell>>| {
        let r = w.rows(&rows);
        if r.is_ok() {
          n += rows.len();
          if let Some(q) = &qid {
            emit("db:export-progress", vec![Value::String(q.clone()), json!(n)]);
          }
        }
        std::future::ready(r)
      };
      match cfg.kind() {
        Kind::Postgres => pg::stream(&cfg, db.as_deref(), sql, query_id.as_deref(), max, 2000, on_rows).await?,
        Kind::Mysql => my::stream(&cfg, db.as_deref(), sql, query_id.as_deref(), max, 2000, on_rows).await?,
        _ => sl::stream(&cfg, sql, query_id.as_deref(), max, 2000, on_rows).await?,
      };
    } else {
      let rows: Vec<Vec<Cell>> = req
        .get("rows")
        .and_then(Value::as_array)
        .map(|x| x.iter().map(|r| r.as_array().map(|c| c.iter().map(Cell::from_value).collect()).unwrap_or_default()).collect())
        .unwrap_or_default();
      for chunk in rows.chunks(2000) {
        w.rows(chunk)?;
      }
    }
    Ok(())
  }
  .await;
  match r {
    Ok(()) => {
      let n = w.close()?;
      Ok(json!({ "path": path, "rows": n }))
    }
    Err(e) => {
      w.abort();
      Err(e)
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  #[test]
  fn tables_and_names() {
    let t = format_table(&["a".into(), "bb".into()], &[vec![json!(1), Value::Null], vec![json!("x\ny"), json!(true)]]);
    assert_eq!(t, "a    | bb\n-----+-----\n1    | NULL\nx\\ny | true");
    assert_eq!(split_qualified("\"My\"\"S\".\"T.x\""), (Some("My\"S".into()), "T.x".into()));
    assert_eq!(split_qualified("users"), (None, "users".into()));
    assert_eq!(strip_trailing_semicolon("select 1 ;  "), "select 1 ");
    assert_eq!(strip_trailing_semicolon("select ';' x"), "select ';' x");
  }
}
