import { useEffect, useMemo, useState } from 'react'
import { Plus, RefreshCw, Trash2, Users } from 'lucide-react'
import type { ObjectKind, RoleGrant, RoleInfo } from '../../../../../main/db/types'
import { planText } from '../../../../../main/db/ddl'
import {
  ROLE_FLAGS,
  alterRoleSql,
  createRoleSql,
  dropRoleSql,
  membersOf,
  newRole,
  roleDraft,
  roleProblems,
  type RoleDraft
} from '../../../../../main/db/privs'
import { useT } from '../../../i18n'
import { useDb, type RolesTab } from '../../../state/db'
import { Button, Switch, TextInput } from '../../../components/ui/Controls'
import { Row, errText } from './ConnectionForm'
import DdlDialog, { type DdlAction } from './DdlDialog'
import { RolePicker, useApply, useRoles } from './privsUi'

// Roles of a server: a filterable list on the left, the selected role's
// attributes, memberships and (in the tab's database) granted objects on the right.

export default function RolesView({ tab }: { tab: RolesTab }): JSX.Element {
  const t = useT()
  const conn = useDb((s) => s.connections.find((c) => c.id === tab.connId))
  const [reload, setReload] = useState(0)
  const { roles, error } = useRoles(tab.connId, reload)
  /** A role name, '' for a new role, null for none. */
  const [sel, setSel] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [system, setSystem] = useState(false)

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return roles.filter((r) => (system || !r.system) && (!q || r.name.toLowerCase().includes(q)))
  }, [roles, filter, system])
  const role = sel ? roles.find((r) => r.name === sel) : undefined
  const readOnly = !!conn?.readOnly

  return (
    <div className="dbx-roles">
      <div className="dbx-roles-list">
        <div className="dbx-roles-tools">
          <TextInput value={filter} placeholder={t('db.r.filterRoles')} spellCheck={false} onChange={(e) => setFilter(e.target.value)} />
          <button className="dbx-design-del" title={t('db.refresh')} onClick={() => setReload((n) => n + 1)}>
            <RefreshCw size={12} />
          </button>
        </div>
        <label className="dbx-privs-opt">
          <Switch checked={system} onChange={setSystem} />
          <span>{t('db.r.showSystem')}</span>
        </label>
        {!readOnly && (
          <button className={`dbx-roles-item new${sel === '' ? ' sel' : ''}`} onClick={() => setSel('')}>
            <Plus size={12} /> {t('db.r.newRole')}
          </button>
        )}
        <div className="dbx-roles-scroll">
          {error && <div className="dbx-error">{error}</div>}
          {shown.map((r) => (
            <button key={r.name} className={`dbx-roles-item${sel === r.name ? ' sel' : ''}`} onClick={() => setSel(r.name)}>
              <Users size={12} className={r.login ? 'login' : undefined} />
              <span className="dbx-roles-name">{r.name}</span>
              {r.superuser && <span className="dbx-tag pk">SUPER</span>}
              {!r.login && <span className="dbx-tag">{t('db.r.group')}</span>}
            </button>
          ))}
        </div>
      </div>
      <div className="dbx-roles-main">
        {sel === null ? (
          <div className="dbx-empty">{t('db.r.pickRole')}</div>
        ) : sel && !role ? (
          <div className="dbx-empty">{roles.length ? t('db.notFound') : t('db.loading')}</div>
        ) : (
          <RoleEditor
            // A fresh draft whenever the catalog copy of the role changes.
            key={`${sel}|${JSON.stringify(role ?? null)}|${JSON.stringify(role ? membersOf(roles, role.name) : null)}`}
            connId={tab.connId}
            db={tab.db}
            role={role}
            roles={roles}
            readOnly={readOnly}
            onSaved={(name) => {
              setSel(name)
              setReload((n) => n + 1)
            }}
          />
        )}
      </div>
    </div>
  )
}

