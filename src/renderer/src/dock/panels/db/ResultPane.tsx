import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Download, X } from 'lucide-react'
import type { DbKind, QueryColumn, QueryResult } from '../../../../../main/db/types'
import { countQuery, viewQuery, type ResultView, type ViewFilter } from '../../../../../main/db/sqlText'
import { useT } from '../../../i18n'
import { dbUid, type RunResult } from '../../../state/db'
import { Button, TextInput } from '../../../components/ui/Controls'
import ResultGrid, { toDelimited } from './ResultGrid'
import ExportDialog from './ExportDialog'
import { errText } from './ConnectionForm'

// Scrolling keeps paging in rows up to this many; past it, narrow the query or export.
export const MAX_ROWS = 100_000
// A count(*) slower than this is given up on (the status then shows loaded rows only).
const COUNT_TIMEOUT = 15_000
const NO_VIEW: ResultView = { filters: [] }

const sameColumns = (a: QueryColumn[], b: QueryColumn[]): boolean =>
  a.length === b.length && a.every((c, i) => c.name === b[i].name && c.type === b[i].type)

// A query result with everything around the grid: server-side sort and filters
// (the query re-run through a wrapper, still paged as it scrolls), the total row
// count, copy and export. The owner holds the RunResult and hands in `patch`,
// which must drop updates once that result is replaced.
export default function ResultPane({
  connId,
  db,
  kind,
  limit,
  entry,
  patch,
  name,
  table,
  lead
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
      .query(connId, db, effSql, { limit, offset })
      .then((page) =>
        p((r) => {
          if (r.view !== v || !r.result) return r
          if (r.result.rows.length !== offset) return { ...r, loadingMore: false }
          return { ...r, loadingMore: false, result: { ...r.result, rows: r.result.rows.concat(page.rows), truncated: page.truncated } }
        })
      )
      .catch((e) => p((r) => (r.view !== v ? r : { ...r, loadingMore: false, moreError: errText(e) })))
  }, [canMore, entry.loadingMore, entry.view, effSql, res.rows.length, patch, connId, db, limit])

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
      .query(connId, db, q, { limit, queryId })
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
      .query(connId, db, cq, { limit: 1, queryId })
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
  const viewable = effSql !== null

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
          rows={res.rows}
          onMore={canMore ? loadMore : undefined}
          loadingMore={entry.loadingMore}
          sort={view.sort}
          onSort={viewable ? (s) => applyView({ ...view, sort: s ?? undefined }) : undefined}
          onFilter={viewable ? addFilter : undefined}
          onAskFilter={viewable ? (col, op) => setAsk({ col, op, value: '' }) : undefined}
          columnInfo={(c) => window.api.db.column(connId, db, c.table!, c.attnum!)}
          epoch={epoch}
        />
      </div>
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
        <span className="dbx-spacer" />
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
