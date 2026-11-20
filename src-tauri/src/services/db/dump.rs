// Backup and restore through the PostgreSQL client tools (dump.ts +
// dumpArgs.ts): found on disk (the login PATH and the usual install places),
// run as child processes with the password in the environment, verbose output
// streamed back as progress.

use super::pgwire::node_fs_error;
use super::{err, js, num, Cfg, DbErr, R};
use regex::Regex;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::process::Stdio;
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

#[derive(Clone, Debug)]
pub struct ToolInfo {
  pub dir: String,
  pub version: String,
  pub major: f64,
  pub pg_dump: String,
  pub pg_restore: Option<String>,
  pub psql: Option<String>,
}

impl ToolInfo {
  pub fn to_value(&self) -> Value {
    json!({ "dir": self.dir, "version": self.version, "major": num(self.major), "pgDump": self.pg_dump, "pgRestore": self.pg_restore, "psql": self.psql })
  }
}

pub fn dump_ext(format: &str) -> Option<&'static str> {
  match format {
    "custom" => Some("dump"),
    "plain" => Some("sql"),
    "tar" => Some("tar"),
    "directory" => Some(""),
    _ => None,
  }
}

// ---- dumpArgs.ts --------------------------------------------------------------------

/// A schema or table name as a pg_dump/pg_restore pattern: quoted, so it matches literally.
fn pattern_of(parts: &[&str]) -> String {
  parts.iter().map(|p| format!("\"{}\"", p.replace('"', "\"\""))).collect::<Vec<_>>().join(".")
}

fn clamp_int(n: Option<&Value>, lo: f64, hi: f64) -> String {
  let v = n.map(|v| match v {
    Value::Number(x) => x.as_f64().unwrap_or(0.0),
    Value::String(s) => js::number(s),
    Value::Bool(b) => *b as i32 as f64,
    Value::Null => 0.0,
    _ => f64::NAN,
  });
  let x = v.filter(|x| !x.is_nan() && *x != 0.0).unwrap_or(0.0).floor();
  js::num_str(x.max(lo).min(hi))
}

fn vs(v: &Value, k: &str) -> String {
  match v.get(k) {
    Some(Value::String(s)) => s.clone(),
    None | Some(Value::Null) => String::new(),
    Some(x) => js::string(x),
  }
}
fn vb(v: &Value, k: &str) -> bool {
  js::truthy(v.get(k))
}
fn vn(v: &Value, k: &str) -> f64 {
  v.get(k).and_then(Value::as_f64).unwrap_or(f64::NAN)
}
fn str_list(v: &Value, k: &str) -> Vec<String> {
  v.get(k).and_then(Value::as_array).map(|a| a.iter().map(js::string).collect()).unwrap_or_default()
}

/// libpq environment for a connection: credentials never go on the command line.
pub fn tool_env(cfg: &Cfg, database: Option<&str>, password: Option<String>, home: &str) -> Vec<(String, String)> {
  let expand = |p: &str| if let Some(rest) = p.strip_prefix('~') { format!("{home}{rest}") } else { p.to_string() };
  let mut env = vec![
    ("PGHOST".to_string(), cfg.host_or_localhost()),
    ("PGPORT".into(), if cfg.port != 0.0 && !cfg.port.is_nan() { js::num_str(cfg.port) } else { "5432".into() }),
    ("PGUSER".into(), cfg.user.clone()),
    ("PGDATABASE".into(), database.filter(|d| !d.is_empty()).map(str::to_string).unwrap_or_else(|| if cfg.database.is_empty() { "postgres".into() } else { cfg.database.clone() })),
    ("PGAPPNAME".into(), "riven".into()),
    ("PGCONNECT_TIMEOUT".into(), "10".into()),
  ];
  if let Some(p) = password.filter(|p| !p.is_empty()) {
    env.push(("PGPASSWORD".into(), p));
  }
  // Same as the driver: no SSL unless the connection asks for it.
  match &cfg.ssl {
    None => env.push(("PGSSLMODE".into(), "disable".into())),
    Some(s) => {
      env.push(("PGSSLMODE".into(), s.mode.clone()));
      if s.mode != "disable" {
        if let Some(x) = s.ca.as_deref().filter(|x| !x.is_empty()) {
          env.push(("PGSSLROOTCERT".into(), expand(x)));
        }
        if let Some(x) = s.cert.as_deref().filter(|x| !x.is_empty()) {
          env.push(("PGSSLCERT".into(), expand(x)));
        }
        if let Some(x) = s.key.as_deref().filter(|x| !x.is_empty()) {
          env.push(("PGSSLKEY".into(), expand(x)));
        }
      }
    }
  }
  env
}

