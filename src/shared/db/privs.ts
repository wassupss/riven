import { literal, quoteIdent } from './sqlText'
import { qualify, type DdlPlan } from './ddl'
import type { DefaultAcl, DefaultObjType, Grant, PolicyCommand, PolicyInfo, PrivKind, PrivTarget, RoleInfo } from './types'

// Builders for roles, GRANT/REVOKE, default privileges and row-level security.
// Pure functions shared with the renderer (preview) and main (apply). PostgreSQL syntax.

const qi = (s: string): string => quoteIdent('postgres', s)
const lit = (s: string): string => literal('postgres', s)

/** Role specs that are keywords, not names. */
const ROLE_KEYWORDS = ['PUBLIC', 'CURRENT_USER', 'CURRENT_ROLE', 'SESSION_USER']
export const roleSpec = (r: string): string => (ROLE_KEYWORDS.includes(r.toUpperCase()) ? r.toUpperCase() : qi(r))

// ---- roles ------------------------------------------------------------------

export interface RoleDraft {
  name: string
  login: boolean
  superuser: boolean
  inherit: boolean
  createDb: boolean
  createRole: boolean
  replication: boolean
  bypassRls: boolean
  /** Empty: no limit. */
  connLimit: string
  /** Empty: never expires. */
  validUntil: string
  /** Empty: keep (or, for a new role, none). */
  password: string
  clearPassword: boolean
  comment: string
  memberOf: Array<{ role: string; admin: boolean }>
  /** Roles that are members of this one. */
  members: Array<{ role: string; admin: boolean }>
}

export const ROLE_FLAGS = ['login', 'superuser', 'inherit', 'createDb', 'createRole', 'replication', 'bypassRls'] as const
type Flag = (typeof ROLE_FLAGS)[number]
const FLAG_SQL: Record<Flag, string> = {
  login: 'LOGIN',
  superuser: 'SUPERUSER',
  inherit: 'INHERIT',
  createDb: 'CREATEDB',
  createRole: 'CREATEROLE',
  replication: 'REPLICATION',
  bypassRls: 'BYPASSRLS'
}

export const newRole = (): RoleDraft => ({
  name: '',
  login: true,
  superuser: false,
  inherit: true,
  createDb: false,
  createRole: false,
  replication: false,
  bypassRls: false,
  connLimit: '',
  validUntil: '',
  password: '',
  clearPassword: false,
  comment: '',
  memberOf: [],
  members: []
})

/** Who is a member of `name`, read off every role's memberOf. */
export const membersOf = (roles: RoleInfo[], name: string): Array<{ role: string; admin: boolean }> =>
  roles.flatMap((r) => r.memberOf.filter((m) => m.role === name).map((m) => ({ role: r.name, admin: m.admin })))

export function roleDraft(r: RoleInfo, roles: RoleInfo[]): RoleDraft {
  return {
    name: r.name,
    login: r.login,
    superuser: r.superuser,
    inherit: r.inherit,
    createDb: r.createDb,
    createRole: r.createRole,
    replication: r.replication,
    bypassRls: r.bypassRls,
    connLimit: r.connLimit < 0 ? '' : String(r.connLimit),
    validUntil: r.validUntil ?? '',
    password: '',
    clearPassword: false,
    comment: r.comment ?? '',
    memberOf: r.memberOf.map((m) => ({ ...m })),
    members: membersOf(roles, r.name)
  }
}

export function roleProblems(d: RoleDraft): string[] {
  const out: string[] = []
  if (!d.name.trim()) out.push('db.r.err.name')
  if (d.connLimit.trim() && !/^-?\d+$/.test(d.connLimit.trim())) out.push('db.r.err.connLimit')
  const self = d.memberOf.some((m) => m.role === d.name) || d.members.some((m) => m.role === d.name)
  if (self) out.push('db.r.err.self')
  return out
}