function RoleEditor({
  connId,
  db,
  role,
  roles,
  readOnly,
  onSaved
}: {
  connId: string
  db?: string
  role?: RoleInfo
  roles: RoleInfo[]
  readOnly: boolean
  /** The role's name after the change; null once it was dropped. */
  onSaved: (name: string | null) => void
}): JSX.Element {
  const t = useT()
  const orig = useMemo(() => (role ? roleDraft(role, roles) : null), [role, roles])
  const [d, setD] = useState<RoleDraft>(() => orig ?? newRole())
  const [action, setAction] = useState<DdlAction | null>(null)
  const ap = useApply()

  const problems = roleProblems(d)
  const plan = useMemo(() => (orig ? alterRoleSql(orig, d) : createRoleSql(d)), [orig, d])
  const dirty = orig ? plan.stmts.length > 0 : true
  const set = (p: Partial<RoleDraft>): void => {
    ap.setStatus(null)
    setD((x) => ({ ...x, ...p }))
  }
  const name = d.name.trim()

  const drop = (): void => {
    if (!role) return
    const others = roles.filter((r) => r.name !== role.name && !r.system).map((r) => r.name)
    setAction({
      title: t('db.d.dropTitle', { name: role.name }),
      connId,
      db,
      fields: [
        {
          key: 'reassign',
          label: t('db.r.reassignTo'),
          kind: 'select',
          hint: t('db.r.reassignHint'),
          options: [{ value: '', label: t('db.r.noReassign') }, ...others.map((n) => ({ value: n, label: n }))]
        },
        { key: 'dropOwned', label: 'DROP OWNED', kind: 'switch', hint: t('db.r.dropOwnedHint') }
      ],
      build: (v) => dropRoleSql(role.name, { reassignTo: String(v.reassign || '') || undefined, dropOwned: !!v.dropOwned }),
      confirm: role.name,
      danger: true,
      applyLabel: t('db.d.drop'),
      onDone: () => onSaved(null)
    })
  }

  const members = (key: 'memberOf' | 'members', label: string, hint: string): JSX.Element => (
    <Row label={label} hint={hint}>
      <div className="dbx-roles-members">
        {d[key].map((m, i) => (
          <span key={m.role} className="dbx-roles-member">
            <span className="dbx-design-name">{m.role}</span>
            <label className="dbx-privs-opt" title={t('db.r.adminHint')}>
              <Switch
                checked={m.admin}
                disabled={readOnly}
                onChange={(x) => set({ [key]: d[key].map((y, j) => (j === i ? { ...y, admin: x } : y)) })}
              />
              <span>ADMIN</span>
            </label>
            {!readOnly && (
              <button className="dbx-design-del" title={t('db.d.remove')} onClick={() => set({ [key]: d[key].filter((_, j) => j !== i) })}>
                <Trash2 size={12} />
              </button>
            )}
          </span>
        ))}
        {!readOnly && (
          <RolePicker
            roles={roles}
            taken={[...d[key].map((m) => m.role), name, orig?.name ?? '']}
            placeholder={t('db.r.addRole')}
            systemToo={key === 'memberOf'}
            onPick={(r) => set({ [key]: [...d[key], { role: r, admin: false }] })}
          />
        )}
      </div>
    </Row>
  )

  return (
    <div className="dbx-roles-edit">
      <div className="dbx-privs-bar">
        <span className="dbx-obj-title">{role ? role.name : t('db.r.newRole')}</span>
        {role?.system && <span className="dbx-tag">{t('db.r.system')}</span>}
        <span className="dbx-spacer" />
        {role && !readOnly && (
          <Button variant="ghost" className="dbx-danger-btn" onClick={drop}>
            <Trash2 size={12} /> {t('db.d.drop')}
          </Button>
        )}
        <Button variant="ghost" disabled={!orig || !dirty || ap.busy} onClick={() => orig && setD(orig)}>
          {t('db.d.reset')}
        </Button>
        <Button
          variant="primary"
          disabled={!dirty || ap.busy || readOnly || problems.length > 0}
          onClick={() => void ap.run(connId, db, plan, () => onSaved(name || orig?.name || null))}
        >
          {ap.busy ? t('db.d.applying') : orig ? t('db.d.apply') : t('db.d.create')}
        </Button>
      </div>
      <div className="dbx-form-body">
        <Row label={t('db.c.name')}>
          <TextInput value={d.name} spellCheck={false} autoFocus={!role} disabled={readOnly} onChange={(e) => set({ name: e.target.value })} />
        </Row>
        <Row label={t('db.c.comment')}>
          <TextInput value={d.comment} disabled={readOnly} onChange={(e) => set({ comment: e.target.value })} />
        </Row>
        <div className="dbx-form-sect">{t('db.r.attributes')}</div>
        <div className="dbx-roles-flags">
          {ROLE_FLAGS.map((f) => (
            <label key={f} className="dbx-privs-opt" title={t(`db.r.flagHint.${f}`)}>
              <Switch checked={d[f]} disabled={readOnly} onChange={(x) => set({ [f]: x })} />
              <span>{t(`db.r.flag.${f}`)}</span>
            </label>
          ))}
        </div>
        <Row label={t('db.r.connLimit')} hint={t('db.r.connLimitHint')}>
          <TextInput
            className="w-num"
            value={d.connLimit}
            placeholder={t('db.r.unlimited')}
            disabled={readOnly}
            onChange={(e) => set({ connLimit: e.target.value })}
          />
        </Row>
        <Row label={t('db.r.validUntil')} hint={t('db.r.validUntilHint')}>
          <TextInput
            value={d.validUntil}
            placeholder="2030-12-31 00:00:00+09"
            spellCheck={false}
            disabled={readOnly}
            onChange={(e) => set({ validUntil: e.target.value })}
          />
        </Row>
        <Row label={t('db.r.password')} hint={role ? t('db.r.passwordKeep') : undefined}>
          <div className="dbx-roles-pw">
            <TextInput
              type="password"
              autoComplete="new-password"
              value={d.password}
              disabled={readOnly || d.clearPassword}
              onChange={(e) => set({ password: e.target.value })}
            />
            {role && (
              <label className="dbx-privs-opt">
                <Switch checked={d.clearPassword} disabled={readOnly} onChange={(x) => set({ clearPassword: x, password: '' })} />
                <span>{t('db.r.clearPassword')}</span>
              </label>
            )}
          </div>
        </Row>
        <div className="dbx-form-sect">{t('db.r.membership')}</div>
        {members('memberOf', t('db.r.memberOf'), t('db.r.memberOfHint'))}
        {members('members', t('db.r.members'), t('db.r.membersHint'))}
        {problems.length > 0 && (
          <div className="dbx-design-problems">
            {problems.map((p) => (
              <div key={p}>{t(p)}</div>
            ))}
          </div>
        )}
        {readOnly && <div className="dbx-design-problems">{t('db.d.readOnly')}</div>}
        <div className="dbx-form-sect">SQL</div>
        <pre className="dbx-ddl-preview">{!dirty ? t('db.d.noChanges') : problems.length ? t('db.d.incomplete') : planText(plan)}</pre>
        {ap.status && <div className={`dbx-form-status ${ap.status.ok ? 'ok' : 'err'}`}>{ap.status.text}</div>}
        {role && (
          <>
            <div className="dbx-form-sect">{t('db.r.grantedIn', { db: db ?? '' })}</div>
            <RoleGrants connId={connId} db={db} role={role.name} />
          </>
        )}
      </div>
      {action && <DdlDialog action={action} onClose={() => setAction(null)} />}
    </div>
  )
}