fn content_flag(c: &str) -> Option<&'static str> {
  match c {
    "schema" => Some("--schema-only"),
    "data" => Some("--data-only"),
    _ => None,
  }
}

pub fn dump_args(o: &Value, file: &str) -> Vec<String> {
  let format = vs(o, "format");
  let content = vs(o, "content");
  let mut a = vec![format!("--format={format}"), format!("--file={file}"), "--verbose".into()];
  if let Some(c) = content_flag(&content) {
    a.push(c.into());
  }
  for s in str_list(o, "schemas") {
    a.push(format!("--schema={}", pattern_of(&[&s])));
  }
  if let Some(ts) = o.get("tables").and_then(Value::as_array) {
    for t in ts {
      let s = t.get(0).map(js::string).unwrap_or_else(|| "undefined".into());
      let n = t.get(1).map(js::string).unwrap_or_else(|| "undefined".into());
      a.push(format!("--table={}", pattern_of(&[&s, &n])));
    }
  }
  if vb(o, "noOwner") {
    a.push("--no-owner".into());
  }
  if vb(o, "noPrivileges") {
    a.push("--no-privileges".into());
  }
  if format == "plain" {
    if vb(o, "clean") && content != "data" {
      a.push("--clean".into());
      a.push("--if-exists".into());
    }
    if vb(o, "create") && content != "data" {
      a.push("--create".into());
    }
  }
  if content != "schema" {
    match vs(o, "rows").as_str() {
      "inserts" => a.push("--inserts".into()),
      "column-inserts" => a.push("--column-inserts".into()),
      _ => {}
    }
  }
  if format == "custom" || format == "directory" {
    a.push(format!("--compress={}", clamp_int(o.get("compress"), 0.0, 9.0)));
  }
  if format == "directory" && vn(o, "jobs") > 1.0 {
    a.push(format!("--jobs={}", clamp_int(o.get("jobs"), 1.0, 16.0)));
  }
  a
}

/// pg_restore for archives, psql for plain SQL. Connection comes from the environment.
pub fn restore_args(o: &Value, stdin: bool) -> (&'static str, Vec<String>) {
  let path = vs(o, "path");
  if vs(o, "format") == "plain" {
    let mut args = vec!["--no-psqlrc".to_string(), "--echo-errors".into(), format!("--file={}", if stdin { "-" } else { &path })];
    if vb(o, "exitOnError") || vb(o, "singleTransaction") {
      args.push("--set=ON_ERROR_STOP=1".into());
    }
    if vb(o, "singleTransaction") {
      args.push("--single-transaction".into());
    }
    return ("psql", args);
  }
  let content = vs(o, "content");
  let mut args = vec!["--verbose".to_string(), format!("--format={}", vs(o, "format")), "--dbname=".into()];
  if let Some(c) = content_flag(&content) {
    args.push(c.into());
  }
  for s in str_list(o, "schemas") {
    args.push(format!("--schema={s}"));
  }
  if vb(o, "clean") && content != "data" {
    args.push("--clean".into());
    args.push("--if-exists".into());
  }
  if vb(o, "noOwner") {
    args.push("--no-owner".into());
  }
  if vb(o, "noPrivileges") {
    args.push("--no-privileges".into());
  }
  if vb(o, "exitOnError") {
    args.push("--exit-on-error".into());
  }
  if vb(o, "singleTransaction") {
    args.push("--single-transaction".into());
  } else if vn(o, "jobs") > 1.0 {
    args.push(format!("--jobs={}", clamp_int(o.get("jobs"), 1.0, 16.0)));
  }
  args.push(path);
  ("pg_restore", args)
}

