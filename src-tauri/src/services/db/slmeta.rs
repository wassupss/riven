// SQLite catalog (sqliteMeta.ts: sqlite_master and the table-valued pragmas).
// The file is one database; its schemas are `main` plus whatever is attached.

use super::pgmeta::{ColInfo, TableInfo};
use super::sl::{rows, SlParam};
use super::sqltext::quote_ident;
use super::tableids::{column_id, column_name, table_of};
use super::{num, Cell, Cfg, Kind, R};
use serde_json::{json, Map, Value};

fn s(c: Option<&Cell>) -> String {
  match c {
    None | Some(Cell::Null) => String::new(),
    Some(c) => c.js_string(),
  }
}
fn qi(x: &str) -> String {
  quote_ident(Kind::Sqlite, x)
}
fn master(schema: &str) -> String {
  format!("{}.sqlite_master", qi(if schema.is_empty() { "main" } else { schema }))
}
// sqlite_sequence, sqlite_stat1 and autoindexes are SQLite's own.
const USER: &str = "name not like 'sqlite\\_%' escape '\\'";

fn p(v: &[&str]) -> Vec<SlParam> {
  v.iter().map(|x| SlParam::Str(x.to_string())).collect()
}
fn main_or(schema: &str) -> &str {
  if schema.is_empty() {
    "main"
  } else {
    schema
  }
}

pub fn list_databases() -> Value {
  json!(["main"])
}

pub async fn list_schemas(cfg: &Cfg) -> R<Vec<(String, bool)>> {
  let r = rows(cfg, "select name from pragma_database_list order by seq", vec![]).await?;
  Ok(r.iter().map(|x| s(x.first())).filter(|n| n != "temp").map(|n| (n, false)).collect())
}

pub async fn list_objects(cfg: &Cfg, schema: &str) -> R<Vec<Value>> {
  let r = rows(cfg, format!("select name, type from {} where type in ('table', 'view') and {USER} order by name", master(schema)), vec![]).await?;
  Ok(r.iter().map(|x| json!({ "name": s(x.first()), "kind": if s(x.get(1)) == "view" { "view" } else { "table" }, "rows": null })).collect())
}

async fn object_type(cfg: &Cfg, schema: &str, name: &str) -> R<Option<&'static str>> {
  let r = rows(cfg, format!("select type from {} where name = ? and type in ('table', 'view')", master(schema)), p(&[name])).await?;
  Ok(r.first().map(|x| if s(x.first()) == "view" { "view" } else { "table" }))
}

pub async fn find_schema(cfg: &Cfg, name: &str) -> R<Option<String>> {
  for (sch, _) in list_schemas(cfg).await? {
    if object_type(cfg, &sch, name).await?.is_some() {
      return Ok(Some(sch));
    }
  }
  Ok(None)
}

struct XColumn {
  name: String,
  ty: String,
  notnull: bool,
  default: Option<String>,
  pk: f64,
  /// 2: generated virtual, 3: generated stored.
  hidden: f64,
}

async fn columns_of(cfg: &Cfg, schema: &str, name: &str) -> R<Vec<XColumn>> {
  let r = rows(cfg, "select name, type, \"notnull\", dflt_value, pk, hidden from pragma_table_xinfo(?, ?) order by cid", p(&[name, main_or(schema)])).await?;
  Ok(
    r.iter()
      .map(|x| XColumn {
        name: s(x.first()),
        ty: s(x.get(1)).to_lowercase(),
        notnull: x.get(2).map(Cell::number) == Some(1.0),
        default: if x.get(3).is_none_or(Cell::is_null) { None } else { Some(s(x.get(3))) },
        pk: x.get(4).map(Cell::number).unwrap_or(f64::NAN),
        hidden: x.get(5).map(Cell::number).unwrap_or(f64::NAN),
      })
      .collect(),
  )
}