function membership(d: RoleDraft, name: string, before: RoleDraft | null): string[] {
  const out: string[] = []
  const diff = (
    was: Array<{ role: string; admin: boolean }>,
    now: Array<{ role: string; admin: boolean }>,
    grant: (r: string) => string,
    revoke: (r: string, adminOnly: boolean) => string
  ): void => {
    for (const w of was) {
      const n = now.find((x) => x.role === w.role)
      if (!n) out.push(revoke(w.role, false))
      else if (w.admin && !n.admin) out.push(revoke(w.role, true))
    }
    for (const n of now) {
      const w = was.find((x) => x.role === n.role)
      if (!w || (n.admin && !w.admin)) out.push(grant(n.role) + (n.admin ? ' WITH ADMIN OPTION' : ''))
    }
  }
  diff(
    before?.memberOf ?? [],
    d.memberOf.filter((m) => m.role),
    (r) => `GRANT ${qi(r)} TO ${qi(name)}`,
    (r, a) => `REVOKE ${a ? 'ADMIN OPTION FOR ' : ''}${qi(r)} FROM ${qi(name)}`
  )
  diff(
    before?.members ?? [],
    d.members.filter((m) => m.role),
    (r) => `GRANT ${qi(name)} TO ${qi(r)}`,
    (r, a) => `REVOKE ${a ? 'ADMIN OPTION FOR ' : ''}${qi(name)} FROM ${qi(r)}`
  )
  return out
}

const connLimit = (s: string): number => (s.trim() ? Number(s.trim()) : -1)

export function createRoleSql(d: RoleDraft): DdlPlan {
  const opts: string[] = []
  for (const f of ROLE_FLAGS) {
    if (f === 'inherit') {
      if (!d.inherit) opts.push('NOINHERIT')
    } else if (d[f]) opts.push(FLAG_SQL[f])
  }
  if (connLimit(d.connLimit) >= 0) opts.push(`CONNECTION LIMIT ${connLimit(d.connLimit)}`)
  if (d.validUntil.trim()) opts.push(`VALID UNTIL ${lit(d.validUntil.trim())}`)
  if (d.password) opts.push(`PASSWORD ${lit(d.password)}`)
  const name = d.name.trim()
  const stmts = [`CREATE ROLE ${qi(name)}${opts.length ? ' WITH ' + opts.join(' ') : ''}`, ...membership(d, name, null)]
  if (d.comment.trim()) stmts.push(`COMMENT ON ROLE ${qi(name)} IS ${lit(d.comment)}`)
  return { stmts, atomic: true, secret: d.password ? [lit(d.password)] : undefined }
}

export function alterRoleSql(orig: RoleDraft, d: RoleDraft): DdlPlan {
  const name = orig.name
  const opts: string[] = []
  for (const f of ROLE_FLAGS) if (d[f] !== orig[f]) opts.push(d[f] ? FLAG_SQL[f] : 'NO' + FLAG_SQL[f])
  if (connLimit(d.connLimit) !== connLimit(orig.connLimit)) opts.push(`CONNECTION LIMIT ${connLimit(d.connLimit)}`)
  if (d.validUntil.trim() !== orig.validUntil.trim()) opts.push(`VALID UNTIL ${lit(d.validUntil.trim() || 'infinity')}`)
  if (d.password) opts.push(`PASSWORD ${lit(d.password)}`)
  else if (d.clearPassword) opts.push('PASSWORD NULL')
  const stmts: string[] = []
  if (opts.length) stmts.push(`ALTER ROLE ${qi(name)} WITH ${opts.join(' ')}`)
  stmts.push(...membership(d, name, orig))
  if (d.comment.trim() !== orig.comment.trim()) stmts.push(`COMMENT ON ROLE ${qi(name)} IS ${d.comment.trim() ? lit(d.comment) : 'NULL'}`)
  const to = d.name.trim()
  if (to && to !== name) stmts.push(`ALTER ROLE ${qi(name)} RENAME TO ${qi(to)}`)
  return { stmts, atomic: true, secret: d.password ? [lit(d.password)] : undefined }
}