/// "pg_dump (PostgreSQL) 16.2 (Homebrew)" -> ("16.2", 16).
pub fn parse_tool_version(out: &str) -> Option<(String, f64)> {
  static RE: OnceLock<Regex> = OnceLock::new();
  let m = RE.get_or_init(|| Regex::new(r"\(PostgreSQL\)\s+([0-9]+)(?:\.([0-9]+))?").expect("re")).captures(out)?;
  let major: f64 = m[1].parse().unwrap_or(f64::NAN);
  let minor = m.get(2).map(|x| x.as_str());
  // 9.x majors were two numbers.
  if major < 10.0 {
    if let Some(mi) = minor {
      return Some((format!("{}.{mi}", &m[1]), major + mi.parse::<f64>().unwrap_or(0.0) / 10.0));
    }
  }
  Some((match minor {
    Some(mi) => format!("{}.{mi}", &m[1]),
    None => m[1].to_string(),
  }, major))
}

/// server_version_num -> major (90624 -> 9.6, 160002 -> 16).
pub fn server_major(n: f64) -> f64 {
  if n >= 100000.0 {
    (n / 10000.0).floor()
  } else {
    (n / 10000.0).floor() + ((n / 100.0).floor() % 100.0) / 10.0
  }
}

fn sniff_format(head: &[u8], is_dir: bool) -> &'static str {
  if is_dir {
    return "directory";
  }
  if head.len() >= 5 && &head[0..5] == b"PGDMP" {
    return "custom";
  }
  if head.len() >= 262 && &head[257..262] == b"ustar" {
    return "tar";
  }
  "plain"
}

fn plain_header(text: &str, out: &mut Map<String, Value>) {
  static S: OnceLock<Regex> = OnceLock::new();
  static D: OnceLock<Regex> = OnceLock::new();
  if let Some(m) = S.get_or_init(|| Regex::new(r"(?m)^-- Dumped from database version (\S+)").expect("re")).captures(text) {
    out.insert("serverVersion".into(), m[1].into());
  }
  if let Some(m) = D.get_or_init(|| Regex::new(r"(?m)^-- Dumped by pg_dump version (\S+)").expect("re")).captures(text) {
    out.insert("dumpVersion".into(), m[1].into());
  }
}

const TOC_TYPES: &[&str] = &[
  "TABLE DATA", "SEQUENCE SET", "SEQUENCE OWNED BY", "FK CONSTRAINT", "MATERIALIZED VIEW DATA", "MATERIALIZED VIEW", "DEFAULT ACL", "TABLE ATTACH", "INDEX ATTACH", "ACL", "COMMENT",
  "CONSTRAINT", "DEFAULT", "EXTENSION", "FUNCTION", "PROCEDURE", "AGGREGATE", "INDEX", "SCHEMA", "SEQUENCE", "TABLE", "TRIGGER", "TYPE", "DOMAIN", "VIEW", "POLICY", "ROW SECURITY",
  "RULE", "PUBLICATION", "SUBSCRIPTION", "COLLATION", "BLOBS", "BLOB",
];

/// Summary of `pg_restore --list` output, keys in the order Node set them
/// (schemas and counts first, then the header facts as they appear).
fn parse_toc(out: &str, info: &mut Map<String, Value>) {
  static KV: OnceLock<Regex> = OnceLock::new();
  static LINE: OnceLock<Regex> = OnceLock::new();
  let kv_re = KV.get_or_init(|| Regex::new(r"^;\s+(dbname|Dumped from database version|Dumped by pg_dump version):\s*(.*)$").expect("re"));
  let line_re = LINE.get_or_init(|| Regex::new(r"^[0-9]+;\s+[0-9]+\s+[0-9]+\s+(.*)$").expect("re"));
  let mut schemas: Vec<String> = vec![];
  let mut counts: Vec<(String, f64)> = vec![];
  info.insert("schemas".into(), json!([]));
  info.insert("counts".into(), json!({}));
  for line in out.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l)) {
    if line.starts_with(';') {
      if let Some(kv) = kv_re.captures(line) {
        let v = js::trim(&kv[2]).to_string();
        let k = match &kv[1] {
          "dbname" => "database",
          k if k.starts_with("Dumped from") => "serverVersion",
          _ => "dumpVersion",
        };
        info.insert(k.into(), v.into());
      }
      continue;
    }
    let Some(m) = line_re.captures(line) else { continue };
    let rest = &m[1];
    let Some(ty) = TOC_TYPES.iter().find(|x| rest.starts_with(&format!("{x} "))) else { continue };
    match counts.iter_mut().find(|(k, _)| k == ty) {
      Some(c) => c.1 += 1.0,
      None => counts.push((ty.to_string(), 1.0)),
    }
    let after = &rest[ty.len() + 1..];
    let mut parts = after.split(' ');
    let schema = parts.next().unwrap_or("");
    let add = |s: &str, v: &mut Vec<String>| {
      if !v.iter().any(|x| x == s) {
        v.push(s.to_string());
      }
    };
    if *ty == "SCHEMA" {
      add(parts.next().unwrap_or(schema), &mut schemas);
    } else if !schema.is_empty() && schema != "-" {
      add(schema, &mut schemas);
    }
  }
  // [...set].sort(): UTF-16 code unit order.
  schemas.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
  info.insert("schemas".into(), json!(schemas));
  info.insert("counts".into(), Value::Object(counts.into_iter().map(|(k, v)| (k, num(v))).collect()));
}

