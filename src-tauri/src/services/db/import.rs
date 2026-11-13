// CSV import (csv.ts + importer.ts): a streaming RFC 4180 parser, delimiter
// guessing, and the load itself: streamed from disk, decoded as it goes,
// inserted in parameterized batches, all in one PostgreSQL transaction.

use super::pgwire::node_fs_error;
use super::sqltext::{qualify, quote_ident, truncate_sql};
use super::{err, js, Cfg, DbErr, Kind, R};
use encoding_rs::Encoding;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::io::Read;
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};

const DELIMITERS: &[char] = &[',', '\t', ';', '|'];
const ENCODINGS: &[&str] = &["utf-8", "euc-kr", "utf-16le", "shift_jis", "gb18030", "windows-1252"];
const PREVIEW_BYTES: u64 = 256 * 1024;
const PREVIEW_ROWS: usize = 200;

/// Incremental parser: push() text chunks, get back the records completed so
/// far; end() flushes the last one (csv.ts CsvParser, same state machine).
pub struct CsvParser {
  field: String,
  record: Vec<String>,
  quoted: bool,
  quote_end: bool,
  touched: bool,
  last_cr: bool,
  delim: Option<char>,
}

impl CsvParser {
  pub fn new(delim: &str) -> CsvParser {
    // A multi-character delimiter never matched a single character in csv.ts.
    let d = if delim.chars().count() == 1 { delim.chars().next() } else { None };
    CsvParser { field: String::new(), record: vec![], quoted: false, quote_end: false, touched: false, last_cr: false, delim: d }
  }

  pub fn push(&mut self, text: &str) -> Vec<Vec<String>> {
    let mut out = vec![];
    let t: Vec<char> = text.chars().collect();
    let n = t.len();
    let mut i = 0;
    if self.last_cr && t.first() == Some(&'\n') {
      i = 1;
    }
    self.last_cr = false;
    while i < n {
      if self.quoted {
        if self.quote_end {
          self.quote_end = false;
          if t[i] == '"' {
            self.field.push('"');
            i += 1;
            continue;
          }
          self.quoted = false;
          continue;
        }
        match t[i..].iter().position(|c| *c == '"') {
          None => {
            self.field.extend(&t[i..]);
            break;
          }
          Some(off) => {
            let q = i + off;
            self.field.extend(&t[i..q]);
            i = q + 1;
            if i >= n {
              self.quote_end = true;
              break;
            }
            if t[i] == '"' {
              self.field.push('"');
              i += 1;
            } else {
              self.quoted = false;
            }
            continue;
          }
        }
      }
      let c = t[i];
      if c == '"' && self.field.is_empty() && !self.touched {
        self.quoted = true;
        self.touched = true;
        i += 1;
      } else if Some(c) == self.delim {
        self.end_field();
        i += 1;
      } else if c == '\n' || c == '\r' {
        self.end_record(&mut out);
        if c == '\r' {
          if i + 1 >= n {
            self.last_cr = true;
          } else if t[i + 1] == '\n' {
            i += 1;
          }
        }
        i += 1;
      } else {
        let mut j = i + 1;
        while j < n {
          let x = t[j];
          if Some(x) == self.delim || x == '\n' || x == '\r' {
            break;
          }
          j += 1;
        }
        self.field.extend(&t[i..j]);
        i = j;
      }
    }
    out
  }

  pub fn end(&mut self) -> Vec<Vec<String>> {
    let mut out = vec![];
    if self.quote_end {
      self.quote_end = false;
      self.quoted = false;
    }
    self.end_record(&mut out);
    out
  }

  fn end_field(&mut self) {
    self.record.push(std::mem::take(&mut self.field));
    self.touched = false;
  }

  fn end_record(&mut self, out: &mut Vec<Vec<String>>) {
    if self.record.is_empty() && self.field.is_empty() && !self.touched {
      return;
    }
    self.end_field();
    out.push(std::mem::take(&mut self.record));
  }
}

