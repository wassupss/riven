import { useEffect, useMemo, useState } from 'react'
import { KeyRound, Plus, RotateCcw, Trash2 } from 'lucide-react'
import type { TableInfo } from '../../../../../main/db/types'
import { invalidateCompletion } from './sqlComplete'
import {
  FK_ACTIONS,
  INDEX_METHODS,
  alterTableSql,
  createTableSql,
  draftFromTable,
  draftProblems,
  emptyColumn,
  emptyConstraint,
  emptyIndex,
  newTable,
  planText,
  type ColumnDraft,
  type ConstraintDraft,
  type ConstraintType,
  type IndexDraft,
  type TableDraft
} from '../../../../../main/db/ddl'
import { useT } from '../../../i18n'
import { useDb, type DesignTab } from '../../../state/db'
import { Button, Select, Switch, TextInput } from '../../../components/ui/Controls'
import { errText } from './ConnectionForm'

const TYPES = [
  'bigint',
  'integer',
  'smallint',
  'numeric',
  'numeric(12,2)',
  'real',
  'double precision',
  'boolean',
  'text',
  'varchar(255)',
  'char(1)',
  'uuid',
  'date',
  'time',
  'timestamp',
  'timestamptz',
  'interval',
  'jsonb',
  'json',
  'bytea',
  'inet',
  'text[]',
  'integer[]',
  'bigint generated always as identity',
  'bigserial',
  'serial'
]