/// The object a verbose pg_dump / pg_restore line is working on, for progress.
fn progress_object(line: &str) -> Option<String> {
  static RE: OnceLock<Regex> = OnceLock::new();
  let re = RE.get_or_init(|| Regex::new(r#"(?:dumping contents of table|processing data for table|restoring data for table|creating [A-Za-z0-9_]+(?: [A-Za-z0-9_]+)?)\s+"([^"]+)""#).expect("re"));
  re.captures(line).map(|m| m[1].to_string())
}

/// Drops lines a server of this major can't run; None when nothing needs dropping.
fn plain_line_filter(server: f64) -> Option<Regex> {
  // Settings a newer pg_dump writes that an older server rejects, by the major that introduced them.
  if server < 17.0 {
    Some(Regex::new(r"^SET transaction_timeout = ").expect("re"))
  } else {
    None
  }
}

// ---- finding the tools ---------------------------------------------------------------

fn subdirs(parent: &str, prefix: &str, tail: &str) -> Vec<String> {
  let Ok(rd) = std::fs::read_dir(parent) else { return vec![] };
  // readdir order: the file system's (APFS: sorted by name).
  let mut names: Vec<String> = rd.filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().into_owned()).collect();
  names.sort();
  names.into_iter().filter(|n| n.starts_with(prefix)).map(|n| format!("{parent}/{n}/{tail}")).collect()
}

// Apps started from Finder get a bare PATH, so the login PATH and the usual install places are searched.
fn candidate_dirs(extra: Option<&str>) -> Vec<String> {
  let mut dirs: Vec<String> = vec![];
  if let Some(e) = extra.filter(|e| !e.is_empty()) {
    dirs.push(e.to_string());
  }
  dirs.extend(crate::services::shell_env::login_path().split(':').filter(|d| !d.is_empty()).map(str::to_string));
  for root in ["/opt/homebrew", "/usr/local"] {
    dirs.push(format!("{root}/bin"));
    dirs.push(format!("{root}/opt/libpq/bin"));
    dirs.extend(subdirs(&format!("{root}/opt"), "postgresql", "bin"));
  }
  dirs.extend(subdirs("/Applications/Postgres.app/Contents/Versions", "", "bin"));
  let mut seen = HashSet::new();
  dirs.retain(|d| seen.insert(d.clone()));
  dirs
}

async fn version_of(bin: &str) -> Option<(String, f64)> {
  let mut c = crate::services::shell_env::tokio_command(bin);
  c.arg("--version").stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).kill_on_drop(true);
  let out = tokio::time::timeout(Duration::from_secs(5), c.output()).await.ok()?.ok()?;
  if !out.status.success() {
    return None;
  }
  parse_tool_version(&String::from_utf8_lossy(&out.stdout))
}

fn tool_cache() -> MutexGuard<'static, Option<(String, Vec<ToolInfo>)>> {
  static C: OnceLock<Mutex<Option<(String, Vec<ToolInfo>)>>> = OnceLock::new();
  C.get_or_init(Default::default).lock().unwrap_or_else(|e| e.into_inner())
}

