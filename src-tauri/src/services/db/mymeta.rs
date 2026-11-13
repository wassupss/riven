// MySQL / MariaDB catalog (mysqlMeta.ts, information_schema). A database is
// its own and only schema: the explorer's schema level is the database name.

use super::my::rows;
use super::mywire::Param;
use super::pgmeta::{ColInfo, TableInfo};
use super::sqltext::quote_ident;
use super::tableids::{column_id, column_name, table_of};
use super::{num, Cell, Cfg, Kind, R};
use serde_json::{json, Map, Value};

const SYSTEM_DBS: &[&str] = &["information_schema", "mysql", "performance_schema", "sys"];

fn table_type(t: &str) -> Option<&'static str> {
  Some(match t {
    "BASE TABLE" => "table",
    "VIEW" | "SYSTEM VIEW" => "view",
    "SEQUENCE" => "sequence",
    _ => return None,
  })
}

fn s(c: Option<&Cell>) -> String {
  c.map(Cell::s).unwrap_or_default()
}
fn qi(x: &str) -> String {
  quote_ident(Kind::Mysql, x)
}
// MariaDB reports a missing default as the text NULL and quotes string defaults.
fn default_of(c: Option<&Cell>) -> Option<String> {
  match c {
    None | Some(Cell::Null) => None,
    Some(Cell::Str(x)) if x == "NULL" => None,
    Some(x) => Some(x.js_string()),
  }
}
fn comment_of(c: Option<&Cell>) -> Option<String> {
  match c {
    None | Some(Cell::Null) => None,
    Some(Cell::Str(x)) if x.is_empty() => None,
    Some(x) => Some(x.js_string()),
  }
}
fn ps(v: &[&str]) -> Vec<Param> {
  v.iter().map(|x| Param::Str(x.to_string())).collect()
}
fn eq_str(c: Option<&Cell>, v: &str) -> bool {
  matches!(c, Some(Cell::Str(x)) if x == v)
}

pub async fn list_databases(cfg: &Cfg) -> R<Value> {
  let r = rows(cfg, None, "show databases", []).await?;
  let names: Vec<String> = r.iter().map(|x| s(x.first())).collect();
  let sys = |n: &String| SYSTEM_DBS.contains(&n.to_lowercase().as_str());
  let mut out: Vec<Value> = names.iter().filter(|n| !sys(n)).map(|n| Value::String(n.clone())).collect();
  out.extend(names.iter().filter(|n| sys(n)).map(|n| Value::String(n.clone())));
  Ok(Value::Array(out))
}

pub fn list_schemas(cfg: &Cfg, db: Option<&str>) -> Vec<(String, bool)> {
  let name = db.filter(|d| !d.is_empty()).map(str::to_string).unwrap_or_else(|| cfg.database.clone());
  if name.is_empty() {
    return vec![];
  }
  let sys = SYSTEM_DBS.contains(&name.to_lowercase().as_str());
  vec![(name, sys)]
}

pub async fn list_objects(cfg: &Cfg, db: Option<&str>, schema: &str) -> R<Vec<Value>> {
  let (rels, procs) = tokio::try_join!(
    rows(cfg, db, "select table_name, table_type, table_comment, table_rows from information_schema.tables\n        where table_schema = ? order by table_name", ps(&[schema])),
    rows(
      cfg,
      db,
      "select r.routine_name, r.routine_type, r.dtd_identifier,\n              (select group_concat(concat_ws(' ', if(r.routine_type = 'PROCEDURE', p.parameter_mode, null), p.parameter_name, p.dtd_identifier)\n                        order by p.ordinal_position separator ', ')\n                 from information_schema.parameters p\n                where p.specific_schema = r.routine_schema and p.specific_name = r.specific_name and p.ordinal_position > 0)\n         from information_schema.routines r where r.routine_schema = ? order by r.routine_name",
      ps(&[schema])
    )
  )?;
  let mut out = vec![];
  for r in &rels {
    let kind = table_type(&s(r.get(1))).unwrap_or("table");
    let est = match r.get(3) {
      None | Some(Cell::Null) => None,
      Some(c) => Some(c.number()),
    };
    out.push(json!({
      "name": s(r.first()),
      "kind": kind,
      "comment": if kind == "view" { None } else { comment_of(r.get(2)) },
      "rows": match est { Some(e) if kind == "table" && e.is_finite() => num(e), _ => Value::Null },
    }));
  }
  for r in &procs {
    out.push(json!({
      "name": s(r.first()),
      "kind": if s(r.get(1)) == "PROCEDURE" { "procedure" } else { "function" },
      "args": s(r.get(3)),
      "result": s(r.get(2)),
    }));
  }
  Ok(out)
}

