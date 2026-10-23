import { pgRows } from './pg'
import { PRIVS } from './privs'
import type {
  ConnectionConfig,
  DefaultAcl,
  DefaultObjType,
  Grant,
  PolicyCommand,
  PrivInfo,
  PrivTarget,
  RlsInfo,
  RoleGrant,
  RoleInfo
} from './types'

// Catalog reads for roles, privileges, default privileges and RLS (PostgreSQL).

const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v))
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v))
const json = <T>(v: unknown, fallback: T): T => {
  try {
    return v === null || v === undefined ? fallback : (JSON.parse(String(v)) as T)
  } catch {
    return fallback
  }
}

/** A grantee oid as a name; 0 is PUBLIC. */
const GRANTEE = `case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee)::text end`
const REL_OID =
  '(select c.oid from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = $1 and c.relname = $2)'

export async function listRoles(cfg: ConnectionConfig): Promise<RoleInfo[]> {
  const rows = await pgRows(
    cfg,
    undefined,
    `select r.rolname::text, r.rolsuper, r.rolcanlogin, r.rolinherit, r.rolcreatedb, r.rolcreaterole,
            r.rolreplication, r.rolbypassrls, r.rolconnlimit, r.rolvaliduntil::text,
            shobj_description(r.oid, 'pg_authid'),
            coalesce((select json_agg(json_build_array(g.rolname, m.admin_option) order by g.rolname)
                      from pg_auth_members m join pg_roles g on g.oid = m.roleid where m.member = r.oid), '[]')::text
     from pg_roles r order by r.rolname`
  )
  return rows.map((r) => {
    // PG 16 keeps one membership row per grantor: merge them.
    const memberOf: RoleInfo['memberOf'] = []
    for (const [role, admin] of json<Array<[string, boolean]>>(r[11], [])) {
      const m = memberOf.find((x) => x.role === role)
      if (m) m.admin ||= admin
      else memberOf.push({ role, admin })
    }
    const until = strOrNull(r[9])
    return {
      name: str(r[0]),
      superuser: !!r[1],
      login: !!r[2],
      inherit: !!r[3],
      createDb: !!r[4],
      createRole: !!r[5],
      replication: !!r[6],
      bypassRls: !!r[7],
      connLimit: Number(r[8]),
      validUntil: until === 'infinity' ? null : until,
      comment: strOrNull(r[10]),
      memberOf,
      system: str(r[0]).startsWith('pg_')
    }
  })
}

/** The catalog row, ACL column, owner column and acldefault() code of each kind. */
function aclSource(t: PrivTarget): { from: string; params: unknown[] } {
  switch (t.kind) {
    case 'schema':
      return { from: `select nspacl acl, nspowner owner, 'n'::"char" code from pg_namespace where nspname = $1`, params: [t.name] }
    case 'database':
      return { from: `select datacl acl, datdba owner, 'd'::"char" code from pg_database where datname = $1`, params: [t.name] }
    case 'function':
    case 'procedure':
      return {
        from: `select proacl acl, proowner owner, 'f'::"char" code from pg_proc
               where oid = (select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                            where n.nspname = $1 and p.proname = $2 and pg_get_function_identity_arguments(p.oid) = $3 limit 1)`,
        params: [t.schema, t.name, t.args ?? '']
      }
    default:
      return {
        from: `select relacl acl, relowner owner, (case when relkind = 'S' then 's' else 'r' end)::"char" code from pg_class where oid = ${REL_OID}`,
        params: [t.schema, t.name]
      }
  }
}

export async function objectPrivileges(cfg: ConnectionConfig, db: string | undefined, t: PrivTarget): Promise<PrivInfo | null> {
  const src = aclSource(t)
  const rows = await pgRows(
    cfg,
    db,
    `select pg_get_userbyid(o.owner)::text, ${GRANTEE}, a.privilege_type::text, a.is_grantable,
            current_setting('server_version_num')::int
     from (${src.from}) o
     left join lateral aclexplode(coalesce(o.acl, acldefault(o.code, o.owner))) a on true`,
    src.params
  )
  if (!rows.length) return null
  const grants: Grant[] = rows.filter((r) => r[2] !== null).map((r) => ({ grantee: str(r[1]), privilege: str(r[2]), grantable: !!r[3] }))
  const available = [...PRIVS[t.kind]]
  if (t.kind === 'table' && Number(rows[0][4]) >= 170000) available.push('MAINTAIN')
  return { owner: str(rows[0][0]), grants, available }
}

const DEFACL_TYPE: Record<string, DefaultObjType> = { r: 'tables', S: 'sequences', f: 'functions', T: 'types', n: 'schemas' }

