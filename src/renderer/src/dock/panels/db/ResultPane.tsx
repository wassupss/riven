import { caps } from '../../../../../main/db/engines'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Download, Plus, X } from 'lucide-react'
import type { DbKind, QueryColumn, QueryResult } from '../../../../../main/db/types'
import { countQuery, viewQuery, type ResultView, type ViewFilter } from '../../../../../main/db/sqlText'
import { NO_EDITS, buildEdits, editCount, editMapping, previewSql, type Cell, type EditTarget, type PendingEdits } from '../../../../../main/db/edit'
import { useT } from '../../../i18n'
import { dbUid, type RunResult } from '../../../state/db'
import { Button, TextInput } from '../../../components/ui/Controls'
import ResultGrid, { toDelimited, type GridEdit } from './ResultGrid'
import ExportDialog from './ExportDialog'
import { errText } from './ConnectionForm'

// Scrolling keeps paging in rows up to this many; past it, narrow the query or export.
export const MAX_ROWS = 100_000
// A count(*) slower than this is given up on (the status then shows loaded rows only).
const COUNT_TIMEOUT = 15_000
const NO_VIEW: ResultView = { filters: [] }

const sameColumns = (a: QueryColumn[], b: QueryColumn[]): boolean =>
  a.length === b.length && a.every((c, i) => c.name === b[i].name && c.type === b[i].type)

const sameCell = (a: Cell, b: Cell): boolean => (a === null || b === null ? a === b : String(a) === String(b))