/// `a.localeCompare(b, undefined, { numeric: true })` for version strings.
fn version_cmp(a: &str, b: &str) -> std::cmp::Ordering {
  fn chunks(s: &str) -> Vec<Result<u64, String>> {
    let mut out = vec![];
    let mut cur = String::new();
    let mut digit = None;
    for c in s.chars() {
      let d = c.is_ascii_digit();
      if digit.is_some_and(|x| x != d) {
        out.push(if digit == Some(true) { Ok(cur.parse().unwrap_or(0)) } else { Err(std::mem::take(&mut cur)) });
        cur.clear();
      }
      digit = Some(d);
      cur.push(c);
    }
    if !cur.is_empty() {
      out.push(if digit == Some(true) { Ok(cur.parse().unwrap_or(0)) } else { Err(cur) });
    }
    out
  }
  let (x, y) = (chunks(a), chunks(b));
  for (p, q) in x.iter().zip(y.iter()) {
    let o = match (p, q) {
      (Ok(m), Ok(n)) => m.cmp(n),
      (Err(m), Err(n)) => crate::services::collate::locale_compare(m, n),
      (Ok(_), Err(_)) => std::cmp::Ordering::Less,
      (Err(_), Ok(_)) => std::cmp::Ordering::Greater,
    };
    if o != std::cmp::Ordering::Equal {
      return o;
    }
  }
  x.len().cmp(&y.len())
}

/// Every pg_dump found, newest first, with its sibling pg_restore and psql.
pub async fn find_tools(extra: Option<&str>, refresh: bool) -> Vec<ToolInfo> {
  let key = extra.unwrap_or("").to_string();
  if !refresh {
    if let Some((k, t)) = &*tool_cache() {
      if *k == key {
        return t.clone();
      }
    }
  }
  let mut found: Vec<ToolInfo> = vec![];
  let mut seen = HashSet::new();
  for dir in candidate_dirs(extra) {
    let bin = format!("{dir}/pg_dump");
    if !Path::new(&bin).exists() {
      continue;
    }
    let Some((version, major)) = version_of(&bin).await else { continue };
    if !seen.insert(version.clone()) {
      continue;
    }
    let sib = |n: &str| {
      let p = format!("{dir}/{n}");
      Path::new(&p).exists().then_some(p)
    };
    found.push(ToolInfo { pg_restore: sib("pg_restore"), psql: sib("psql"), dir, version, major, pg_dump: bin });
  }
  found.sort_by(|a, b| b.major.partial_cmp(&a.major).unwrap_or(std::cmp::Ordering::Equal).then_with(|| version_cmp(&b.version, &a.version)));
  *tool_cache() = Some((key, found.clone()));
  found
}

// ---- running them ----------------------------------------------------------------------

fn running() -> MutexGuard<'static, HashMap<String, u32>> {
  static R: OnceLock<Mutex<HashMap<String, u32>>> = OnceLock::new();
  R.get_or_init(Default::default).lock().unwrap_or_else(|e| e.into_inner())
}
fn cancelled() -> MutexGuard<'static, HashSet<String>> {
  static C: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
  C.get_or_init(Default::default).lock().unwrap_or_else(|e| e.into_inner())
}

pub fn cancel_dump(job_id: &str) -> bool {
  let Some(pid) = running().get(job_id).copied() else { return false };
  cancelled().insert(job_id.to_string());
  unsafe { libc::kill(pid as i32, libc::SIGTERM) };
  true
}

pub struct ToolRun {
  pub code: i32,
  pub errors: Vec<String>,
  pub ignored: f64,
}

const KEEP: usize = 20;

/// The app's environment without PG* (a PGSERVICE or stray PGPASSWORD must not
/// override the connection), with the login PATH.
fn base_env() -> Vec<(String, String)> {
  let mut env: Vec<(String, String)> = std::env::vars().filter(|(k, _)| !k.starts_with("PG")).collect();
  let path = crate::services::shell_env::login_path();
  env.retain(|(k, _)| k != "PATH");
  env.push(("PATH".into(), path));
  env
}

pub type ProgressFn = Arc<dyn Fn(Option<String>, f64) + Send + Sync>;

/// Throttled progress: the object being worked on and how many lines went by.
struct Sink {
  send: ProgressFn,
  obj: Option<String>,
  n: f64,
  last: f64,
}
impl Sink {
  fn line(&mut self, l: &str) {
    self.n += 1.0;
    if let Some(o) = progress_object(l) {
      self.obj = Some(o);
    }
    let now = js::now_ms();
    if now - self.last >= 150.0 {
      self.last = now;
      (self.send)(self.obj.clone(), self.n);
    }
  }
  fn flush(&self) {
    (self.send)(self.obj.clone(), self.n);
  }
}