/** Drops a role; first hands what it owns (in this database) to `reassignTo` and drops its grants here. */
export function dropRoleSql(name: string, o: { reassignTo?: string; dropOwned?: boolean } = {}): DdlPlan {
  const stmts: string[] = []
  if (o.reassignTo) stmts.push(`REASSIGN OWNED BY ${qi(name)} TO ${roleSpec(o.reassignTo)}`)
  if (o.dropOwned) stmts.push(`DROP OWNED BY ${qi(name)}`)
  stmts.push(`DROP ROLE ${qi(name)}`)
  return { stmts, atomic: true }
}

// ---- GRANT / REVOKE ---------------------------------------------------------

/** Privileges by kind, in the order the matrix shows them. MAINTAIN (PG 17+) comes from the server. */
export const PRIVS: Record<PrivKind, string[]> = {
  table: ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'],
  sequence: ['USAGE', 'SELECT', 'UPDATE'],
  schema: ['USAGE', 'CREATE'],
  database: ['CONNECT', 'CREATE', 'TEMPORARY'],
  function: ['EXECUTE'],
  procedure: ['EXECUTE']
}

/** The kind GRANT uses for an explorer object kind, or null when it has no privileges of its own. */
export function privKindOf(k: string): PrivKind | null {
  if (['table', 'partitioned', 'view', 'matview', 'foreign'].includes(k)) return 'table'
  if (k === 'sequence' || k === 'schema' || k === 'database' || k === 'procedure') return k
  if (k === 'function' || k === 'aggregate' || k === 'window') return 'function'
  return null
}

export function targetSql(t: PrivTarget): string {
  switch (t.kind) {
    case 'schema':
      return `SCHEMA ${qi(t.name)}`
    case 'database':
      return `DATABASE ${qi(t.name)}`
    case 'function':
    case 'procedure':
      return `${t.kind.toUpperCase()} ${qualify(t.schema, t.name)}(${t.args ?? ''})`
    default:
      return `${t.kind.toUpperCase()} ${qualify(t.schema, t.name)}`
  }
}

/** grantee -> privilege -> grantable. Duplicates (several grantors) merge. */
export type GrantMap = Map<string, Map<string, boolean>>

export function grantMap(grants: Grant[]): GrantMap {
  const m: GrantMap = new Map()
  for (const g of grants) {
    const row = m.get(g.grantee) ?? new Map<string, boolean>()
    row.set(g.privilege, (row.get(g.privilege) ?? false) || g.grantable)
    m.set(g.grantee, row)
  }
  return m
}

export function grantList(m: GrantMap): Grant[] {
  return [...m].flatMap(([grantee, row]) => [...row].map(([privilege, grantable]) => ({ grantee, privilege, grantable })))
}

const ORDER = [...new Set(Object.values(PRIVS).flat().concat('MAINTAIN'))]
const byOrder = (a: string, b: string): number => ORDER.indexOf(a) - ORDER.indexOf(b)

/**
 * The GRANT/REVOKE statements that turn `before` into `after` on one object.
 * `on` is the object clause ("TABLE public.t"), or the default-privileges form.
 */
function grantStmts(
  before: GrantMap,
  after: GrantMap,
  grant: (privs: string, grantee: string, option: boolean) => string,
  revoke: (privs: string, grantee: string, optionOnly: boolean) => string
): string[] {
  const out: string[] = []
  const grantees = [...new Set([...before.keys(), ...after.keys()])]
  for (const g of grantees) {
    const was = before.get(g) ?? new Map<string, boolean>()
    const now = after.get(g) ?? new Map<string, boolean>()
    const gone = [...was.keys()].filter((p) => !now.has(p)).sort(byOrder)
    const demoted = [...was.keys()].filter((p) => now.has(p) && was.get(p) && !now.get(p)).sort(byOrder)
    const plain = [...now.keys()].filter((p) => !was.has(p) && !now.get(p)).sort(byOrder)
    const option = [...now.keys()].filter((p) => now.get(p) && !was.get(p)).sort(byOrder)
    const spec = roleSpec(g)
    if (gone.length) out.push(revoke(gone.join(', '), spec, false))
    if (demoted.length) out.push(revoke(demoted.join(', '), spec, true))
    if (plain.length) out.push(grant(plain.join(', '), spec, false))
    if (option.length) out.push(grant(option.join(', '), spec, true))
  }
  return out
}