async fn table_kind(cfg: &Cfg, db: Option<&str>, schema: &str, name: &str) -> R<Option<&'static str>> {
  let r = rows(cfg, db, "select table_type from information_schema.tables where table_schema = ? and table_name = ?", ps(&[schema, name])).await?;
  Ok(r.first().map(|x| table_type(&s(x.first())).unwrap_or("table")))
}

pub async fn find_schema(cfg: &Cfg, db: Option<&str>, name: &str) -> R<Option<String>> {
  let cur = db.filter(|d| !d.is_empty()).map(str::to_string).unwrap_or_else(|| cfg.database.clone());
  let r = rows(
    cfg,
    db,
    "select s from (\n       select table_schema s from information_schema.tables where table_name = ?\n       union all select routine_schema from information_schema.routines where routine_name = ?) x\n     order by s = ? desc, s limit 1",
    ps(&[name, name, &cur]),
  )
  .await?;
  Ok(r.first().map(|x| s(x.first())))
}

struct IndexRow {
  name: String,
  unique: bool,
  cols: Vec<String>,
}

async fn indexes_of(cfg: &Cfg, db: Option<&str>, schema: &str, name: &str) -> R<Vec<IndexRow>> {
  let r = rows(
    cfg,
    db,
    "select index_name, non_unique, column_name, sub_part from information_schema.statistics\n      where table_schema = ? and table_name = ? order by index_name = 'PRIMARY' desc, index_name, seq_in_index",
    ps(&[schema, name]),
  )
  .await?;
  let mut out: Vec<IndexRow> = vec![];
  for x in &r {
    let n = s(x.first());
    let i = match out.iter().position(|i| i.name == n) {
      Some(i) => i,
      None => {
        out.push(IndexRow { name: n.clone(), unique: x.get(1).map(Cell::number) == Some(0.0), cols: vec![] });
        out.len() - 1
      }
    };
    let col = if x.get(2).is_none_or(Cell::is_null) {
      "(expression)".to_string()
    } else {
      qi(&s(x.get(2))) + &if x.get(3).is_none_or(Cell::is_null) { String::new() } else { format!("({})", s(x.get(3))) }
    };
    out[i].cols.push(col);
  }
  Ok(out)
}

struct ConstraintRow {
  name: String,
  ty: char,
  cols: Vec<String>,
  def: String,
}