pub fn parse_csv(text: &str, delim: &str) -> Vec<Vec<String>> {
  let mut p = CsvParser::new(delim);
  let mut r = p.push(text);
  r.extend(p.end());
  r
}

/// The delimiter that splits the first lines into the most equal, widest columns.
pub fn detect_delimiter(sample: &str) -> String {
  let mut lines: Vec<&str> = vec![];
  // sample.split(/\r\n|\n|\r/).slice(0, 20)
  let b = sample.as_bytes();
  let (mut start, mut i) = (0, 0);
  while i < b.len() && lines.len() < 20 {
    if b[i] == b'\r' || b[i] == b'\n' {
      lines.push(&sample[start..i]);
      if b[i] == b'\r' && i + 1 < b.len() && b[i + 1] == b'\n' {
        i += 1;
      }
      start = i + 1;
    }
    i += 1;
  }
  if lines.len() < 20 {
    lines.push(&sample[start.min(sample.len())..]);
  }
  if lines.len() > 1 {
    lines.pop();
  }
  let joined = lines.join("\n");
  let mut best = ",".to_string();
  let mut best_score = 0.0;
  for d in DELIMITERS {
    let ds = d.to_string();
    let rows = parse_csv(&joined, &ds);
    if rows.is_empty() {
      continue;
    }
    let w = rows[0].len();
    if w < 2 {
      continue;
    }
    let same = rows.iter().filter(|r| r.len() == w).count() as f64 / rows.len() as f64;
    let score = same * 10.0 + (w.min(50) as f64) / 50.0;
    if score > best_score {
      best_score = score;
      best = ds;
    }
  }
  best
}

fn strip_bom(s: String) -> String {
  match s.strip_prefix('\u{feff}') {
    Some(x) => x.to_string(),
    None => s,
  }
}

fn encoding_of(e: &str) -> &'static Encoding {
  let name = if ENCODINGS.contains(&e) { e } else { "utf-8" };
  Encoding::for_label(name.as_bytes()).unwrap_or(encoding_rs::UTF_8)
}

fn stat_size(path: &str) -> R<u64> {
  std::fs::metadata(path).map(|m| m.len()).map_err(|e| DbErr::new(format!("{}, stat '{path}'", node_fs_error(&e))))
}

pub fn preview_csv(path: &str, encoding: &str, delimiter: Option<&str>) -> R<Value> {
  let size = stat_size(path)?;
  let mut f = std::fs::File::open(path).map_err(|e| DbErr::new(format!("{}, open '{path}'", node_fs_error(&e))))?;
  let mut buf = vec![0u8; size.min(PREVIEW_BYTES) as usize];
  let mut got = 0;
  while got < buf.len() {
    match f.read(&mut buf[got..]) {
      Ok(0) => break,
      Ok(n) => got += n,
      Err(e) => return err(format!("{}, read", node_fs_error(&e))),
    }
  }
  // TextDecoder(..).decode(buf, { stream: true }): a cut-off sequence at the end is held back.
  let mut dec = encoding_of(encoding).new_decoder_with_bom_removal();
  let mut text = String::with_capacity(got * 2 + 16);
  let _ = dec.decode_to_string(&buf[..got], &mut text, false);
  let text = strip_bom(text);
  let delim = delimiter.filter(|d| !d.is_empty()).map(str::to_string).unwrap_or_else(|| detect_delimiter(&text));
  let mut p = CsvParser::new(&delim);
  let mut rows = p.push(&text);
  // A cut-off last record is only complete when the whole file was read.
  if size <= PREVIEW_BYTES {
    rows.extend(p.end());
  }
  let more = size > PREVIEW_BYTES || rows.len() > PREVIEW_ROWS;
  rows.truncate(PREVIEW_ROWS);
  Ok(json!({ "path": path, "size": size, "delimiter": delim, "rows": rows, "more": more }))
}

fn cancelled() -> MutexGuard<'static, HashSet<String>> {
  static C: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
  C.get_or_init(Default::default).lock().unwrap_or_else(|e| e.into_inner())
}