// Create or alter one table: columns, keys, constraints, indexes. Every edit is
// a draft until Apply, which runs the previewed DDL in one transaction.
export default function TableDesigner({ tab }: { tab: DesignTab }): JSX.Element {
  const t = useT()
  const conn = useDb((s) => s.connections.find((c) => c.id === tab.connId))
  const invalidate = useDb((s) => s.invalidate)
  const retarget = useDb((s) => s.retarget)
  const openObject = useDb((s) => s.openObject)
  const [orig, setOrig] = useState<{ info?: TableInfo | null; error?: string }>({})
  const [draft, setDraft] = useState<TableDraft | null>(tab.name ? null : newTable(tab.schema))
  const [reload, setReload] = useState(0)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => {
    if (!tab.name) return
    let live = true
    setOrig({})
    window.api.db
      .table(tab.connId, tab.db, tab.schema, tab.name)
      .then((info) => {
        if (!live) return
        setOrig({ info })
        setDraft(info ? draftFromTable(info) : null)
      })
      .catch((e) => live && setOrig({ error: errText(e) }))
    return () => {
      live = false
    }
  }, [tab.connId, tab.db, tab.schema, tab.name, reload])

  const plan = useMemo(() => {
    if (!draft) return null
    if (!tab.name) return createTableSql(draft)
    return orig.info ? alterTableSql(orig.info, draft) : null
  }, [draft, orig.info, tab.name])
  const problems = useMemo(() => (draft ? draftProblems(draft) : []), [draft])
  const readOnly = !!conn?.readOnly
  const canApply = !!plan?.stmts.length && !problems.length && !busy && !readOnly

  const edit = (fn: (d: TableDraft) => TableDraft): void => {
    setStatus(null)
    setDraft((d) => (d ? fn(d) : d))
  }
  const setCol = (i: number, p: Partial<ColumnDraft>): void =>
    edit((d) => ({ ...d, columns: d.columns.map((c, j) => (j === i ? { ...c, ...p } : c)) }))
  const setCon = (i: number, p: Partial<ConstraintDraft>): void =>
    edit((d) => ({ ...d, constraints: d.constraints.map((c, j) => (j === i ? { ...c, ...p } : c)) }))
  const setIdx = (i: number, p: Partial<IndexDraft>): void =>
    edit((d) => ({ ...d, indexes: d.indexes.map((c, j) => (j === i ? { ...c, ...p } : c)) }))
  // New rows go away; existing ones toggle a drop.
  const removeAt = <K extends 'columns' | 'constraints' | 'indexes'>(k: K, i: number): void =>
    edit((d) => {
      const list = d[k] as Array<{ orig?: string; dropped?: boolean }>
      return {
        ...d,
        [k]: list[i].orig ? list.map((x, j) => (j === i ? { ...x, dropped: !x.dropped } : x)) : list.filter((_, j) => j !== i)
      }
    })

  const apply = async (): Promise<void> => {
    if (!draft || !plan || !canApply) return
    setBusy(true)
    setStatus(null)
    try {
      await window.api.db.ddlApply(tab.connId, tab.db, plan)
      invalidateCompletion(tab.connId)
      const name = draft.name.trim()
      const change = { connId: tab.connId, db: tab.db, schema: tab.schema }
      if (!tab.name) {
        invalidate(change)
        retarget(tab.id, name)
      } else if (name !== tab.name) {
        // Retitles this tab too, which reloads it under the new name.
        invalidate(change, { name: tab.name, renamed: name })
      } else {
        invalidate(change)
        setReload((n) => n + 1)
      }
      setStatus({ ok: true, text: t('db.d.applied', { n: plan.stmts.length }) })
    } catch (e) {
      setStatus({ ok: false, text: errText(e) })
    } finally {
      setBusy(false)
    }
  }

  if (orig.error) return <div className="dbx-error">{orig.error}</div>
  if (!draft) return <div className="dbx-empty">{orig.info === null ? t('db.notFound') : t('db.loading')}</div>

  const dirty = !!plan?.stmts.length

  return (
    <div className="dbx-design">
      <div className="dbx-obj-head">
        <span className="dbx-obj-title">
          <span className="dbx-meta">{tab.schema}.</span>
          {tab.name ?? t('db.d.newTable')}
        </span>
        <span className="dbx-kind k-table">{tab.name ? t('db.d.design') : t('db.d.create')}</span>
        <span className="dbx-spacer" />
        {tab.name && (
          <button className="dbx-link" onClick={() => openObject(tab.connId, tab.db, tab.schema, tab.name!, 'table')}>
            {t('db.d.view')}
          </button>
        )}
        <Button
          variant="ghost"
          disabled={!dirty || busy}
          onClick={() => {
            setStatus(null)
            setDraft(orig.info ? draftFromTable(orig.info) : newTable(tab.schema))
          }}
        >
          {t('db.d.reset')}
        </Button>
        <Button variant="primary" disabled={!canApply} onClick={() => void apply()}>
          {busy ? t('db.d.applying') : t('db.d.apply')}
        </Button>
      </div>
      <div className="dbx-design-body">
        <div className="dbx-design-meta">
          <label>
            <span>{t('db.d.tableName')}</span>
            <TextInput value={draft.name} spellCheck={false} autoFocus={!tab.name} onChange={(e) => edit((d) => ({ ...d, name: e.target.value }))} />
          </label>
          <label className="grow">
            <span>{t('db.c.comment')}</span>
            <TextInput value={draft.comment} onChange={(e) => edit((d) => ({ ...d, comment: e.target.value }))} />
          </label>
        </div>

        <Section title={t('db.columns')} onAdd={() => edit((d) => ({ ...d, columns: [...d.columns, emptyColumn()] }))}>
          <table className="dbx-design-grid">
            <thead>
              <tr>
                <th>{t('db.c.name')}</th>
                <th>{t('db.c.type')}</th>
                <th title="NOT NULL">NOT NULL</th>
                <th title={t('db.d.primaryKey')}>PK</th>
                <th>{t('db.c.default')}</th>
                <th>{t('db.c.comment')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {draft.columns.map((c, i) => (
                <tr key={i} className={rowClass(c)}>
                  <td>
                    <TextInput value={c.name} spellCheck={false} disabled={c.dropped} onChange={(e) => setCol(i, { name: e.target.value })} />
                  </td>
                  <td>
                    <TextInput
                      value={c.type}
                      list="dbx-types"
                      spellCheck={false}
                      disabled={c.dropped}
                      onChange={(e) => setCol(i, { type: e.target.value })}
                    />
                  </td>
                  <td className="c">
                    <Switch checked={!c.nullable} disabled={c.dropped || c.pk} onChange={(v) => setCol(i, { nullable: !v })} />
                  </td>
                  <td className="c">
                    <button
                      className={`dbx-pk-toggle${c.pk ? ' on' : ''}`}
                      disabled={c.dropped}
                      title={t('db.d.primaryKey')}
                      onClick={() => setCol(i, c.pk ? { pk: false } : { pk: true, nullable: false })}
                    >
                      <KeyRound size={12} />
                    </button>
                  </td>
                  <td>
                    <TextInput value={c.default} spellCheck={false} disabled={c.dropped} placeholder="-" onChange={(e) => setCol(i, { default: e.target.value })} />
                  </td>
                  <td>
                    <TextInput value={c.comment} disabled={c.dropped} onChange={(e) => setCol(i, { comment: e.target.value })} />
                  </td>
                  <td className="c">
                    <RowAction dropped={c.dropped} onClick={() => removeAt('columns', i)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <datalist id="dbx-types">
            {TYPES.map((x) => (
              <option key={x} value={x} />
            ))}
          </datalist>
        </Section>

        <Section
          title={t('db.constraints')}
          add={
            <span className="dbx-design-adds">
              {(['foreign key', 'unique', 'check'] as ConstraintType[]).map((k) => (
                <button key={k} className="dbx-link" onClick={() => edit((d) => ({ ...d, constraints: [...d.constraints, emptyConstraint(k)] }))}>
                  <Plus size={11} /> {k.toUpperCase()}
                </button>
              ))}
            </span>
          }
        >
          {!draft.constraints.length && <div className="dbx-dim dbx-design-none">{t('db.none')}</div>}
          {draft.constraints.map((c, i) =>
            c.orig ? (
              <div key={i} className={`dbx-design-item ${rowClass(c)}`}>
                <span className={`dbx-tag c-${c.type.replace(/[^a-z]/g, '')}`}>{c.type}</span>
                <span className="dbx-design-name">{c.orig}</span>
                <code className="dbx-design-def">{c.def}</code>
                <RowAction dropped={c.dropped} onClick={() => removeAt('constraints', i)} />
              </div>
            ) : (
              <div key={i} className="dbx-design-item added">
                <span className={`dbx-tag c-${c.type.replace(/[^a-z]/g, '')}`}>{c.type}</span>
                <TextInput className="w-name" value={c.name} placeholder={t('db.d.autoName')} spellCheck={false} onChange={(e) => setCon(i, { name: e.target.value })} />
                {c.type === 'check' ? (
                  <TextInput className="grow" value={c.expr} placeholder="price > 0" spellCheck={false} onChange={(e) => setCon(i, { expr: e.target.value })} />
                ) : (
                  <TextInput className="grow" value={c.columns} placeholder={t('db.d.columnsPh')} spellCheck={false} onChange={(e) => setCon(i, { columns: e.target.value })} />
                )}
                {c.type === 'foreign key' && (
                  <>
                    <span className="dbx-dim">→</span>
                    <TextInput className="w-ref" value={c.refTable} placeholder="schema.table" spellCheck={false} onChange={(e) => setCon(i, { refTable: e.target.value })} />
                    <TextInput className="w-cols" value={c.refColumns} placeholder="(pk)" spellCheck={false} onChange={(e) => setCon(i, { refColumns: e.target.value })} />
                    <FkAction label="ON DELETE" value={c.onDelete} onChange={(v) => setCon(i, { onDelete: v })} />
                    <FkAction label="ON UPDATE" value={c.onUpdate} onChange={(v) => setCon(i, { onUpdate: v })} />
                  </>
                )}
                <RowAction onClick={() => removeAt('constraints', i)} />
              </div>
            )
          )}
        </Section>

        <Section title={t('db.indexes')} onAdd={() => edit((d) => ({ ...d, indexes: [...d.indexes, emptyIndex()] }))}>
          {!draft.indexes.length && <div className="dbx-dim dbx-design-none">{t('db.none')}</div>}
          {draft.indexes.map((x, i) =>
            x.orig ? (
              <div key={i} className={`dbx-design-item ${rowClass(x)}`}>
                {x.unique && <span className="dbx-tag uq">UNIQUE</span>}
                <span className="dbx-design-name">{x.orig}</span>
                <code className="dbx-design-def">{x.def}</code>
                <RowAction dropped={x.dropped} onClick={() => removeAt('indexes', i)} />
              </div>
            ) : (
              <div key={i} className="dbx-design-item added">
                <TextInput className="w-name" value={x.name} placeholder={t('db.d.autoName')} spellCheck={false} onChange={(e) => setIdx(i, { name: e.target.value })} />
                <TextInput className="grow" value={x.columns} placeholder={t('db.d.indexColsPh')} spellCheck={false} onChange={(e) => setIdx(i, { columns: e.target.value })} />
                <Select value={x.method} onChange={(e) => setIdx(i, { method: e.target.value })}>
                  {INDEX_METHODS.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </Select>
                <label className="dbx-design-flag">
                  <Switch checked={x.unique} onChange={(v) => setIdx(i, { unique: v })} />
                  UNIQUE
                </label>
                <TextInput className="w-ref" value={x.where} placeholder="WHERE ..." spellCheck={false} onChange={(e) => setIdx(i, { where: e.target.value })} />
                <RowAction onClick={() => removeAt('indexes', i)} />
              </div>
            )
          )}
        </Section>

        <div className="dbx-form-sect">SQL</div>
        {problems.length > 0 && (
          <ul className="dbx-design-problems">
            {problems.map((p, i) => (
              <li key={i}>{t(p.key, { name: p.name ?? '' })}</li>
            ))}
          </ul>
        )}
        {readOnly && <div className="dbx-design-problems">{t('db.d.readOnly')}</div>}
        <pre className="dbx-ddl-preview">{plan?.stmts.length ? planText(plan) : t('db.d.noChanges')}</pre>
        {status && <div className={`dbx-form-status ${status.ok ? 'ok' : 'err'}`}>{status.text}</div>}
      </div>
    </div>
  )
}

const rowClass = (x: { orig?: string; dropped?: boolean }): string => (x.dropped ? 'dropped' : x.orig ? '' : 'added')

function Section({ title, onAdd, add, children }: { title: string; onAdd?: () => void; add?: React.ReactNode; children: React.ReactNode }): JSX.Element {
  const t = useT()
  return (
    <div className="dbx-design-sect">
      <div className="dbx-design-sect-head">
        <span>{title}</span>
        {add ??
          (onAdd && (
            <button className="dbx-link" onClick={onAdd}>
              <Plus size={11} /> {t('db.d.add')}
            </button>
          ))}
      </div>
      {children}
    </div>
  )
}

function RowAction({ dropped, onClick }: { dropped?: boolean; onClick: () => void }): JSX.Element {
  const t = useT()
  return (
    <button className="dbx-design-del" title={dropped ? t('db.d.restore') : t('db.d.remove')} onClick={onClick}>
      {dropped ? <RotateCcw size={12} /> : <Trash2 size={12} />}
    </button>
  )
}

function FkAction({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }): JSX.Element {
  return (
    <Select value={value} title={label} onChange={(e) => onChange(e.target.value)}>
      {FK_ACTIONS.map((a) => (
        <option key={a} value={a}>
          {a ? `${label} ${a}` : label}
        </option>
      ))}
    </Select>
  )
}