/** Objects in `db` this role holds privileges on; a click opens their privileges. */
function RoleGrants({ connId, db, role }: { connId: string; db?: string; role: string }): JSX.Element {
  const t = useT()
  const openObject = useDb((s) => s.openObject)
  const openPrivs = useDb((s) => s.openPrivs)
  const [s, setS] = useState<{ rows?: RoleGrant[]; error?: string }>({})

  useEffect(() => {
    let live = true
    window.api.db
      .roleGrants(connId, db, role)
      .then((rows) => live && setS({ rows }))
      .catch((e) => live && setS({ error: errText(e) }))
    return () => {
      live = false
    }
  }, [connId, db, role])

  if (s.error) return <div className="dbx-error">{s.error}</div>
  if (!s.rows) return <div className="dbx-empty">{t('db.loading')}</div>
  if (!s.rows.length) return <div className="dbx-design-none">{t('db.r.noRoleGrants')}</div>

  const open = (g: RoleGrant): void => {
    if (g.kind === 'database' || g.kind === 'schema') return void openPrivs(connId, db, g.kind, g.name)
    // Routines come back as name(args).
    const m = /^(.*)\((.*)\)$/.exec(g.name)
    if (m) openObject(connId, db, g.schema, m[1], g.kind as ObjectKind, m[2])
    else openObject(connId, db, g.schema, g.name, g.kind as ObjectKind)
  }

  return (
    <div className="dbx-table-wrap">
      <table className="dbx-table dbx-roles-grants">
        <thead>
          <tr>
            <th>{t('db.r.object')}</th>
            <th>{t('db.c.type')}</th>
            <th>{t('db.r.privileges')}</th>
          </tr>
        </thead>
        <tbody>
          {s.rows.map((g) => (
            <tr key={`${g.kind}|${g.schema}|${g.name}|${g.viaPublic}`} className="clickable" onClick={() => open(g)}>
              <td>
                {g.schema && <span className="dbx-meta">{g.schema}.</span>}
                {g.name}
                {g.viaPublic && <span className="dbx-tag">PUBLIC</span>}
              </td>
              <td>{t(`db.r.kind.${g.kind}`)}</td>
              <td>
                {g.privileges.map((p) => (
                  <span key={p} className={`dbx-tag${g.grantable.includes(p) ? ' uq' : ''}`} title={g.grantable.includes(p) ? t('db.r.withGrant') : undefined}>
                    {p}
                  </span>
                ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
