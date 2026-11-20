// PostgreSQL catalog reads: browsing and editing metadata (meta.ts), roles
// and privileges (privMeta.ts), the monitor (monitorMeta.ts), the ER diagram
// (erdMeta.ts), schema snapshots for diffing (schemaDiffMeta.ts) and full data
// search (dataSearch.ts). Objects are built in the key order the TS literals
// had.

use super::pg::{self, rows, rows_s};
use super::sqltext::{literal, qi};
use super::{js, num, Cell, Cfg, Kind, R};
use serde_json::{json, Map, Value};

const REL_OID: &str = "(select c.oid from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = $1 and c.relname = $2)";
const SYSTEM_SCHEMAS: &[&str] = &["pg_catalog", "information_schema"];

fn relkind(k: &str) -> Option<&'static str> {
  Some(match k {
    "r" => "table",
    "p" => "partitioned",
    "v" => "view",
    "m" => "matview",
    "f" => "foreign",
    "S" => "sequence",
    _ => return None,
  })
}

fn s(c: Option<&Cell>) -> String {
  c.map(Cell::s).unwrap_or_default()
}
fn so(c: Option<&Cell>) -> Value {
  match c {
    None | Some(Cell::Null) => Value::Null,
    Some(x) => Value::String(x.js_string()),
  }
}
fn so_opt(c: Option<&Cell>) -> Option<String> {
  c.and_then(Cell::opt)
}
fn is_true(c: Option<&Cell>) -> bool {
  c.is_some_and(Cell::is_true)
}
fn truthy(c: Option<&Cell>) -> bool {
  c.is_some_and(Cell::truthy)
}

/// JSON.parse(String(v)) with a fallback (null/undefined or bad JSON).
fn parse_json(c: Option<&Cell>) -> Option<Value> {
  match c {
    None | Some(Cell::Null) => None,
    Some(x) => serde_json::from_str(&x.js_string()).ok(),
  }
}

pub async fn list_databases(cfg: &Cfg) -> R<Value> {
  let r = rows(cfg, None, "select datname::text from pg_database where datallowconn and not datistemplate order by datname", &[]).await?;
  Ok(Value::Array(r.iter().map(|x| Value::String(s(x.first()))).collect()))
}

pub async fn list_schemas(cfg: &Cfg, db: Option<&str>) -> R<Vec<(String, bool)>> {
  let r = rows(
    cfg,
    db,
    "select nspname::text from pg_namespace\n     where nspname not like 'pg_toast%' and nspname not like 'pg_temp_%'\n     order by (nspname in ('pg_catalog','information_schema')), nspname",
    &[],
  )
  .await?;
  Ok(r.iter().map(|x| (s(x.first()), SYSTEM_SCHEMAS.contains(&s(x.first()).as_str()))).collect())
}

pub async fn list_objects(cfg: &Cfg, db: Option<&str>, schema: &str) -> R<Vec<Value>> {
  let rels = rows_s(
    cfg,
    db,
    "select c.relname::text, c.relkind::text, obj_description(c.oid, 'pg_class'), c.reltuples::float8\n     from pg_class c join pg_namespace n on n.oid = c.relnamespace\n     where n.nspname = $1 and c.relkind in ('r','p','v','m','f','S') and not c.relispartition\n     order by c.relname",
    &[schema],
  )
  .await?;
  let procs = rows_s(
    cfg,
    db,
    "select p.proname::text, pg_get_function_identity_arguments(p.oid), pg_get_function_result(p.oid), p.prokind::text\n     from pg_proc p join pg_namespace n on n.oid = p.pronamespace\n     where n.nspname = $1 order by p.proname",
    &[schema],
  )
  .await?;
  let mut out = vec![];
  for r in &rels {
    let est = match r.get(3) {
      Some(Cell::Num(f)) => Some(*f),
      _ => None,
    };
    out.push(json!({
      "name": s(r.first()),
      "kind": relkind(&s(r.get(1))).unwrap_or("table"),
      "comment": so(r.get(2)),
      "rows": match est { Some(e) if e >= 0.0 => num((e + 0.5).floor()), _ => Value::Null },
    }));
  }
  for r in &procs {
    let kind = match s(r.get(3)).as_str() {
      "p" => "procedure",
      "a" => "aggregate",
      "w" => "window",
      _ => "function",
    };
    out.push(json!({ "name": s(r.first()), "kind": kind, "args": s(r.get(1)), "result": so_opt(r.get(2)).unwrap_or_default() }));
  }
  Ok(out)
}

async fn rel_kind(cfg: &Cfg, db: Option<&str>, schema: &str, name: &str) -> R<Option<&'static str>> {
  let r = rows_s(cfg, db, &format!("select relkind::text from pg_class where oid = {REL_OID}"), &[schema, name]).await?;
  Ok(r.first().map(|x| relkind(&s(x.first())).unwrap_or("table")))
}

pub async fn find_schema(cfg: &Cfg, db: Option<&str>, name: &str) -> R<Option<String>> {
  let r = rows_s(
    cfg,
    db,
    "select n.nspname::text from pg_class c join pg_namespace n on n.oid = c.relnamespace\n     where c.relname = $1 and c.relkind in ('r','p','v','m','f','S')\n     order by array_position(current_schemas(false), n.nspname::name) nulls last, n.nspname limit 1",
    &[name],
  )
  .await?;
  if let Some(x) = r.first() {
    return Ok(Some(s(x.first())));
  }
  let p = rows_s(
    cfg,
    db,
    "select n.nspname::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace\n     where p.proname = $1 order by array_position(current_schemas(false), n.nspname::name) nulls last limit 1",
    &[name],
  )
  .await?;
  Ok(p.first().map(|x| s(x.first())))
}

pub struct ColInfo {
  pub name: String,
  pub ty: String,
  pub nullable: bool,
  pub default: Option<String>,
  pub comment: Option<String>,
  pub primary_key: bool,
}
pub struct TableInfo {
  pub schema: String,
  pub name: String,
  pub kind: String,
  pub comment: Option<String>,
  pub columns: Vec<ColInfo>,
  pub indexes: Vec<(String, String, bool, bool)>,
  pub constraints: Vec<(String, String, String)>,
}

impl TableInfo {
  pub fn to_value(&self) -> Value {
    json!({
      "schema": self.schema,
      "name": self.name,
      "kind": self.kind,
      "comment": self.comment,
      "columns": self.columns.iter().map(|c| json!({
        "name": c.name, "type": c.ty, "nullable": c.nullable, "default": c.default, "comment": c.comment, "primaryKey": c.primary_key
      })).collect::<Vec<_>>(),
      "indexes": self.indexes.iter().map(|(n, d, u, p)| json!({ "name": n, "def": d, "unique": u, "primary": p })).collect::<Vec<_>>(),
      "constraints": self.constraints.iter().map(|(n, t, d)| json!({ "name": n, "type": t, "def": d })).collect::<Vec<_>>(),
    })
  }
}

pub async fn table_info(cfg: &Cfg, db: Option<&str>, schema: &str, name: &str) -> R<Option<TableInfo>> {
  let Some(kind) = rel_kind(cfg, db, schema, name).await? else { return Ok(None) };
  let args = [schema, name];
  let q1 = format!(
    "select a.attname::text, format_type(a.atttypid, a.atttypmod), not a.attnotnull,\n              pg_get_expr(d.adbin, d.adrelid), col_description(a.attrelid, a.attnum),\n              coalesce(a.attnum = any(pk.conkey), false)\n       from pg_attribute a\n       left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum\n       left join pg_constraint pk on pk.conrelid = a.attrelid and pk.contype = 'p'\n       where a.attrelid = {REL_OID} and a.attnum > 0 and not a.attisdropped\n       order by a.attnum"
  );
  let q2 = format!(
    "select i.relname::text, pg_get_indexdef(ix.indexrelid), ix.indisunique, ix.indisprimary\n       from pg_index ix join pg_class i on i.oid = ix.indexrelid\n       where ix.indrelid = {REL_OID} order by ix.indisprimary desc, i.relname"
  );
  let q3 = format!(
    "select conname::text, contype::text, pg_get_constraintdef(oid) from pg_constraint\n       where conrelid = {REL_OID} and contype in ('p','f','u','c') order by contype, conname"
  );
  let q4 = format!("select obj_description({REL_OID}, 'pg_class')");
  let (cols, idx, cons, cmt) = tokio::try_join!(rows_s(cfg, db, &q1, &args), rows_s(cfg, db, &q2, &args), rows_s(cfg, db, &q3, &args), rows_s(cfg, db, &q4, &args))?;
  Ok(Some(TableInfo {
    schema: schema.into(),
    name: name.into(),
    kind: kind.into(),
    comment: cmt.first().and_then(|r| so_opt(r.first())),
    columns: cols
      .iter()
      .map(|r| ColInfo {
        name: s(r.first()),
        ty: s(r.get(1)),
        nullable: is_true(r.get(2)),
        default: so_opt(r.get(3)),
        comment: so_opt(r.get(4)),
        primary_key: is_true(r.get(5)),
      })
      .collect(),
    indexes: idx.iter().map(|r| (s(r.first()), s(r.get(1)), is_true(r.get(2)), is_true(r.get(3)))).collect(),
    constraints: cons
      .iter()
      .map(|r| {
        let t = s(r.get(1));
        let tn = match t.as_str() {
          "p" => "primary key".into(),
          "f" => "foreign key".into(),
          "u" => "unique".into(),
          "c" => "check".into(),
          _ => t,
        };
        (s(r.first()), tn, s(r.get(2)))
      })
      .collect(),
  }))
}