async fn constraints_of(cfg: &Cfg, db: Option<&str>, schema: &str, name: &str) -> R<Vec<ConstraintRow>> {
  let args = ps(&[schema, name]);
  let (cons, keys, checks) = tokio::join!(
    rows(
      cfg,
      db,
      "select tc.constraint_name, tc.constraint_type, rc.update_rule, rc.delete_rule\n         from information_schema.table_constraints tc\n         left join information_schema.referential_constraints rc\n           on rc.constraint_schema = tc.constraint_schema and rc.constraint_name = tc.constraint_name and rc.table_name = tc.table_name\n        where tc.table_schema = ? and tc.table_name = ? order by tc.constraint_type, tc.constraint_name",
      &args
    ),
    rows(
      cfg,
      db,
      "select constraint_name, column_name, referenced_table_schema, referenced_table_name, referenced_column_name\n         from information_schema.key_column_usage where table_schema = ? and table_name = ? order by constraint_name, ordinal_position",
      &args
    ),
    rows(
      cfg,
      db,
      "select cc.constraint_name, cc.check_clause from information_schema.check_constraints cc\n         join information_schema.table_constraints tc\n           on tc.constraint_schema = cc.constraint_schema and tc.constraint_name = cc.constraint_name and tc.constraint_type = 'CHECK'\n        where tc.table_schema = ? and tc.table_name = ?",
      &args
    )
  );
  let (cons, keys) = (cons?, keys?);
  let checks = checks.unwrap_or_default();
  let mut out = vec![];
  for r in &cons {
    let cname = s(r.first());
    let ty = match s(r.get(1)).as_str() {
      "PRIMARY KEY" => 'p',
      "FOREIGN KEY" => 'f',
      "UNIQUE" => 'u',
      "CHECK" => 'c',
      _ => continue,
    };
    let ks: Vec<&Vec<Cell>> = keys.iter().filter(|k| s(k.first()) == cname).collect();
    let cols: Vec<String> = ks.iter().map(|k| s(k.get(1))).collect();
    let list = cols.iter().map(|c| qi(c)).collect::<Vec<_>>().join(", ");
    let def = match ty {
      'c' => {
        // new Map(checks): the last row for a name wins.
        let clause = checks.iter().rev().find(|c| s(c.first()) == cname).map(|c| s(c.get(1))).unwrap_or_default();
        format!("CHECK ({clause})")
      }
      'p' => format!("PRIMARY KEY ({list})"),
      'u' => format!("UNIQUE ({list})"),
      _ => {
        let rf = ks.first();
        let target = match rf {
          Some(k) if s(k.get(2)) != schema => format!("{}.{}", qi(&s(k.get(2))), qi(&s(k.get(3)))),
          Some(k) => qi(&s(k.get(3))),
          None => qi(""),
        };
        let mut d = format!("FOREIGN KEY ({list}) REFERENCES {target} ({})", ks.iter().map(|k| qi(&s(k.get(4)))).collect::<Vec<_>>().join(", "));
        let rule = |c: Option<&Cell>| c.filter(|c| c.truthy()).map(Cell::s).filter(|v| v != "RESTRICT" && v != "NO ACTION");
        if let Some(u) = rule(r.get(2)) {
          d += &format!(" ON UPDATE {u}");
        }
        if let Some(u) = rule(r.get(3)) {
          d += &format!(" ON DELETE {u}");
        }
        d
      }
    };
    out.push(ConstraintRow { name: cname, ty, cols, def });
  }
  Ok(out)
}

fn contype_name(t: char) -> &'static str {
  match t {
    'p' => "primary key",
    'f' => "foreign key",
    'u' => "unique",
    _ => "check",
  }
}

pub async fn table_info(cfg: &Cfg, db: Option<&str>, schema: &str, name: &str) -> R<Option<TableInfo>> {
  let Some(kind) = table_kind(cfg, db, schema, name).await? else { return Ok(None) };
  let (cols, idx, cons, cmt) = tokio::try_join!(
    rows(
      cfg,
      db,
      "select column_name, column_type, is_nullable, column_default, column_comment, column_key\n         from information_schema.columns where table_schema = ? and table_name = ? order by ordinal_position",
      ps(&[schema, name])
    ),
    indexes_of(cfg, db, schema, name),
    constraints_of(cfg, db, schema, name),
    rows(cfg, db, "select table_comment from information_schema.tables where table_schema = ? and table_name = ?", ps(&[schema, name]))
  )?;
  let t = qi(name);
  Ok(Some(TableInfo {
    schema: schema.into(),
    name: name.into(),
    kind: kind.into(),
    comment: if kind == "view" { None } else { comment_of(cmt.first().and_then(|r| r.first())) },
    columns: cols
      .iter()
      .map(|r| ColInfo {
        name: s(r.first()),
        ty: s(r.get(1)),
        nullable: eq_str(r.get(2), "YES"),
        default: default_of(r.get(3)),
        comment: comment_of(r.get(4)),
        primary_key: eq_str(r.get(5), "PRI"),
      })
      .collect(),
    indexes: idx
      .iter()
      .map(|i| {
        let def = if i.name == "PRIMARY" {
          format!("PRIMARY KEY ({})", i.cols.join(", "))
        } else {
          format!("CREATE {}INDEX {} ON {t} ({})", if i.unique { "UNIQUE " } else { "" }, qi(&i.name), i.cols.join(", "))
        };
        (i.name.clone(), def, i.unique, i.name == "PRIMARY")
      })
      .collect(),
    constraints: cons.iter().map(|c| (c.name.clone(), contype_name(c.ty).to_string(), c.def.clone())).collect(),
  }))
}