export function grantsSql(target: PrivTarget, before: Grant[], after: Grant[], o: { cascade?: boolean } = {}): DdlPlan {
  const on = targetSql(target)
  const cascade = o.cascade ? ' CASCADE' : ''
  return {
    stmts: grantStmts(
      grantMap(before),
      grantMap(after),
      (p, g, opt) => `GRANT ${p} ON ${on} TO ${g}${opt ? ' WITH GRANT OPTION' : ''}`,
      (p, g, opt) => `REVOKE ${opt ? 'GRANT OPTION FOR ' : ''}${p} ON ${on} FROM ${g}${cascade}`
    ),
    atomic: true
  }
}

// ---- default privileges -----------------------------------------------------

export const DEFAULT_PRIVS: Record<DefaultObjType, string[]> = {
  tables: PRIVS.table,
  sequences: PRIVS.sequence,
  functions: ['EXECUTE'],
  types: ['USAGE'],
  schemas: ['USAGE', 'CREATE']
}
export const DEFAULT_OBJ_TYPES = Object.keys(DEFAULT_PRIVS) as DefaultObjType[]

/** Default ACL entries grouped per (role, schema, object type, grantee). */
export interface DefaultRule {
  role: string
  schema: string | null
  objType: DefaultObjType
  grantee: string
  privileges: string[]
  /** The subset held WITH GRANT OPTION. */
  grantable: string[]
}

export const ruleKey = (r: Pick<DefaultRule, 'role' | 'schema' | 'objType' | 'grantee'>): string =>
  JSON.stringify([r.role, r.schema, r.objType, r.grantee])

export function defaultRules(acl: DefaultAcl[]): DefaultRule[] {
  const m = new Map<string, DefaultRule>()
  for (const a of acl) {
    const k = ruleKey(a)
    const r = m.get(k) ?? { role: a.role, schema: a.schema, objType: a.objType, grantee: a.grantee, privileges: [], grantable: [] }
    if (!r.privileges.includes(a.privilege)) r.privileges.push(a.privilege)
    if (a.grantable && !r.grantable.includes(a.privilege)) r.grantable.push(a.privilege)
    m.set(k, r)
  }
  for (const r of m.values()) r.privileges.sort(byOrder)
  return [...m.values()]
}

/** Changes one default rule from `before` (null: none yet) to `after` (null: remove it). */
export function defaultRuleSql(before: DefaultRule | null, after: DefaultRule | null): DdlPlan {
  const r = after ?? before
  if (!r) return { stmts: [], atomic: true }
  const head = `ALTER DEFAULT PRIVILEGES FOR ROLE ${qi(r.role)}${r.schema && r.objType !== 'schemas' ? ` IN SCHEMA ${qi(r.schema)}` : ''}`
  const on = r.objType.toUpperCase()
  const toMap = (x: DefaultRule | null): GrantMap =>
    x ? new Map([[x.grantee, new Map(x.privileges.map((p) => [p, x.grantable.includes(p)]))]]) : new Map()
  return {
    stmts: grantStmts(
      toMap(before),
      toMap(after),
      (p, g, opt) => `${head} GRANT ${p} ON ${on} TO ${g}${opt ? ' WITH GRANT OPTION' : ''}`,
      (p, g, opt) => `${head} REVOKE ${opt ? 'GRANT OPTION FOR ' : ''}${p} ON ${on} FROM ${g}`
    ),
    atomic: true
  }
}