fn n(v: f64) -> Option<String> {
  Some(js::num_str(v))
}

pub async fn column_detail(cfg: &Cfg, db: Option<&str>, table: f64, attnum: f64) -> R<Value> {
  let ps = [n(table), n(attnum)];
  let (cols, cons, idx) = tokio::try_join!(
    rows(
      cfg,
      db,
      "select n.nspname::text, c.relname::text, a.attname::text, format_type(a.atttypid, a.atttypmod), not a.attnotnull,\n              pg_get_expr(d.adbin, d.adrelid), col_description(a.attrelid, a.attnum), a.attidentity::text\n       from pg_attribute a\n       join pg_class c on c.oid = a.attrelid\n       join pg_namespace n on n.oid = c.relnamespace\n       left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum\n       where a.attrelid = $1 and a.attnum = $2 and not a.attisdropped",
      &ps
    ),
    rows(
      cfg,
      db,
      "select contype::text, conname::text, pg_get_constraintdef(oid) from pg_constraint\n       where conrelid = $1 and $2::int2 = any(conkey) order by contype, conname",
      &ps
    ),
    rows(
      cfg,
      db,
      "select i.relname::text from pg_index ix join pg_class i on i.oid = ix.indexrelid\n       where ix.indrelid = $1 and $2::int2 = any(ix.indkey::int2[]) and not ix.indisprimary order by i.relname",
      &ps
    )
  )?;
  let Some(r) = cols.first() else { return Ok(Value::Null) };
  let ident = s(r.get(7));
  Ok(json!({
    "table": format!("{}.{}", s(r.first()), s(r.get(1))),
    "column": s(r.get(2)),
    "type": s(r.get(3)),
    "nullable": is_true(r.get(4)),
    "default": so(r.get(5)),
    "comment": so(r.get(6)),
    "identity": match ident.as_str() { "a" => Value::from("always"), "d" => Value::from("by default"), _ => Value::Null },
    "constraints": cons.iter().map(|c| json!({ "type": s(c.first()), "name": s(c.get(1)), "def": s(c.get(2)) })).collect::<Vec<_>>(),
    "indexes": idx.iter().map(|i| s(i.first())).collect::<Vec<_>>(),
  }))
}

fn trim_end(s: &str) -> &str {
  s.trim_end_matches(js::js_space)
}

pub async fn object_ddl(cfg: &Cfg, db: Option<&str>, schema: &str, name: &str) -> R<String> {
  let full = format!("{}.{}", qi(schema), qi(name));
  let kind = rel_kind(cfg, db, schema, name).await?;
  if matches!(kind, Some("view") | Some("matview")) {
    let r = rows_s(cfg, db, &format!("select pg_get_viewdef({REL_OID}, true)"), &[schema, name]).await?;
    let head = if kind == Some("view") { "CREATE OR REPLACE VIEW" } else { "CREATE MATERIALIZED VIEW" };
    let def = s(r.first().and_then(|x| x.first()));
    return Ok(format!("{head} {full} AS\n{};\n", trim_end(&def).trim_end_matches(';')));
  }
  if kind == Some("sequence") {
    let r = rows_s(
      cfg,
      db,
      "select start_value::text, increment_by::text, min_value::text, max_value::text, cycle, cache_size::text\n       from pg_sequences where schemaname = $1 and sequencename = $2",
      &[schema, name],
    )
    .await?;
    let empty = vec![];
    let x = r.first().unwrap_or(&empty);
    return Ok(format!(
      "CREATE SEQUENCE {full}\n    START WITH {}\n    INCREMENT BY {}\n    MINVALUE {}\n    MAXVALUE {}\n    CACHE {}{};\n",
      s(x.first()),
      s(x.get(1)),
      s(x.get(2)),
      s(x.get(3)),
      s(x.get(5)),
      if is_true(x.get(4)) { "\n    CYCLE" } else { "" }
    ));
  }
  if kind.is_none() {
    let defs = rows_s(
      cfg,
      db,
      "select pg_get_functiondef(p.oid) from pg_proc p join pg_namespace n on n.oid = p.pronamespace\n       where n.nspname = $1 and p.proname = $2 and p.prokind in ('f','p') order by p.oid",
      &[schema, name],
    )
    .await?;
    if defs.is_empty() {
      return super::err(format!("No table, view, sequence or function {schema}.{name}"));
    }
    return Ok(defs.iter().map(|r| format!("{};\n", trim_end(&s(r.first())))).collect::<Vec<_>>().join("\n"));
  }
  let Some(d) = table_info(cfg, db, schema, name).await? else { return super::err("Cannot read properties of null (reading 'columns')") };
  let mut lines: Vec<String> = d
    .columns
    .iter()
    .map(|c| {
      let mut l = format!("    {} {}", qi(&c.name), c.ty);
      if let Some(df) = &c.default {
        l += &format!(" DEFAULT {df}");
      }
      if !c.nullable {
        l += " NOT NULL";
      }
      l
    })
    .collect();
  for (cn, _, def) in &d.constraints {
    lines.push(format!("    CONSTRAINT {} {def}", qi(cn)));
  }
  let mut out = format!("CREATE TABLE {full}\n(\n{}\n);\n", lines.join(",\n"));
  let con_names: Vec<&String> = d.constraints.iter().map(|c| &c.0).collect();
  for (iname, idef, _, _) in &d.indexes {
    if !con_names.contains(&iname) {
      out += &format!("\n{idef};\n");
    }
  }
  if let Some(c) = &d.comment {
    out += &format!("\nCOMMENT ON TABLE {full} IS {};\n", literal(Kind::Postgres, Some(c)));
  }
  for c in &d.columns {
    if let Some(cm) = &c.comment {
      out += &format!("COMMENT ON COLUMN {full}.{} IS {};\n", qi(&c.name), literal(Kind::Postgres, Some(cm)));
    }
  }
  Ok(out)
}

pub async fn edit_target(cfg: &Cfg, db: Option<&str>, table: f64) -> R<Value> {
  let ps = [n(table)];
  let (rel, pk, cols) = tokio::try_join!(
    rows(cfg, db, "select n.nspname::text, c.relname::text, c.relkind::text\n       from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.oid = $1", &ps),
    rows(cfg, db, "select unnest(conkey)::int from pg_constraint where conrelid = $1 and contype = 'p'", &ps),
    rows(
      cfg,
      db,
      "select a.attnum::int, a.attname::text, format_type(a.atttypid, a.atttypmod),\n              coalesce(to_jsonb(a)->>'attgenerated', '') = 's' or a.attidentity = 'a'\n       from pg_attribute a where a.attrelid = $1 and a.attnum > 0 and not a.attisdropped order by a.attnum",
      &ps
    )
  )?;
  let Some(r0) = rel.first() else { return Ok(Value::Null) };
  let rk = s(r0.get(2));
  let keys: Vec<f64> = pk.iter().map(|r| r.first().map(Cell::number).unwrap_or(0.0)).collect();
  let ok_kind = rk == "r" || rk == "p";
  let mut m = Map::new();
  m.insert("table".into(), num(table));
  m.insert("schema".into(), Value::String(s(r0.first())));
  m.insert("name".into(), Value::String(s(r0.get(1))));
  m.insert("editable".into(), Value::Bool(ok_kind && !keys.is_empty()));
  if !ok_kind {
    m.insert("reason".into(), "kind".into());
  } else if keys.is_empty() {
    m.insert("reason".into(), "nopk".into());
  }
  m.insert("pk".into(), Value::Array(keys.iter().map(|k| num(*k)).collect()));
  m.insert(
    "columns".into(),
    Value::Array(
      cols
        .iter()
        .map(|r| json!({ "attnum": num(r.first().map(Cell::number).unwrap_or(0.0)), "name": s(r.get(1)), "type": s(r.get(2)), "readOnly": is_true(r.get(3)) }))
        .collect(),
    ),
  );
  Ok(Value::Object(m))
}