pub fn cancel_import(query_id: &str) {
  cancelled().insert(query_id.to_string());
}

/// Parameters per INSERT stay well under PostgreSQL's 65535 limit.
pub fn batch_rows(cols: usize) -> usize {
  (30000 / cols.max(1)).clamp(1, 1000)
}

/// INSERT ... VALUES ($1, $2), ($3, $4) ... for `rows` rows of the mapped columns.
pub fn insert_sql(schema: &str, table: &str, names: &[String], rows: usize) -> String {
  let cols = names.iter().map(|n| quote_ident(Kind::Postgres, n)).collect::<Vec<_>>().join(", ");
  let mut groups = Vec::with_capacity(rows);
  let mut p = 1;
  for _ in 0..rows {
    let g: Vec<String> = (0..names.len())
      .map(|_| {
        let s = format!("${p}");
        p += 1;
        s
      })
      .collect();
    groups.push(format!("({})", g.join(", ")));
  }
  format!("INSERT INTO {} ({cols}) VALUES {}", qualify(schema, table), groups.join(", "))
}

pub struct ImportColumn {
  pub name: String,
  pub source: Option<f64>,
  pub ty: Option<String>,
}

pub struct ImportOptions {
  pub path: String,
  pub encoding: String,
  pub delimiter: String,
  pub header: bool,
  pub skip: f64,
  pub schema: String,
  pub table: String,
  pub create: bool,
  pub truncate: bool,
  pub columns: Vec<ImportColumn>,
  pub empty_as_null: bool,
  pub null_text: Option<String>,
  pub skip_errors: bool,
}

impl ImportOptions {
  pub fn from_value(v: &Value) -> ImportOptions {
    let s = |k: &str| match v.get(k) {
      Some(Value::String(x)) => x.clone(),
      None | Some(Value::Null) => String::new(),
      Some(x) => js::string(x),
    };
    ImportOptions {
      path: s("path"),
      encoding: s("encoding"),
      delimiter: s("delimiter"),
      header: js::truthy(v.get("header")),
      skip: v.get("skip").and_then(Value::as_f64).unwrap_or(0.0),
      schema: s("schema"),
      table: s("table"),
      create: js::truthy(v.get("create")),
      truncate: js::truthy(v.get("truncate")),
      columns: v
        .get("columns")
        .and_then(Value::as_array)
        .map(|a| {
          a.iter()
            .map(|c| ImportColumn {
              name: c.get("name").and_then(Value::as_str).unwrap_or("").to_string(),
              source: c.get("source").and_then(Value::as_f64),
              ty: c.get("type").and_then(Value::as_str).map(str::to_string),
            })
            .collect()
        })
        .unwrap_or_default(),
      empty_as_null: js::truthy(v.get("emptyAsNull")),
      null_text: v.get("nullText").and_then(Value::as_str).map(str::to_string),
      skip_errors: v.get("onError").and_then(Value::as_str) == Some("skip"),
    }
  }
}

fn create_table_for_import(schema: &str, table: &str, cols: &[&ImportColumn]) -> String {
  let lines: Vec<String> = cols
    .iter()
    .map(|c| {
      let ty = c.ty.as_deref().map(js::trim).filter(|t| !t.is_empty()).unwrap_or("text");
      format!("  {} {ty}", quote_ident(Kind::Postgres, &c.name))
    })
    .collect();
  format!("CREATE TABLE {} (\n{}\n)", qualify(schema, table), lines.join(",\n"))
}

/// One record's parameter values for the mapped columns.
fn row_values(rec: &[String], sources: &[f64], empty_as_null: bool, null_text: Option<&str>) -> Vec<Option<String>> {
  sources
    .iter()
    .map(|s| {
      let v = if *s >= 0.0 && s.fract() == 0.0 { rec.get(*s as usize) } else { None }?;
      if empty_as_null && v.is_empty() {
        return None;
      }
      if let Some(nt) = null_text.filter(|x| !x.is_empty()) {
        if v == nt {
          return None;
        }
      }
      Some(v.clone())
    })
    .collect()
}

