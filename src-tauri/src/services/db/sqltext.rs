// SQL text rules (src/main/db/sqlText.ts): statement splitting, identifier
// quoting, and the read-only / dangerous-statement guards. Also the few ddl.ts
// and privs.ts pieces main used (isDdl, qualify, truncateSql, PRIVS).
//
// The scanner must read text the way the SERVER does, since the read-only
// check counts statements with it: MySQL needs whitespace after `--` for a
// comment and runs the body of `/*! ... */`, PostgreSQL nests block comments
// and treats `\` as an escape inside E'...'. Text is scanned as chars; every
// rule here looks at ASCII or "any char >= 0x80", so a JS UTF-16 index and a
// char index pick out the same statements.

use super::Kind;
use crate::services::chat::util::js_trim;
use regex::Regex;
use std::sync::OnceLock;

fn is_space(c: char) -> bool {
  matches!(c, ' ' | '\t' | '\n' | '\r' | '\u{c}' | '\u{b}')
}
fn is_ctl(c: char) -> bool {
  (c as u32) < 0x20
}
fn is_word(c: char) -> bool {
  c == '_' || c.is_ascii_alphanumeric() || (c as u32) >= 0x80
}

fn at(t: &[char], i: usize) -> Option<char> {
  t.get(i).copied()
}

fn index_of(t: &[char], c: char, from: usize) -> Option<usize> {
  (from..t.len()).find(|&j| t[j] == c)
}

fn find_seq(t: &[char], pat: &[char], from: usize) -> Option<usize> {
  if pat.is_empty() {
    return Some(from.min(t.len()));
  }
  if pat.len() > t.len() {
    return None;
  }
  (from..=t.len() - pat.len()).find(|&j| t[j..j + pat.len()] == *pat)
}

fn line_end(t: &[char], i: usize) -> usize {
  index_of(t, '\n', i).map(|j| j + 1).unwrap_or(t.len())
}

fn dash_comment(t: &[char], i: usize, kind: Kind) -> bool {
  if at(t, i) != Some('-') || at(t, i + 1) != Some('-') {
    return false;
  }
  if kind != Kind::Mysql {
    return true;
  }
  match at(t, i + 2) {
    None => true,
    Some(n) => is_space(n) || is_ctl(n),
  }
}

fn block_end(t: &[char], i: usize, kind: Kind) -> usize {
  let mut depth = 1;
  let mut j = i + 2;
  let n = t.len();
  while j < n && depth > 0 {
    if t[j] == '/' && at(t, j + 1) == Some('*') && kind == Kind::Postgres {
      depth += 1;
      j += 2;
    } else if t[j] == '*' && at(t, j + 1) == Some('/') {
      depth -= 1;
      j += 2;
    } else {
      j += 1;
    }
  }
  j
}

fn quote_end(t: &[char], i: usize, kind: Kind, e_string: bool) -> usize {
  let q = t[i];
  let backslash = kind == Kind::Mysql || e_string;
  let mut j = i + 1;
  let n = t.len();
  while j < n {
    if backslash && t[j] == '\\' {
      j += 2;
      continue;
    }
    if t[j] == q {
      if at(t, j + 1) == Some(q) {
        j += 2;
        continue;
      }
      break;
    }
    j += 1;
  }
  (j + 1).min(n)
}

fn dollar_tag(t: &[char], i: usize) -> Option<Vec<char>> {
  let close = index_of(t, '$', i + 1)?;
  let inner = &t[i + 1..close];
  if !inner.iter().all(|c| c.is_ascii_alphanumeric() || *c == '_') {
    return None;
  }
  if inner.first().is_some_and(|c| c.is_ascii_digit()) {
    return None;
  }
  Some(t[i..=close].to_vec())
}