const COMPLETION_TABLES: usize = 3000;

pub async fn completion_meta(cfg: &Cfg, db: Option<&str>) -> R<Value> {
  let hidden = "n.nspname not in ('pg_catalog', 'information_schema') and n.nspname !~ '^pg_(toast|temp)'";
  let q1 = format!("select n.nspname::text from pg_namespace n where {hidden} order by 1");
  let q3 = format!(
    "select n.nspname::text, c.relname::text, c.relkind::text,\n              (select json_agg(json_build_array(a.attname, format_type(a.atttypid, a.atttypmod)) order by a.attnum)::text\n                 from pg_attribute a where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped)\n         from pg_class c join pg_namespace n on n.oid = c.relnamespace\n        where c.relkind in ('r', 'p', 'v', 'm', 'f') and not c.relispartition and {hidden}\n        order by n.nspname, c.relname limit {}",
    COMPLETION_TABLES + 1
  );
  let q4 = format!(
    "select distinct n.nspname::text || '.' || p.proname::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace\n        where {hidden} and p.prokind in ('f', 'a', 'w') order by 1 limit 2000"
  );
  let (schemas, path, tables, fns) =
    tokio::try_join!(rows(cfg, db, &q1, &[]), rows(cfg, db, "select array_to_json(current_schemas(false))::text", &[]), rows(cfg, db, &q3, &[]), rows(cfg, db, &q4, &[]))?;
  let search_path = parse_json(path.first().and_then(|r| r.first())).unwrap_or_else(|| json!(["public"]));
  Ok(json!({
    "schemas": schemas.iter().map(|r| s(r.first())).collect::<Vec<_>>(),
    "searchPath": search_path,
    "tables": tables.iter().take(COMPLETION_TABLES).map(|r| {
      let cols = parse_json(r.get(3)).and_then(|v| v.as_array().cloned()).unwrap_or_default();
      json!({
        "schema": s(r.first()),
        "name": s(r.get(1)),
        "kind": s(r.get(2)),
        "columns": cols.iter().map(|c| json!({ "name": c.get(0), "type": c.get(1) })).collect::<Vec<_>>(),
      })
    }).collect::<Vec<_>>(),
    "functions": fns.iter().map(|r| s(r.first())).collect::<Vec<_>>(),
    "truncated": tables.len() > COMPLETION_TABLES,
  }))
}

// ---- roles and privileges (privMeta.ts) ------------------------------------------------

const GRANTEE: &str = "case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee)::text end";

pub async fn list_roles(cfg: &Cfg) -> R<Value> {
  let r = rows(
    cfg,
    None,
    "select r.rolname::text, r.rolsuper, r.rolcanlogin, r.rolinherit, r.rolcreatedb, r.rolcreaterole,\n            r.rolreplication, r.rolbypassrls, r.rolconnlimit, r.rolvaliduntil::text,\n            shobj_description(r.oid, 'pg_authid'),\n            coalesce((select json_agg(json_build_array(g.rolname, m.admin_option) order by g.rolname)\n                      from pg_auth_members m join pg_roles g on g.oid = m.roleid where m.member = r.oid), '[]')::text\n     from pg_roles r order by r.rolname",
    &[],
  )
  .await?;
  Ok(Value::Array(
    r.iter()
      .map(|x| {
        // PG 16 keeps one membership row per grantor: merge them.
        let mut member_of: Vec<(String, bool)> = vec![];
        for pair in parse_json(x.get(11)).and_then(|v| v.as_array().cloned()).unwrap_or_default() {
          let role = pair.get(0).map(js::string).unwrap_or_else(|| "undefined".into());
          let admin = js::truthy(pair.get(1));
          match member_of.iter_mut().find(|m| m.0 == role) {
            Some(m) => m.1 = m.1 || admin,
            None => member_of.push((role, admin)),
          }
        }
        let until = so_opt(x.get(9));
        let name = s(x.first());
        json!({
          "name": name,
          "superuser": truthy(x.get(1)),
          "login": truthy(x.get(2)),
          "inherit": truthy(x.get(3)),
          "createDb": truthy(x.get(4)),
          "createRole": truthy(x.get(5)),
          "replication": truthy(x.get(6)),
          "bypassRls": truthy(x.get(7)),
          "connLimit": num(x.get(8).map(Cell::number).unwrap_or(f64::NAN)),
          "validUntil": if until.as_deref() == Some("infinity") { None } else { until },
          "comment": so(x.get(10)),
          "memberOf": member_of.iter().map(|(r, a)| json!({ "role": r, "admin": a })).collect::<Vec<_>>(),
          "system": name.starts_with("pg_"),
        })
      })
      .collect(),
  ))
}

pub async fn object_privileges(cfg: &Cfg, db: Option<&str>, t: &Value) -> R<Value> {
  let kind = t.get("kind").map(js::string).unwrap_or_default();
  let (from, ps): (String, Vec<Option<String>>) = match kind.as_str() {
    "schema" => ("select nspacl acl, nspowner owner, 'n'::\"char\" code from pg_namespace where nspname = $1".into(), vec![js::pg_param(t.get("name").unwrap_or(&Value::Null))]),
    "database" => ("select datacl acl, datdba owner, 'd'::\"char\" code from pg_database where datname = $1".into(), vec![js::pg_param(t.get("name").unwrap_or(&Value::Null))]),
    "function" | "procedure" => (
      "select proacl acl, proowner owner, 'f'::\"char\" code from pg_proc\n               where oid = (select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace\n                            where n.nspname = $1 and p.proname = $2 and pg_get_function_identity_arguments(p.oid) = $3 limit 1)".into(),
      vec![js::pg_param(t.get("schema").unwrap_or(&Value::Null)), js::pg_param(t.get("name").unwrap_or(&Value::Null)), Some(match t.get("args") { None | Some(Value::Null) => String::new(), Some(v) => js::string(v) })],
    ),
    _ => (
      format!("select relacl acl, relowner owner, (case when relkind = 'S' then 's' else 'r' end)::\"char\" code from pg_class where oid = {REL_OID}"),
      vec![js::pg_param(t.get("schema").unwrap_or(&Value::Null)), js::pg_param(t.get("name").unwrap_or(&Value::Null))],
    ),
  };
  let r = rows(
    cfg,
    db,
    &format!(
      "select pg_get_userbyid(o.owner)::text, {GRANTEE}, a.privilege_type::text, a.is_grantable,\n            current_setting('server_version_num')::int\n     from ({from}) o\n     left join lateral aclexplode(coalesce(o.acl, acldefault(o.code, o.owner))) a on true"
    ),
    &ps,
  )
  .await?;
  let Some(first) = r.first() else { return Ok(Value::Null) };
  let grants: Vec<Value> = r
    .iter()
    .filter(|x| !x.get(2).is_none_or(Cell::is_null))
    .map(|x| json!({ "grantee": s(x.get(1)), "privilege": s(x.get(2)), "grantable": truthy(x.get(3)) }))
    .collect();
  let mut available: Vec<Value> = super::sqltext::privs(&kind).iter().map(|p| Value::from(*p)).collect();
  if kind == "table" && first.get(4).map(Cell::number).unwrap_or(0.0) >= 170000.0 {
    available.push("MAINTAIN".into());
  }
  Ok(json!({ "owner": s(first.first()), "grants": grants, "available": available }))
}