export async function defaultAcls(cfg: ConnectionConfig, db: string | undefined): Promise<DefaultAcl[]> {
  const rows = await pgRows(
    cfg,
    db,
    `select pg_get_userbyid(d.defaclrole)::text, n.nspname::text, d.defaclobjtype::text, ${GRANTEE}, a.privilege_type::text, a.is_grantable
     from pg_default_acl d left join pg_namespace n on n.oid = d.defaclnamespace
     cross join lateral aclexplode(d.defaclacl) a
     order by 1, 2 nulls first, 3, 4`
  )
  return rows
    .filter((r) => DEFACL_TYPE[str(r[2])])
    .map((r) => ({
      role: str(r[0]),
      schema: strOrNull(r[1]),
      objType: DEFACL_TYPE[str(r[2])],
      grantee: str(r[3]),
      privilege: str(r[4]),
      grantable: !!r[5]
    }))
}

const POLCMD: Record<string, PolicyCommand> = { '*': 'ALL', r: 'SELECT', a: 'INSERT', w: 'UPDATE', d: 'DELETE' }

export async function rlsInfo(cfg: ConnectionConfig, db: string | undefined, schema: string, table: string): Promise<RlsInfo | null> {
  const head = await pgRows(cfg, db, `select relrowsecurity, relforcerowsecurity from pg_class where oid = ${REL_OID}`, [schema, table])
  if (!head.length) return null
  const rows = await pgRows(
    cfg,
    db,
    `select p.polname::text, p.polcmd::text, p.polpermissive,
            coalesce((select json_agg(case when r = 0 then 'PUBLIC' else pg_get_userbyid(r)::text end) from unnest(p.polroles) r), '[]')::text,
            pg_get_expr(p.polqual, p.polrelid), pg_get_expr(p.polwithcheck, p.polrelid)
     from pg_policy p where p.polrelid = ${REL_OID} order by 1`,
    [schema, table]
  )
  return {
    enabled: !!head[0][0],
    forced: !!head[0][1],
    policies: rows.map((r) => ({
      name: str(r[0]),
      command: POLCMD[str(r[1])] ?? 'ALL',
      permissive: !!r[2],
      roles: json<string[]>(r[3], []),
      using: strOrNull(r[4]),
      check: strOrNull(r[5])
    }))
  }
}

const ROLE_GRANTS_LIMIT = 2000

/** Objects in `db` with privileges granted to `role` (or to PUBLIC), from explicit ACLs. */
export async function roleGrants(cfg: ConnectionConfig, db: string | undefined, role: string): Promise<RoleGrant[]> {
  const rows = await pgRows(
    cfg,
    db,
    `with r as (select oid from pg_roles where rolname = $1),
     x as (
       select (case c.relkind when 'r' then 'table' when 'p' then 'partitioned' when 'v' then 'view' when 'm' then 'matview'
                 when 'f' then 'foreign' else 'sequence' end) kind, n.nspname::text sch, c.relname::text nm, a.*
       from pg_class c join pg_namespace n on n.oid = c.relnamespace cross join lateral aclexplode(c.relacl) a
       where c.relkind in ('r','p','v','m','f','S') and not c.relispartition
         and n.nspname not in ('pg_catalog', 'information_schema') and n.nspname not like 'pg_toast%'
       union all
       select 'schema', '', n.nspname::text, a.* from pg_namespace n cross join lateral aclexplode(n.nspacl) a
       where n.nspname not in ('pg_catalog', 'information_schema') and n.nspname not like 'pg_toast%'
       union all
       select (case p.prokind when 'p' then 'procedure' else 'function' end), n.nspname::text,
              p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', a.*
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace cross join lateral aclexplode(p.proacl) a
       where n.nspname not in ('pg_catalog', 'information_schema')
       union all
       select 'database', '', d.datname::text, a.* from pg_database d cross join lateral aclexplode(d.datacl) a
       where d.datname = current_database()
     )
     select kind, sch, nm, json_agg(privilege_type order by privilege_type)::text,
            coalesce(json_agg(privilege_type) filter (where is_grantable), '[]')::text, grantee = 0
     from x where grantee = (select oid from r) or grantee = 0
     group by kind, sch, nm, grantee = 0
     order by (kind = 'database') desc, (kind = 'schema') desc, sch, nm
     limit ${ROLE_GRANTS_LIMIT}`,
    [role]
  )
  return rows.map((r) => ({
    kind: str(r[0]) as RoleGrant['kind'],
    schema: str(r[1]),
    name: str(r[2]),
    privileges: json<string[]>(r[3], []),
    grantable: json<string[]>(r[4], []),
    viaPublic: !!r[5]
  }))
}
