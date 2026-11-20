// Result export writers (export.ts + mask.ts). Rows arrive in batches (a
// streamed read or the rows the grid already holds) and go straight to the
// file, so exporting a large table never holds it in memory. XLSX is written
// by hand: a zip of a few XML parts with the sheet deflated as it streams.
//
// The text written is the text Node wrote (numbers as JS prints them, JSON as
// JSON.stringify, masks per code point); the deflate bytes inside an XLSX come
// from a different compressor, so the zip differs while its parts are equal.

use super::js::{num_str, utf16_len};
use super::pgwire::node_fs_error;
use super::sqltext::{literal, quote_ident};
use super::{Cell, Kind, R};
use flate2::write::DeflateEncoder;
use flate2::Compression;
use regex::Regex;
use serde_json::Value;
use std::fs::File;
use std::io::{BufWriter, Write};
use std::sync::OnceLock;

/// Excel's sheet limit, header row included.
pub const XLSX_MAX_ROWS: usize = 1_048_575;

// ---- mask.ts ------------------------------------------------------------------------

#[derive(Clone)]
pub struct ExportColumn {
  pub index: usize,
  pub name: String,
  pub ty: String,
  pub mask: String,
  pub keep: Option<f64>,
}

pub struct ExportOptions {
  pub format: String,
  pub columns: Vec<ExportColumn>,
  pub header: bool,
  pub null_text: String,
  pub bom: bool,
  pub table: String,
}

impl ExportOptions {
  pub fn from_value(v: &Value) -> ExportOptions {
    let s = |k: &str| match v.get(k) {
      Some(Value::String(x)) => x.clone(),
      None | Some(Value::Null) => String::new(),
      Some(x) => super::js::string(x),
    };
    ExportOptions {
      format: s("format"),
      columns: v
        .get("columns")
        .and_then(Value::as_array)
        .map(|a| {
          a.iter()
            .map(|c| ExportColumn {
              index: c.get("index").and_then(Value::as_f64).filter(|f| *f >= 0.0).map(|f| f as usize).unwrap_or(usize::MAX),
              name: c.get("name").map(|x| x.as_str().map(str::to_string).unwrap_or_else(|| super::js::string(x))).unwrap_or_else(|| "undefined".into()),
              ty: c.get("type").and_then(Value::as_str).unwrap_or("").to_string(),
              mask: c.get("mask").and_then(Value::as_str).unwrap_or("").to_string(),
              keep: c.get("keep").and_then(Value::as_f64),
            })
            .collect()
        })
        .unwrap_or_default(),
      header: super::js::truthy(v.get("header")),
      null_text: s("nullText"),
      bom: super::js::truthy(v.get("bom")),
      table: s("table"),
    }
  }
}

fn alnum(c: char) -> bool {
  static RE: OnceLock<Regex> = OnceLock::new();
  let re = RE.get_or_init(|| Regex::new(r"^[\p{L}\p{N}]$").expect("re"));
  let mut b = [0u8; 4];
  re.is_match(c.encode_utf8(&mut b))
}

/// Replace letters/digits outside [keep_start, n - keep_end) of the alnum sequence.
fn hide(s: &str, keep_start: f64, keep_end: f64) -> String {
  let n = s.chars().filter(|c| alnum(*c)).count() as f64;
  let mut i = 0.0;
  let mut out = String::with_capacity(s.len());
  for ch in s.chars() {
    if !alnum(ch) {
      out.push(ch);
      continue;
    }
    out.push(if i < keep_start || i >= n - keep_end { ch } else { '*' });
    i += 1.0;
  }
  out
}

fn middle(s: &str) -> String {
  let n = s.chars().filter(|c| alnum(*c)).count() as f64;
  let start = (n / 3.0).floor().max(1.0);
  let mut end = (n / 3.0).ceil();
  if start + end >= n {
    end = (n - start - 1.0).max(0.0);
  }
  hide(s, start, end)
}

pub fn mask_value(v: &Cell, mode: &str, keep: Option<f64>) -> Cell {
  if mode == "none" || v.is_null() {
    return v.clone();
  }
  if mode == "empty" {
    return Cell::Null;
  }
  let s = v.js_string();
  Cell::Str(match mode {
    "full" => hide(&s, 0.0, 0.0),
    "start" => hide(&s, keep.unwrap_or(1.0).max(0.0), 0.0),
    "end" => hide(&s, 0.0, keep.unwrap_or(4.0).max(0.0)),
    "middle" => middle(&s),
    "email" => match s.rfind('@') {
      Some(at) if at > 0 => {
        let local = &s[..at];
        hide(local, (utf16_len(local) as f64 - 1.0).max(1.0).min(2.0), 0.0) + &s[at..]
      }
      _ => middle(&s),
    },
    _ => return v.clone(),
  })
}