pub async fn default_acls(cfg: &Cfg, db: Option<&str>) -> R<Value> {
  let r = rows(
    cfg,
    db,
    &format!(
      "select pg_get_userbyid(d.defaclrole)::text, n.nspname::text, d.defaclobjtype::text, {GRANTEE}, a.privilege_type::text, a.is_grantable\n     from pg_default_acl d left join pg_namespace n on n.oid = d.defaclnamespace\n     cross join lateral aclexplode(d.defaclacl) a\n     order by 1, 2 nulls first, 3, 4"
    ),
    &[],
  )
  .await?;
  let ty = |k: &str| match k {
    "r" => Some("tables"),
    "S" => Some("sequences"),
    "f" => Some("functions"),
    "T" => Some("types"),
    "n" => Some("schemas"),
    _ => None,
  };
  Ok(Value::Array(
    r.iter()
      .filter_map(|x| {
        let t = ty(&s(x.get(2)))?;
        Some(json!({
          "role": s(x.first()),
          "schema": so(x.get(1)),
          "objType": t,
          "grantee": s(x.get(3)),
          "privilege": s(x.get(4)),
          "grantable": truthy(x.get(5)),
        }))
      })
      .collect(),
  ))
}

pub async fn rls_info(cfg: &Cfg, db: Option<&str>, schema: &str, table: &str) -> R<Value> {
  let head = rows_s(cfg, db, &format!("select relrowsecurity, relforcerowsecurity from pg_class where oid = {REL_OID}"), &[schema, table]).await?;
  let Some(h) = head.first() else { return Ok(Value::Null) };
  let r = rows_s(
    cfg,
    db,
    &format!(
      "select p.polname::text, p.polcmd::text, p.polpermissive,\n            coalesce((select json_agg(case when r = 0 then 'PUBLIC' else pg_get_userbyid(r)::text end) from unnest(p.polroles) r), '[]')::text,\n            pg_get_expr(p.polqual, p.polrelid), pg_get_expr(p.polwithcheck, p.polrelid)\n     from pg_policy p where p.polrelid = {REL_OID} order by 1"
    ),
    &[schema, table],
  )
  .await?;
  let cmd = |c: &str| match c {
    "r" => "SELECT",
    "a" => "INSERT",
    "w" => "UPDATE",
    "d" => "DELETE",
    _ => "ALL",
  };
  Ok(json!({
    "enabled": truthy(h.first()),
    "forced": truthy(h.get(1)),
    "policies": r.iter().map(|x| json!({
      "name": s(x.first()),
      "command": cmd(&s(x.get(1))),
      "permissive": truthy(x.get(2)),
      "roles": parse_json(x.get(3)).unwrap_or_else(|| json!([])),
      "using": so(x.get(4)),
      "check": so(x.get(5)),
    })).collect::<Vec<_>>(),
  }))
}

pub async fn role_grants(cfg: &Cfg, db: Option<&str>, role: &str) -> R<Value> {
  let r = rows_s(
    cfg,
    db,
    "with r as (select oid from pg_roles where rolname = $1),\n     x as (\n       select (case c.relkind when 'r' then 'table' when 'p' then 'partitioned' when 'v' then 'view' when 'm' then 'matview'\n                 when 'f' then 'foreign' else 'sequence' end) kind, n.nspname::text sch, c.relname::text nm, a.*\n       from pg_class c join pg_namespace n on n.oid = c.relnamespace cross join lateral aclexplode(c.relacl) a\n       where c.relkind in ('r','p','v','m','f','S') and not c.relispartition\n         and n.nspname not in ('pg_catalog', 'information_schema') and n.nspname not like 'pg_toast%'\n       union all\n       select 'schema', '', n.nspname::text, a.* from pg_namespace n cross join lateral aclexplode(n.nspacl) a\n       where n.nspname not in ('pg_catalog', 'information_schema') and n.nspname not like 'pg_toast%'\n       union all\n       select (case p.prokind when 'p' then 'procedure' else 'function' end), n.nspname::text,\n              p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', a.*\n       from pg_proc p join pg_namespace n on n.oid = p.pronamespace cross join lateral aclexplode(p.proacl) a\n       where n.nspname not in ('pg_catalog', 'information_schema')\n       union all\n       select 'database', '', d.datname::text, a.* from pg_database d cross join lateral aclexplode(d.datacl) a\n       where d.datname = current_database()\n     )\n     select kind, sch, nm, json_agg(privilege_type order by privilege_type)::text,\n            coalesce(json_agg(privilege_type) filter (where is_grantable), '[]')::text, grantee = 0\n     from x where grantee = (select oid from r) or grantee = 0\n     group by kind, sch, nm, grantee = 0\n     order by (kind = 'database') desc, (kind = 'schema') desc, sch, nm\n     limit 2000",
    &[role],
  )
  .await?;
  Ok(Value::Array(
    r.iter()
      .map(|x| {
        json!({
          "kind": s(x.first()),
          "schema": s(x.get(1)),
          "name": s(x.get(2)),
          "privileges": parse_json(x.get(3)).unwrap_or_else(|| json!([])),
          "grantable": parse_json(x.get(4)).unwrap_or_else(|| json!([])),
          "viaPublic": truthy(x.get(5)),
        })
      })
      .collect(),
  ))
}

// ---- monitor (monitorMeta.ts) ------------------------------------------------------------

fn mnum(c: Option<&Cell>) -> Value {
  // typeof v === 'number' ? v : Number(v) || 0
  let f = match c {
    Some(Cell::Num(f)) => *f,
    Some(x) => {
      let f = x.number();
      if f.is_nan() || f == 0.0 { 0.0 } else { f }
    }
    None => 0.0,
  };
  num(f)
}
fn mnum_or_null(c: Option<&Cell>) -> Value {
  match c {
    None | Some(Cell::Null) => Value::Null,
    x => mnum(x),
  }
}
fn age(col: &str) -> String {
  format!("extract(epoch from now() - {col})::float8")
}

pub async fn server_overview(cfg: &Cfg, db: Option<&str>) -> R<Value> {
  let head = rows(
    cfg,
    db,
    &format!(
      "select version(), current_setting('server_version_num')::int,\n            {}, current_database()::text,\n            pg_database_size(current_database())::float8,\n            current_setting('max_connections')::int,\n            d.xact_commit::float8, d.xact_rollback::float8, d.blks_hit::float8, d.blks_read::float8,\n            d.deadlocks::float8, d.temp_bytes::float8, d.conflicts::float8, d.tup_returned::float8,\n            d.tup_fetched::float8, d.tup_inserted::float8, d.tup_updated::float8, d.tup_deleted::float8,\n            (select count(*)::int from pg_stat_activity where cardinality(pg_blocking_pids(pid)) > 0),\n            (select {} from pg_stat_activity where backend_type = 'client backend' and pid <> pg_backend_pid()),\n            current_setting('is_superuser') = 'on'\n       from pg_stat_database d where d.datname = current_database()",
      age("pg_postmaster_start_time()"),
      age("min(xact_start)")
    ),
    &[],
  )
  .await?;
  let states = rows(
    cfg,
    db,
    "select coalesce(state, 'unknown'), count(*)::int from pg_stat_activity\n      where backend_type = 'client backend' and pid <> pg_backend_pid() group by 1",
    &[],
  )
  .await?;
  let dbs = rows(
    cfg,
    db,
    "select datname::text, pg_database_size(datname)::float8 from pg_database\n      where datallowconn and not datistemplate and has_database_privilege(datname, 'CONNECT') order by 2 desc",
    &[],
  )
  .await?;
  let mut st = Map::new();
  for r in &states {
    st.insert(s(r.first()), mnum(r.get(1)));
  }
  let total: f64 = st.values().map(|v| v.as_f64().unwrap_or(0.0)).sum();
  let empty = vec![];
  let h = head.first().unwrap_or(&empty);
  Ok(json!({
    "version": s(h.first()),
    "versionNum": mnum(h.get(1)),
    "uptime": mnum(h.get(2)),
    "database": s(h.get(3)),
    "dbSize": mnum(h.get(4)),
    "maxConnections": mnum(h.get(5)),
    "connections": num(total),
    "states": st,
    "commits": mnum(h.get(6)),
    "rollbacks": mnum(h.get(7)),
    "blksHit": mnum(h.get(8)),
    "blksRead": mnum(h.get(9)),
    "deadlocks": mnum(h.get(10)),
    "tempBytes": mnum(h.get(11)),
    "conflicts": mnum(h.get(12)),
    "tupReturned": mnum(h.get(13)),
    "tupFetched": mnum(h.get(14)),
    "tupInserted": mnum(h.get(15)),
    "tupUpdated": mnum(h.get(16)),
    "tupDeleted": mnum(h.get(17)),
    "blocked": mnum(h.get(18)),
    "oldestXact": mnum_or_null(h.get(19)),
    "superuser": is_true(h.get(20)),
    "databases": dbs.iter().map(|r| json!({ "name": s(r.first()), "size": mnum(r.get(1)) })).collect::<Vec<_>>(),
  }))
}

