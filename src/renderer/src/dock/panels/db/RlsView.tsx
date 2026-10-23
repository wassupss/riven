import { useEffect, useState } from 'react'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import type { PolicyCommand, PolicyInfo, RlsInfo } from '../../../../../main/db/types'
import { POLICY_COMMANDS, dropPolicyStmt, newPolicy, policyDraft, policyProblems, policySql, rlsSql, type PolicyDraft } from '../../../../../main/db/privs'
import { useT } from '../../../i18n'
import { Button, Switch } from '../../../components/ui/Controls'
import { errText } from './ConnectionForm'
import DdlDialog, { type DdlAction, type FieldValue } from './DdlDialog'
import { useApply } from './privsUi'

// Row-level security of one table: the ENABLE / FORCE switches (applied at
// once) and its policies, each created, edited or dropped through a dialog.

const toDraft = (v: Record<string, FieldValue>): PolicyDraft => ({
  name: String(v.name ?? ''),
  command: String(v.command ?? 'ALL') as PolicyCommand,
  permissive: v.type !== 'restrictive',
  roles: String(v.roles ?? ''),
  using: String(v.using ?? ''),
  check: String(v.check ?? '')
})

export default function RlsView({
  connId,
  db,
  schema,
  table,
  readOnly
}: {
  connId: string
  db?: string
  schema: string
  table: string
  readOnly: boolean
}): JSX.Element {
  const t = useT()
  const [info, setInfo] = useState<{ data?: RlsInfo | null; error?: string }>({})
  const [reload, setReload] = useState(0)
  const [action, setAction] = useState<DdlAction | null>(null)
  const ap = useApply()

  useEffect(() => {
    let live = true
    window.api.db
      .rls(connId, db, schema, table)
      .then((data) => live && setInfo({ data }))
      .catch((e) => live && setInfo({ error: errText(e) }))
    return () => {
      live = false
    }
  }, [connId, db, schema, table, reload])

  if (info.error) return <div className="dbx-error">{info.error}</div>
  if (!info.data) return <div className="dbx-empty">{info.data === null ? t('db.notFound') : t('db.loading')}</div>
  const rls = info.data
  const refresh = (): void => setReload((n) => n + 1)

  const toggle = (now: { enabled: boolean; forced: boolean }): void =>
    void ap.run(connId, db, rlsSql(schema, table, rls, now), refresh)

  const edit = (p?: PolicyInfo): void => {
    const orig = p ? policyDraft(p) : undefined
    const d = orig ?? newPolicy()
    setAction({
      title: p ? t('db.r.editPolicy', { name: p.name }) : t('db.r.newPolicy'),
      connId,
      db,
      fields: [
        { key: 'name', label: t('db.c.name'), kind: 'text' },
        { key: 'command', label: t('db.r.command'), kind: 'select', options: POLICY_COMMANDS.map((c) => ({ value: c, label: c })) },
        {
          key: 'type',
          label: t('db.r.policyType'),
          kind: 'select',
          hint: t('db.r.policyTypeHint'),
          options: [
            { value: 'permissive', label: 'PERMISSIVE' },
            { value: 'restrictive', label: 'RESTRICTIVE' }
          ]
        },
        { key: 'roles', label: t('db.r.policyRoles'), kind: 'text', placeholder: 'PUBLIC', hint: t('db.r.policyRolesHint') },
        { key: 'using', label: 'USING', kind: 'sql', rows: 3, placeholder: 'owner = current_user', hint: t('db.r.usingHint') },
        { key: 'check', label: 'WITH CHECK', kind: 'sql', rows: 3, placeholder: 'owner = current_user', hint: t('db.r.checkHint') }
      ],
      initial: { ...d, type: d.permissive ? 'permissive' : 'restrictive' },
      build: (v) => {
        const nd = toDraft(v)
        if (policyProblems(nd).length) return null
        const plan = policySql(schema, table, nd, orig)
        return plan.stmts.length ? plan : null
      },
      onDone: refresh
    })
  }

  const drop = (p: PolicyInfo): void =>
    setAction({
      title: t('db.r.dropPolicy', { name: p.name }),
      connId,
      db,
      fields: [],
      build: () => ({ stmts: [dropPolicyStmt(schema, table, p.name)], atomic: true }),
      confirm: p.name,
      danger: true,
      applyLabel: t('db.d.drop'),
      onDone: refresh
    })

  return (
    <div className="dbx-privs">
      <div className="dbx-privs-bar">
        <label className="dbx-privs-opt" title={t('db.r.rlsEnableHint')}>
          <Switch checked={rls.enabled} disabled={readOnly || ap.busy} onChange={(x) => toggle({ ...rls, enabled: x })} />
          <span>{t('db.r.rlsEnabled')}</span>
        </label>
        <label className="dbx-privs-opt" title={t('db.r.rlsForceHint')}>
          <Switch checked={rls.forced} disabled={readOnly || ap.busy} onChange={(x) => toggle({ ...rls, forced: x })} />
          <span>{t('db.r.rlsForced')}</span>
        </label>
        <span className="dbx-spacer" />
        {!readOnly && (
          <Button variant="ghost" onClick={() => edit()}>
            <Plus size={12} /> {t('db.r.newPolicy')}
          </Button>
        )}
      </div>
      {rls.enabled && !rls.policies.length && <div className="dbx-design-problems">{t('db.r.rlsNoPolicies')}</div>}
      {!rls.enabled && rls.policies.length > 0 && <div className="dbx-design-problems">{t('db.r.rlsOff')}</div>}
      <div className="dbx-table-wrap">
        <table className="dbx-table">
          <thead>
            <tr>
              <th>{t('db.c.name')}</th>
              <th>{t('db.r.command')}</th>
              <th>{t('db.r.policyType')}</th>
              <th>{t('db.r.policyRoles')}</th>
              <th>USING</th>
              <th>WITH CHECK</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rls.policies.map((p) => (
              <tr key={p.name}>
                <td>{p.name}</td>
                <td>{p.command}</td>
                <td>{p.permissive ? 'PERMISSIVE' : 'RESTRICTIVE'}</td>
                <td>{p.roles.join(', ')}</td>
                <td className="dbx-mono">{p.using ?? ''}</td>
                <td className="dbx-mono">{p.check ?? ''}</td>
                <td className="c dbx-nowrap">
                  {!readOnly && (
                    <>
                      <button className="dbx-design-del" title={t('db.r.editPolicy', { name: p.name })} onClick={() => edit(p)}>
                        <Pencil size={12} />
                      </button>
                      <button className="dbx-design-del" title={t('db.r.dropPolicy', { name: p.name })} onClick={() => drop(p)}>
                        <Trash2 size={12} />
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
            {!rls.policies.length && (
              <tr>
                <td colSpan={7} className="dbx-dim">
                  {t('db.r.noPolicies')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {readOnly && <div className="dbx-design-problems">{t('db.d.readOnly')}</div>}
      {ap.status && <div className={`dbx-form-status ${ap.status.ok ? 'ok' : 'err'}`}>{ap.status.text}</div>}
      {action && <DdlDialog action={action} onClose={() => setAction(null)} />}
    </div>
  )
}