fn pk_cols(cols: &[XColumn]) -> Vec<String> {
  let mut v: Vec<&XColumn> = cols.iter().filter(|c| c.pk > 0.0).collect();
  v.sort_by(|a, b| a.pk.partial_cmp(&b.pk).unwrap_or(std::cmp::Ordering::Equal));
  v.iter().map(|c| c.name.clone()).collect()
}

struct IndexRow {
  name: String,
  unique: bool,
  origin: String,
  cols: Vec<String>,
  sql: Option<String>,
}

async fn indexes_of(cfg: &Cfg, schema: &str, name: &str) -> R<Vec<IndexRow>> {
  let sc = main_or(schema);
  let (list, cols, sqls) = tokio::try_join!(
    rows(cfg, "select name, \"unique\", origin from pragma_index_list(?, ?) order by seq", p(&[name, sc])),
    rows(cfg, "select il.name, ii.name from pragma_index_list(?, ?) il join pragma_index_info(il.name, ?) ii order by il.seq, ii.seqno", p(&[name, sc, sc])),
    rows(cfg, format!("select name, sql from {} where type = 'index' and tbl_name = ?", master(sc)), p(&[name]))
  )?;
  Ok(
    list
      .iter()
      .map(|r| {
        let n = s(r.first());
        IndexRow {
          name: n.clone(),
          unique: r.get(1).map(Cell::number) == Some(1.0),
          origin: s(r.get(2)),
          // An expression index part has no column name.
          cols: cols.iter().filter(|c| s(c.first()) == n).map(|c| if c.get(1).is_none_or(Cell::is_null) { "(expression)".to_string() } else { qi(&s(c.get(1))) }).collect(),
          // new Map(sqls): the last row for a name wins.
          sql: sqls.iter().rev().find(|x| s(x.first()) == n).and_then(|x| if x.get(1).is_none_or(Cell::is_null) { None } else { Some(s(x.get(1))) }),
        }
      })
      .collect(),
  )
}

struct ForeignKey {
  name: String,
  cols: Vec<String>,
  def: String,
}

const FK_ACTION_DEFAULT: &[&str] = &["NO ACTION", "RESTRICT", ""];

async fn foreign_keys_of(cfg: &Cfg, schema: &str, name: &str) -> R<Vec<ForeignKey>> {
  let r = rows(cfg, "select id, \"table\", \"from\", \"to\", on_update, on_delete from pragma_foreign_key_list(?, ?) order by id, seq", p(&[name, main_or(schema)])).await?;
  // Map insertion order: ids in first-seen order.
  let mut by_id: Vec<(String, Vec<&Vec<Cell>>)> = vec![];
  for x in &r {
    let k = s(x.first());
    match by_id.iter_mut().find(|(id, _)| *id == k) {
      Some((_, v)) => v.push(x),
      None => by_id.push((k, vec![x])),
    }
  }
  Ok(
    by_id
      .into_iter()
      .map(|(id, rs)| {
        let cols: Vec<String> = rs.iter().map(|x| s(x.get(2))).collect();
        // A reference to the parent's primary key leaves `to` empty.
        let to = if rs.iter().all(|x| !x.get(3).is_none_or(Cell::is_null)) { format!(" ({})", rs.iter().map(|x| qi(&s(x.get(3)))).collect::<Vec<_>>().join(", ")) } else { String::new() };
        let mut def = format!("FOREIGN KEY ({}) REFERENCES {}{to}", cols.iter().map(|c| qi(c)).collect::<Vec<_>>().join(", "), qi(&s(rs[0].get(1))));
        let upd = s(rs[0].get(4));
        let del = s(rs[0].get(5));
        if !FK_ACTION_DEFAULT.contains(&upd.as_str()) {
          def += &format!(" ON UPDATE {upd}");
        }
        if !FK_ACTION_DEFAULT.contains(&del.as_str()) {
          def += &format!(" ON DELETE {del}");
        }
        ForeignKey { name: format!("fk_{id}"), cols, def }
      })
      .collect(),
  )
}