/// [start, end) char ranges of the statements in `text`.
fn split_chars(t: &[char], kind: Kind) -> Vec<(usize, usize)> {
  if kind == Kind::Redis {
    let mut out = Vec::new();
    let mut pos = 0;
    for line in t.split(|c| *c == '\n') {
      let s: String = line.iter().collect();
      let tr = js_trim(&s);
      if !tr.is_empty() && !tr.starts_with('#') && !tr.starts_with("//") {
        out.push((pos, pos + line.len()));
      }
      pos += line.len() + 1;
    }
    return out;
  }
  let mut out = Vec::new();
  let n = t.len();
  let mut start = 0;
  let mut i = 0;
  while i < n {
    let c = t[i];
    if dash_comment(t, i, kind) || (c == '#' && kind == Kind::Mysql) {
      i = line_end(t, i);
      continue;
    }
    if c == '/' && at(t, i + 1) == Some('*') {
      if kind == Kind::Mysql && at(t, i + 2) == Some('!') {
        i += 3;
        continue;
      }
      i = block_end(t, i, kind);
      continue;
    }
    if c == '\'' || c == '"' || c == '`' {
      let e_string = kind == Kind::Postgres
        && c == '\''
        && i > 0
        && (t[i - 1] == 'e' || t[i - 1] == 'E')
        && (i < 2 || !is_word(t[i - 2]) || (t[i - 2] as u32) >= 0x80);
      i = quote_end(t, i, kind, e_string);
      continue;
    }
    if c == '$' && kind == Kind::Postgres {
      if let Some(tag) = dollar_tag(t, i) {
        i = match find_seq(t, &tag, i + tag.len()) {
          Some(j) => j + tag.len(),
          None => n,
        };
        continue;
      }
    }
    if c == ';' {
      out.push((start, i));
      start = i + 1;
    }
    i += 1;
  }
  out.push((start, n));
  out.retain(|&(s, e)| {
    let x: String = t[s.min(n)..e.min(n)].iter().collect();
    !js_trim(&x).is_empty()
  });
  out
}

pub fn split_count(text: &str, kind: Kind) -> usize {
  let t: Vec<char> = text.chars().collect();
  split_chars(&t, kind).len()
}

pub fn statements(text: &str, kind: Kind) -> Vec<String> {
  let t: Vec<char> = text.chars().collect();
  split_chars(&t, kind)
    .into_iter()
    .map(|(s, e)| {
      let x: String = t[s..e].iter().collect();
      js_trim(&x).to_string()
    })
    .collect()
}

// ---- guard ------------------------------------------------------------------

struct Tok {
  text: String,
  word: bool,
  depth: i32,
}

fn scan(sql: &str, kind: Kind) -> (Vec<Tok>, bool) {
  let t: Vec<char> = sql.chars().collect();
  let mut toks = Vec::new();
  let n = t.len();
  let my = kind == Kind::Mysql;
  let mut i = 0;
  let mut depth = 0i32;
  let mut exec_comment = false;
  while i < n {
    let c = t[i];
    if is_space(c) {
      i += 1;
      continue;
    }
    if dash_comment(&t, i, kind) || (c == '#' && my) {
      i = line_end(&t, i);
      continue;
    }
    if c == '/' && at(&t, i + 1) == Some('*') {
      if my && at(&t, i + 2) == Some('!') {
        exec_comment = true;
        i += 3;
        while i < n && t[i].is_ascii_digit() {
          i += 1;
        }
        continue;
      }
      i = block_end(&t, i, kind);
      continue;
    }
    if c == '\'' || c == '"' || c == '`' {
      let e_string = kind == Kind::Postgres && c == '\'' && i > 0 && (t[i - 1] == 'e' || t[i - 1] == 'E');
      let end = quote_end(&t, i, kind, e_string);
      let hi = (i + 1).max(end.saturating_sub(1));
      let inner: String = t[(i + 1).min(n)..hi.min(n)].iter().collect();
      if c == '\'' {
        toks.push(Tok { text: "'".into(), word: false, depth });
      } else {
        toks.push(Tok { text: inner.to_lowercase(), word: true, depth });
      }
      i = end;
      continue;
    }
    if c == '$' && kind == Kind::Postgres {
      if let Some(tag) = dollar_tag(&t, i) {
        i = match find_seq(&t, &tag, i + tag.len()) {
          Some(j) => j + tag.len(),
          None => n,
        };
        toks.push(Tok { text: "'".into(), word: false, depth });
        continue;
      }
    }
    if is_word(c) {
      let s = i;
      while i < n && (is_word(t[i]) || t[i] == '$') {
        i += 1;
      }
      let w: String = t[s..i].iter().collect();
      toks.push(Tok { text: w.to_lowercase(), word: true, depth });
      continue;
    }
    if c == '(' {
      depth += 1;
    }
    toks.push(Tok { text: c.to_string(), word: false, depth });
    if c == ')' {
      depth -= 1;
    }
    i += 1;
  }
  (toks, exec_comment)
}

