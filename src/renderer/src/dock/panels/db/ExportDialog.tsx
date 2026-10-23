import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import type { QueryColumn } from '../../../../../main/db/types'
import {
  projectRow,
  suggestMask,
  XLSX_MAX_ROWS,
  type ExportColumn,
  type ExportFormat,
  type ExportOptions,
  type MaskMode
} from '../../../../../main/db/mask'
import { useT } from '../../../i18n'
import { dbUid } from '../../../state/db'
import { Button, NumberInput, Segmented, Select, Switch, TextInput } from '../../../components/ui/Controls'
import { Row, errText } from './ConnectionForm'

type Cell = string | number | boolean | null
type Scope = 'loaded' | 'all' | 'range'
type Col = ExportColumn & { on: boolean }

const FORMATS: Array<{ value: ExportFormat; label: string }> = [
  { value: 'xlsx', label: 'Excel' },
  { value: 'csv', label: 'CSV' },
  { value: 'tsv', label: 'TSV' },
  { value: 'json', label: 'JSON' },
  { value: 'sql', label: 'SQL' }
]
const MASKS: MaskMode[] = ['none', 'full', 'start', 'end', 'middle', 'email', 'empty']
const LS_FORMAT = 'db.export.format'
const PREVIEW_ROWS = 5

// Export settings: format, which rows (loaded / all re-read from the server /
// a range), which columns and how each is masked. Main writes the file.
export default function ExportDialog({
  connId,
  db,
  columns,
  rows,
  sql,
  truncated,
  total,
  name,
  table,
  onClose
}: {
  connId: string
  db: string | undefined
  columns: QueryColumn[]
  rows: Cell[][]
  /** The (viewed) query, re-read for "all" / a range; null when it can't be re-run. */
  sql: string | null
  truncated: boolean
  total?: number
  name: string
  table: string
  onClose: () => void
}): JSX.Element {
  const t = useT()
  const server = sql !== null && truncated
  const [format, setFormat] = useState<ExportFormat>(() => {
    const f = localStorage.getItem(LS_FORMAT)
    return FORMATS.some((x) => x.value === f) ? (f as ExportFormat) : 'xlsx'
  })
  const [scope, setScope] = useState<Scope>(server ? 'all' : 'loaded')
  const [from, setFrom] = useState(1)
  const [count, setCount] = useState(Math.min(rows.length, 1000) || 1000)
  const [cols, setCols] = useState<Col[]>(() =>
    columns.map((c, index) => ({ index, name: c.name, type: c.type, mask: suggestMask(c.name), on: true }))
  )
  const [header, setHeader] = useState(true)
  const [bom, setBom] = useState(true)
  const [nullText, setNullText] = useState('')
  const [target, setTarget] = useState(table)
  const [busy, setBusy] = useState<{ queryId: string; n: number } | null>(null)
  const [status, setStatus] = useState<{ ok: boolean; text: string; path?: string } | null>(null)

  useEffect(
    () => window.api.db.onExportProgress((id, n) => setBusy((b) => (b && b.queryId === id ? { ...b, n } : b))),
    []
  )
  useEffect(() => {
    const esc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', esc)
    return () => window.removeEventListener('keydown', esc)
  }, [busy, onClose])

  const picked = useMemo<ExportColumn[]>(() => cols.filter((c) => c.on).map(({ on: _on, ...c }) => c), [cols])
  const start = Math.max(0, Math.floor(from) - 1)
  const size = Math.max(1, Math.floor(count))
  const localRows = scope === 'range' && !server ? rows.slice(start, start + size) : rows
  const preview = useMemo(
    () => (scope === 'range' && server ? [] : localRows.slice(0, PREVIEW_ROWS).map((r) => projectRow(r, picked))),
    [localRows, picked, scope, server]
  )
  const sample = preview.length ? preview : rows.slice(0, PREVIEW_ROWS).map((r) => projectRow(r, picked))
  const estimate = scope === 'loaded' ? rows.length : scope === 'range' ? (server ? size : localRows.length) : total
  const delim = format === 'csv' || format === 'tsv'

  const setCol = (i: number, p: Partial<Col>): void => setCols((cs) => cs.map((c, j) => (j === i ? { ...c, ...p } : c)))
  const allOn = cols.every((c) => c.on)

  const run = async (): Promise<void> => {
    if (!picked.length || busy) return
    localStorage.setItem(LS_FORMAT, format)
    const options: ExportOptions = { format, columns: picked, header, nullText, bom, table: target.trim() || 'result' }
    const queryId = dbUid()
    setBusy({ queryId, n: 0 })
    setStatus(null)
    const req =
      scope === 'loaded' || (scope === 'range' && !server)
        ? { options, name, rows: localRows, queryId }
        : { options, name, sql: sql!, offset: scope === 'range' ? start : 0, max: scope === 'range' ? size : undefined, queryId }
    try {
      const r = await window.api.db.export(connId, db, req)
      if (r) setStatus({ ok: true, text: t('db.x.done', { n: r.rows.toLocaleString() }), path: r.path })
    } catch (e) {
      setStatus({ ok: false, text: errText(e) })
    } finally {
      setBusy(null)
    }
  }

  const scopes: Array<{ value: Scope; label: string }> = server
    ? [
        { value: 'all', label: total !== undefined ? t('db.x.allN', { n: total.toLocaleString() }) : t('db.x.all') },
        { value: 'loaded', label: t('db.x.loaded', { n: rows.length.toLocaleString() }) },
        { value: 'range', label: t('db.x.range') }
      ]
    : [
        { value: 'loaded', label: t('db.x.allN', { n: rows.length.toLocaleString() }) },
        { value: 'range', label: t('db.x.range') }
      ]

  return createPortal(
    <div className="modal-overlay" onClick={() => !busy && onClose()}>
      <div className="modal dbx-form dbx-export" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span>{t('db.x.title')}</span>
        </div>
        <div className="dbx-form-body">
          <Row label={t('db.x.format')}>
            <Segmented value={format} options={FORMATS} onChange={setFormat} />
          </Row>
          <Row label={t('db.x.scope')}>
            <Segmented value={scope} options={scopes} onChange={setScope} />
          </Row>
          {scope === 'range' && (
            <Row label={t('db.x.rangeRows')}>
              <div className="dbx-form-pair">
                <label className="dbx-form-inline">
                  {t('db.x.from')}
                  <NumberInput min={1} value={from} onChange={(e) => setFrom(Number(e.target.value) || 1)} />
                </label>
                <label className="dbx-form-inline">
                  {t('db.x.count')}
                  <NumberInput min={1} value={count} onChange={(e) => setCount(Number(e.target.value) || 1)} />
                </label>
              </div>
            </Row>
          )}
          {format === 'xlsx' && estimate !== undefined && estimate > XLSX_MAX_ROWS && (
            <div className="dbx-form-status err">{t('db.x.xlsxCap', { n: XLSX_MAX_ROWS.toLocaleString() })}</div>
          )}
          {format !== 'json' && (
            <Row label={t('db.x.header')}>
              <Switch checked={header} onChange={setHeader} />
            </Row>
          )}
          {delim && (
            <>
              <Row label={t('db.x.bom')} hint={t('db.x.bomHint')}>
                <Switch checked={bom} onChange={setBom} />
              </Row>
              <Row label={t('db.x.null')}>
                <TextInput value={nullText} placeholder={t('db.x.nullEmpty')} onChange={(e) => setNullText(e.target.value)} />
              </Row>
            </>
          )}
          {format === 'sql' && (
            <Row label={t('db.x.table')}>
              <TextInput value={target} onChange={(e) => setTarget(e.target.value)} />
            </Row>
          )}
          <div className="dbx-form-sect dbx-x-sect">
            <span>
              {t('db.x.columns')} ({picked.length}/{cols.length})
            </span>
            <button className="dbx-link" onClick={() => setCols((cs) => cs.map((c) => ({ ...c, on: !allOn })))}>
              {allOn ? t('db.x.noneCols') : t('db.x.allCols')}
            </button>
          </div>
          <div className="dbx-x-cols">
            {cols.map((c, i) => (
              <div key={i} className={`dbx-x-col${c.on ? '' : ' off'}`}>
                <Switch checked={c.on} onChange={(on) => setCol(i, { on })} />
                <span className="dbx-x-name" title={c.name}>
                  {c.name}
                </span>
                <span className="dbx-x-type">{c.type}</span>
                <Select value={c.mask} disabled={!c.on} onChange={(e) => setCol(i, { mask: e.target.value as MaskMode })}>
                  {MASKS.map((m) => (
                    <option key={m} value={m}>
                      {t(`db.mask.${m}`)}
                    </option>
                  ))}
                </Select>
                {c.mask === 'start' || c.mask === 'end' ? (
                  <NumberInput
                    className="dbx-x-keep"
                    min={0}
                    title={t('db.x.keep')}
                    value={c.keep ?? (c.mask === 'start' ? 1 : 4)}
                    onChange={(e) => setCol(i, { keep: Math.max(0, Number(e.target.value) || 0) })}
                  />
                ) : (
                  <span className="dbx-x-keep" />
                )}
              </div>
            ))}
          </div>
          {picked.length > 0 && sample.length > 0 && (
            <>
              <div className="dbx-form-sect">{t('db.x.preview')}</div>
              <div className="dbx-x-preview">
                <table className="dbx-table">
                  <thead>
                    <tr>
                      {picked.map((c) => (
                        <th key={c.index}>{c.name}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {sample.map((r, i) => (
                      <tr key={i}>
                        {r.map((v, j) => (
                          <td key={j} className={v === null ? 'dbx-dim' : undefined}>
                            {v === null ? (delim ? nullText || 'NULL' : 'NULL') : String(v).slice(0, 80)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
        {busy ? (
          <div className="dbx-form-status">{t('db.x.running', { n: busy.n.toLocaleString() })}</div>
        ) : (
          status && (
            <div className={`dbx-form-status${status.ok ? ' ok' : ' err'}`}>
              {status.text}
              {status.path && (
                <>
                  {' '}
                  <span className="dbx-meta">{status.path}</span>{' '}
                  <button className="dbx-link" onClick={() => void window.api.workspace.reveal(status.path!)}>
                    {t('db.x.reveal')}
                  </button>
                </>
              )}
            </div>
          )
        )}
        <div className="dbx-form-foot">
          {!picked.length && <span className="dbx-warn">{t('db.x.noCols')}</span>}
          <span className="dbx-spacer" />
          {busy ? (
            <Button onClick={() => void window.api.db.cancel(connId, busy.queryId)}>{t('db.cancel')}</Button>
          ) : (
            <Button variant="ghost" onClick={onClose}>
              {status?.ok ? t('common.close') : t('common.cancel')}
            </Button>
          )}
          <Button variant="primary" disabled={!!busy || !picked.length} onClick={() => void run()}>
            {t('db.x.run')}
          </Button>
        </div>
      </div>
    </div>,
    document.body
  )
}
