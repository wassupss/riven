import { caps } from '../../../../../main/db/engines'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as monaco from 'monaco-editor'
import { ArrowRight, Copy, Download, FileCode2, GitCompare, Play, RefreshCw, TriangleAlert } from 'lucide-react'
import {
  buildMigration,
  diffSchemas,
  migrationPlan,
  migrationScript,
  type DiffItem,
  type DiffKind,
  type DiffStatus,
  type SchemaSnapshot
} from '../../../../../main/db/schemaDiff'
import type { SchemaInfo } from '../../../../../main/db/types'
import { editorTheme } from '../../../editor/highlight'
import { useT } from '../../../i18n'
import { Button, Select, TextInput } from '../../../components/ui/Controls'
import { useDb, type DiffTab } from '../../../state/db'
import { errText } from './ConnectionForm'
import { PrivCell } from './privsUi'
import { invalidateCompletion } from './sqlComplete'

type Endpoint = NonNullable<DiffTab['target']>

const KIND_ORDER: DiffKind[] = ['enum', 'sequence', 'table', 'view', 'matview', 'function', 'procedure']
const sameEnd = (a: Endpoint, b: Endpoint): boolean => a.connId === b.connId && (a.db ?? '') === (b.db ?? '') && a.schema === b.schema

// Schema comparison: the tab's schema is the source, the picked one the
// target. Lists what differs, shows both sides' DDL, and builds (and can
// apply) the migration that makes the target match for the checked objects.
export default function DiffView({ tab }: { tab: DiffTab }): JSX.Element {
  const t = useT()
  const connections = useDb((s) => s.connections)
  const setDiffTarget = useDb((s) => s.setDiffTarget)
  const invalidate = useDb((s) => s.invalidate)
  const openSql = useDb((s) => s.openSql)
  const src: Endpoint = { connId: tab.connId, db: tab.db, schema: tab.schema }
  const [tgt, setTgt] = useState<Endpoint>(tab.target ?? { connId: tab.connId, db: tab.db, schema: '' })
  const [snaps, setSnaps] = useState<{ src: SchemaSnapshot; tgt: SchemaSnapshot; tgtEnd: Endpoint } | null>(null)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [selected, setSelected] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const items = useMemo(() => (snaps ? diffSchemas(snaps.src, snaps.tgt) : null), [snaps])
  const itemsRef = useRef(items)
  itemsRef.current = items
  const migration = useMemo(() => (snaps && items ? buildMigration(snaps.src, snaps.tgt, picked) : null), [snaps, items, picked])
  const script = useMemo(() => (migration && snaps ? migrationScript(migration, snaps.tgtEnd.schema) : ''), [migration, snaps])
  const tgtConn = connections.find((c) => c.id === (snaps?.tgtEnd ?? tgt).connId)
  const ready = !!tgt.schema && !sameEnd(src, tgt)

  const compare = useCallback(
    async (end: Endpoint, keepPicks: boolean): Promise<void> => {
      setBusy(true)
      setStatus(null)
      try {
        const [a, b] = await Promise.all([
          window.api.db.schemaSnapshot(tab.connId, tab.db, tab.schema),
          window.api.db.schemaSnapshot(end.connId, end.db, end.schema)
        ])
        if (!alive.current) return
        const next = diffSchemas(a, b)
        // A refresh keeps what was unchecked; anything new starts checked.
        const known = new Set(keepPicks ? (itemsRef.current ?? []).map((x) => x.key) : [])
        setSnaps({ src: a, tgt: b, tgtEnd: end })
        setPicked((prev) => new Set(next.filter((x) => !known.has(x.key) || prev.has(x.key)).map((x) => x.key)))
        setSelected((cur) => (cur && next.some((x) => x.key === cur) ? cur : (next[0]?.key ?? null)))
        setError(null)
      } catch (e) {
        if (alive.current) setError(errText(e))
      } finally {
        if (alive.current) setBusy(false)
      }
    },
    [tab.connId, tab.db, tab.schema]
  )

  // A target remembered from before compares straight away.
  const first = useRef(true)
  useEffect(() => {
    if (first.current && tab.target && ready) void compare(tab.target, false)
    first.current = false
  }, [compare, tab.target, ready])

  const pickTarget = (end: Endpoint): void => {
    setTgt(end)
    if (end.schema) setDiffTarget(tab.id, end)
  }

  const needle = q.trim().toLowerCase()
  const groups = useMemo(() => {
    if (!items) return []
    const shown = needle ? items.filter((x) => x.name.toLowerCase().includes(needle)) : items
    return KIND_ORDER.map((k) => ({ kind: k, items: shown.filter((x) => x.kind === k) })).filter((g) => g.items.length)
  }, [items, needle])
  const item = items?.find((x) => x.key === selected) ?? null

  const toggle = (keys: string[], on: boolean): void =>
    setPicked((p) => {
      const n = new Set(p)
      for (const k of keys) {
        if (on) n.add(k)
        else n.delete(k)
      }
      return n
    })

  const copy = async (): Promise<void> => {
    await navigator.clipboard.writeText(script)
    setStatus({ ok: true, text: t('db.diff.copied') })
  }
  const save = async (): Promise<void> => {
    if (!snaps) return
    try {
      const path = await window.api.db.saveText(`${snaps.tgtEnd.schema}-migration`, 'sql', script)
      if (path) setStatus({ ok: true, text: t('db.erd.saved', { path }) })
    } catch (e) {
      setStatus({ ok: false, text: errText(e) })
    }
  }
  const apply = async (): Promise<void> => {
    if (!snaps || !migration?.stmts.length) return
    const end = snaps.tgtEnd
    const where = `${tgtConn?.name ?? ''} / ${end.db ?? tgtConn?.database ?? ''} / ${end.schema}`
    const msg = migration.destructive
      ? t('db.diff.confirmDestructive', { n: String(migration.stmts.length), d: String(migration.destructive), where })
      : t('db.diff.confirm', { n: String(migration.stmts.length), where })
    if (!window.confirm(msg)) return
    setBusy(true)
    setStatus(null)
    try {
      const n = await window.api.db.ddlApply(end.connId, end.db, migrationPlan(migration, end.schema))
      invalidateCompletion(end.connId)
      invalidate({ connId: end.connId, db: end.db, schema: end.schema })
      if (!alive.current) return
      setStatus({ ok: true, text: t('db.diff.applied', { n: String(n) }) })
      await compare(end, true)
    } catch (e) {
      if (alive.current) setStatus({ ok: false, text: errText(e) })
    } finally {
      if (alive.current) setBusy(false)
    }
  }

  return (
    <div className="dbx-obj dbx-diff">
      <div className="dbx-obj-head">
        <span className="dbx-obj-title">{t('db.diff.compare')}</span>
        <span className="dbx-diff-end" title={t('db.diff.sourceHint')}>
          <span className="dbx-meta">{t('db.diff.source')}</span>
          <span className="dbx-diff-src">
            {connections.find((c) => c.id === tab.connId)?.name ?? ''} / {tab.db ?? connections.find((c) => c.id === tab.connId)?.database ?? ''} /{' '}
            {tab.schema}
          </span>
        </span>
        <ArrowRight size={13} className="dbx-diff-arrow" />
        <span className="dbx-diff-end" title={t('db.diff.targetHint')}>
          <span className="dbx-meta">{t('db.diff.target')}</span>
          <EndpointPicker value={tgt} onChange={pickTarget} />
        </span>
        <Button variant="primary" disabled={!ready || busy} onClick={() => void compare(tgt, false)}>
          <GitCompare size={13} /> {t('db.diff.run')}
        </Button>
        {snaps && (
          <button className="dbx-icon-btn" title={t('db.refresh')} disabled={busy} onClick={() => void compare(snaps.tgtEnd, true)}>
            <RefreshCw size={13} className={busy ? 'dbx-spin' : undefined} />
          </button>
        )}
      </div>
      {tgt.schema && sameEnd(src, tgt) && <div className="dbx-form-status err">{t('db.diff.sameSchema')}</div>}
      {error && <div className="dbx-error">{error}</div>}
      {status && <div className={`dbx-form-status ${status.ok ? 'ok' : 'err'}`}>{status.text}</div>}
      {!items && !error && <div className="dbx-empty-state">{t('db.diff.pickTarget')}</div>}
      {items && !items.length && <div className="dbx-empty-state">{t('db.diff.identical')}</div>}
      {items && items.length > 0 && migration && (
        <div className="dbx-diff-body">
          <div className="dbx-diff-list">
            <div className="dbx-diff-list-head">
              <PrivCell
                state={picked.size === items.length ? 1 : 0}
                onClick={() => toggle(items.map((x) => x.key), picked.size !== items.length)}
              />
              <TextInput className="dbx-diff-q" placeholder={t('db.diff.filter')} value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            <div className="dbx-diff-items">
              {groups.map((g) => (
                <div key={g.kind}>
                  <div className="dbx-diff-group">
                    {t(`db.diff.kind.${g.kind}`)} <span className="dbx-meta">{g.items.length}</span>
                  </div>
                  {g.items.map((x) => (
                    <DiffRow
                      key={x.key}
                      item={x}
                      picked={picked.has(x.key)}
                      selected={x.key === selected}
                      onPick={(on) => toggle([x.key], on)}
                      onSelect={() => setSelected(x.key)}
                    />
                  ))}
                </div>
              ))}
            </div>
          </div>
          <div className="dbx-diff-main">
            <div className="dbx-diff-sides">
              <span>
                {t('db.diff.target')}: {snaps?.tgtEnd.schema}
              </span>
              <span>
                {t('db.diff.source')}: {tab.schema}
              </span>
            </div>
            <SideBySide original={item?.target ?? ''} modified={item?.source ?? ''} />
            <div className="dbx-diff-mig">
              <div className="dbx-diff-mig-head">
                <span className="dbx-obj-title">{t('db.diff.migration')}</span>
                <span className="dbx-meta">{t('db.diff.stmts', { n: String(migration.stmts.length) })}</span>
                {migration.destructive > 0 && (
                  <span className="dbx-diff-badge removed">{t('db.diff.destructive', { n: String(migration.destructive) })}</span>
                )}
                <span className="dbx-spacer" />
                <button className="dbx-icon-btn" title={t('db.diff.copy')} disabled={!migration.stmts.length} onClick={() => void copy()}>
                  <Copy size={13} />
                </button>
                <button className="dbx-icon-btn" title={t('db.diff.save')} disabled={!migration.stmts.length} onClick={() => void save()}>
                  <Download size={13} />
                </button>
                <button
                  className="dbx-icon-btn"
                  title={t('db.diff.openConsole')}
                  disabled={!migration.stmts.length || !snaps}
                  onClick={() => snaps && openSql(snaps.tgtEnd.connId, snaps.tgtEnd.db, script)}
                >
                  <FileCode2 size={13} />
                </button>
                <Button
                  variant="primary"
                  className={migration.destructive ? 'dbx-danger-btn' : undefined}
                  disabled={busy || !migration.stmts.length || !!tgtConn?.readOnly}
                  title={tgtConn?.readOnly ? t('db.diff.readOnly') : undefined}
                  onClick={() => void apply()}
                >
                  <Play size={12} /> {t('db.diff.apply')}
                </Button>
              </div>
              {migration.warnings.length > 0 && (
                <ul className="dbx-diff-warn">
                  {migration.warnings.map((w, i) => (
                    <li key={i}>
                      <TriangleAlert size={12} /> {w}
                    </li>
                  ))}
                </ul>
              )}
              <pre className="dbx-ddl-preview dbx-diff-sql">{migration.stmts.length ? script : t('db.diff.nothingPicked')}</pre>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function DiffRow({
  item: x,
  picked,
  selected,
  onPick,
  onSelect
}: {
  item: DiffItem
  picked: boolean
  selected: boolean
  onPick: (on: boolean) => void
  onSelect: () => void
}): JSX.Element {
  const t = useT()
  return (
    <div className={`dbx-diff-row${selected ? ' sel' : ''}`} onClick={onSelect} title={x.warnings.join('\n') || undefined}>
      <span onClick={(e) => e.stopPropagation()}>
        <PrivCell state={picked ? 1 : 0} onClick={() => onPick(!picked)} />
      </span>
      <StatusBadge status={x.status} />
      <span className="dbx-diff-name">{x.name}</span>
      {x.destructive && <span className="dbx-diff-badge removed" title={t('db.diff.dataLoss')}>!</span>}
      {x.warnings.length > 0 && <TriangleAlert size={12} className="dbx-diff-warn-ico" />}
    </div>
  )
}

function StatusBadge({ status }: { status: DiffStatus }): JSX.Element {
  const t = useT()
  return (
    <span className={`dbx-diff-badge ${status}`} title={t(`db.diff.status.${status}`)}>
      {status === 'added' ? '+' : status === 'removed' ? '−' : '~'}
    </span>
  )
}

/** Connection, database and schema of the target, each list read as the one before it is picked. */
function EndpointPicker({ value, onChange }: { value: Endpoint; onChange: (v: Endpoint) => void }): JSX.Element {
  const t = useT()
  const connections = useDb((s) => s.connections)
  const pg = connections.filter((c) => caps(c.kind).diff)
  const conn = connections.find((c) => c.id === value.connId)
  const [dbs, setDbs] = useState<string[]>([])
  const [schemas, setSchemas] = useState<SchemaInfo[]>([])
  const db = value.db ?? conn?.database

  useEffect(() => {
    let live = true
    setDbs([])
    window.api.db
      .databases(value.connId)
      .then((d) => live && setDbs(d))
      .catch(() => live && setDbs([]))
    return () => {
      live = false
    }
  }, [value.connId])
  useEffect(() => {
    let live = true
    setSchemas([])
    window.api.db
      .schemas(value.connId, value.db)
      .then((s) => live && setSchemas(s.filter((x) => !x.isSystem)))
      .catch(() => live && setSchemas([]))
    return () => {
      live = false
    }
  }, [value.connId, value.db])

  return (
    <>
      <Select value={value.connId} onChange={(e) => onChange({ connId: e.target.value, schema: '' })}>
        {pg.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </Select>
      <Select
        value={db ?? ''}
        onChange={(e) => onChange({ connId: value.connId, db: e.target.value === conn?.database ? undefined : e.target.value, schema: '' })}
      >
        {(dbs.length ? dbs : db ? [db] : []).map((d) => (
          <option key={d} value={d}>
            {d}
          </option>
        ))}
      </Select>
      <Select value={value.schema} onChange={(e) => onChange({ ...value, schema: e.target.value })}>
        <option value="">{t('db.diff.pickSchema')}</option>
        {schemas.map((s) => (
          <option key={s.name} value={s.name}>
            {s.name}
          </option>
        ))}
      </Select>
    </>
  )
}

/** Monaco side-by-side diff; one editor for the view's life, models swapped as the selection moves. */
function SideBySide({ original, modified }: { original: string; modified: string }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const editor = useRef<monaco.editor.IStandaloneDiffEditor | null>(null)

  useEffect(() => {
    const e = monaco.editor.createDiffEditor(ref.current!, {
      theme: editorTheme(),
      readOnly: true,
      originalEditable: false,
      automaticLayout: true,
      renderSideBySide: true,
      fontSize: 12,
      minimap: { enabled: false },
      scrollBeyondLastLine: false
    })
    editor.current = e
    return () => {
      const m = e.getModel()
      e.dispose()
      m?.original.dispose()
      m?.modified.dispose()
      editor.current = null
    }
  }, [])

  useEffect(() => {
    const e = editor.current
    if (!e) return
    const prev = e.getModel()
    e.setModel({ original: monaco.editor.createModel(original, 'sql'), modified: monaco.editor.createModel(modified, 'sql') })
    prev?.original.dispose()
    prev?.modified.dispose()
  }, [original, modified])

  return <div className="dbx-diff-editor" ref={ref} />
}