const READ_WORDS: &[&str] = &["select", "with", "values", "table", "show", "explain", "describe", "desc"];
const SESSION_WORDS: &[&str] = &["begin", "start", "commit", "rollback", "end", "abort", "set", "use"];
const SIDE_EFFECT_FUNCS: &[&str] = &[
  "pg_terminate_backend", "pg_cancel_backend", "pg_reload_conf", "pg_rotate_logfile", "pg_read_file",
  "pg_read_binary_file", "pg_ls_dir", "pg_stat_file", "pg_ls_logdir", "pg_ls_waldir", "pg_ls_tmpdir",
  "pg_ls_archive_statusdir", "pg_file_write", "lo_import", "lo_export", "dblink", "dblink_exec",
  "dblink_connect", "dblink_send_query", "set_config", "pg_switch_wal", "pg_create_restore_point",
  "pg_promote", "pg_advisory_lock", "pg_advisory_xact_lock", "pg_try_advisory_lock", "pg_sleep",
  "pg_sleep_for", "pg_sleep_until", "load_file", "sleep", "benchmark", "get_lock", "release_lock", "release_all_locks",
];

/// Why `sql` may not run read-only, or None. strict = agent-written.
pub fn read_only_violation(sql: &str, kind: Kind, strict: bool) -> Option<String> {
  if kind == Kind::Redis {
    return None;
  }
  if split_count(sql, kind) != 1 {
    return Some("Read-only mode runs exactly one statement".into());
  }
  let (toks, exec) = scan(sql, kind);
  if exec {
    return Some("MySQL executable comments (/*! ... */) are not allowed in read-only mode".into());
  }
  let first = toks.iter().find(|t| t.word).map(|t| t.text.as_str()).unwrap_or("");
  let allowed = READ_WORDS.contains(&first) || (!strict && SESSION_WORDS.contains(&first));
  if !allowed {
    return Some(format!("Read-only mode: '{first}' statements are not allowed"));
  }
  let words: Vec<&str> = toks.iter().map(|t| t.text.as_str()).collect();
  let pairs = |a: &str, b: &str| words.iter().enumerate().any(|(k, w)| *w == a && words.get(k + 1) == Some(&b));
  if words.iter().any(|w| w.contains("read_only")) || pairs("read", "write") {
    return Some("Read-only mode: changing the read-only setting is not allowed".into());
  }
  if pairs("into", "outfile") || pairs("into", "dumpfile") {
    return Some("Read-only mode: SELECT ... INTO OUTFILE/DUMPFILE is not allowed".into());
  }
  if strict {
    for (k, t) in toks.iter().enumerate() {
      if t.word && toks.get(k + 1).map(|x| x.text.as_str()) == Some("(") && SIDE_EFFECT_FUNCS.contains(&t.text.as_str()) {
        return Some(format!("Read-only mode: {}() is not allowed (it has side effects outside the transaction)", t.text));
      }
    }
  }
  None
}

/// Reason to confirm before running: UPDATE/DELETE without WHERE, DROP, TRUNCATE.
pub fn unsafe_statement(sql: &str, kind: Kind) -> Option<String> {
  if kind == Kind::Redis {
    let cmd = js_trim(sql).split_whitespace().next().unwrap_or("").to_uppercase();
    return ["FLUSHALL", "FLUSHDB", "DEL", "UNLINK", "SHUTDOWN"].contains(&cmd.as_str()).then(|| format!("{cmd} deletes data"));
  }
  let (toks, _) = scan(sql, kind);
  let top: Vec<&str> = toks.iter().filter(|t| t.depth == 0 && t.word).map(|t| t.text.as_str()).collect();
  let verb = if top.first() == Some(&"with") {
    top.iter().skip(1).find(|w| ["select", "insert", "update", "delete", "merge"].contains(w)).copied()
  } else {
    top.first().copied()
  };
  match verb {
    Some("drop") => Some(format!("DROP {} removes the object and its data", top.get(1).unwrap_or(&"").to_uppercase())),
    Some("truncate") => Some("TRUNCATE deletes every row".into()),
    Some(v @ ("update" | "delete")) if !top.contains(&"where") => Some(format!("{} without WHERE changes every row", v.to_uppercase())),
    _ => None,
  }
}

const NOT_PAGEABLE: &[&str] = &["insert", "update", "delete", "merge", "into", "for", "nextval", "setval"];

fn body(sql: &str) -> String {
  let t = js_trim(sql);
  // .replace(/;\s*$/, '')
  static RE: OnceLock<Regex> = OnceLock::new();
  let re = RE.get_or_init(|| Regex::new(r";[\t\n\x0B\x0C\r \u{a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}]*$").unwrap());
  re.replace(t, "").into_owned()
}