/// The chosen columns of a row, masked.
pub fn project_row(row: &[Cell], cols: &[ExportColumn]) -> Vec<Cell> {
  cols.iter().map(|c| mask_value(row.get(c.index).unwrap_or(&Cell::Null), &c.mask, c.keep)).collect()
}

// ---- file -----------------------------------------------------------------------------

struct Out {
  f: BufWriter<File>,
  bytes: u64,
  path: String,
}

impl Out {
  fn open(path: &str) -> R<Out> {
    let f = File::create(path).map_err(|e| super::DbErr::new(format!("{}, open '{path}'", node_fs_error(&e))))?;
    Ok(Out { f: BufWriter::with_capacity(1 << 16, f), bytes: 0, path: path.into() })
  }
  fn write(&mut self, b: &[u8]) -> R<()> {
    self.bytes += b.len() as u64;
    self.f.write_all(b).map_err(|e| super::DbErr::new(format!("{}, write", node_fs_error(&e))))
  }
  fn close(&mut self) -> R<()> {
    self.f.flush().map_err(|e| super::DbErr::new(format!("{}, write", node_fs_error(&e))))
  }
}

// ---- zip ------------------------------------------------------------------------------

fn dos_time() -> (u16, u16) {
  let now = unsafe { libc::time(std::ptr::null_mut()) };
  let mut tm: libc::tm = unsafe { std::mem::zeroed() };
  unsafe { libc::localtime_r(&now, &mut tm) };
  let time = ((tm.tm_hour << 11) | (tm.tm_min << 5) | (tm.tm_sec / 2)) as u16;
  let date = (((tm.tm_year + 1900 - 1980) << 9) | ((tm.tm_mon + 1) << 5) | tm.tm_mday) as u16;
  (time, date)
}

struct ZipEntry {
  name: Vec<u8>,
  crc: u32,
  csize: u32,
  usize: u32,
  offset: u32,
  streamed: bool,
}

struct Zip {
  entries: Vec<ZipEntry>,
  t: (u16, u16),
}

fn le16(v: &mut Vec<u8>, x: u16) {
  v.extend_from_slice(&x.to_le_bytes());
}
fn le32(v: &mut Vec<u8>, x: u32) {
  v.extend_from_slice(&x.to_le_bytes());
}

impl Zip {
  fn header(&self, name: &[u8], flags: u16, crc: u32, csize: u32, usize: u32) -> Vec<u8> {
    let mut h = Vec::with_capacity(30 + name.len());
    le32(&mut h, 0x04034b50);
    le16(&mut h, 20);
    le16(&mut h, flags);
    le16(&mut h, 8);
    le16(&mut h, self.t.0);
    le16(&mut h, self.t.1);
    le32(&mut h, crc);
    le32(&mut h, csize);
    le32(&mut h, usize);
    le16(&mut h, name.len() as u16);
    le16(&mut h, 0);
    h.extend_from_slice(name);
    h
  }

  fn file(&mut self, out: &mut Out, path: &str, text: &str) -> R<()> {
    let data = text.as_bytes();
    let mut z = DeflateEncoder::new(Vec::new(), Compression::new(6));
    z.write_all(data)?;
    let z = z.finish()?;
    let e = ZipEntry { name: path.as_bytes().to_vec(), crc: crc32fast::hash(data), csize: z.len() as u32, usize: data.len() as u32, offset: out.bytes as u32, streamed: false };
    out.write(&self.header(&e.name, 0, e.crc, e.csize, e.usize))?;
    out.write(&z)?;
    self.entries.push(e);
    Ok(())
  }