// A query result with everything around the grid: server-side sort and filters
// (the query re-run through a wrapper, still paged as it scrolls), the total row
// count, copy and export, and editing when the rows come from one table with a
// primary key. The owner holds the RunResult and hands in `patch`, which must
// drop updates once that result is replaced. Edits stay pending in the grid
// until applied; with `session` they run inside the console's open transaction.
export default function ResultPane({
  connId,
  db,
  kind,
  limit,
  entry,
  patch,
  name,
  table,
  lead,
  session,
  onTx,
  editable
}: {
  connId: string
  db: string | undefined
  kind: DbKind
  limit: number
  entry: RunResult & { result: QueryResult }
  patch: (fn: (r: RunResult) => RunResult) => void
  /** Suggested export file name. */
  name: string
  /** INSERT target for a SQL export. */
  table?: string
  /** Shown first in the status bar. */
  lead?: ReactNode
  /** The console's manual-commit session: paging and edits run inside it. */
  session?: string
  /** Called after something ran in `session` (its transaction may have changed). */
  onTx?: () => void
  /** The connection allows writes. */
  editable?: boolean
}): JSX.Element {
  const t = useT()
  const res = entry.result
  const view = entry.view ?? NO_VIEW
  // The query as viewed; null when it can't be re-run (so no sort, filter, paging).
  const effSql = useMemo(() => viewQuery(entry.sql, kind, view), [entry.sql, kind, view])
  const [epoch, setEpoch] = useState(0)
  const [ask, setAsk] = useState<{ col: number; op: 'like' | 'eq'; value: string } | null>(null)
  const [exporting, setExporting] = useState(false)
  const viewQid = useRef<string | null>(null)
  const countQid = useRef<string | null>(null)
  const aux = { session, aux: true }

  const stop = (ref: React.MutableRefObject<string | null>): void => {
    if (ref.current) void window.api.db.cancel(connId, ref.current)
    ref.current = null
  }
  useEffect(
    () => () => {
      if (viewQid.current) void window.api.db.cancel(connId, viewQid.current)
      if (countQid.current) void window.api.db.cancel(connId, countQid.current)
    },
    [connId]
  )

  const canMore =
    res.truncated && effSql !== null && !entry.moreError && !entry.viewLoading && res.rows.length < MAX_ROWS

  const loadMore = useCallback((): void => {
    if (!canMore || entry.loadingMore || effSql === null) return
    const offset = res.rows.length
    const v = entry.view
    const p = patch
    p((r) => ({ ...r, loadingMore: true, moreError: undefined }))
    window.api.db
      .query(connId, db, effSql, { limit, offset, ...aux })
      .then((page) =>
        p((r) => {
          if (r.view !== v || !r.result) return r
          if (r.result.rows.length !== offset) return { ...r, loadingMore: false }
          return { ...r, loadingMore: false, result: { ...r.result, rows: r.result.rows.concat(page.rows), truncated: page.truncated } }
        })
      )
      .catch((e) => p((r) => (r.view !== v ? r : { ...r, loadingMore: false, moreError: errText(e) })))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canMore, entry.loadingMore, entry.view, effSql, res.rows.length, patch, connId, db, limit, session])

  // Re-run through a new view. Keeps the columns array when the shape is the
  // same, so the grid keeps its column widths across a re-sort.
  const applyView = (next: ResultView): void => {
    const q = viewQuery(entry.sql, kind, next)
    if (q === null) return
    stop(viewQid)
    stop(countQid)
    const queryId = dbUid()
    viewQid.current = queryId
    const p = patch
    p((r) => ({ ...r, view: next, viewLoading: true, viewError: undefined, loadingMore: false, moreError: undefined, total: undefined, counting: false }))
    window.api.db
      .query(connId, db, q, { limit, queryId, ...aux })
      .then((result) => {
        p((r) =>
          r.view !== next
            ? r
            : {
                ...r,
                viewLoading: false,
                result: r.result && sameColumns(r.result.columns, result.columns) ? { ...result, columns: r.result.columns } : result
              }
        )
        setEpoch((e) => e + 1)
      })
      .catch((e) => p((r) => (r.view !== next ? r : { ...r, viewLoading: false, viewError: errText(e) })))
      .finally(() => {
        if (viewQid.current === queryId) viewQid.current = null
      })
  }

  const addFilter = (f: ViewFilter): void => {
    const same = (x: ViewFilter): boolean => x.col === f.col && x.op === f.op && (x.value ?? null) === (f.value ?? null)
    if (view.filters.some(same)) return
    applyView({ ...view, filters: [...view.filters, f] })
  }
  const removeFilter = (i: number): void => applyView({ ...view, filters: view.filters.filter((_, j) => j !== i) })

  // Total rows: counted once per view when the result was cut at the limit.
  useEffect(() => {
    if (!res.truncated || entry.total !== undefined || entry.counting || entry.viewLoading || effSql === null) return
    const cq = countQuery(effSql, kind)
    if (!cq) return
    const v = entry.view
    const p = patch
    const queryId = dbUid()
    countQid.current = queryId
    p((r) => ({ ...r, counting: true }))
    const timer = setTimeout(() => void window.api.db.cancel(connId, queryId), COUNT_TIMEOUT)
    window.api.db
      .query(connId, db, cq, { limit: 1, queryId, ...aux })
      .then((c) => {
        const n = Number(c.rows[0]?.[0])
        p((r) => (r.view !== v ? r : { ...r, counting: false, total: Number.isFinite(n) ? n : null }))
      })
      .catch(() => p((r) => (r.view !== v ? r : { ...r, counting: false, total: null })))
      .finally(() => {
        clearTimeout(timer)
        if (countQid.current === queryId) countQid.current = null
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [res.truncated, entry.total, entry.counting, entry.viewLoading, effSql])

  // --- Editing ---
  // The one table the result's columns come from (-1 for several, as in a join).
  const tableOid = useMemo(() => {
    const oids = new Set(res.columns.filter((c) => c.table !== undefined).map((c) => c.table!))
    return oids.size === 1 ? [...oids][0] : oids.size > 1 ? -1 : undefined
  }, [res.columns])
  const canEditKind = !!editable && caps(kind).edit
  const [target, setTarget] = useState<EditTarget | null | undefined>(undefined)
  useEffect(() => {
    setTarget(undefined)
    if (!canEditKind || tableOid === undefined || tableOid < 0) return
    let live = true
    window.api.db
      .editTarget(connId, db, tableOid)
      .then((tg) => live && setTarget(tg))
      .catch(() => live && setTarget(null))
    return () => {
      live = false
    }
  }, [canEditKind, connId, db, tableOid])
  const mapping = useMemo(() => (target ? editMapping(target, res.columns) : null), [target, res.columns])
  const [pending, setPending] = useState<PendingEdits>(NO_EDITS)
  const [applying, setApplying] = useState(false)
  const [applyError, setApplyError] = useState<string | null>(null)
  const [showSql, setShowSql] = useState(false)
  // A new result (or view of it) drops edits made against the old rows.
  useEffect(() => {
    setPending(NO_EDITS)
    setApplyError(null)
    setShowSql(false)
  }, [res.columns, entry.view])
  const nEdits = editCount(pending)
  const nIns = pending.inserts.length
  const deleted = useMemo(() => new Set(pending.deletes), [pending.deletes])

  // What the grid shows: new rows first, then the result with pending values.
  const shown = useMemo(() => {
    const keys = Object.keys(pending.updates).map(Number)
    let base = res.rows
    if (keys.length) {
      base = res.rows.slice()
      for (const k of keys) {
        const u = pending.updates[k]
        base[k] = base[k].map((v, c) => (c in u ? u[c] : v))
      }
    }
    if (!nIns) return base
    return pending.inserts.map((ins) => res.columns.map((_, c) => (c in ins ? ins[c] : null))).concat(base)
  }, [res.rows, res.columns, pending, nIns])

  const change = (fn: (p: PendingEdits) => PendingEdits): void => {
    setPending(fn)
    setApplyError(null)
  }
  const dropKey = <T,>(rec: Record<number, T>, k: number): Record<number, T> => {
    const next = { ...rec }
    delete next[k]
    return next
  }
  const gridEdit: GridEdit | undefined = mapping
    ? {
        inserted: nIns,
        canEdit: (c) => mapping.has(c) && !mapping.get(c)!.readOnly,
        mark: (r) => (r < nIns ? 'ins' : deleted.has(r - nIns) ? 'del' : undefined),
        dirty: (r, c) => (r < nIns ? c in pending.inserts[r] : c in (pending.updates[r - nIns] ?? {})),
        set: (r, c, v) =>
          change((p) => {
            if (r < p.inserts.length) return { ...p, inserts: p.inserts.map((ins, n) => (n === r ? { ...ins, [c]: v } : ins)) }
            const i = r - p.inserts.length
            const row = sameCell(res.rows[i][c], v) ? dropKey(p.updates[i] ?? {}, c) : { ...p.updates[i], [c]: v }
            return { ...p, updates: Object.keys(row).length ? { ...p.updates, [i]: row } : dropKey(p.updates, i) }
          }),
        revert: (r, c) =>
          change((p) => {
            if (r < p.inserts.length) return { ...p, inserts: p.inserts.map((ins, n) => (n === r ? dropKey(ins, c) : ins)) }
            const i = r - p.inserts.length
            if (!p.updates[i]) return p
            const row = dropKey(p.updates[i], c)
            return { ...p, updates: Object.keys(row).length ? { ...p.updates, [i]: row } : dropKey(p.updates, i) }
          }),
        toggleDelete: (r) =>
          change((p) => {
            if (r < p.inserts.length) return { ...p, inserts: p.inserts.filter((_, n) => n !== r) }
            const i = r - p.inserts.length
            return { ...p, deletes: p.deletes.includes(i) ? p.deletes.filter((d) => d !== i) : [...p.deletes, i] }
          })
      }
    : undefined

  // The new row goes first; the epoch bump scrolls the grid up to it.
  const addRow = (): void => {
    change((p) => ({ ...p, inserts: [{}, ...p.inserts] }))
    setEpoch((e) => e + 1)
  }

  const plan = useMemo(
    () => (target && mapping && nEdits ? buildEdits(target, res.columns, res.rows, pending, kind) : null),
    [target, mapping, nEdits, res.columns, res.rows, pending, kind]
  )

  const apply = async (): Promise<void> => {
    if (!plan || applying) return
    setApplying(true)
    setApplyError(null)
    const v = entry.view
    const done = pending
    try {
      const out = await window.api.db.apply(connId, db, session, plan.stmts)
      // Rows as the database has them now (defaults, triggers), from RETURNING.
      const fill = (row: Cell[], i: number): Cell[] => {
        const ret = out[i]
        if (!ret) return row
        const next = row.slice()
        plan.returning.forEach((ci, j) => (next[ci] = ret[j]))
        return next
      }
      patch((r) => {
        if (r.view !== v || !r.result) return r
        const cols = r.result.columns
        let rows = r.result.rows.slice()
        const inserted: Cell[][] = []
        plan.kinds.forEach((k, i) => {
          if (k.op === 'update' && rows[k.index]) rows[k.index] = fill(rows[k.index], i)
          else if (k.op === 'insert') inserted.push(fill(cols.map(() => null), i))
        })
        const del = new Set(done.deletes)
        if (del.size) rows = rows.filter((_, i) => !del.has(i))
        if (inserted.length) rows = inserted.concat(rows)
        const delta = inserted.length - del.size
        return { ...r, result: { ...r.result, rows }, total: typeof r.total === 'number' ? r.total + delta : r.total }
      })
      setPending(NO_EDITS)
      setShowSql(false)
    } catch (e) {
      setApplyError(errText(e))
    } finally {
      setApplying(false)
      if (session) onTx?.()
    }
  }

  const roReason =
    !canEditKind || tableOid === undefined || target === undefined
      ? null
      : tableOid < 0
        ? t('db.ed.roJoin')
        : !target
          ? t('db.ed.roUnknown')
          : target.reason === 'kind'
            ? t('db.ed.roKind')
            : target.reason === 'nopk'
              ? t('db.ed.roNoPk')
              : !mapping
                ? t('db.ed.roPkCol')
                : null

  const submitAsk = (): void => {
    if (!ask) return
    const value = ask.value
    setAsk(null)
    if (ask.op === 'like' && !value) return
    addFilter({ col: res.columns[ask.col].name, op: ask.op, value })
  }

  const filterText = (f: ViewFilter): string =>
    f.op === 'eq'
      ? `= ${f.value}`
      : f.op === 'ne'
        ? `≠ ${f.value}`
        : f.op === 'null'
          ? 'IS NULL'
          : f.op === 'notnull'
            ? 'IS NOT NULL'
            : `${t('db.flt.containsShort')} "${f.value}"`

  const loaded = res.rows.length
  const total = res.truncated ? entry.total : loaded
  // Sorting or filtering re-runs the query, which would lose pending edits.
  const viewable = effSql !== null && nEdits === 0

  return (
    <div className="dbx-pane">
      {(view.filters.length > 0 || ask || entry.viewError) && (
        <div className="dbx-vfs">
          {view.filters.map((f, i) => (
            <span key={i} className="dbx-vf" title={`${f.col} ${filterText(f)}`}>
              <b>{f.col}</b> {filterText(f)}
              <button className="dbx-vf-x" disabled={entry.viewLoading} onClick={() => removeFilter(i)}>
                <X size={10} />
              </button>
            </span>
          ))}
          {ask && (
            <span className="dbx-vf-ask">
              <b>{res.columns[ask.col]?.name}</b> {ask.op === 'like' ? t('db.flt.containsShort') : '='}
              <TextInput
                autoFocus
                value={ask.value}
                placeholder={t('db.flt.placeholder')}
                onChange={(e) => setAsk({ ...ask, value: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') submitAsk()
                  else if (e.key === 'Escape') setAsk(null)
                }}
              />
              <button className="dbx-link" onClick={submitAsk}>
                {t('db.flt.apply')}
              </button>
              <button className="dbx-link" onClick={() => setAsk(null)}>
                {t('common.cancel')}
              </button>
            </span>
          )}
          {view.filters.length > 1 && (
            <button className="dbx-link" disabled={entry.viewLoading} onClick={() => applyView({ ...view, filters: [] })}>
              {t('db.flt.clearAll')}
            </button>
          )}
          {entry.viewError && (
            <span className="dbx-error-inline" title={entry.viewError}>
              {entry.viewError}
            </span>
          )}
        </div>
      )}
      <div className={`dbx-result-body${entry.viewLoading ? ' busy' : ''}`}>
        <ResultGrid
          columns={res.columns}
          rows={shown}
          onMore={canMore ? loadMore : undefined}
          loadingMore={entry.loadingMore}
          sort={view.sort}
          onSort={viewable ? (s) => applyView({ ...view, sort: s ?? undefined }) : undefined}
          onFilter={viewable ? addFilter : undefined}
          onAskFilter={viewable ? (col, op) => setAsk({ col, op, value: '' }) : undefined}
          columnInfo={(c) => window.api.db.column(connId, db, c.table!, c.attnum!)}
          epoch={epoch}
          edit={gridEdit}
        />
      </div>
      {(nEdits > 0 || applyError) && (
        <div className="dbx-edits">
          {showSql && plan && <pre className="dbx-edits-sql">{previewSql(plan.stmts, kind)}</pre>}
          <div className="dbx-edits-bar">
            {nEdits > 0 && <span className="dbx-edits-n">{t('db.ed.pending', { n: nEdits })}</span>}
            {applyError && (
              <span className="dbx-error-inline" title={applyError}>
                {applyError}
              </span>
            )}
            <span className="dbx-spacer" />
            {plan && (
              <button className="dbx-link" onClick={() => setShowSql(!showSql)}>
                {showSql ? t('db.ed.hideSql') : t('db.ed.showSql')}
              </button>
            )}
            <Button disabled={applying} onClick={() => change(() => NO_EDITS)}>
              {t('db.ed.discard')}
            </Button>
            <Button
              variant="primary"
              disabled={applying || !plan}
              onClick={() => void apply()}
              title={session ? t('db.ed.applyTxHint') : t('db.ed.applyHint')}
            >
              {applying ? t('db.ed.applying') : t('db.ed.apply')}
            </Button>
          </div>
        </div>
      )}
      <div className="dbx-status">
        {lead}
        {entry.viewLoading && <span className="dbx-spin">{t('db.loading')}</span>}
        <span className="dbx-count">
          {typeof total === 'number'
            ? total === loaded
              ? t('db.rowsN', { n: loaded.toLocaleString() })
              : t('db.rowsOf', { n: loaded.toLocaleString(), total: total.toLocaleString() })
            : t('db.rowsLoaded', { n: loaded.toLocaleString() }) + (entry.counting ? t('db.counting') : '')}
          {entry.moreError ? (
            <span className="dbx-warn">
              {' '}
              {t('db.moreFailed')}{' '}
              <button className="dbx-link" title={entry.moreError} onClick={() => patch((r) => ({ ...r, moreError: undefined }))}>
                {t('db.retry')}
              </button>
            </span>
          ) : res.truncated && !viewable ? (
            <span className="dbx-warn"> {t('db.truncated', { n: loaded.toLocaleString() })}</span>
          ) : (
            res.truncated &&
            loaded >= MAX_ROWS && <span className="dbx-warn"> {t('db.maxRows', { n: MAX_ROWS.toLocaleString() })}</span>
          )}
        </span>
        <span className="dbx-meta dbx-ms">{res.timeMs} ms</span>
        {roReason && (
          <span className="dbx-meta dbx-ro" title={roReason}>
            {t('db.ed.readOnly')}
          </span>
        )}
        <span className="dbx-spacer" />
        {mapping && (
          <button className="dbx-link" disabled={applying} onClick={addRow}>
            <Plus size={11} /> {t('db.ed.addRow')}
          </button>
        )}
        <button className="dbx-link" onClick={() => void navigator.clipboard.writeText(toDelimited(res.columns, res.rows, ','))}>
          {t('db.copyCsv')}
        </button>
        <button className="dbx-link" onClick={() => void navigator.clipboard.writeText(toDelimited(res.columns, res.rows, '\t'))}>
          {t('db.copyTsv')}
        </button>
        <Button className="dbx-export-btn" onClick={() => setExporting(true)}>
          <Download size={11} /> {t('db.export')}
        </Button>
      </div>
      {exporting && (
        <ExportDialog
          connId={connId}
          db={db}
          columns={res.columns}
          rows={res.rows}
          sql={effSql}
          truncated={res.truncated}
          total={typeof total === 'number' ? total : undefined}
          name={name}
          table={table ?? 'result'}
          onClose={() => setExporting(false)}
        />
      )}
    </div>
  )
}