pub async fn list_sessions(cfg: &Cfg, db: Option<&str>) -> R<Value> {
  let r = rows(
    cfg,
    db,
    &format!(
      "select pid, coalesce(usename::text, ''), coalesce(datname::text, ''), application_name,\n            coalesce(host(client_addr), case when client_port = -1 then 'local' else '' end),\n            coalesce(backend_type, ''), coalesce(state, ''), coalesce(wait_event_type, ''), coalesce(wait_event, ''),\n            {}, {}, {}, {},\n            left(query, 10000), array_to_string(pg_blocking_pids(pid), ',')\n       from pg_stat_activity where pid <> pg_backend_pid()\n      order by (state = 'active') desc nulls last, query_start nulls last",
      age("backend_start"),
      age("xact_start"),
      age("query_start"),
      age("state_change")
    ),
    &[],
  )
  .await?;
  Ok(Value::Array(
    r.iter()
      .map(|x| {
        let pids: Vec<Value> = match x.get(14) {
          Some(c) if c.truthy() => c.js_string().split(',').map(js::number).filter(|f| f.is_finite()).map(num).collect(),
          _ => vec![],
        };
        json!({
          "pid": mnum(x.first()),
          "user": s(x.get(1)),
          "database": s(x.get(2)),
          "application": s(x.get(3)),
          "client": s(x.get(4)),
          "backendType": s(x.get(5)),
          "state": s(x.get(6)),
          "waitType": s(x.get(7)),
          "wait": s(x.get(8)),
          "backendAge": mnum_or_null(x.get(9)),
          "xactAge": mnum_or_null(x.get(10)),
          "queryAge": mnum_or_null(x.get(11)),
          "stateAge": mnum_or_null(x.get(12)),
          "query": s(x.get(13)),
          "blockedBy": pids,
        })
      })
      .collect(),
  ))
}

pub async fn list_locks(cfg: &Cfg, db: Option<&str>) -> R<Value> {
  let r = rows(
    cfg,
    db,
    &format!(
      "select l.pid, l.locktype, l.mode, l.granted,\n            case when l.relation is null then ''\n                 when l.database = (select oid from pg_database where datname = current_database()) then l.relation::regclass::text\n                 else l.relation::text end,\n            concat_ws(' ', l.transactionid::text, l.virtualxid, case when l.page is not null then 'page ' || l.page end,\n                      case when l.tuple is not null then 'tuple ' || l.tuple end),\n            coalesce(a.usename::text, ''), coalesce(a.state, ''), {}, left(coalesce(a.query, ''), 2000)\n       from pg_locks l left join pg_stat_activity a on a.pid = l.pid\n      where l.pid is distinct from pg_backend_pid()\n      order by l.granted, a.query_start nulls last, l.pid\n      limit 2000",
      age("a.query_start")
    ),
    &[],
  )
  .await?;
  Ok(Value::Array(
    r.iter()
      .map(|x| {
        json!({
          "pid": mnum(x.first()),
          "locktype": s(x.get(1)),
          "mode": s(x.get(2)),
          "granted": is_true(x.get(3)),
          "relation": s(x.get(4)),
          "target": s(x.get(5)),
          "user": s(x.get(6)),
          "state": s(x.get(7)),
          "queryAge": mnum_or_null(x.get(8)),
          "query": s(x.get(9)),
        })
      })
      .collect(),
  ))
}

pub async fn table_stats(cfg: &Cfg, db: Option<&str>) -> R<Value> {
  let r = rows(
    cfg,
    db,
    &format!(
      "select s.schemaname::text, s.relname::text, c.relkind::text,\n            pg_total_relation_size(s.relid)::float8, pg_relation_size(s.relid)::float8, pg_indexes_size(s.relid)::float8,\n            case when c.reltoastrelid = 0 then 0 else pg_total_relation_size(c.reltoastrelid) end::float8,\n            s.n_live_tup::float8, s.n_dead_tup::float8, coalesce(s.seq_scan, 0)::float8, coalesce(s.idx_scan, 0)::float8,\n            s.n_tup_ins::float8, s.n_tup_upd::float8, s.n_tup_del::float8, s.n_mod_since_analyze::float8,\n            {}, {},\n            s.last_autovacuum is not null and (s.last_vacuum is null or s.last_autovacuum > s.last_vacuum),\n            s.last_autoanalyze is not null and (s.last_analyze is null or s.last_autoanalyze > s.last_analyze)\n       from pg_stat_user_tables s join pg_class c on c.oid = s.relid\n      order by 4 desc, 1, 2",
      age("greatest(s.last_vacuum, s.last_autovacuum)"),
      age("greatest(s.last_analyze, s.last_autoanalyze)")
    ),
    &[],
  )
  .await?;
  Ok(Value::Array(
    r.iter()
      .map(|x| {
        json!({
          "schema": s(x.first()),
          "name": s(x.get(1)),
          "kind": s(x.get(2)),
          "total": mnum(x.get(3)),
          "table": mnum(x.get(4)),
          "indexes": mnum(x.get(5)),
          "toast": mnum(x.get(6)),
          "live": mnum(x.get(7)),
          "dead": mnum(x.get(8)),
          "seqScan": mnum(x.get(9)),
          "idxScan": mnum(x.get(10)),
          "inserted": mnum(x.get(11)),
          "updated": mnum(x.get(12)),
          "deleted": mnum(x.get(13)),
          "modSinceAnalyze": mnum(x.get(14)),
          "vacuumAge": mnum_or_null(x.get(15)),
          "analyzeAge": mnum_or_null(x.get(16)),
          "autoVacuumed": is_true(x.get(17)),
          "autoAnalyzed": is_true(x.get(18)),
        })
      })
      .collect(),
  ))
}

pub async fn index_stats(cfg: &Cfg, db: Option<&str>) -> R<Value> {
  let r = rows(
    cfg,
    db,
    "select s.schemaname::text, s.relname::text, s.indexrelname::text, pg_relation_size(s.indexrelid)::float8,\n            s.idx_scan::float8, s.idx_tup_read::float8, s.idx_tup_fetch::float8,\n            i.indisunique, i.indisprimary, i.indisvalid, pg_get_indexdef(s.indexrelid)\n       from pg_stat_user_indexes s join pg_index i on i.indexrelid = s.indexrelid\n      order by 4 desc, 1, 2, 3",
    &[],
  )
  .await?;
  Ok(Value::Array(
    r.iter()
      .map(|x| {
        json!({
          "schema": s(x.first()),
          "table": s(x.get(1)),
          "name": s(x.get(2)),
          "size": mnum(x.get(3)),
          "scans": mnum(x.get(4)),
          "tupRead": mnum(x.get(5)),
          "tupFetch": mnum(x.get(6)),
          "unique": is_true(x.get(7)),
          "primary": is_true(x.get(8)),
          "valid": is_true(x.get(9)),
          "def": s(x.get(10)),
        })
      })
      .collect(),
  ))
}

pub async fn list_settings(cfg: &Cfg, db: Option<&str>) -> R<Value> {
  let r = rows(
    cfg,
    db,
    "select name, coalesce(setting, ''), coalesce(unit, ''), coalesce(category, ''), coalesce(short_desc, ''),\n            context, vartype, coalesce(source, ''), coalesce(min_val, ''), coalesce(max_val, ''),\n            coalesce(array_to_string(enumvals, chr(31)), ''), coalesce(boot_val, ''), coalesce(reset_val, ''),\n            coalesce(pending_restart, false)\n       from pg_settings order by category, name",
    &[],
  )
  .await?;
  Ok(Value::Array(
    r.iter()
      .map(|x| {
        let ev: Vec<String> = if truthy(x.get(10)) { s(x.get(10)).split('\u{1f}').map(str::to_string).collect() } else { vec![] };
        json!({
          "name": s(x.first()),
          "setting": s(x.get(1)),
          "unit": s(x.get(2)),
          "category": s(x.get(3)),
          "description": s(x.get(4)),
          "context": s(x.get(5)),
          "vartype": s(x.get(6)),
          "source": s(x.get(7)),
          "min": s(x.get(8)),
          "max": s(x.get(9)),
          "enumvals": ev,
          "boot": s(x.get(11)),
          "reset": s(x.get(12)),
          "pendingRestart": is_true(x.get(13)),
        })
      })
      .collect(),
  ))
}