pub type Progress = Arc<dyn Fn(f64, f64, f64) + Send + Sync>;

struct Load {
  per: usize,
  full_sql: String,
  one_sql: String,
  schema: String,
  table: String,
  names: Vec<String>,
  sources: Vec<f64>,
  empty_as_null: bool,
  null_text: Option<String>,
  skip_errors: bool,
  query_id: Option<String>,
  batch: Vec<Vec<String>>,
  batch_start: usize,
  rows: f64,
  skipped: f64,
  errors: Vec<Value>,
}

impl Load {
  fn is_cancelled(&self) -> bool {
    self.query_id.as_ref().is_some_and(|q| cancelled().contains(q))
  }

  async fn insert(&self, c: &mut super::pgwire::PgConn, recs: &[Vec<String>], sql: &str) -> R<()> {
    let mut params = vec![];
    for r in recs {
      params.extend(row_values(r, &self.sources, self.empty_as_null, self.null_text.as_deref()));
    }
    c.query(sql, &params).await.map(|_| ())
  }

  async fn flush(&mut self, c: &mut super::pgwire::PgConn) -> R<()> {
    if self.batch.is_empty() {
      return Ok(());
    }
    if self.is_cancelled() {
      return err("Cancelled");
    }
    let batch = std::mem::take(&mut self.batch);
    let sql = if batch.len() == self.per { self.full_sql.clone() } else { insert_sql(&self.schema, &self.table, &self.names, batch.len()) };
    if !self.skip_errors {
      self.insert(c, &batch, &sql).await?;
      self.rows += batch.len() as f64;
      return Ok(());
    }
    // Batch first; on failure retry it row by row and drop the bad ones.
    c.query("savepoint riven_imp", &[]).await?;
    match self.insert(c, &batch, &sql).await {
      Ok(()) => self.rows += batch.len() as f64,
      Err(_) => {
        c.query("rollback to savepoint riven_imp", &[]).await?;
        let one = self.one_sql.clone();
        for (i, rec) in batch.iter().enumerate() {
          let r = async {
            self.insert(c, std::slice::from_ref(rec), &one).await?;
            c.query("release savepoint riven_imp", &[]).await?;
            c.query("savepoint riven_imp", &[]).await?;
            Ok::<_, DbErr>(())
          }
          .await;
          match r {
            Ok(()) => self.rows += 1.0,
            Err(e) => {
              if self.is_cancelled() {
                return Err(e);
              }
              c.query("rollback to savepoint riven_imp", &[]).await?;
              self.skipped += 1.0;
              if self.errors.len() < 20 {
                self.errors.push(json!({ "record": self.batch_start + i + 1, "message": e.msg }));
              }
            }
          }
        }
      }
    }
    c.query("release savepoint riven_imp", &[]).await?;
    Ok(())
  }
}

pub async fn run_import(cfg: &Cfg, db: Option<&str>, o: ImportOptions, query_id: Option<&str>, progress: Progress) -> R<Value> {
  let r = run_import_inner(cfg, db, o, query_id, progress).await;
  let was_cancelled = query_id.is_some_and(|q| cancelled().contains(q));
  if let Some(q) = query_id {
    cancelled().remove(q);
  }
  match r {
    Err(_) if was_cancelled => err("Cancelled"),
    r => r,
  }
}

