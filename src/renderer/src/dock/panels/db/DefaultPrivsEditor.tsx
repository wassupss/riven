import { useEffect, useMemo, useState } from 'react'
import { Plus, RotateCcw, Trash2 } from 'lucide-react'
import type { DefaultObjType } from '../../../../../main/db/types'
import { planText, type DdlPlan } from '../../../../../main/db/ddl'
import { DEFAULT_OBJ_TYPES, DEFAULT_PRIVS, defaultRuleSql, defaultRules, ruleKey, type DefaultRule } from '../../../../../main/db/privs'
import { useT } from '../../../i18n'
import { Button, Select, TextInput } from '../../../components/ui/Controls'
import { errText } from './ConnectionForm'
import { PrivCell, nextCell, useApply, useRoles, type CellState } from './privsUi'

// ALTER DEFAULT PRIVILEGES: what objects a role creates later get granted.
// One row per (creator, schema, object type, grantee); each row diffs on its own.

interface Item {
  rule: DefaultRule
  orig?: DefaultRule
  dropped?: boolean
}

export default function DefaultPrivsEditor({
  connId,
  db,
  schema,
  readOnly
}: {
  connId: string
  db?: string
  /** Only the rules of this schema (and new ones go here). Undefined: the whole database. */
  schema?: string
  readOnly: boolean
}): JSX.Element {
  const t = useT()
  const { roles } = useRoles(connId)
  const [state, setState] = useState<{ rules?: DefaultRule[]; error?: string }>({})
  const [items, setItems] = useState<Item[]>([])
  const [reload, setReload] = useState(0)
  const [add, setAdd] = useState<{ role: string; schema: string; objType: DefaultObjType; grantee: string }>({
    role: '',
    schema: schema ?? '',
    objType: 'tables',
    grantee: ''
  })
  const ap = useApply()

  useEffect(() => {
    let live = true
    setState({})
    window.api.db
      .defaultAcl(connId, db)
      .then((acl) => {
        if (!live) return
        const rules = defaultRules(acl).filter((r) => schema === undefined || r.schema === schema)
        setState({ rules })
        setItems(rules.map((r) => ({ rule: r, orig: r })))
      })
      .catch((e) => live && setState({ error: errText(e) }))
    return () => {
      live = false
    }
  }, [connId, db, schema, reload])

  const plan = useMemo<DdlPlan>(() => {
    const stmts = items.flatMap((x) => {
      const now = x.dropped || !x.rule.privileges.length ? null : x.rule
      return defaultRuleSql(x.orig ?? null, now).stmts
    })
    return { stmts, atomic: true }
  }, [items])

  if (state.error) return <div className="dbx-error">{state.error}</div>
  if (!state.rules) return <div className="dbx-empty">{t('db.loading')}</div>

  const edit = (fn: (xs: Item[]) => Item[]): void => {
    ap.setStatus(null)
    setItems(fn)
  }
  const cell = (r: DefaultRule, p: string): CellState => (!r.privileges.includes(p) ? 0 : r.grantable.includes(p) ? 2 : 1)
  const cycle = (i: number, p: string): void =>
    edit((xs) =>
      xs.map((x, j) => {
        if (j !== i) return x
        const s = nextCell(cell(x.rule, p))
        const privileges = s === 0 ? x.rule.privileges.filter((q) => q !== p) : x.rule.privileges.includes(p) ? x.rule.privileges : [...x.rule.privileges, p]
        const grantable = s === 2 ? [...x.rule.grantable, p] : x.rule.grantable.filter((q) => q !== p)
        return { ...x, rule: { ...x.rule, privileges, grantable } }
      })
    )
  const newRule: DefaultRule = {
    role: add.role,
    schema: add.objType === 'schemas' ? null : add.schema.trim() || null,
    objType: add.objType,
    grantee: add.grantee,
    privileges: [],
    grantable: []
  }
  const taken = items.some((x) => ruleKey(x.rule) === ruleKey(newRule))
  const canAdd = !!add.role && !!add.grantee && !taken
  const dirty = plan.stmts.length > 0
  const roleNames = roles.filter((r) => !r.system).map((r) => r.name)

  return (
    <div className="dbx-privs">
      <div className="dbx-privs-bar">
        <span className="dbx-meta">{t('db.r.defaultHint')}</span>
        <span className="dbx-spacer" />
        <Button variant="ghost" disabled={!dirty || ap.busy} onClick={() => setItems(state.rules!.map((r) => ({ rule: r, orig: r })))}>
          {t('db.d.reset')}
        </Button>
        <Button
          variant="primary"
          disabled={!dirty || ap.busy || readOnly}
          onClick={() => void ap.run(connId, db, plan, () => setReload((n) => n + 1))}
        >
          {ap.busy ? t('db.d.applying') : t('db.d.apply')}
        </Button>
      </div>
      {items.length ? (
        <div className="dbx-defacl">
          {items.map((x, i) => (
            <div key={ruleKey(x.rule)} className={`dbx-design-item${x.dropped ? ' dropped' : x.orig ? '' : ' added'}`}>
              <span className="dbx-design-name" title={t('db.r.creator')}>
                {x.rule.role}
              </span>
              {schema === undefined && <span className="dbx-meta">{x.rule.schema ?? t('db.r.allSchemas')}</span>}
              <span className="dbx-tag">{t(`db.r.obj.${x.rule.objType}`)}</span>
              <span className="dbx-meta">→</span>
              <span className="dbx-design-name">{x.rule.grantee}</span>
              <span className="dbx-defacl-cells">
                {DEFAULT_PRIVS[x.rule.objType].map((p) => (
                  <span key={p} className="dbx-defacl-cell">
                    <PrivCell state={cell(x.rule, p)} disabled={readOnly || x.dropped} onClick={() => cycle(i, p)} />
                    <span>{p}</span>
                  </span>
                ))}
              </span>
              <span className="dbx-spacer" />
              {!readOnly && (
                <button
                  className="dbx-design-del"
                  title={x.dropped ? t('db.d.restore') : t('db.d.remove')}
                  onClick={() =>
                    edit((xs) => (x.orig ? xs.map((y, j) => (j === i ? { ...y, dropped: !y.dropped } : y)) : xs.filter((_, j) => j !== i)))
                  }
                >
                  {x.dropped ? <RotateCcw size={12} /> : <Trash2 size={12} />}
                </button>
              )}
            </div>
          ))}
        </div>
      ) : (
        <div className="dbx-design-none">{t('db.r.noDefaults')}</div>
      )}
      {!readOnly && (
        <div className="dbx-privs-add">
          <Select value={add.role} title={t('db.r.creator')} onChange={(e) => setAdd({ ...add, role: e.target.value })}>
            <option value="">{t('db.r.creator')}</option>
            {roleNames.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </Select>
          {schema === undefined && add.objType !== 'schemas' && (
            <TextInput
              className="w-schema"
              value={add.schema}
              placeholder={t('db.r.allSchemas')}
              spellCheck={false}
              onChange={(e) => setAdd({ ...add, schema: e.target.value })}
            />
          )}
          <Select value={add.objType} onChange={(e) => setAdd({ ...add, objType: e.target.value as DefaultObjType })}>
            {DEFAULT_OBJ_TYPES.filter((o) => schema === undefined || o !== 'schemas').map((o) => (
              <option key={o} value={o}>
                {t(`db.r.obj.${o}`)}
              </option>
            ))}
          </Select>
          <Select value={add.grantee} title={t('db.r.grantee')} onChange={(e) => setAdd({ ...add, grantee: e.target.value })}>
            <option value="">{t('db.r.grantee')}</option>
            {['PUBLIC', ...roleNames].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </Select>
          <button
            className="dbx-link"
            disabled={!canAdd}
            title={taken ? t('db.r.ruleExists') : undefined}
            onClick={() => edit((xs) => [...xs, { rule: { ...newRule, privileges: [...DEFAULT_PRIVS[newRule.objType].slice(0, 1)] } }])}
          >
            <Plus size={11} /> {t('db.r.addRule')}
          </button>
        </div>
      )}
      {readOnly && <div className="dbx-design-problems">{t('db.d.readOnly')}</div>}
      <pre className="dbx-ddl-preview">{dirty ? planText(plan) : t('db.d.noChanges')}</pre>
      {ap.status && <div className={`dbx-form-status ${ap.status.ok ? 'ok' : 'err'}`}>{ap.status.text}</div>}
    </div>
  )
}