  fn finish(&mut self, out: &mut Out) -> R<()> {
    let start = out.bytes as u32;
    for e in &self.entries {
      let mut c = Vec::with_capacity(46 + e.name.len());
      le32(&mut c, 0x02014b50);
      le16(&mut c, 20);
      le16(&mut c, 20);
      le16(&mut c, if e.streamed { 0x08 } else { 0 });
      le16(&mut c, 8);
      le16(&mut c, self.t.0);
      le16(&mut c, self.t.1);
      le32(&mut c, e.crc);
      le32(&mut c, e.csize);
      le32(&mut c, e.usize);
      le16(&mut c, e.name.len() as u16);
      c.extend_from_slice(&[0; 12]);
      le32(&mut c, e.offset);
      c.extend_from_slice(&e.name);
      out.write(&c)?;
    }
    let mut end = Vec::with_capacity(22);
    le32(&mut end, 0x06054b50);
    le32(&mut end, 0);
    le16(&mut end, self.entries.len() as u16);
    le16(&mut end, self.entries.len() as u16);
    le32(&mut end, out.bytes as u32 - start);
    le32(&mut end, start);
    le16(&mut end, 0);
    out.write(&end)
  }
}

/// A zip entry whose content is pushed in pieces; sizes follow in a data descriptor.
struct Sheet {
  e: ZipEntry,
  z: DeflateEncoder<Vec<u8>>,
  hasher: crc32fast::Hasher,
  buf: String,
  len: usize,
}

impl Sheet {
  fn begin(zip: &Zip, out: &mut Out, path: &str) -> R<Sheet> {
    let e = ZipEntry { name: path.as_bytes().to_vec(), crc: 0, csize: 0, usize: 0, offset: out.bytes as u32, streamed: true };
    out.write(&zip.header(&e.name, 0x08, 0, 0, 0))?;
    Ok(Sheet { e, z: DeflateEncoder::new(Vec::new(), Compression::new(6)), hasher: crc32fast::Hasher::new(), buf: String::new(), len: 0 })
  }
  fn drain(&mut self, out: &mut Out) -> R<()> {
    let v = self.z.get_mut();
    if !v.is_empty() {
      self.e.csize = self.e.csize.wrapping_add(v.len() as u32);
      out.write(v)?;
      v.clear();
    }
    Ok(())
  }
  fn flush(&mut self, out: &mut Out) -> R<()> {
    if self.buf.is_empty() {
      return Ok(());
    }
    let b = std::mem::take(&mut self.buf);
    self.len = 0;
    self.hasher.update(b.as_bytes());
    self.e.usize = self.e.usize.wrapping_add(b.len() as u32);
    self.z.write_all(b.as_bytes())?;
    self.drain(out)
  }
  fn add(&mut self, out: &mut Out, s: &str) -> R<()> {
    self.buf.push_str(s);
    self.len += utf16_len(s);
    if self.len > 1 << 16 {
      self.flush(out)?;
    }
    Ok(())
  }
  fn end(mut self, zip: &mut Zip, out: &mut Out) -> R<()> {
    self.flush(out)?;
    self.z.try_finish()?;
    self.drain(out)?;
    self.e.crc = self.hasher.clone().finalize();
    let mut d = Vec::with_capacity(16);
    le32(&mut d, 0x08074b50);
    le32(&mut d, self.e.crc);
    le32(&mut d, self.e.csize);
    le32(&mut d, self.e.usize);
    out.write(&d)?;
    zip.entries.push(self.e);
    Ok(())
  }
}

// ---- formats ----------------------------------------------------------------------------

fn xml(s: &str) -> String {
  let mut out = String::with_capacity(s.len());
  for c in s.chars() {
    match c {
      '\u{0}'..='\u{8}' | '\u{b}' | '\u{c}' | '\u{e}'..='\u{1f}' | '\u{fffe}' | '\u{ffff}' => {}
      '&' => out.push_str("&amp;"),
      '<' => out.push_str("&lt;"),
      '>' => out.push_str("&gt;"),
      '"' => out.push_str("&quot;"),
      c => out.push(c),
    }
  }
  out
}

const NUMERIC_TYPES: &[&str] = &["bigint", "numeric", "smallint", "integer", "real", "double precision", "oid"];

/// s.slice(0, n) in UTF-16 units; half a surrogate pair becomes U+FFFD as Buffer.from wrote it.
fn slice16(s: &str, n: usize) -> String {
  let mut out = String::new();
  let mut k = 0;
  for c in s.chars() {
    let w = c.len_utf16();
    if k + w > n {
      if k < n {
        out.push('\u{fffd}');
      }
      break;
    }
    out.push(c);
    k += w;
  }
  out
}

fn plain_number(s: &str) -> bool {
  static RE: OnceLock<Regex> = OnceLock::new();
  RE.get_or_init(|| Regex::new(r"^-?[0-9]+(\.[0-9]+)?$").expect("re")).is_match(s)
}