pub async fn column_detail(cfg: &Cfg, db: Option<&str>, table: f64, attnum: f64) -> R<Value> {
  let (Some((sch, tbl)), Some(col)) = (table_of(&cfg.id, table), column_name(table, attnum)) else { return Ok(Value::Null) };
  let (cols, cons, idx) = tokio::try_join!(
    rows(
      cfg,
      db,
      "select column_type, is_nullable, column_default, column_comment, extra\n         from information_schema.columns where table_schema = ? and table_name = ? and column_name = ?",
      ps(&[&sch, &tbl, &col])
    ),
    constraints_of(cfg, db, &sch, &tbl),
    indexes_of(cfg, db, &sch, &tbl)
  )?;
  let Some(r) = cols.first() else { return Ok(Value::Null) };
  let extra = s(r.get(4)).to_lowercase();
  let q = qi(&col);
  Ok(json!({
    "table": format!("{sch}.{tbl}"),
    "column": col,
    "type": s(r.first()),
    "nullable": eq_str(r.get(1), "YES"),
    "default": default_of(r.get(2)),
    "comment": comment_of(r.get(3)),
    "identity": if extra.contains("auto_increment") { Some("auto_increment") } else { None },
    "constraints": cons.iter().filter(|c| c.cols.contains(&col) || (c.ty == 'c' && c.def.contains(&col))).map(|c| json!({ "type": c.ty.to_string(), "name": c.name, "def": c.def })).collect::<Vec<_>>(),
    "indexes": idx.iter().filter(|i| i.name != "PRIMARY" && i.cols.iter().any(|c| *c == q || c.starts_with(&format!("{q}(")))).map(|i| i.name.clone()).collect::<Vec<_>>(),
  }))
}

fn trim_end(x: &str) -> &str {
  x.trim_end_matches(super::js::js_space)
}

pub async fn object_ddl(cfg: &Cfg, db: Option<&str>, schema: &str, name: &str) -> R<String> {
  let full = format!("{}.{}", qi(schema), qi(name));
  let kind = table_kind(cfg, db, schema, name).await?;
  let show = |what: &'static str| {
    let full = full.clone();
    async move {
      let r = rows(cfg, db, &format!("show create {what} {full}"), []).await?;
      Ok::<_, super::DbErr>(format!("{};\n", trim_end(&s(r.first().and_then(|x| x.get(1))))))
    }
  };
  match kind {
    Some("view") => return show("view").await,
    Some("sequence") => return show("sequence").await,
    Some(_) => return show("table").await,
    None => {}
  }
  let routines = rows(cfg, db, "select routine_type from information_schema.routines where routine_schema = ? and routine_name = ?", ps(&[schema, name])).await?;
  if routines.is_empty() {
    return super::err(format!("No table, view or routine {schema}.{name}"));
  }
  let mut out = vec![];
  for r in &routines {
    let ty = s(r.first()).to_lowercase();
    let body = rows(cfg, db, &format!("show create {ty} {full}"), []).await?;
    match body.first().and_then(|x| x.get(2)) {
      None | Some(Cell::Null) => out.push(format!("-- The body of {ty} {full} is not visible to this user\n")),
      Some(b) => out.push(format!("DELIMITER $$\n{}$$\nDELIMITER ;\n", trim_end(&b.js_string()))),
    }
  }
  Ok(out.join("\n"))
}