pub async fn signal_backend(cfg: &Cfg, db: Option<&str>, pid: f64, terminate: bool) -> R<bool> {
  let f = if terminate { "pg_terminate_backend" } else { "pg_cancel_backend" };
  let r = rows(cfg, db, &format!("select {f}($1::int)"), &[n(pid.floor())]).await?;
  Ok(is_true(r.first().and_then(|x| x.first())))
}

pub async fn reload_conf(cfg: &Cfg, db: Option<&str>) -> R<bool> {
  let r = rows(cfg, db, "select pg_reload_conf()", &[]).await?;
  Ok(is_true(r.first().and_then(|x| x.first())))
}

// ---- ER diagram (erdMeta.ts) ---------------------------------------------------------------

fn name_list(c: Option<&Cell>) -> Vec<String> {
  match c {
    Some(Cell::Str(t)) => match serde_json::from_str::<Value>(t) {
      Ok(Value::Array(a)) => a.iter().map(js::string).collect(),
      _ => vec![],
    },
    _ => vec![],
  }
}

fn erd_kind(k: &str) -> &'static str {
  match k {
    "p" => "partitioned",
    "f" => "foreign",
    _ => "table",
  }
}

pub async fn erd_model(cfg: &Cfg, db: Option<&str>, schema: &str) -> R<Value> {
  let rels = rows_s(
    cfg,
    db,
    "select c.oid::int, c.relname::text, c.relkind::text, obj_description(c.oid, 'pg_class')\n       from pg_class c join pg_namespace n on n.oid = c.relnamespace\n      where n.nspname = $1 and c.relkind in ('r', 'p', 'f') and not c.relispartition\n      order by c.relname",
    &[schema],
  )
  .await?;
  let cols = rows_s(
    cfg,
    db,
    "select a.attrelid::int, a.attname::text, format_type(a.atttypid, a.atttypmod), a.attnotnull\n       from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace\n      where n.nspname = $1 and c.relkind in ('r', 'p', 'f') and not c.relispartition\n        and a.attnum > 0 and not a.attisdropped\n      order by a.attrelid, a.attnum",
    &[schema],
  )
  .await?;
  let cons = rows_s(
    cfg,
    db,
    "select k.conname::text, k.contype::text, k.conrelid::int,\n            (select json_agg(a.attname::text order by u.ord)::text from unnest(k.conkey) with ordinality u(att, ord)\n               join pg_attribute a on a.attrelid = k.conrelid and a.attnum = u.att),\n            fn.nspname::text, fc.relname::text,\n            (select json_agg(a.attname::text order by u.ord)::text from unnest(k.confkey) with ordinality u(att, ord)\n               join pg_attribute a on a.attrelid = k.confrelid and a.attnum = u.att),\n            fc.relkind::text\n       from pg_constraint k join pg_class c on c.oid = k.conrelid join pg_namespace n on n.oid = c.relnamespace\n       left join pg_class fc on fc.oid = k.confrelid left join pg_namespace fn on fn.oid = fc.relnamespace\n      where n.nspname = $1 and k.contype in ('p', 'f') and not c.relispartition\n      order by k.conname",
    &[schema],
  )
  .await?;
  struct T {
    key: String,
    schema: String,
    name: String,
    kind: &'static str,
    columns: Vec<(String, String, bool, bool, bool)>,
    comment: Option<String>,
    external: bool,
  }
  let mut tables: Vec<T> = vec![];
  let mut by_oid: Vec<(f64, usize)> = vec![];
  for r in &rels {
    let name = s(r.get(1));
    tables.push(T { key: name.clone(), schema: schema.into(), name, kind: erd_kind(&s(r.get(2))), columns: vec![], comment: r.get(3).filter(|c| c.truthy()).map(Cell::s), external: false });
    by_oid.push((r.first().map(Cell::number).unwrap_or(f64::NAN), tables.len() - 1));
  }
  let find = |oid: f64| by_oid.iter().find(|(o, _)| *o == oid).map(|(_, i)| *i);
  for r in &cols {
    if let Some(i) = find(r.first().map(Cell::number).unwrap_or(f64::NAN)) {
      tables[i].columns.push((s(r.get(1)), s(r.get(2)), is_true(r.get(3)), false, false));
    }
  }
  let mut external: Vec<T> = vec![];
  let mut refs: Vec<Value> = vec![];
  for r in &cons {
    let Some(ti) = find(r.get(2).map(Cell::number).unwrap_or(f64::NAN)) else { continue };
    let own = name_list(r.get(3));
    let pk = r.get(1).is_some_and(|c| matches!(c, Cell::Str(x) if x == "p"));
    for c in tables[ti].columns.iter_mut() {
      if own.contains(&c.0) {
        if pk {
          c.3 = true;
        } else {
          c.4 = true;
        }
      }
    }
    if !r.get(1).is_some_and(|c| matches!(c, Cell::Str(x) if x == "f")) {
      continue;
    }
    let to_cols = name_list(r.get(6));
    let mut to = s(r.get(5));
    if s(r.get(4)) != schema {
      to = format!("{}.{}", s(r.get(4)), s(r.get(5)));
      let xi = match external.iter().position(|x| x.key == to) {
        Some(i) => i,
        None => {
          external.push(T { key: to.clone(), schema: s(r.get(4)), name: s(r.get(5)), kind: erd_kind(&s(r.get(7))), columns: vec![], comment: None, external: true });
          external.len() - 1
        }
      };
      for c in &to_cols {
        if !external[xi].columns.iter().any(|y| &y.0 == c) {
          external[xi].columns.push((c.clone(), String::new(), true, true, false));
        }
      }
    }
    refs.push(json!({ "name": s(r.first()), "from": tables[ti].key, "fromCols": own, "to": to, "toCols": to_cols }));
  }
  external.sort_by(|a, b| crate::services::collate::locale_compare(&a.key, &b.key));
  tables.extend(external);
  let tv: Vec<Value> = tables
    .iter()
    .map(|t| {
      let mut m = Map::new();
      m.insert("key".into(), t.key.clone().into());
      m.insert("schema".into(), t.schema.clone().into());
      m.insert("name".into(), t.name.clone().into());
      m.insert("kind".into(), t.kind.into());
      m.insert("columns".into(), Value::Array(t.columns.iter().map(|c| json!({ "name": c.0, "type": c.1, "notNull": c.2, "pk": c.3, "fk": c.4 })).collect()));
      if t.external {
        m.insert("external".into(), true.into());
      }
      if let Some(c) = &t.comment {
        m.insert("comment".into(), c.clone().into());
      }
      Value::Object(m)
    })
    .collect();
  Ok(json!({ "schema": schema, "tables": tv, "refs": refs }))
}

// ---- schema snapshot (schemaDiffMeta.ts) ---------------------------------------------------

fn not_ext(cls: &str, oid: &str) -> String {
  format!("not exists (select 1 from pg_depend x where x.classid = '{cls}'::regclass and x.objid = {oid} and x.deptype = 'e')")
}