async fn run(job_id: &str, bin: &str, args: &[String], env: Vec<(String, String)>, sink: &mut Sink, input: Option<(String, Regex)>) -> R<ToolRun> {
  let mut c = tokio::process::Command::new(bin);
  c.args(args).env_clear().envs(base_env()).envs(env).stdout(Stdio::piped()).stderr(Stdio::piped());
  c.stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() });
  let mut child = c.spawn().map_err(|e| spawn_error(bin, &e))?;
  if let Some(pid) = child.id() {
    running().insert(job_id.to_string(), pid);
  }
  let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
  let read = |r: Box<dyn tokio::io::AsyncRead + Unpin + Send>, tx: tokio::sync::mpsc::UnboundedSender<String>| {
    tokio::spawn(async move {
      let mut br = BufReader::new(r);
      let mut buf = vec![];
      while let Ok(n) = br.read_until(b'\n', &mut buf).await {
        if n == 0 {
          break;
        }
        // split(/\r?\n/): the last piece without a newline is held until more arrives (dropped at the end).
        if buf.last() != Some(&b'\n') {
          break;
        }
        buf.pop();
        if buf.last() == Some(&b'\r') {
          buf.pop();
        }
        let _ = tx.send(String::from_utf8_lossy(&buf).into_owned());
        buf.clear();
      }
    })
  };
  let out = child.stdout.take().map(|s| read(Box::new(s), tx.clone()));
  let errs = child.stderr.take().map(|s| read(Box::new(s), tx.clone()));
  drop(tx);
  if let (Some((path, bad)), Some(mut stdin)) = (input, child.stdin.take()) {
    let pid = child.id();
    tokio::spawn(async move {
      let Ok(mut f) = tokio::fs::File::open(&path).await else {
        if let Some(pid) = pid {
          unsafe { libc::kill(pid as i32, libc::SIGTERM) };
        }
        return;
      };
      // readline with crlfDelay: lines end at \n, \r\n or \r; each goes on with \n.
      let mut data = vec![0u8; 1 << 16];
      let mut line: Vec<u8> = vec![];
      let mut cr = false;
      let mut out: Vec<u8> = vec![];
      let emit = |l: &[u8], out: &mut Vec<u8>| {
        let s = String::from_utf8_lossy(l);
        if !bad.is_match(&s) {
          out.extend_from_slice(s.as_bytes());
          out.push(b'\n');
        }
      };
      loop {
        let n = match f.read(&mut data).await {
          Ok(0) | Err(_) => break,
          Ok(n) => n,
        };
        for &b in &data[..n] {
          if cr && b == b'\n' {
            cr = false;
            continue;
          }
          cr = false;
          if b == b'\n' || b == b'\r' {
            emit(&line, &mut out);
            line.clear();
            cr = b == b'\r';
          } else {
            line.push(b);
          }
        }
        if out.len() > 1 << 16 {
          if stdin.write_all(&out).await.is_err() {
            return;
          }
          out.clear();
        }
      }
      if !line.is_empty() {
        emit(&line, &mut out);
      }
      let _ = stdin.write_all(&out).await;
      let _ = stdin.shutdown().await;
    });
  }
  // The first errors are the cause, the last ones what stopped it: keep both ends.
  static IGN: OnceLock<Regex> = OnceLock::new();
  static ERR: OnceLock<Regex> = OnceLock::new();
  let ign_re = IGN.get_or_init(|| Regex::new(r"errors ignored on restore:\s*([0-9]+)").expect("re"));
  let err_re = ERR.get_or_init(|| Regex::new(r"(?:^|[^A-Za-z0-9_])(error|fatal|FATAL|ERROR)(?:$|[^A-Za-z0-9_])").expect("re"));
  let mut head: Vec<String> = vec![];
  let mut tail: std::collections::VecDeque<String> = Default::default();
  let mut count = 0usize;
  let mut ignored = -1.0;
  while let Some(line) = rx.recv().await {
    if line.is_empty() {
      continue;
    }
    if let Some(m) = ign_re.captures(&line) {
      ignored = m[1].parse().unwrap_or(f64::NAN);
    } else if err_re.is_match(&line) {
      count += 1;
      if head.len() < KEEP {
        head.push(line.clone());
      } else {
        tail.push_back(line.clone());
        if tail.len() > KEEP {
          tail.pop_front();
        }
      }
    }
    sink.line(&line);
  }
  if let Some(t) = out {
    let _ = t.await;
  }
  if let Some(t) = errs {
    let _ = t.await;
  }
  let status = child.wait().await;
  running().remove(job_id);
  let code = match status {
    Ok(s) => s.code().unwrap_or(1),
    Err(e) => return Err(DbErr::new(e.to_string())),
  };
  let skipped = count - head.len() - tail.len();
  let mut errors = head;
  if skipped > 0 {
    errors.push(format!("... {skipped} more ..."));
  }
  errors.extend(tail);
  Ok(ToolRun { code, errors, ignored: if ignored >= 0.0 { ignored } else { count as f64 } })
}