/// The query re-read from `offset` on, or None when it can't be paged.
pub fn paged_query(sql: &str, kind: Kind, offset: f64) -> Option<String> {
  if kind == Kind::Redis || split_count(sql, kind) != 1 {
    return None;
  }
  let (toks, exec) = scan(sql, kind);
  if exec {
    return None;
  }
  let words: Vec<&str> = toks.iter().filter(|t| t.word).map(|t| t.text.as_str()).collect();
  if !["select", "with", "values", "table"].contains(words.first().unwrap_or(&"")) {
    return None;
  }
  if words.iter().any(|w| NOT_PAGEABLE.contains(w) || SIDE_EFFECT_FUNCS.contains(w)) {
    return None;
  }
  let n = super::js::num_str(offset.floor().max(0.0));
  let off = match kind {
    Kind::Postgres => format!("offset {n}"),
    Kind::Mysql => format!("limit 18446744073709551615 offset {n}"),
    _ => format!("limit -1 offset {n}"),
  };
  Some(format!("select * from (\n{}\n) as riven_page {off}", body(sql)))
}

// ---- identifiers ------------------------------------------------------------

const RESERVED: &str = "all analyse analyze and any array as asc asymmetric between both by case cast change check collate column \
condition constraint create cross current_date current_role current_time current_timestamp current_user \
database default deferrable delete desc distinct do drop else end except exists false fetch for foreign from \
full grant group having in index initially inner insert interval intersect into is join key keys lateral \
leading left like limit localtime localtimestamp match natural not null offset on only or order outer placing \
primary range rank read references returning right row rows select session_user set some symmetric table then \
to trailing true union unique update usage user using values variadic when where window with write";

fn reserved(s: &str) -> bool {
  static SET: OnceLock<std::collections::HashSet<&'static str>> = OnceLock::new();
  SET.get_or_init(|| RESERVED.split(' ').collect()).contains(s.to_lowercase().as_str())
}

pub fn quote_ident(kind: Kind, s: &str) -> String {
  if kind == Kind::Redis {
    return s.to_string();
  }
  let mut cs = s.chars();
  let plain = match cs.next() {
    None => false,
    Some(f) => {
      if kind == Kind::Postgres {
        (f.is_ascii_lowercase() || f == '_') && cs.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
      } else {
        (f.is_ascii_alphabetic() || f == '_') && cs.all(|c| c.is_ascii_alphanumeric() || c == '_')
      }
    }
  };
  if !reserved(s) && plain {
    return s.to_string();
  }
  if kind == Kind::Mysql {
    format!("`{}`", s.replace('`', "``"))
  } else {
    format!("\"{}\"", s.replace('"', "\"\""))
  }
}

pub fn literal(kind: Kind, v: Option<&str>) -> String {
  match v {
    None => "NULL".into(),
    Some(v) if kind == Kind::Mysql => format!("'{}'", v.replace('\\', "\\\\").replace('\'', "''")),
    Some(v) => format!("'{}'", v.replace('\'', "''")),
  }
}

pub fn qi(s: &str) -> String {
  quote_ident(Kind::Postgres, s)
}

/// ddl.ts qualify: schema.name for PostgreSQL.
pub fn qualify(schema: &str, name: &str) -> String {
  format!("{}.{}", qi(schema), qi(name))
}

/// ddl.ts truncateSql(schema, name) with no options (the importer's use).
pub fn truncate_sql(schema: &str, name: &str) -> Vec<String> {
  vec![format!("TRUNCATE TABLE {}", qualify(schema, name))]
}