fn xlsx_cell(v: &Cell, numeric: bool, style: &str) -> String {
  match v {
    Cell::Null => "<c/>".into(),
    Cell::Bool(b) => format!("<c t=\"b\"{style}><v>{}</v></c>", if *b { 1 } else { 0 }),
    Cell::Num(f) if f.is_finite() => format!("<c{style}><v>{}</v></c>", num_str(*f)),
    _ => {
      let s = v.js_string();
      // int8/numeric arrive as text; a number cell only when Excel keeps every digit.
      if numeric && plain_number(&s) && s.replace(['-', '.'], "").trim_start_matches('0').len() <= 15 {
        return format!("<c{style}><v>{s}</v></c>");
      }
      let t = if utf16_len(&s) > 32767 { slice16(&s, 32767) } else { s };
      format!("<c t=\"inlineStr\"{style}><is><t xml:space=\"preserve\">{}</t></is></c>", xml(&t))
    }
  }
}

const XLSX_PARTS: &[(&str, &str)] = &[
  (
    "[Content_Types].xml",
    concat!(
      "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\">",
      "<Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/>",
      "<Default Extension=\"xml\" ContentType=\"application/xml\"/>",
      "<Override PartName=\"/xl/workbook.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml\"/>",
      "<Override PartName=\"/xl/worksheets/sheet1.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml\"/>",
      "<Override PartName=\"/xl/styles.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml\"/></Types>"
    ),
  ),
  (
    "_rels/.rels",
    concat!(
      "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">",
      "<Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"xl/workbook.xml\"/></Relationships>"
    ),
  ),
  (
    "xl/workbook.xml",
    concat!(
      "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><workbook xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\" ",
      "xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\"><sheets><sheet name=\"Sheet1\" sheetId=\"1\" r:id=\"rId1\"/></sheets></workbook>"
    ),
  ),
  (
    "xl/_rels/workbook.xml.rels",
    concat!(
      "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">",
      "<Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet\" Target=\"worksheets/sheet1.xml\"/>",
      "<Relationship Id=\"rId2\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles\" Target=\"styles.xml\"/></Relationships>"
    ),
  ),
  (
    "xl/styles.xml",
    concat!(
      "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><styleSheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\">",
      "<fonts count=\"2\"><font><sz val=\"11\"/><name val=\"Calibri\"/></font><font><b/><sz val=\"11\"/><name val=\"Calibri\"/></font></fonts>",
      "<fills count=\"2\"><fill><patternFill patternType=\"none\"/></fill><fill><patternFill patternType=\"gray125\"/></fill></fills>",
      "<borders count=\"1\"><border><left/><right/><top/><bottom/><diagonal/></border></borders>",
      "<cellStyleXfs count=\"1\"><xf numFmtId=\"0\" fontId=\"0\" fillId=\"0\" borderId=\"0\"/></cellStyleXfs>",
      "<cellXfs count=\"2\"><xf numFmtId=\"0\" fontId=\"0\" fillId=\"0\" borderId=\"0\" xfId=\"0\"/>",
      "<xf numFmtId=\"0\" fontId=\"1\" fillId=\"0\" borderId=\"0\" xfId=\"0\" applyFont=\"1\"/></cellXfs>",
      "<cellStyles count=\"1\"><cellStyle name=\"Normal\" xfId=\"0\" builtinId=\"0\"/></cellStyles></styleSheet>"
    ),
  ),
];

fn delim_field(v: &Cell, sep: char, null_text: &str) -> String {
  if v.is_null() {
    return null_text.into();
  }
  let s = v.js_string();
  if s.contains(sep) || s.contains('"') || s.contains('\n') || s.contains('\r') {
    format!("\"{}\"", s.replace('"', "\"\""))
  } else {
    s
  }
}

fn sql_value(v: &Cell) -> String {
  match v {
    Cell::Null => "NULL".into(),
    Cell::Num(_) | Cell::Bool(_) => v.js_string(),
    Cell::Str(s) => literal(Kind::Postgres, Some(s)),
  }
}

/// JSON.stringify of a cell.
fn json_cell(v: &Cell) -> String {
  match v {
    Cell::Null => "null".into(),
    Cell::Bool(b) => b.to_string(),
    Cell::Num(f) if f.is_finite() => num_str(*f),
    Cell::Num(_) => "null".into(),
    Cell::Str(s) => serde_json::to_string(s).unwrap_or_default(),
  }
}