pub async fn edit_target(cfg: &Cfg, db: Option<&str>, table: f64) -> R<Value> {
  let Some((sch, tbl)) = table_of(&cfg.id, table) else { return Ok(Value::Null) };
  let (kind, cols, pk) = tokio::try_join!(
    table_kind(cfg, db, &sch, &tbl),
    rows(cfg, db, "select column_name, column_type, extra from information_schema.columns\n        where table_schema = ? and table_name = ? order by ordinal_position", ps(&[&sch, &tbl])),
    rows(cfg, db, "select column_name from information_schema.statistics\n        where table_schema = ? and table_name = ? and index_name = 'PRIMARY' order by seq_in_index", ps(&[&sch, &tbl]))
  )?;
  let Some(kind) = kind else { return Ok(Value::Null) };
  let t = table as u32;
  let keys: Vec<i64> = pk.iter().map(|r| column_id(t, &s(r.first()))).collect();
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
  let generated = |x: &str| {
    let l = x.to_lowercase();
    l.contains("generated") || l.contains("persistent")
  };
  m.insert(
    "columns".into(),
    Value::Array(cols.iter().map(|r| json!({ "attnum": column_id(t, &s(r.first())), "name": s(r.first()), "type": s(r.get(1)), "readOnly": generated(&s(r.get(2))) })).collect()),
  );
  Ok(Value::Object(m))
}

const COMPLETION_TABLES: usize = 3000;

pub async fn completion_meta(cfg: &Cfg, db: Option<&str>) -> R<Value> {
  let hidden = format!("not in ({})", SYSTEM_DBS.iter().map(|x| format!("'{x}'")).collect::<Vec<_>>().join(", "));
  let (schemas, tables, cols, fns) = tokio::try_join!(
    rows(cfg, db, format!("select schema_name from information_schema.schemata where schema_name {hidden} order by 1"), []),
    rows(
      cfg,
      db,
      format!("select table_schema, table_name, table_type from information_schema.tables\n        where table_schema {hidden} order by table_schema, table_name limit {}", COMPLETION_TABLES + 1),
      []
    ),
    rows(
      cfg,
      db,
      format!("select table_schema, table_name, column_name, column_type from information_schema.columns\n        where table_schema {hidden} order by table_schema, table_name, ordinal_position limit 60000"),
      []
    ),
    rows(cfg, db, format!("select concat(routine_schema, '.', routine_name) from information_schema.routines where routine_schema {hidden} order by 1 limit 2000"), &[])
  )?;
  let mut by_table: std::collections::HashMap<String, Vec<Value>> = Default::default();
  for r in &cols {
    by_table.entry(format!("{}\u{0}{}", s(r.first()), s(r.get(1)))).or_default().push(json!({ "name": s(r.get(2)), "type": s(r.get(3)) }));
  }
  let cur = db.filter(|d| !d.is_empty()).map(str::to_string).unwrap_or_else(|| cfg.database.clone());
  Ok(json!({
    "schemas": schemas.iter().map(|r| s(r.first())).collect::<Vec<_>>(),
    "searchPath": if cur.is_empty() { vec![] } else { vec![cur] },
    "tables": tables.iter().take(COMPLETION_TABLES).map(|r| json!({
      "schema": s(r.first()),
      "name": s(r.get(1)),
      "kind": if s(r.get(2)) == "BASE TABLE" { "r" } else { "v" },
      "columns": by_table.get(&format!("{}\u{0}{}", s(r.first()), s(r.get(1)))).cloned().unwrap_or_default(),
    })).collect::<Vec<_>>(),
    "functions": fns.iter().map(|r| s(r.first())).collect::<Vec<_>>(),
    "truncated": tables.len() > COMPLETION_TABLES,
  }))
}