pub async fn table_info(cfg: &Cfg, schema: &str, name: &str) -> R<Option<TableInfo>> {
  let Some(kind) = object_type(cfg, schema, name).await? else { return Ok(None) };
  let is_table = kind == "table";
  let (cols, idx, fks) = tokio::try_join!(
    columns_of(cfg, schema, name),
    async { if is_table { indexes_of(cfg, schema, name).await } else { Ok(vec![]) } },
    async { if is_table { foreign_keys_of(cfg, schema, name).await } else { Ok(vec![]) } }
  )?;
  let pk = pk_cols(&cols);
  let t = qi(name);
  let mut constraints = vec![];
  if !pk.is_empty() {
    constraints.push(("pk".to_string(), "primary key".to_string(), format!("PRIMARY KEY ({})", pk.iter().map(|c| qi(c)).collect::<Vec<_>>().join(", "))));
  }
  for i in &idx {
    if i.origin == "u" {
      constraints.push((i.name.clone(), "unique".into(), format!("UNIQUE ({})", i.cols.join(", "))));
    }
  }
  for f in &fks {
    constraints.push((f.name.clone(), "foreign key".into(), f.def.clone()));
  }
  Ok(Some(TableInfo {
    schema: schema.into(),
    name: name.into(),
    kind: kind.into(),
    comment: None,
    columns: cols
      .iter()
      .filter(|c| c.hidden != 1.0)
      .map(|c| ColInfo { name: c.name.clone(), ty: c.ty.clone(), nullable: !c.notnull && c.pk == 0.0, default: c.default.clone(), comment: None, primary_key: c.pk > 0.0 })
      .collect(),
    indexes: idx
      .iter()
      .map(|i| {
        let def = if i.origin == "pk" {
          format!("PRIMARY KEY ({})", i.cols.join(", "))
        } else {
          i.sql.clone().unwrap_or_else(|| format!("CREATE {}INDEX {} ON {t} ({})", if i.unique { "UNIQUE " } else { "" }, qi(&i.name), i.cols.join(", ")))
        };
        (i.name.clone(), def, i.unique, i.origin == "pk")
      })
      .collect(),
    constraints,
  }))
}

pub async fn column_detail(cfg: &Cfg, table: f64, attnum: f64) -> R<Value> {
  let (Some((sch, tbl)), Some(col)) = (table_of(&cfg.id, table), column_name(table, attnum)) else { return Ok(Value::Null) };
  let (cols, idx, fks) = tokio::try_join!(columns_of(cfg, &sch, &tbl), indexes_of(cfg, &sch, &tbl), foreign_keys_of(cfg, &sch, &tbl))?;
  let Some(c) = cols.iter().find(|x| x.name == col) else { return Ok(Value::Null) };
  let q = qi(&col);
  let pk = pk_cols(&cols);
  let mut constraints = vec![];
  if pk.contains(&col) {
    constraints.push(json!({ "type": "p", "name": "pk", "def": format!("PRIMARY KEY ({})", pk.iter().map(|c| qi(c)).collect::<Vec<_>>().join(", ")) }));
  }
  for i in &idx {
    if i.origin == "u" && i.cols.contains(&q) {
      constraints.push(json!({ "type": "u", "name": i.name, "def": format!("UNIQUE ({})", i.cols.join(", ")) }));
    }
  }
  for f in &fks {
    if f.cols.contains(&col) {
      constraints.push(json!({ "type": "f", "name": f.name, "def": f.def }));
    }
  }
  // A lone INTEGER PRIMARY KEY is the rowid: it numbers itself.
  let rowid = pk.len() == 1 && pk[0] == col && c.ty == "integer";
  Ok(json!({
    "table": format!("{sch}.{tbl}"),
    "column": col,
    "type": c.ty,
    "nullable": !c.notnull && c.pk == 0.0,
    "default": c.default,
    "comment": null,
    "identity": if rowid { Some("rowid") } else { None },
    "constraints": constraints,
    "indexes": idx.iter().filter(|i| i.origin == "c" && i.cols.contains(&q)).map(|i| i.name.clone()).collect::<Vec<_>>(),
  }))
}

