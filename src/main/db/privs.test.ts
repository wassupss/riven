import { describe, expect, it } from 'vitest'
import { planText } from './ddl'
import {
  alterRoleSql,
  createRoleSql,
  defaultRuleSql,
  defaultRules,
  dropRoleSql,
  grantsSql,
  membersOf,
  newPolicy,
  newRole,
  policyProblems,
  policySql,
  privKindOf,
  rlsSql,
  roleDraft,
  targetSql
} from './privs'
import type { RoleInfo } from './types'

const role = (name: string, memberOf: RoleInfo['memberOf'] = []): RoleInfo => ({
  name,
  superuser: false,
  login: true,
  inherit: true,
  createDb: false,
  createRole: false,
  replication: false,
  bypassRls: false,
  connLimit: -1,
  validUntil: null,
  comment: null,
  memberOf,
  system: false
})

describe('roles', () => {
  it('creates with only the non-default options and masks the password', () => {
    const d = { ...newRole(), name: 'App User', createDb: true, inherit: false, connLimit: '5', password: "p'w" }
    d.memberOf.push({ role: 'readers', admin: true })
    d.members.push({ role: 'bob', admin: false })
    d.comment = 'svc'
    const plan = createRoleSql(d)
    expect(plan.stmts).toEqual([
      `CREATE ROLE "App User" WITH LOGIN NOINHERIT CREATEDB CONNECTION LIMIT 5 PASSWORD 'p''w'`,
      'GRANT readers TO "App User" WITH ADMIN OPTION',
      'GRANT "App User" TO bob',
      `COMMENT ON ROLE "App User" IS 'svc'`
    ])
    expect(planText(plan)).toContain("PASSWORD '********'")
    expect(planText(plan)).not.toContain('p\'\'w')
  })
  it('alters flags, membership and comment, then renames', () => {
    const roles = [role('app', [{ role: 'readers', admin: true }, { role: 'old', admin: false }]), role('bob', [{ role: 'app', admin: false }])]
    const orig = roleDraft(roles[0], roles)
    expect(orig.members).toEqual([{ role: 'bob', admin: false }])
    const d = roleDraft(roles[0], roles)
    d.name = 'svc'
    d.login = false
    d.superuser = true
    d.validUntil = ''
    d.clearPassword = true
    d.memberOf = [{ role: 'readers', admin: false }, { role: 'writers', admin: false }]
    d.members = [{ role: 'bob', admin: true }]
    d.comment = 'x'
    expect(alterRoleSql(orig, d).stmts).toEqual([
      'ALTER ROLE app WITH NOLOGIN SUPERUSER PASSWORD NULL',
      'REVOKE ADMIN OPTION FOR readers FROM app',
      'REVOKE old FROM app',
      'GRANT writers TO app',
      'GRANT app TO bob WITH ADMIN OPTION',
      "COMMENT ON ROLE app IS 'x'",
      'ALTER ROLE app RENAME TO svc'
    ])
    expect(alterRoleSql(orig, roleDraft(roles[0], roles)).stmts).toEqual([])
  })
  it('clears an expiry with infinity and drops with reassignment', () => {
    const r = { ...role('a'), validUntil: '2030-01-01' }
    const d = roleDraft(r, [r])
    d.validUntil = ''
    expect(alterRoleSql(roleDraft(r, [r]), d).stmts).toEqual([`ALTER ROLE a WITH VALID UNTIL 'infinity'`])
    expect(dropRoleSql('a', { reassignTo: 'postgres', dropOwned: true }).stmts).toEqual([
      'REASSIGN OWNED BY a TO postgres',
      'DROP OWNED BY a',
      'DROP ROLE a'
    ])
    expect(membersOf([role('x', [{ role: 'a', admin: true }])], 'a')).toEqual([{ role: 'x', admin: true }])
  })
})