/// A canonical array index ("0", "17"): JS objects list these first, ascending.
fn array_index(k: &str) -> Option<u32> {
  if k.is_empty() || (k.len() > 1 && k.starts_with('0')) || !k.bytes().all(|b| b.is_ascii_digit()) {
    return None;
  }
  k.parse::<u64>().ok().filter(|n| *n < u32::MAX as u64).map(|n| n as u32)
}

enum Fmt {
  Xlsx { zip: Zip, sheet: Option<Sheet>, numeric: Vec<bool>, max: usize },
  Delim { sep: char },
  Json { keys: Vec<String> },
  Sql { head: String },
}

pub struct ExportWriter {
  out: Out,
  o: ExportOptions,
  fmt: Fmt,
  count: usize,
}

/// Open a writer for `path`. Rows passed in are full result rows; the writer projects and masks them.
pub fn open_export(path: &str, o: ExportOptions) -> R<ExportWriter> {
  let mut out = Out::open(path)?;
  let names: Vec<String> = o.columns.iter().map(|c| c.name.clone()).collect();
  let fmt = match o.format.as_str() {
    "xlsx" => {
      let mut zip = Zip { entries: vec![], t: dos_time() };
      for (p, text) in XLSX_PARTS {
        zip.file(&mut out, p, text)?;
      }
      let mut sheet = Sheet::begin(&zip, &mut out, "xl/worksheets/sheet1.xml")?;
      let numeric = o.columns.iter().map(|c| NUMERIC_TYPES.contains(&c.ty.as_str())).collect();
      let mut head = String::from("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><worksheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\">");
      if o.header {
        head.push_str("<sheetViews><sheetView workbookViewId=\"0\"><pane ySplit=\"1\" topLeftCell=\"A2\" activePane=\"bottomLeft\" state=\"frozen\"/></sheetView></sheetViews>");
      }
      head.push_str("<sheetData>");
      sheet.add(&mut out, &head)?;
      if o.header {
        let row: String = names.iter().map(|n| xlsx_cell(&Cell::Str(n.clone()), false, " s=\"1\"")).collect();
        sheet.add(&mut out, &format!("<row>{row}</row>"))?;
      }
      let max = XLSX_MAX_ROWS - if o.header { 1 } else { 0 };
      Fmt::Xlsx { zip, sheet: Some(sheet), numeric, max }
    }
    "csv" | "tsv" => {
      let sep = if o.format == "csv" { ',' } else { '\t' };
      if o.bom {
        out.write("\u{feff}".as_bytes())?;
      }
      if o.header {
        let line = names.iter().map(|n| delim_field(&Cell::Str(n.clone()), sep, "")).collect::<Vec<_>>().join(&sep.to_string()) + "\r\n";
        out.write(line.as_bytes())?;
      }
      Fmt::Delim { sep }
    }
    "json" => {
      // Duplicate names would collapse in an object: a_2, a_3, ...
      let mut seen: std::collections::HashMap<String, usize> = Default::default();
      let keys = names
        .iter()
        .map(|n| {
          let k = *seen.get(n).unwrap_or(&0);
          seen.insert(n.clone(), k + 1);
          if k > 0 {
            format!("{n}_{}", k + 1)
          } else {
            n.clone()
          }
        })
        .collect();
      out.write(b"[")?;
      Fmt::Json { keys }
    }
    _ => {
      let unquote = |p: &str| -> String {
        let a = p.strip_prefix('"').unwrap_or(p);
        a.strip_suffix('"').unwrap_or(a).to_string()
      };
      let target = o.table.split('.').map(|p| quote_ident(Kind::Postgres, &unquote(p))).collect::<Vec<_>>().join(".");
      let target = if target.is_empty() { "result".to_string() } else { target };
      let head = format!("insert into {target} ({}) values ", names.iter().map(|n| quote_ident(Kind::Postgres, n)).collect::<Vec<_>>().join(", "));
      Fmt::Sql { head }
    }
  };
  Ok(ExportWriter { out, o, fmt, count: 0 })
}