pub async fn object_ddl(cfg: &Cfg, schema: &str, name: &str) -> R<String> {
  let r = rows(
    cfg,
    format!(
      "select sql from {} where sql is not null and (name = ? or (tbl_name = ? and type in ('index', 'trigger')))\n      order by case type when 'table' then 0 when 'view' then 0 when 'index' then 1 else 2 end, name",
      master(schema)
    ),
    p(&[name, name]),
  )
  .await?;
  if r.is_empty() {
    return super::err(format!("No table or view {schema}.{name}"));
  }
  Ok(r.iter().map(|x| format!("{};\n", s(x.first()).trim_end_matches(super::js::js_space))).collect::<Vec<_>>().join("\n"))
}

pub async fn edit_target(cfg: &Cfg, table: f64) -> R<Value> {
  let Some((sch, tbl)) = table_of(&cfg.id, table) else { return Ok(Value::Null) };
  let Some(kind) = object_type(cfg, &sch, &tbl).await? else { return Ok(Value::Null) };
  let cols = columns_of(cfg, &sch, &tbl).await?;
  let t = table as u32;
  let keys: Vec<i64> = pk_cols(&cols).iter().map(|c| column_id(t, c)).collect();
  let ok_kind = kind == "table";
  let mut m = Map::new();
  m.insert("table".into(), num(table));
  m.insert("schema".into(), sch.into());
  m.insert("name".into(), tbl.into());
  m.insert("editable".into(), (ok_kind && !keys.is_empty()).into());
  if !ok_kind {
    m.insert("reason".into(), "kind".into());
  } else if keys.is_empty() {
    m.insert("reason".into(), "nopk".into());
  }
  m.insert("pk".into(), json!(keys));
  m.insert(
    "columns".into(),
    Value::Array(
      cols
        .iter()
        .filter(|c| c.hidden != 1.0)
        .map(|c| json!({ "attnum": column_id(t, &c.name), "name": c.name, "type": c.ty, "readOnly": c.hidden == 2.0 || c.hidden == 3.0 }))
        .collect(),
    ),
  );
  Ok(Value::Object(m))
}

const COMPLETION_TABLES: usize = 3000;

pub async fn completion_meta(cfg: &Cfg) -> R<Value> {
  let schemas: Vec<String> = list_schemas(cfg).await?.into_iter().map(|x| x.0).collect();
  let mut tables: Vec<(String, String, &'static str, Vec<Value>)> = vec![];
  let mut truncated = false;
  for sc in &schemas {
    let r = rows(
      cfg,
      format!(
        "select m.name, m.type, p.name, p.type from {} m join pragma_table_info(m.name, ?) p\n        where m.type in ('table', 'view') and m.{USER} order by m.name, p.cid",
        master(sc)
      ),
      p(&[sc]),
    )
    .await?;
    for x in &r {
      let name = s(x.first());
      let same = tables.last().is_some_and(|t| t.1 == name && t.0 == *sc);
      if !same {
        if tables.len() >= COMPLETION_TABLES {
          truncated = true;
          break;
        }
        tables.push((sc.clone(), name, if s(x.get(1)) == "view" { "v" } else { "r" }, vec![]));
      }
      tables.last_mut().expect("table").3.push(json!({ "name": s(x.get(2)), "type": s(x.get(3)).to_lowercase() }));
    }
  }
  Ok(json!({
    "schemas": schemas,
    "searchPath": ["main"],
    "tables": tables.into_iter().map(|(sc, n, k, c)| json!({ "schema": sc, "name": n, "kind": k, "columns": c })).collect::<Vec<_>>(),
    "functions": [],
    "truncated": truncated,
  }))
}