// ---- row-level security -----------------------------------------------------

export const POLICY_COMMANDS: PolicyCommand[] = ['ALL', 'SELECT', 'INSERT', 'UPDATE', 'DELETE']

export interface PolicyDraft {
  name: string
  command: PolicyCommand
  permissive: boolean
  /** Comma-separated; empty means PUBLIC. */
  roles: string
  using: string
  check: string
}

export const newPolicy = (): PolicyDraft => ({ name: '', command: 'ALL', permissive: true, roles: '', using: '', check: '' })

export const policyDraft = (p: PolicyInfo): PolicyDraft => ({
  name: p.name,
  command: p.command,
  permissive: p.permissive,
  roles: p.roles.join(', '),
  using: p.using ?? '',
  check: p.check ?? ''
})

const roleList = (s: string): string[] =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)

export function policyProblems(d: PolicyDraft): string[] {
  const out: string[] = []
  if (!d.name.trim()) out.push('db.r.err.policyName')
  if (d.check.trim() && (d.command === 'SELECT' || d.command === 'DELETE')) out.push('db.r.err.noCheck')
  if (d.using.trim() && d.command === 'INSERT') out.push('db.r.err.noUsing')
  if (!d.using.trim() && !d.check.trim()) out.push('db.r.err.policyExpr')
  return out
}

const stripSemi = (s: string): string => s.trim().replace(/;+\s*$/, '')

export function createPolicyStmt(schema: string, table: string, d: PolicyDraft): string {
  const roles = roleList(d.roles)
  let s = `CREATE POLICY ${qi(d.name.trim())} ON ${qualify(schema, table)}`
  if (!d.permissive) s += ' AS RESTRICTIVE'
  if (d.command !== 'ALL') s += ` FOR ${d.command}`
  if (roles.length && !(roles.length === 1 && roles[0].toUpperCase() === 'PUBLIC')) s += ` TO ${roles.map(roleSpec).join(', ')}`
  if (d.using.trim()) s += ` USING (${stripSemi(d.using)})`
  if (d.check.trim()) s += ` WITH CHECK (${stripSemi(d.check)})`
  return s
}

/** Creates a policy, or replaces `orig` with it (renamed in place when that's all that changed). */
export function policySql(schema: string, table: string, d: PolicyDraft, orig?: PolicyDraft): DdlPlan {
  if (!orig) return { stmts: [createPolicyStmt(schema, table, d)], atomic: true }
  const on = qualify(schema, table)
  const same = (a: PolicyDraft, b: PolicyDraft): boolean =>
    a.command === b.command &&
    a.permissive === b.permissive &&
    roleList(a.roles).join() === roleList(b.roles).join() &&
    stripSemi(a.using) === stripSemi(b.using) &&
    stripSemi(a.check) === stripSemi(b.check)
  const to = d.name.trim()
  if (same(orig, d))
    return { stmts: to !== orig.name ? [`ALTER POLICY ${qi(orig.name)} ON ${on} RENAME TO ${qi(to)}`] : [], atomic: true }
  return { stmts: [dropPolicyStmt(schema, table, orig.name), createPolicyStmt(schema, table, d)], atomic: true }
}

export const dropPolicyStmt = (schema: string, table: string, name: string): string =>
  `DROP POLICY ${qi(name)} ON ${qualify(schema, table)}`

export function rlsSql(schema: string, table: string, was: { enabled: boolean; forced: boolean }, now: { enabled: boolean; forced: boolean }): DdlPlan {
  const on = `ALTER TABLE ${qualify(schema, table)}`
  const stmts: string[] = []
  if (was.enabled !== now.enabled) stmts.push(`${on} ${now.enabled ? 'ENABLE' : 'DISABLE'} ROW LEVEL SECURITY`)
  if (was.forced !== now.forced) stmts.push(`${on} ${now.forced ? 'FORCE' : 'NO FORCE'} ROW LEVEL SECURITY`)
  return { stmts, atomic: true }
}