impl ExportWriter {
  pub fn rows(&mut self, batch: &[Vec<Cell>]) -> R<()> {
    let cols = &self.o.columns;
    match &mut self.fmt {
      Fmt::Xlsx { sheet, numeric, max, .. } => {
        let sheet = sheet.as_mut().expect("sheet");
        for r in batch {
          if self.count >= *max {
            return Ok(());
          }
          let p = project_row(r, cols);
          let row: String = p.iter().enumerate().map(|(i, v)| xlsx_cell(v, numeric[i] && cols[i].mask == "none", "")).collect();
          sheet.add(&mut self.out, &format!("<row>{row}</row>"))?;
          self.count += 1;
        }
      }
      Fmt::Delim { sep } => {
        let mut s = String::new();
        let sep_s = sep.to_string();
        for r in batch {
          s += &project_row(r, cols).iter().map(|v| delim_field(v, *sep, &self.o.null_text)).collect::<Vec<_>>().join(&sep_s);
          s += "\r\n";
        }
        self.count += batch.len();
        self.out.write(s.as_bytes())?;
      }
      Fmt::Json { keys } => {
        let mut s = String::new();
        for r in batch {
          let p = project_row(r, cols);
          // Object key order: array indices first (ascending), then insertion order;
          // a repeated key keeps its first place and its last value.
          let mut obj: Vec<(&str, &Cell)> = vec![];
          for (i, k) in keys.iter().enumerate() {
            match obj.iter_mut().find(|(x, _)| *x == k.as_str()) {
              Some(slot) => slot.1 = &p[i],
              None => obj.push((k, &p[i])),
            }
          }
          let (mut idx, rest): (Vec<_>, Vec<_>) = obj.into_iter().partition(|(k, _)| array_index(k).is_some());
          idx.sort_by_key(|(k, _)| array_index(k));
          let body = idx.into_iter().chain(rest).map(|(k, v)| format!("{}:{}", serde_json::to_string(k).unwrap_or_default(), json_cell(v))).collect::<Vec<_>>().join(",");
          s += if self.count > 0 { ",\n" } else { "\n" };
          self.count += 1;
          s += &format!("{{{body}}}");
        }
        self.out.write(s.as_bytes())?;
      }
      Fmt::Sql { head } => {
        let mut s = String::new();
        for r in batch {
          s += head;
          s += "(";
          s += &project_row(r, cols).iter().map(sql_value).collect::<Vec<_>>().join(", ");
          s += ");\n";
        }
        self.count += batch.len();
        self.out.write(s.as_bytes())?;
      }
    }
    Ok(())
  }

  /// Finish the file; returns the data rows written.
  pub fn close(mut self) -> R<usize> {
    match &mut self.fmt {
      Fmt::Xlsx { zip, sheet, .. } => {
        let mut sh = sheet.take().expect("sheet");
        sh.add(&mut self.out, "</sheetData></worksheet>")?;
        sh.end(zip, &mut self.out)?;
        zip.finish(&mut self.out)?;
      }
      Fmt::Json { .. } => self.out.write(b"\n]\n")?,
      _ => {}
    }
    self.out.close()?;
    Ok(self.count)
  }

  /// Stop and delete the partial file.
  pub fn abort(mut self) {
    let _ = self.out.close();
    let _ = std::fs::remove_file(&self.out.path);
  }
}

/// `(name || fallback).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 120)`
pub fn safe_name(name: &str, fallback: &str) -> String {
  let n = if name.is_empty() { fallback } else { name };
  let replaced: String = n.chars().map(|c| if matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '\u{0}'..='\u{1f}') { '_' } else { c }).collect();
  slice16(&replaced, 120)
}

#[cfg(test)]
mod tests {
  use super::*;
  #[test]
  fn masks_like_mask_ts() {
    let m = |v: &str, mode: &str, k: Option<f64>| match mask_value(&Cell::Str(v.into()), mode, k) {
      Cell::Str(s) => s,
      _ => String::new(),
    };
    assert_eq!(m("010-1234-5678", "middle", None), "010-****-5678");
    assert_eq!(m("hong@example.com", "email", None), "ho**@example.com");
    assert_eq!(m("a@x.io", "email", None), "a@x.io");
    assert_eq!(m("123456-1234567", "end", None), "******-***4567");
    assert_eq!(m("abc", "start", Some(1.0)), "a**");
  }
  #[test]
  fn xlsx_cells() {
    assert_eq!(xlsx_cell(&Cell::Str("00123456789012345".into()), true, ""), "<c><v>00123456789012345</v></c>");
    assert!(xlsx_cell(&Cell::Str("1234567890123456".into()), true, "").contains("inlineStr"));
    assert_eq!(xlsx_cell(&Cell::Num(1.5), false, ""), "<c><v>1.5</v></c>");
    assert_eq!(xlsx_cell(&Cell::Str("a<b".into()), false, ""), "<c t=\"inlineStr\"><is><t xml:space=\"preserve\">a&lt;b</t></is></c>");
  }
}