describe('grants', () => {
  it('names the target per kind', () => {
    expect(targetSql({ kind: 'table', schema: 'public', name: 'T' })).toBe('TABLE public."T"')
    expect(targetSql({ kind: 'function', schema: 's', name: 'f', args: 'integer' })).toBe('FUNCTION s.f(integer)')
    expect(targetSql({ kind: 'database', schema: '', name: 'shop' })).toBe('DATABASE shop')
    expect(privKindOf('matview')).toBe('table')
    expect(privKindOf('aggregate')).toBe('function')
  })
  it('diffs grants, grant options and PUBLIC', () => {
    const target = { kind: 'table' as const, schema: 'public', name: 't' }
    const before = [
      { grantee: 'bob', privilege: 'SELECT', grantable: true },
      { grantee: 'bob', privilege: 'INSERT', grantable: false },
      { grantee: 'PUBLIC', privilege: 'SELECT', grantable: false }
    ]
    const after = [
      { grantee: 'bob', privilege: 'SELECT', grantable: false },
      { grantee: 'bob', privilege: 'UPDATE', grantable: false },
      { grantee: 'bob', privilege: 'DELETE', grantable: true },
      { grantee: 'Ann', privilege: 'SELECT', grantable: false }
    ]
    expect(grantsSql(target, before, after, { cascade: true }).stmts).toEqual([
      'REVOKE INSERT ON TABLE public.t FROM bob CASCADE',
      'REVOKE GRANT OPTION FOR SELECT ON TABLE public.t FROM bob CASCADE',
      'GRANT UPDATE ON TABLE public.t TO bob',
      'GRANT DELETE ON TABLE public.t TO bob WITH GRANT OPTION',
      'REVOKE SELECT ON TABLE public.t FROM PUBLIC CASCADE',
      'GRANT SELECT ON TABLE public.t TO "Ann"'
    ])
    expect(grantsSql(target, before, before).stmts).toEqual([])
  })
})

describe('default privileges', () => {
  it('groups entries into rules and diffs one', () => {
    const rules = defaultRules([
      { role: 'app', schema: 'public', objType: 'tables', grantee: 'ro', privilege: 'SELECT', grantable: false },
      { role: 'app', schema: 'public', objType: 'tables', grantee: 'rw', privilege: 'UPDATE', grantable: true },
      { role: 'app', schema: 'public', objType: 'tables', grantee: 'rw', privilege: 'INSERT', grantable: false }
    ])
    expect(rules.map((r) => [r.grantee, r.privileges, r.grantable])).toEqual([
      ['ro', ['SELECT'], []],
      ['rw', ['INSERT', 'UPDATE'], ['UPDATE']]
    ])
    expect(defaultRuleSql(null, { ...rules[0], privileges: ['SELECT', 'INSERT'] }).stmts).toEqual([
      'ALTER DEFAULT PRIVILEGES FOR ROLE app IN SCHEMA public GRANT SELECT, INSERT ON TABLES TO ro'
    ])
    expect(defaultRuleSql(rules[1], null).stmts).toEqual([
      'ALTER DEFAULT PRIVILEGES FOR ROLE app IN SCHEMA public REVOKE INSERT, UPDATE ON TABLES FROM rw'
    ])
    expect(defaultRuleSql(null, { role: 'a', schema: null, objType: 'functions', grantee: 'PUBLIC', privileges: ['EXECUTE'], grantable: [] }).stmts).toEqual([
      'ALTER DEFAULT PRIVILEGES FOR ROLE a GRANT EXECUTE ON FUNCTIONS TO PUBLIC'
    ])
  })
})

describe('row-level security', () => {
  it('creates, renames, replaces and validates policies', () => {
    const d = { ...newPolicy(), name: 'own rows', command: 'UPDATE' as const, permissive: false, roles: 'app, current_user', using: 'owner = current_user;', check: 'owner = current_user' }
    expect(policySql('public', 't', d).stmts).toEqual([
      'CREATE POLICY "own rows" ON public.t AS RESTRICTIVE FOR UPDATE TO app, CURRENT_USER USING (owner = current_user) WITH CHECK (owner = current_user)'
    ])
    expect(policySql('public', 't', { ...d, name: 'mine' }, d).stmts).toEqual(['ALTER POLICY "own rows" ON public.t RENAME TO mine'])
    expect(policySql('public', 't', { ...d, roles: 'PUBLIC' }, d).stmts).toEqual([
      'DROP POLICY "own rows" ON public.t',
      'CREATE POLICY "own rows" ON public.t AS RESTRICTIVE FOR UPDATE USING (owner = current_user) WITH CHECK (owner = current_user)'
    ])
    expect(policyProblems({ ...newPolicy(), command: 'SELECT', check: 'x' })).toEqual(['db.r.err.policyName', 'db.r.err.noCheck'])
    expect(rlsSql('public', 't', { enabled: false, forced: false }, { enabled: true, forced: true }).stmts).toEqual([
      'ALTER TABLE public.t ENABLE ROW LEVEL SECURITY',
      'ALTER TABLE public.t FORCE ROW LEVEL SECURITY'
    ])
  })
})