pub async fn schema_snapshot(cfg: &Cfg, db: Option<&str>, schema: &str) -> R<Value> {
  let p = || vec![Some(schema.to_string())];
  let q_rels = format!(
    "select c.oid::int, c.relname::text, c.relkind::text, c.relpersistence::text,\n              case when c.relkind = 'p' then pg_get_partkeydef(c.oid) end,\n              case when c.relkind in ('v', 'm') then pg_get_viewdef(c.oid, true) end,\n              obj_description(c.oid, 'pg_class')\n         from pg_class c join pg_namespace n on n.oid = c.relnamespace\n        where n.nspname = $1 and c.relkind in ('r', 'p', 'v', 'm') and not c.relispartition and {}\n        order by c.oid",
    not_ext("pg_class", "c.oid")
  );
  let q_cols = "select a.attrelid::int, a.attname::text, format_type(a.atttypid, a.atttypmod), a.attnotnull,\n              a.attidentity::text, a.attgenerated::text, pg_get_expr(d.adbin, d.adrelid, true), col_description(a.attrelid, a.attnum)\n         from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace\n         left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum\n        where n.nspname = $1 and c.relkind in ('r', 'p', 'v', 'm') and a.attnum > 0 and not a.attisdropped\n        order by a.attrelid, a.attnum";
  let q_cons = "select k.conrelid::int, k.conname::text, k.contype::text, pg_get_constraintdef(k.oid, true)\n         from pg_constraint k join pg_class c on c.oid = k.conrelid join pg_namespace n on n.oid = c.relnamespace\n        where n.nspname = $1 and k.contype in ('p', 'u', 'c', 'f', 'x')";
  let q_idx = "select i.indrelid::int, ic.relname::text, pg_get_indexdef(i.indexrelid, 0, true)\n         from pg_index i join pg_class ic on ic.oid = i.indexrelid join pg_namespace n on n.oid = ic.relnamespace\n        where n.nspname = $1\n          and not exists (select 1 from pg_constraint k where k.conindid = i.indexrelid and k.conrelid = i.indrelid and k.contype in ('p', 'u', 'x'))";
  let q_trg = "select t.tgrelid::int, t.tgname::text, pg_get_triggerdef(t.oid, true)\n         from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace\n        where n.nspname = $1 and not t.tgisinternal";
  let q_seqs = format!(
    "select c.relname::text, format_type(s.seqtypid, null), s.seqstart::text, s.seqincrement::text, s.seqmin::text,\n              s.seqmax::text, s.seqcache::text, s.seqcycle,\n              (select quote_ident(tc.relname) || '.' || quote_ident(a.attname)\n                 from pg_depend d join pg_class tc on tc.oid = d.refobjid\n                 join pg_attribute a on a.attrelid = d.refobjid and a.attnum = d.refobjsubid\n                where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.refclassid = 'pg_class'::regclass and d.deptype = 'a' limit 1)\n         from pg_sequence s join pg_class c on c.oid = s.seqrelid join pg_namespace n on n.oid = c.relnamespace\n        where n.nspname = $1 and {}\n          and not exists (select 1 from pg_depend d where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'i')\n        order by c.relname",
    not_ext("pg_class", "c.oid")
  );
  let q_enums = format!(
    "select t.typname::text, (select json_agg(e.enumlabel::text order by e.enumsortorder)::text from pg_enum e where e.enumtypid = t.oid),\n              obj_description(t.oid, 'pg_type')\n         from pg_type t join pg_namespace n on n.oid = t.typnamespace\n        where n.nspname = $1 and t.typtype = 'e' and {}\n        order by t.typname",
    not_ext("pg_type", "t.oid")
  );
  let q_procs = format!(
    "select p.proname::text, p.prokind::text, pg_get_function_identity_arguments(p.oid), pg_get_function_arguments(p.oid),\n              case when p.prokind = 'f' then pg_get_function_result(p.oid) end, pg_get_functiondef(p.oid),\n              quote_ident(n.nspname) || '.' || quote_ident(p.proname), quote_ident(p.proname), obj_description(p.oid, 'pg_proc')\n         from pg_proc p join pg_namespace n on n.oid = p.pronamespace\n        where n.nspname = $1 and p.prokind in ('f', 'p') and {}\n        order by p.proname, p.oid",
    not_ext("pg_proc", "p.oid")
  );
  let res = pg::read_in(
    cfg,
    db,
    schema,
    &[(&q_rels, p()), (q_cols, p()), (q_cons, p()), (q_idx, p()), (q_trg, p()), (&q_seqs, p()), (&q_enums, p()), (&q_procs, p())],
  )
  .await?;
  let [rels, cols, cons, idx, trg, seqs, enums, procs]: [Vec<Vec<Cell>>; 8] = res.try_into().map_err(|_| super::DbErr::new("snapshot"))?;
  let key = |r: &Vec<Cell>| r.first().map(Cell::number).unwrap_or(f64::NAN).to_bits();
  let mut cols_of: Vec<(u64, Vec<Value>, Vec<Value>)> = vec![];
  for r in &cols {
    let k = key(r);
    let gen = s(r.get(5)) == "s";
    let full = json!({
      "name": s(r.get(1)),
      "type": s(r.get(2)),
      "notNull": is_true(r.get(3)),
      "default": if gen { Value::Null } else { so(r.get(6)) },
      "identity": s(r.get(4)),
      "generated": if gen { Value::String(s(r.get(6))) } else { Value::Null },
      "comment": so(r.get(7)),
    });
    let short = json!({ "name": s(r.get(1)), "type": s(r.get(2)) });
    match cols_of.iter_mut().find(|x| x.0 == k) {
      Some(x) => {
        x.1.push(full);
        x.2.push(short);
      }
      None => cols_of.push((k, vec![full], vec![short])),
    }
  }
  let group = |rs: &Vec<Vec<Cell>>, make: &dyn Fn(&Vec<Cell>) -> Value| {
    let mut m: Vec<(u64, Vec<Value>)> = vec![];
    for r in rs {
      let k = key(r);
      match m.iter_mut().find(|x| x.0 == k) {
        Some(x) => x.1.push(make(r)),
        None => m.push((k, vec![make(r)])),
      }
    }
    m
  };
  let named = |r: &Vec<Cell>| json!({ "name": s(r.get(1)), "def": s(r.get(2)) });
  let cons_of = group(&cons, &|r| json!({ "name": s(r.get(1)), "type": s(r.get(2)), "def": s(r.get(3)) }));
  let idx_of = group(&idx, &named);
  let trg_of = group(&trg, &named);
  let get = |m: &Vec<(u64, Vec<Value>)>, k: u64| m.iter().find(|x| x.0 == k).map(|x| x.1.clone()).unwrap_or_default();
  let mut tables: Vec<(String, Value)> = vec![];
  let mut views: Vec<Value> = vec![];
  for r in &rels {
    let id = r.first().map(Cell::number).unwrap_or(f64::NAN);
    let k = id.to_bits();
    let kind = s(r.get(2));
    let name = s(r.get(1));
    let cset = cols_of.iter().find(|x| x.0 == k);
    if kind == "v" || kind == "m" {
      views.push(json!({
        "name": name,
        "materialized": kind == "m",
        "def": js::trim(&s(r.get(5))),
        "columns": cset.map(|x| x.2.clone()).unwrap_or_default(),
        "indexes": get(&idx_of, k),
        "comment": so(r.get(6)),
        "order": num(id),
      }));
    } else {
      tables.push((
        name.clone(),
        json!({
          "name": name,
          "partitioned": kind == "p",
          "unlogged": s(r.get(3)) == "u",
          "partKey": so(r.get(4)),
          "columns": cset.map(|x| x.1.clone()).unwrap_or_default(),
          "constraints": get(&cons_of, k),
          "indexes": get(&idx_of, k),
          "triggers": get(&trg_of, k),
          "comment": so(r.get(6)),
        }),
      ));
    }
  }
  tables.sort_by(|a, b| crate::services::collate::locale_compare(&a.0, &b.0));
  Ok(json!({
    "schema": schema,
    "tables": tables.into_iter().map(|x| x.1).collect::<Vec<_>>(),
    "views": views,
    "sequences": seqs.iter().map(|r| json!({
      "name": s(r.first()), "type": s(r.get(1)), "start": s(r.get(2)), "increment": s(r.get(3)), "min": s(r.get(4)),
      "max": s(r.get(5)), "cache": s(r.get(6)), "cycle": is_true(r.get(7)), "ownedBy": so(r.get(8)),
    })).collect::<Vec<_>>(),
    "enums": enums.iter().map(|r| json!({ "name": s(r.first()), "labels": name_list(r.get(1)), "comment": so(r.get(2)) })).collect::<Vec<_>>(),
    "routines": procs.iter().map(|r| {
      let def = s(r.get(5)).replacen(&format!("{}(", s(r.get(6))), &format!("{}(", s(r.get(7))), 1);
      json!({
        "name": s(r.first()),
        "procedure": s(r.get(1)) == "p",
        "args": s(r.get(2)),
        "argsFull": s(r.get(3)),
        "result": so(r.get(4)),
        "def": js::trim(&def),
        "comment": so(r.get(8)),
      })
    }).collect::<Vec<_>>(),
  }))
}

// ---- full data search (dataSearch.ts) ------------------------------------------------------

const SEARCH_MAX_PER_TABLE: f64 = 1000.0;
const SEARCH_CONCURRENCY: usize = 3;

pub struct SearchTable {
  pub schema: String,
  pub table: String,
  pub kind: &'static str,
  pub columns: Vec<String>,
}

impl SearchTable {
  pub fn to_value(&self) -> Value {
    json!({ "schema": self.schema, "table": self.table, "kind": self.kind, "columns": self.columns })
  }
}

