// Numeric ids for the tables and columns behind a result, for engines without
// oids (MySQL, SQLite) (tableIds.ts). The grid keys editing and the column
// menu on QueryColumn.table/attnum; these stand in for pg's table oid and
// attnum. Ids live for the process and are only ever compared, never stored.

use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard, OnceLock};

struct TableRef {
  conn: String,
  schema: String,
  name: String,
  columns: Vec<String>,
}

#[derive(Default)]
struct Ids {
  by_key: HashMap<String, u32>,
  by_id: Vec<TableRef>,
}

fn ids() -> MutexGuard<'static, Ids> {
  static I: OnceLock<Mutex<Ids>> = OnceLock::new();
  I.get_or_init(Default::default).lock().unwrap_or_else(|e| e.into_inner())
}

pub fn table_id(conn: &str, schema: &str, name: &str) -> u32 {
  let key = format!("{conn}\u{0}{schema}\u{0}{name}");
  let mut g = ids();
  if let Some(id) = g.by_key.get(&key) {
    return *id;
  }
  let id = g.by_key.len() as u32 + 1;
  g.by_key.insert(key, id);
  g.by_id.push(TableRef { conn: conn.into(), schema: schema.into(), name: name.into(), columns: vec![] });
  id
}

/// The column's number in its table (by name; stable for the process).
pub fn column_id(table: u32, column: &str) -> i64 {
  let mut g = ids();
  let Some(t) = g.by_id.get_mut((table as usize).wrapping_sub(1)) else { return 0 };
  if let Some(i) = t.columns.iter().position(|c| c == column) {
    return i as i64 + 1;
  }
  t.columns.push(column.into());
  t.columns.len() as i64
}

/// The table an id stands for, if it was made for this connection.
pub fn table_of(conn: &str, table: f64) -> Option<(String, String)> {
  if table < 1.0 || table.fract() != 0.0 {
    return None;
  }
  let g = ids();
  let t = g.by_id.get(table as usize - 1)?;
  (t.conn == conn).then(|| (t.schema.clone(), t.name.clone()))
}

/// Column name for a number, if known.
pub fn column_name(table: f64, attnum: f64) -> Option<String> {
  if table < 1.0 || table.fract() != 0.0 || attnum < 1.0 || attnum.fract() != 0.0 {
    return None;
  }
  let g = ids();
  g.by_id.get(table as usize - 1)?.columns.get(attnum as usize - 1).cloned()
}