/// Node's spawn error text: "spawn /path ENOENT".
fn spawn_error(bin: &str, e: &std::io::Error) -> DbErr {
  let code = match e.raw_os_error() {
    Some(libc::ENOENT) => "ENOENT".to_string(),
    Some(libc::EACCES) => "EACCES".to_string(),
    Some(libc::ENOTDIR) => "ENOTDIR".to_string(),
    _ => e.to_string(),
  };
  DbErr::new(format!("spawn {bin} {code}"))
}

fn last5(errors: &[String]) -> String {
  errors[errors.len().saturating_sub(5)..].join("\n")
}

pub async fn run_backup(cfg: &Cfg, db: Option<&str>, tool: &ToolInfo, o: &Value, file: &str, job_id: &str, progress: ProgressFn) -> R<(ToolRun, f64)> {
  // A directory dump needs an empty or missing directory; remember which, to clean up after a failure.
  let existed = Path::new(file).exists();
  let mut sink = Sink { send: progress, obj: None, n: 0.0, last: 0.0 };
  let home = crate::services::paths::home().to_string_lossy().into_owned();
  let res = run(job_id, &tool.pg_dump, &dump_args(o, file), tool_env(cfg, db, super::store::password(&cfg.id), &home), &mut sink, None).await;
  sink.flush();
  let res = res?;
  let failed = res.code != 0 || cancelled().contains(job_id);
  if failed {
    if vs(o, "format") != "directory" || !existed {
      let p = Path::new(file);
      let _ = if p.is_dir() { std::fs::remove_dir_all(p) } else { std::fs::remove_file(p) };
    }
    if cancelled().remove(job_id) {
      return err("Cancelled");
    }
    let m = last5(&res.errors);
    return err(if m.is_empty() { format!("pg_dump exited with code {}", res.code) } else { m });
  }
  let size = size_of(file)?;
  Ok((res, size))
}

pub async fn run_restore(cfg: &Cfg, db: Option<&str>, tool: &ToolInfo, o: &Value, server: f64, job_id: &str, progress: ProgressFn) -> R<ToolRun> {
  // A plain dump from a newer pg_dump goes through a filter for what this server can't run.
  let keep = if vs(o, "format") == "plain" { plain_line_filter(server) } else { None };
  let (which, args) = restore_args(o, keep.is_some());
  let bin = if which == "psql" { tool.psql.clone() } else { tool.pg_restore.clone() };
  let Some(bin) = bin else { return err(format!("{which} not found next to {}", tool.pg_dump)) };
  let input = keep.map(|k| (vs(o, "path"), k));
  let mut sink = Sink { send: progress, obj: None, n: 0.0, last: 0.0 };
  let home = crate::services::paths::home().to_string_lossy().into_owned();
  let res = run(job_id, &bin, &args, tool_env(cfg, db, super::store::password(&cfg.id), &home), &mut sink, input).await;
  sink.flush();
  if cancelled().remove(job_id) {
    return err("Cancelled");
  }
  let res = res?;
  // pg_restore exits 1 when it carried on past errors: a result with warnings, not a failure.
  if res.code != 0 && !(which == "pg_restore" && res.ignored > 0.0 && !vb(o, "exitOnError")) {
    let m = last5(&res.errors);
    return err(if m.is_empty() { format!("{which} exited with code {}", res.code) } else { m });
  }
  Ok(res)
}

