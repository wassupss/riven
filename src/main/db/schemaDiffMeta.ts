import { pgReadIn } from './pg'
import type { SchemaSnapshot, SnapColumn, SnapConstraint, SnapNamedDef, SnapTable, SnapView } from './schemaDiff'
import type { ConnectionConfig } from './types'

// Reads one schema for comparison. Everything is printed with the schema as
// the only search_path entry, so same-schema references come out bare.
// Objects that belong to extensions are left out; so are partitions.

const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v))
const opt = (v: unknown): string | null => (v === null || v === undefined ? null : String(v))
const list = (v: unknown): string[] => {
  try {
    const a: unknown = typeof v === 'string' ? JSON.parse(v) : v
    return Array.isArray(a) ? a.map(String) : []
  } catch {
    return []
  }
}
const notExt = (cls: string, oid: string): string =>
  `not exists (select 1 from pg_depend x where x.classid = '${cls}'::regclass and x.objid = ${oid} and x.deptype = 'e')`

export function schemaSnapshot(cfg: ConnectionConfig, db: string | undefined, schema: string): Promise<SchemaSnapshot> {
  return pgReadIn(cfg, db, schema, async (q) => {
    const rels = await q(
      `select c.oid::int, c.relname::text, c.relkind::text, c.relpersistence::text,
              case when c.relkind = 'p' then pg_get_partkeydef(c.oid) end,
              case when c.relkind in ('v', 'm') then pg_get_viewdef(c.oid, true) end,
              obj_description(c.oid, 'pg_class')
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = $1 and c.relkind in ('r', 'p', 'v', 'm') and not c.relispartition and ${notExt('pg_class', 'c.oid')}
        order by c.oid`,
      [schema]
    )
    const cols = await q(
      `select a.attrelid::int, a.attname::text, format_type(a.atttypid, a.atttypmod), a.attnotnull,
              a.attidentity::text, a.attgenerated::text, pg_get_expr(d.adbin, d.adrelid, true), col_description(a.attrelid, a.attnum)
         from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
         left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
        where n.nspname = $1 and c.relkind in ('r', 'p', 'v', 'm') and a.attnum > 0 and not a.attisdropped
        order by a.attrelid, a.attnum`,
      [schema]
    )
    const cons = await q(
      `select k.conrelid::int, k.conname::text, k.contype::text, pg_get_constraintdef(k.oid, true)
         from pg_constraint k join pg_class c on c.oid = k.conrelid join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = $1 and k.contype in ('p', 'u', 'c', 'f', 'x')`,
      [schema]
    )
    const idx = await q(
      `select i.indrelid::int, ic.relname::text, pg_get_indexdef(i.indexrelid, 0, true)
         from pg_index i join pg_class ic on ic.oid = i.indexrelid join pg_namespace n on n.oid = ic.relnamespace
        where n.nspname = $1
          and not exists (select 1 from pg_constraint k where k.conindid = i.indexrelid and k.conrelid = i.indrelid and k.contype in ('p', 'u', 'x'))`,
      [schema]
    )
    const trg = await q(
      `select t.tgrelid::int, t.tgname::text, pg_get_triggerdef(t.oid, true)
         from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = $1 and not t.tgisinternal`,
      [schema]
    )
    const seqs = await q(
      `select c.relname::text, format_type(s.seqtypid, null), s.seqstart::text, s.seqincrement::text, s.seqmin::text,
              s.seqmax::text, s.seqcache::text, s.seqcycle,
              (select quote_ident(tc.relname) || '.' || quote_ident(a.attname)
                 from pg_depend d join pg_class tc on tc.oid = d.refobjid
                 join pg_attribute a on a.attrelid = d.refobjid and a.attnum = d.refobjsubid
                where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.refclassid = 'pg_class'::regclass and d.deptype = 'a' limit 1)
         from pg_sequence s join pg_class c on c.oid = s.seqrelid join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = $1 and ${notExt('pg_class', 'c.oid')}
          and not exists (select 1 from pg_depend d where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'i')
        order by c.relname`,
      [schema]
    )
    const enums = await q(
      `select t.typname::text, (select json_agg(e.enumlabel::text order by e.enumsortorder)::text from pg_enum e where e.enumtypid = t.oid),
              obj_description(t.oid, 'pg_type')
         from pg_type t join pg_namespace n on n.oid = t.typnamespace
        where n.nspname = $1 and t.typtype = 'e' and ${notExt('pg_type', 't.oid')}
        order by t.typname`,
      [schema]
    )
    const procs = await q(
      `select p.proname::text, p.prokind::text, pg_get_function_identity_arguments(p.oid), pg_get_function_arguments(p.oid),
              case when p.prokind = 'f' then pg_get_function_result(p.oid) end, pg_get_functiondef(p.oid),
              quote_ident(n.nspname) || '.' || quote_ident(p.proname), quote_ident(p.proname), obj_description(p.oid, 'pg_proc')
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = $1 and p.prokind in ('f', 'p') and ${notExt('pg_proc', 'p.oid')}
        order by p.proname, p.oid`,
      [schema]
    )

    const colsOf = new Map<number, SnapColumn[]>()
    for (const [rel, name, type, notNull, identity, generated, def, comment] of cols) {
      const a = colsOf.get(Number(rel)) ?? []
      const gen = str(generated) === 's'
      a.push({
        name: str(name),
        type: str(type),
        notNull: notNull === true,
        default: gen ? null : opt(def),
        identity: (str(identity) as SnapColumn['identity']) || '',
        generated: gen ? str(def) : null,
        comment: opt(comment)
      })
      colsOf.set(Number(rel), a)
    }
    const group = <T>(rows: unknown[][], make: (r: unknown[]) => T): Map<number, T[]> => {
      const m = new Map<number, T[]>()
      for (const r of rows) {
        const a = m.get(Number(r[0])) ?? []
        a.push(make(r))
        m.set(Number(r[0]), a)
      }
      return m
    }
    const named = (r: unknown[]): SnapNamedDef => ({ name: str(r[1]), def: str(r[2]) })
    const consOf = group<SnapConstraint>(cons, (r) => ({ name: str(r[1]), type: str(r[2]), def: str(r[3]) }))
    const idxOf = group(idx, named)
    const trgOf = group(trg, named)

    const tables: SnapTable[] = []
    const views: SnapView[] = []
    for (const [oid, name, kind, persistence, partKey, viewDef, comment] of rels) {
      const id = Number(oid)
      const k = str(kind)
      if (k === 'v' || k === 'm')
        views.push({
          name: str(name),
          materialized: k === 'm',
          def: str(viewDef).trim(),
          columns: (colsOf.get(id) ?? []).map((c) => ({ name: c.name, type: c.type })),
          indexes: idxOf.get(id) ?? [],
          comment: opt(comment),
          order: id
        })
      else
        tables.push({
          name: str(name),
          partitioned: k === 'p',
          unlogged: str(persistence) === 'u',
          partKey: opt(partKey),
          columns: colsOf.get(id) ?? [],
          constraints: consOf.get(id) ?? [],
          indexes: idxOf.get(id) ?? [],
          triggers: trgOf.get(id) ?? [],
          comment: opt(comment)
        })
    }
    tables.sort((a, b) => a.name.localeCompare(b.name))

    return {
      schema,
      tables,
      views,
      sequences: seqs.map(([name, type, start, inc, min, max, cache, cycle, owned]) => ({
        name: str(name),
        type: str(type),
        start: str(start),
        increment: str(inc),
        min: str(min),
        max: str(max),
        cache: str(cache),
        cycle: cycle === true,
        ownedBy: opt(owned)
      })),
      enums: enums.map(([name, labels, comment]) => ({ name: str(name), labels: list(labels), comment: opt(comment) })),
      routines: procs.map(([name, kind, args, argsFull, result, def, qualified, bare, comment]) => ({
        name: str(name),
        procedure: str(kind) === 'p',
        args: str(args),
        argsFull: str(argsFull),
        result: opt(result),
        // The header always names the schema; drop it so both sides compare.
        def: str(def).replace(`${str(qualified)}(`, `${str(bare)}(`).trim(),
        comment: opt(comment)
      }))
    }
  })
}
