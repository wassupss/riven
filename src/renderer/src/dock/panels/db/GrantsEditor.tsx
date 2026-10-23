import { useEffect, useMemo, useState } from 'react'
import { Trash2 } from 'lucide-react'
import type { Grant, PrivInfo, PrivTarget } from '../../../../../main/db/types'
import { planText } from '../../../../../main/db/ddl'
import { grantMap, grantsSql, type GrantMap } from '../../../../../main/db/privs'
import { useT } from '../../../i18n'
import { Button, Switch } from '../../../components/ui/Controls'
import { errText } from './ConnectionForm'
import { PrivCell, RolePicker, nextCell, useApply, useRoles, type CellState } from './privsUi'

// The GRANT matrix of one object: grantees down, privileges across. A cell
// cycles none -> granted -> WITH GRANT OPTION; Apply runs the GRANT/REVOKE diff.

const clone = (m: GrantMap): GrantMap => new Map([...m].map(([g, row]) => [g, new Map(row)]))
const toList = (m: GrantMap): Grant[] =>
  [...m].flatMap(([grantee, row]) => [...row].map(([privilege, grantable]) => ({ grantee, privilege, grantable })))

export default function GrantsEditor({
  connId,
  db,
  target,
  readOnly
}: {
  connId: string
  db?: string
  target: PrivTarget
  readOnly: boolean
}): JSX.Element {
  const t = useT()
  const { roles } = useRoles(connId)
  const [info, setInfo] = useState<{ data?: PrivInfo | null; error?: string }>({})
  const [draft, setDraft] = useState<GrantMap>(new Map())
  const [cascade, setCascade] = useState(false)
  const [reload, setReload] = useState(0)
  const ap = useApply()

  useEffect(() => {
    let live = true
    setInfo({})
    window.api.db
      .privileges(connId, db, target)
      .then((data) => {
        if (!live) return
        setInfo({ data })
        setDraft(data ? grantMap(data.grants) : new Map())
      })
      .catch((e) => live && setInfo({ error: errText(e) }))
    return () => {
      live = false
    }
  }, [connId, db, target.kind, target.schema, target.name, target.args, reload])

  const before = info.data?.grants
  const plan = useMemo(() => (before ? grantsSql(target, before, toList(draft), { cascade }) : null), [before, draft, cascade, target])

  if (info.error) return <div className="dbx-error">{info.error}</div>
  if (!info.data) return <div className="dbx-empty">{info.data === null ? t('db.notFound') : t('db.loading')}</div>

  const { owner, available } = info.data
  const grantees = [...draft.keys()]
  const dirty = !!plan?.stmts.length
  const cell = (g: string, p: string): CellState => {
    const v = draft.get(g)?.get(p)
    return v === undefined ? 0 : v ? 2 : 1
  }
  const edit = (fn: (m: GrantMap) => void): void => {
    ap.setStatus(null)
    setDraft((d) => {
      const m = clone(d)
      fn(m)
      return m
    })
  }
  const setCell = (m: GrantMap, g: string, p: string, s: CellState): void => {
    const row = m.get(g) ?? new Map<string, boolean>()
    if (s === 0) row.delete(p)
    else row.set(p, s === 2)
    m.set(g, row)
  }
  // Header clicks fill a column or row, or clear it when it's already full.
  const toggleCol = (p: string): void =>
    edit((m) => {
      const full = grantees.every((g) => cell(g, p))
      for (const g of grantees) setCell(m, g, p, full ? 0 : cell(g, p) || 1)
    })
  const toggleRow = (g: string): void =>
    edit((m) => {
      const full = available.every((p) => cell(g, p))
      for (const p of available) setCell(m, g, p, full ? 0 : cell(g, p) || 1)
    })

  return (
    <div className="dbx-privs">
      <div className="dbx-privs-bar">
        <span className="dbx-meta">
          {t('db.r.owner')}: <b>{owner}</b>
        </span>
        <span className="dbx-spacer" />
        <label className="dbx-privs-opt" title={t('db.r.cascadeHint')}>
          <Switch checked={cascade} disabled={readOnly} onChange={setCascade} />
          <span>CASCADE</span>
        </label>
        <Button variant="ghost" disabled={!dirty || ap.busy} onClick={() => setDraft(grantMap(info.data!.grants))}>
          {t('db.d.reset')}
        </Button>
        <Button
          variant="primary"
          disabled={!dirty || ap.busy || readOnly}
          onClick={() => plan && void ap.run(connId, db, plan, () => setReload((n) => n + 1))}
        >
          {ap.busy ? t('db.d.applying') : t('db.d.apply')}
        </Button>
      </div>
      <div className="dbx-table-wrap">
        <table className="dbx-table dbx-priv-grid">
          <thead>
            <tr>
              <th>{t('db.r.grantee')}</th>
              {available.map((p) => (
                <th key={p} className="c">
                  <button className="dbx-priv-head" disabled={readOnly || !grantees.length} onClick={() => toggleCol(p)}>
                    {p}
                  </button>
                </th>
              ))}
              <th />
            </tr>
          </thead>
          <tbody>
            {grantees.map((g) => (
              <tr key={g} className={before?.some((x) => x.grantee === g) ? undefined : 'added'}>
                <td>
                  <button className="dbx-priv-head" disabled={readOnly} onClick={() => toggleRow(g)}>
                    {g}
                  </button>
                  {g === owner && <span className="dbx-tag">{t('db.r.ownerTag')}</span>}
                </td>
                {available.map((p) => (
                  <td key={p} className="c">
                    <PrivCell state={cell(g, p)} disabled={readOnly} onClick={() => edit((m) => setCell(m, g, p, nextCell(cell(g, p))))} />
                  </td>
                ))}
                <td className="c">
                  {!readOnly && (
                    <button className="dbx-design-del" title={t('db.r.revokeAll')} onClick={() => edit((m) => m.delete(g))}>
                      <Trash2 size={12} />
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {!grantees.length && (
              <tr>
                <td colSpan={available.length + 2} className="dbx-dim">
                  {t('db.r.noGrants')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {!readOnly && (
        <div className="dbx-privs-add">
          <RolePicker
            roles={roles}
            taken={grantees}
            publicToo
            placeholder={t('db.r.addGrantee')}
            onPick={(g) => edit((m) => m.set(g, new Map()))}
          />
          <span className="dbx-meta">{t('db.r.cellHint')}</span>
        </div>
      )}
      {readOnly && <div className="dbx-design-problems">{t('db.d.readOnly')}</div>}
      <pre className="dbx-ddl-preview">{dirty && plan ? planText(plan) : t('db.d.noChanges')}</pre>
      {ap.status && <div className={`dbx-form-status ${ap.status.ok ? 'ok' : 'err'}`}>{ap.status.text}</div>}
    </div>
  )
}