pub async fn search_tables(cfg: &Cfg, db: Option<&str>, o: &Value) -> R<Vec<SearchTable>> {
  let kinds = if js::truthy(o.get("includeViews")) { "('r', 'p', 'm', 'v', 'f')" } else { "('r', 'p', 'm')" };
  let text_like = if js::truthy(o.get("allTypes")) { String::new() } else { "and (bt.typcategory = 'S' or bt.typname in ('json', 'jsonb', 'xml', 'uuid'))".into() };
  let sql = format!(
    "select n.nspname::text, c.relname::text, c.relkind::text, json_agg(a.attname::text order by a.attnum)::text\n       from pg_class c\n       join pg_namespace n on n.oid = c.relnamespace\n       join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped\n       join pg_type ty on ty.oid = a.atttypid\n       join pg_type bt on bt.oid = case when ty.typtype = 'd' then ty.typbasetype else ty.oid end\n      where c.relkind in {kinds} and not c.relispartition\n        and (cardinality($1::text[]) > 0 and n.nspname = any($1)\n             or cardinality($1::text[]) = 0 and n.nspname not in ('pg_catalog', 'information_schema', 'pg_toast') and n.nspname not like 'pg_temp_%' and n.nspname not like 'pg_toast_temp_%')\n        and has_table_privilege(c.oid, 'select')\n        {text_like}\n      group by n.nspname, c.relname, c.relkind\n      order by n.nspname, c.relname"
  );
  let r = rows(cfg, db, &sql, &[js::pg_param(o.get("schemas").unwrap_or(&Value::Null))]).await?;
  r.iter()
    .map(|x| {
      let k = x.get(2).map(Cell::js_string).unwrap_or_default();
      let cols: Vec<String> = serde_json::from_str::<Vec<Value>>(&x.get(3).map(Cell::js_string).unwrap_or_default())
        .map_err(|e| super::DbErr::new(e.to_string()))?
        .iter()
        .map(js::string)
        .collect();
      Ok(SearchTable {
        schema: x.first().map(Cell::js_string).unwrap_or_default(),
        table: x.get(1).map(Cell::js_string).unwrap_or_default(),
        kind: if k == "v" || k == "f" { "view" } else if k == "m" { "matview" } else { "table" },
        columns: cols,
      })
    })
    .collect()
}

fn like_escape(s: &str) -> String {
  let mut o = String::new();
  for c in s.chars() {
    if matches!(c, '\\' | '%' | '_') {
      o.push('\\');
    }
    o.push(c);
  }
  o
}

/// dataSearchSql.ts searchSql.
pub fn search_sql(t: &SearchTable, term: &str, mode: &str, case_sensitive: bool) -> String {
  let lit = |s: &str| literal(Kind::Postgres, Some(s));
  let cond = t
    .columns
    .iter()
    .map(|c| {
      let col = format!("{}::text", qi(c));
      if mode == "regex" {
        format!("{col} {} {}", if case_sensitive { "~" } else { "~*" }, lit(term))
      } else if mode == "exact" {
        if case_sensitive { format!("{col} = {}", lit(term)) } else { format!("lower({col}) = lower({})", lit(term)) }
      } else {
        format!("{col} {} {}", if case_sensitive { "like" } else { "ilike" }, lit(&format!("%{}%", like_escape(term))))
      }
    })
    .collect::<Vec<_>>()
    .join("\n   or ");
  format!("select *\n  from {}.{}\n where {cond}", qi(&t.schema), qi(&t.table))
}

struct SearchJob {
  cfg: Cfg,
  running: std::sync::Mutex<Vec<String>>,
}

fn active() -> std::sync::MutexGuard<'static, std::collections::HashMap<String, std::sync::Arc<SearchJob>>> {
  static A: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, std::sync::Arc<SearchJob>>>> = std::sync::OnceLock::new();
  A.get_or_init(Default::default).lock().unwrap_or_else(|e| e.into_inner())
}

fn is_active(id: &str, job: &std::sync::Arc<SearchJob>) -> bool {
  active().get(id).is_some_and(|j| std::sync::Arc::ptr_eq(j, job))
}

pub async fn run_search(cfg: &Cfg, db: Option<&str>, o: &Value, search_id: &str, progress: std::sync::Arc<dyn Fn(Value) + Send + Sync>) -> R<Value> {
  let term = o.get("term").map(js::string).filter(|_| js::truthy(o.get("term")));
  let Some(term) = term else { return super::err("Nothing to search for") };
  let job = std::sync::Arc::new(SearchJob { cfg: cfg.clone(), running: Default::default() });
  active().insert(search_id.to_string(), job.clone());
  let mode = o.get("mode").map(js::string).unwrap_or_default();
  let tables = async {
    if mode == "regex" {
      rows(cfg, db, "select '' ~ $1", &[Some(term.clone())]).await?;
    }
    search_tables(cfg, db, o).await
  }
  .await;
  let tables = match tables {
    Ok(t) => std::sync::Arc::new(t),
    Err(e) => {
      if is_active(search_id, &job) {
        active().remove(search_id);
      }
      return Err(e);
    }
  };
  let pt = o.get("perTable").and_then(Value::as_f64).map(f64::floor).filter(|f| *f != 0.0 && !f.is_nan()).unwrap_or(100.0);
  let per_table = pt.min(SEARCH_MAX_PER_TABLE).max(1.0) as usize;
  let timeout = o.get("timeoutMs").and_then(Value::as_f64);
  let case_sensitive = js::truthy(o.get("caseSensitive"));
  let next = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
  let done = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
  let mut workers = vec![];
  for _ in 0..SEARCH_CONCURRENCY.min(tables.len()) {
    let (tables, next, done, job, progress, cfg) = (tables.clone(), next.clone(), done.clone(), job.clone(), progress.clone(), cfg.clone());
    let (db, sid, term, mode) = (db.map(str::to_string), search_id.to_string(), term.clone(), mode.clone());
    workers.push(async move {
      loop {
        if !is_active(&sid, &job) {
          return;
        }
        let i = next.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        if i >= tables.len() {
          return;
        }
        let t = &tables[i];
        let sql = search_sql(t, &term, &mode, case_sensitive);
        let qid = format!("{sid}:{i}");
        job.running.lock().unwrap().push(qid.clone());
        let r = pg::query(&cfg, db.as_deref(), &sql, &pg::QOpts { limit: per_table, read_only: true, timeout_ms: timeout, query_id: Some(&qid) }).await;
        job.running.lock().unwrap().retain(|q| q != &qid);
        let hit = match r {
          Ok(res) if !res.rows.is_empty() => Some(json!({ "schema": t.schema, "table": t.table, "kind": t.kind, "sql": sql, "result": res })),
          Ok(_) => None,
          Err(e) => Some(json!({ "schema": t.schema, "table": t.table, "kind": t.kind, "sql": sql, "error": e.msg })),
        };
        if !is_active(&sid, &job) {
          return;
        }
        let d = done.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
        let mut p = Map::new();
        p.insert("done".into(), num(d as f64));
        p.insert("total".into(), num(tables.len() as f64));
        if let Some(h) = hit {
          p.insert("hit".into(), h);
        }
        progress(Value::Object(p));
      }
    });
  }
  futures_join_all(workers).await;
  let cancelled = !is_active(search_id, &job);
  if !cancelled {
    active().remove(search_id);
  }
  Ok(json!({ "total": tables.len(), "done": done.load(std::sync::atomic::Ordering::SeqCst), "cancelled": cancelled }))
}

async fn futures_join_all<F: std::future::Future<Output = ()>>(fs: Vec<F>) {
  let mut set: Vec<Option<std::pin::Pin<Box<F>>>> = fs.into_iter().map(|f| Some(Box::pin(f))).collect();
  // Poll them together: each worker awaits the network most of the time.
  std::future::poll_fn(|cx| {
    for slot in set.iter_mut() {
      if let Some(f) = slot {
        if f.as_mut().poll(cx).is_ready() {
          *slot = None;
        }
      }
    }
    if set.iter().any(Option::is_some) { std::task::Poll::Pending } else { std::task::Poll::Ready(()) }
  })
  .await
}

pub async fn cancel_search(search_id: &str) {
  let Some(job) = active().remove(search_id) else { return };
  let ids: Vec<String> = job.running.lock().unwrap().clone();
  for q in ids {
    let _ = pg::cancel(&job.cfg, &q).await;
  }
}