/// ddl.ts isDdl.
pub fn is_ddl(stmt: &str, kind: Kind) -> bool {
  static VERBS: OnceLock<Regex> = OnceLock::new();
  static MY: OnceLock<Regex> = OnceLock::new();
  static SL: OnceLock<Regex> = OnceLock::new();
  let s = js_trim(stmt);
  let verbs = VERBS.get_or_init(|| {
    Regex::new(r"(?i)^(create|alter|drop|truncate|comment|refresh|reindex|vacuum|analyze|grant|revoke|cluster|reassign)\b").unwrap()
  });
  if js_word_boundary_match(verbs, s) {
    return true;
  }
  match kind {
    Kind::Mysql => js_word_boundary_match(MY.get_or_init(|| Regex::new(r"(?i)^rename\s+table\b").unwrap()), s),
    Kind::Sqlite => SL
      .get_or_init(|| Regex::new(r#"(?i)^delete\s+from\s+("([^"]|"")*"|\w+)(\s*\.\s*("([^"]|"")*"|\w+))?\s*$"#).unwrap())
      .is_match(&ascii_word_view(s)),
    _ => false,
  }
}

// JS \b and \w are ASCII-only; the regex crate's are Unicode. A pattern ending
// in \b is checked on a copy where every non-ASCII char reads as a symbol.
fn ascii_word_view(s: &str) -> String {
  s.chars().map(|c| if (c as u32) < 0x80 { c } else { '\u{1}' }).collect()
}
fn js_word_boundary_match(re: &Regex, s: &str) -> bool {
  re.is_match(&ascii_word_view(s))
}

/// privs.ts PRIVS.
pub fn privs(kind: &str) -> &'static [&'static str] {
  match kind {
    "table" => &["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"],
    "sequence" => &["USAGE", "SELECT", "UPDATE"],
    "schema" => &["USAGE", "CREATE"],
    "database" => &["CONNECT", "CREATE", "TEMPORARY"],
    "function" | "procedure" => &["EXECUTE"],
    _ => &[],
  }
}

/// driver.ts isTxControl (MySQL's xa included) and pg.ts's (without it).
pub fn is_tx_control(sql: &str, with_xa: bool) -> bool {
  let rest = strip_leading_comments(sql, with_xa);
  static RE: OnceLock<Regex> = OnceLock::new();
  static RE_PG: OnceLock<Regex> = OnceLock::new();
  let re = if with_xa {
    RE.get_or_init(|| Regex::new(r"(?i)^(begin|start\s+transaction|commit|end|rollback|abort|savepoint|release|prepare\s+transaction|set\s+transaction|xa\s)\b").unwrap())
  } else {
    RE_PG.get_or_init(|| Regex::new(r"(?i)^(begin|start\s+transaction|commit|end|rollback|abort|savepoint|release|prepare\s+transaction|set\s+transaction)\b").unwrap())
  };
  re.is_match(&ascii_word_view(&rest))
}

/// /^(\s+|--[^\n]*(\n|$)|#[^\n]*(\n|$)|\/\*[\s\S]*?\*\/)*/ removed (driver.ts;
/// pg.ts's variant has no `#`).
fn strip_leading_comments(sql: &str, hash: bool) -> String {
  let t: Vec<char> = sql.chars().collect();
  let mut i = 0;
  loop {
    let start = i;
    while i < t.len() && js_space(t[i]) {
      i += 1;
    }
    if i < t.len() && t[i] == '-' && at(&t, i + 1) == Some('-') {
      i = line_end(&t, i);
    } else if hash && i < t.len() && t[i] == '#' {
      i = line_end(&t, i);
    } else if i < t.len() && t[i] == '/' && at(&t, i + 1) == Some('*') {
      match (i + 2..t.len().saturating_sub(1)).find(|&j| t[j] == '*' && t[j + 1] == '/') {
        Some(j) => i = j + 2,
        None => break,
      }
    }
    if i == start {
      break;
    }
  }
  t[i..].iter().collect()
}

fn js_space(c: char) -> bool {
  c.is_whitespace() || c == '\u{feff}'
}

/// driver.ts commandOf: the first word, upper-cased.
pub fn command_of(sql: &str) -> String {
  let rest = strip_leading_comments(sql, true);
  rest.chars().take_while(|c| c.is_ascii_alphabetic()).collect::<String>().to_uppercase()
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn splits_like_the_ts_tests() {
    let t = "select ';' as a; -- x;\nselect $$a;b$$; select \"x;y\"";
    assert_eq!(statements(t, Kind::Postgres), vec!["select ';' as a", "-- x;\nselect $$a;b$$", "select \"x;y\""]);
    assert_eq!(split_count("select 'a\\';b'; select 2", Kind::Mysql), 2);
    assert_eq!(split_count("GET a\n# c\n\nSET b 1", Kind::Redis), 2);
    assert_eq!(split_count("select 1 --1; COMMIT; DELETE FROM t", Kind::Mysql), 3);
    assert_eq!(split_count("select 1 -- x; delete", Kind::Mysql), 1);
    assert_eq!(split_count("/*! COMMIT; DELETE FROM t; */ select 1", Kind::Mysql), 3);
    assert_eq!(split_count("/* c; */ select 1", Kind::Mysql), 1);
    assert_eq!(split_count("/* a /* b */ ; */ select 1", Kind::Postgres), 1);
    assert_eq!(split_count("select E'\\'; x'; select 2", Kind::Postgres), 2);
    assert_eq!(split_count("select '\\'; select 2", Kind::Postgres), 2);
    assert_eq!(quote_ident(Kind::Postgres, "User"), "\"User\"");
    assert_eq!(quote_ident(Kind::Mysql, "my col"), "`my col`");
    assert_eq!(quote_ident(Kind::Postgres, "user"), "\"user\"");
    assert_eq!(quote_ident(Kind::Postgres, "users"), "users");
    assert!(is_tx_control("/* x */ -- y\n BEGIN", true));
    assert!(!is_tx_control("beginning", true));
    assert_eq!(command_of("-- c\n insert into x"), "INSERT");
  }
}