fn stat(path: &str) -> R<std::fs::Metadata> {
  std::fs::metadata(path).map_err(|e| DbErr::new(format!("{}, stat '{path}'", node_fs_error(&e))))
}

fn size_of(path: &str) -> R<f64> {
  let s = stat(path)?;
  if !s.is_dir() {
    return Ok(s.len() as f64);
  }
  let mut total = 0.0;
  if let Ok(rd) = std::fs::read_dir(path) {
    for e in rd.flatten() {
      total += std::fs::metadata(e.path()).map(|m| m.len() as f64).unwrap_or(0.0);
    }
  }
  Ok(total)
}

/// What a backup file is and what it holds.
pub async fn inspect_archive(path: &str, tool: Option<&ToolInfo>) -> R<Value> {
  let s = stat(path)?;
  let mut head: Vec<u8> = vec![];
  if !s.is_dir() {
    use std::io::Read;
    let mut f = std::fs::File::open(path).map_err(|e| DbErr::new(format!("{}, open '{path}'", node_fs_error(&e))))?;
    head = vec![0u8; (s.len() as usize).min(8192)];
    let mut got = 0;
    while got < head.len() {
      match f.read(&mut head[got..]) {
        Ok(0) => break,
        Ok(n) => got += n,
        Err(e) => return err(format!("{}, read", node_fs_error(&e))),
      }
    }
    head.truncate(got);
  } else if !Path::new(path).join("toc.dat").exists() {
    return err("Not a pg_dump directory (no toc.dat)");
  }
  let format = sniff_format(&head, s.is_dir());
  let size = if s.is_dir() { size_of(path)? } else { s.len() as f64 };
  let mut info = Map::new();
  info.insert("path".into(), path.into());
  info.insert("format".into(), format.into());
  info.insert("size".into(), num(size));
  if format == "plain" {
    info.insert("schemas".into(), json!([]));
    info.insert("counts".into(), json!({}));
    // Buffer.from(head).toString('utf8'): a cut-off character becomes U+FFFD.
    plain_header(&String::from_utf8_lossy(&head), &mut info);
    return Ok(Value::Object(info));
  }
  let Some(pr) = tool.and_then(|t| t.pg_restore.clone()) else {
    info.insert("schemas".into(), json!([]));
    info.insert("counts".into(), json!({}));
    return Ok(Value::Object(info));
  };
  let mut c = tokio::process::Command::new(&pr);
  c.args(["--list", &format!("--format={format}"), path]).env_clear().envs(base_env()).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
  let cmd = format!("{pr} --list --format={format} {path}");
  let out = match tokio::time::timeout(Duration::from_secs(30), c.output()).await {
    Err(_) => return err(format!("Command failed: {cmd}\n")),
    Ok(Err(e)) => return Err(spawn_error(&pr, &e)),
    Ok(Ok(o)) => o,
  };
  if !out.status.success() {
    let stderr = String::from_utf8_lossy(&out.stderr);
    let t = js::trim(&stderr);
    return err(if t.is_empty() { format!("Command failed: {cmd}\n{stderr}") } else { t.to_string() });
  }
  parse_toc(&String::from_utf8_lossy(&out.stdout), &mut info);
  Ok(Value::Object(info))
}

#[cfg(test)]
mod tests {
  use super::*;
  #[test]
  fn versions_and_args() {
    assert_eq!(parse_tool_version("pg_dump (PostgreSQL) 16.2 (Homebrew)"), Some(("16.2".into(), 16.0)));
    assert_eq!(parse_tool_version("pg_dump (PostgreSQL) 9.6.24"), Some(("9.6".into(), 9.6)));
    assert_eq!(server_major(90624.0), 9.6);
    assert_eq!(server_major(160002.0), 16.0);
    let o = json!({ "format": "directory", "content": "all", "schemas": ["a\"b"], "tables": [["s", "t"]], "noOwner": true, "noPrivileges": false, "clean": true, "create": false, "rows": "inserts", "compress": 12, "jobs": 3 });
    assert_eq!(
      dump_args(&o, "/x"),
      vec!["--format=directory", "--file=/x", "--verbose", "--schema=\"a\"\"b\"", "--table=\"s\".\"t\"", "--no-owner", "--inserts", "--compress=9", "--jobs=3"]
    );
    assert!(version_cmp("16.10", "16.9").is_gt());
  }
}