async fn run_import_inner(cfg: &Cfg, db: Option<&str>, o: ImportOptions, query_id: Option<&str>, progress: Progress) -> R<Value> {
  let mapped: Vec<&ImportColumn> = o.columns.iter().filter(|c| c.source.is_some() && !js::trim(&c.name).is_empty()).collect();
  if mapped.is_empty() {
    return err("No columns mapped");
  }
  if o.schema.is_empty() || o.table.is_empty() {
    return err("No target table");
  }
  let names: Vec<String> = mapped.iter().map(|c| c.name.clone()).collect();
  let sources: Vec<f64> = mapped.iter().map(|c| c.source.unwrap_or(-1.0)).collect();
  let per = batch_rows(names.len());
  let size = stat_size(&o.path)? as f64;
  let create_sql = o.create.then(|| create_table_for_import(&o.schema, &o.table, &mapped));
  let load = Load {
    per,
    full_sql: insert_sql(&o.schema, &o.table, &names, per),
    one_sql: insert_sql(&o.schema, &o.table, &names, 1),
    schema: o.schema.clone(),
    table: o.table.clone(),
    names,
    sources,
    empty_as_null: o.empty_as_null,
    null_text: o.null_text.clone(),
    skip_errors: o.skip_errors,
    query_id: query_id.map(str::to_string),
    batch: vec![],
    batch_start: 0,
    rows: 0.0,
    skipped: 0.0,
    errors: vec![],
  };
  let truncate = (!o.create && o.truncate).then(|| truncate_sql(&o.schema, &o.table));
  let (path, delimiter, encoding, header, skip) = (o.path.clone(), o.delimiter.clone(), o.encoding.clone(), o.header, o.skip);
  super::pg::transaction(cfg, db, query_id, move |c| {
    Box::pin(async move {
      let mut load = load;
      if let Some(sql) = &create_sql {
        c.query(sql, &[]).await?;
      } else if let Some(stmts) = &truncate {
        for s in stmts {
          c.query(s, &[]).await?;
        }
      }
      let mut parser = CsvParser::new(&delimiter);
      let mut dec = encoding_of(&encoding).new_decoder_with_bom_removal();
      let mut header = header;
      let mut skip = if skip.is_finite() { skip.floor().max(0.0) } else { 0.0 };
      let mut record = 0usize;
      let mut bytes = 0.0;
      let mut first = true;
      let mut f = std::fs::File::open(&path).map_err(|e| DbErr::new(format!("{}, open '{path}'", node_fs_error(&e))))?;
      let mut chunk = vec![0u8; 256 * 1024];
      macro_rules! take {
        ($recs:expr) => {
          for r in $recs {
            if header {
              header = false;
              continue;
            }
            if skip > 0.0 {
              skip -= 1.0;
              continue;
            }
            if load.batch.is_empty() {
              load.batch_start = record;
            }
            record += 1;
            load.batch.push(r);
            if load.batch.len() >= load.per {
              load.flush(c).await?;
              progress(load.rows, bytes, size);
            }
          }
        };
      }
      loop {
        let n = match f.read(&mut chunk) {
          Ok(0) => break,
          Ok(n) => n,
          Err(e) => return err(format!("{}, read", node_fs_error(&e))),
        };
        bytes += n as f64;
        let mut text = String::with_capacity(n * 2 + 16);
        let _ = dec.decode_to_string(&chunk[..n], &mut text, false);
        if first {
          text = strip_bom(text);
          first = false;
        }
        take!(parser.push(&text));
      }
      let mut tail = String::with_capacity(16);
      let _ = dec.decode_to_string(&[], &mut tail, true);
      take!(parser.push(&tail));
      take!(parser.end());
      load.flush(c).await?;
      progress(load.rows, size, size);
      Ok(json!({ "rows": load.rows, "skipped": load.skipped, "errors": load.errors }))
    })
  })
  .await
}

#[cfg(test)]
mod tests {
  use super::*;
  #[test]
  fn parses_like_csv_ts() {
    assert_eq!(parse_csv("a,b\r\n\"x,\"\"y\"\"\",2\n\n", ","), vec![vec!["a", "b"], vec!["x,\"y\"", "2"]]);
    let mut p = CsvParser::new(",");
    let mut r = p.push("\"ab\"");
    r.extend(p.push("\"c\",d\r"));
    r.extend(p.push("\ne"));
    r.extend(p.end());
    assert_eq!(r, vec![vec!["ab\"c", "d"], vec!["e"]]);
    assert_eq!(detect_delimiter("a;b;c\n1;2;3\n4;5;6\n7;8"), ";");
    assert_eq!(batch_rows(7), 1000);
    assert_eq!(batch_rows(100), 300);
  }
}
