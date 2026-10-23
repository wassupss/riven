import { useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { columnNames, ENCODINGS, guessType, type CsvEncoding, type ImportOptions, type ImportPreview, type ImportResult } from '../../../../../main/db/csv'
import type { ColumnInfo } from '../../../../../main/db/types'
import { useT } from '../../../i18n'
import { dbUid } from '../../../state/db'
import { Button, Segmented, Select, Switch, TextInput } from '../../../components/ui/Controls'
import { Row, errText } from './ConnectionForm'

type Mode = 'existing' | 'new'
interface NewCol {
  on: boolean
  name: string
  type: string
}

const DELIMS: Array<{ value: string; label: string }> = [
  { value: ',', label: ',' },
  { value: ';', label: ';' },
  { value: '\t', label: 'Tab' },
  { value: '|', label: '|' }
]
const TYPES = ['text', 'integer', 'bigint', 'numeric', 'boolean', 'date', 'timestamp', 'timestamptz', 'uuid', 'jsonb']
const LS_ENC = 'db.import.encoding'
const PREVIEW_ROWS = 5

const baseName = (p: string): string =>
  (p.split(/[\\/]/).pop() ?? 'import')
    .replace(/\.[^.]+$/, '')
    .replace(/[^\p{L}\p{N}_]+/gu, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase() || 'import'

// Loads a CSV/TSV file into a new or existing table: encoding, delimiter and
// header, a column mapping, NULL rules, then one transaction in main.
export default function ImportDialog({
  connId,
  db,
  schema,
  table,
  onClose,
  onDone
}: {
  connId: string
  db: string | undefined
  schema: string
  /** Import into this table; otherwise the dialog offers a new one or any table in the schema. */
  table?: string
  onClose: () => void
  onDone: (table: string, created: boolean) => void
}): JSX.Element | null {
  const t = useT()
  const [path, setPath] = useState<string | null>(null)
  const [encoding, setEncoding] = useState<CsvEncoding>(() => {
    const e = localStorage.getItem(LS_ENC)
    return (ENCODINGS as readonly string[]).includes(e ?? '') ? (e as CsvEncoding) : 'utf-8'
  })
  const [delimiter, setDelimiter] = useState<string | undefined>(undefined)
  const [header, setHeader] = useState(true)
  const [preview, setPreview] = useState<ImportPreview | null>(null)
  const [mode, setMode] = useState<Mode>(table ? 'existing' : 'new')
  const [tables, setTables] = useState<string[]>([])
  const [target, setTarget] = useState(table ?? '')
  const [newName, setNewName] = useState('')
  const [targetCols, setTargetCols] = useState<ColumnInfo[]>([])
  // Existing table: target column -> source field (-1 = none).
  const [map, setMap] = useState<number[]>([])
  const [newCols, setNewCols] = useState<NewCol[]>([])
  const [emptyAsNull, setEmptyAsNull] = useState(true)
  const [nullText, setNullText] = useState('')
  const [truncate, setTruncate] = useState(false)
  const [onError, setOnError] = useState<'abort' | 'skip'>('abort')
  const [busy, setBusy] = useState<{ queryId: string; rows: number; pct: number } | null>(null)
  const [status, setStatus] = useState<{ ok: boolean; text: string; result?: ImportResult } | null>(null)

  const pickFile = useCallback(async (): Promise<void> => {
    const p = await window.api.db.import.pick()
    if (p) {
      setPath(p)
      setDelimiter(undefined)
      setStatus(null)
      setNewName((n) => n || baseName(p))
    } else if (!path) onClose()
  }, [path, onClose])

  useEffect(() => {
    void pickFile()
    // Only on open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!path) return
    let alive = true
    window.api.db.import
      .preview(path, encoding, delimiter)
      .then((p) => {
        if (!alive) return
        setPreview(p)
        if (!delimiter) setDelimiter(p.delimiter)
      })
      .catch((e) => alive && setStatus({ ok: false, text: errText(e) }))
    return () => {
      alive = false
    }
  }, [path, encoding, delimiter])

  useEffect(() => {
    if (table) return
    let alive = true
    window.api.db
      .objects(connId, db, schema)
      .then((os) => alive && setTables(os.filter((o) => o.kind === 'table' || o.kind === 'partitioned').map((o) => o.name)))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [connId, db, schema, table])

  useEffect(() => {
    if (mode !== 'existing' || !target) {
      setTargetCols([])
      return
    }
    let alive = true
    window.api.db
      .table(connId, db, schema, target)
      .then((ti) => alive && setTargetCols(ti?.columns ?? []))
      .catch((e) => alive && setStatus({ ok: false, text: errText(e) }))
    return () => {
      alive = false
    }
  }, [connId, db, schema, target, mode])

  useEffect(() => window.api.db.import.onProgress((id, rows, bytes, size) =>
    setBusy((b) => (b && b.queryId === id ? { ...b, rows, pct: size ? Math.min(100, Math.round((bytes / size) * 100)) : 0 } : b))
  ), [])

  useEffect(() => {
    const esc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', esc)
    return () => window.removeEventListener('keydown', esc)
  }, [busy, onClose])

  const width = useMemo(() => Math.max(0, ...(preview?.rows.slice(0, 50).map((r) => r.length) ?? [0])), [preview])
  const fields = useMemo(() => columnNames(header ? preview?.rows[0] ?? null : null, width), [preview, header, width])
  const data = useMemo(() => (preview ? preview.rows.slice(header ? 1 : 0) : []), [preview, header])

  // Fresh guesses whenever the file's shape changes.
  useEffect(() => {
    setNewCols(fields.map((name, i) => ({ on: true, name, type: guessType(data.map((r) => r[i] ?? '')) })))
  }, [fields, data])

  // Existing table: match columns by name, else by position when there's no header.
  useEffect(() => {
    const lower = fields.map((f) => f.toLowerCase())
    setMap(
      targetCols.map((c, i) => {
        const j = lower.indexOf(c.name.toLowerCase())
        if (j >= 0) return j
        return !header && i < fields.length ? i : -1
      })
    )
  }, [targetCols, fields, header])

  const tableName = mode === 'new' ? newName.trim() : target
  const columns: ImportOptions['columns'] =
    mode === 'new'
      ? newCols.map((c, i) => ({ name: c.name.trim(), source: c.on ? i : null, type: c.type }))
      : targetCols.map((c, i) => ({ name: c.name, source: (map[i] ?? -1) >= 0 ? map[i] : null }))
  const mapped = columns.filter((c) => c.source !== null && c.name)
  const dupName = mode === 'new' && new Set(mapped.map((c) => c.name.toLowerCase())).size !== mapped.length
  const ready = !!path && !!preview && !!tableName && mapped.length > 0 && !dupName && !busy

  const run = async (): Promise<void> => {
    if (!ready || !path || !delimiter) return
    localStorage.setItem(LS_ENC, encoding)
    const queryId = dbUid()
    setBusy({ queryId, rows: 0, pct: 0 })
    setStatus(null)
    const o: ImportOptions = {
      path,
      encoding,
      delimiter,
      header,
      schema,
      table: tableName,
      create: mode === 'new',
      truncate: mode === 'existing' && truncate,
      columns,
      emptyAsNull,
      nullText: nullText || undefined,
      onError
    }
    try {
      const r = await window.api.db.import.run(connId, db, o, queryId)
      setStatus({
        ok: true,
        text: r.skipped ? t('db.imp.doneSkipped', { n: r.rows.toLocaleString(), s: r.skipped.toLocaleString() }) : t('db.imp.done', { n: r.rows.toLocaleString() }),
        result: r
      })
      onDone(tableName, mode === 'new')
    } catch (e) {
      setStatus({ ok: false, text: errText(e) })
    } finally {
      setBusy(null)
    }
  }

  if (!path) return null
  const sample = data.slice(0, PREVIEW_ROWS)
  const shownCols = mapped

  return createPortal(
    <div className="modal-overlay" onClick={() => !busy && onClose()}>
      <div className="modal dbx-form dbx-export dbx-imp" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span>{t('db.imp.title')}</span>
        </div>
        <div className="dbx-form-body">
          <Row label={t('db.imp.file')}>
            <div className="dbx-imp-file">
              <span className="dbx-x-name" title={path}>
                {path}
              </span>
              {preview && <span className="dbx-meta">{fmtSize(preview.size)}</span>}
              <Button disabled={!!busy} onClick={() => void pickFile()}>
                {t('db.imp.change')}
              </Button>
            </div>
          </Row>
          <Row label={t('db.imp.encoding')}>
            <Select value={encoding} onChange={(e) => setEncoding(e.target.value as CsvEncoding)}>
              {ENCODINGS.map((e) => (
                <option key={e} value={e}>
                  {e.toUpperCase()}
                </option>
              ))}
            </Select>
          </Row>
          <Row label={t('db.imp.delimiter')}>
            <Segmented value={delimiter ?? ','} options={DELIMS} onChange={setDelimiter} />
          </Row>
          <Row label={t('db.imp.header')}>
            <Switch checked={header} onChange={setHeader} />
          </Row>
          {!table && (
            <Row label={t('db.imp.target')}>
              <Segmented
                value={mode}
                options={[
                  { value: 'new', label: t('db.imp.newTable') },
                  { value: 'existing', label: t('db.imp.existing') }
                ]}
                onChange={setMode}
              />
            </Row>
          )}
          <Row label={t('db.imp.table')}>
            {mode === 'new' ? (
              <TextInput value={newName} onChange={(e) => setNewName(e.target.value)} />
            ) : table ? (
              <span className="dbx-x-name">
                {schema}.{table}
              </span>
            ) : (
              <Select value={target} onChange={(e) => setTarget(e.target.value)}>
                <option value="">{t('db.imp.pickTable')}</option>
                {tables.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </Select>
            )}
          </Row>
          <Row label={t('db.imp.emptyNull')}>
            <Switch checked={emptyAsNull} onChange={setEmptyAsNull} />
          </Row>
          <Row label={t('db.imp.nullText')} hint={t('db.imp.nullTextHint')}>
            <TextInput value={nullText} placeholder="NULL, \N" onChange={(e) => setNullText(e.target.value)} />
          </Row>
          {mode === 'existing' && (
            <Row label={t('db.imp.truncate')}>
              <Switch checked={truncate} onChange={setTruncate} />
            </Row>
          )}
          <Row label={t('db.imp.onError')}>
            <Segmented
              value={onError}
              options={[
                { value: 'abort', label: t('db.imp.abort') },
                { value: 'skip', label: t('db.imp.skip') }
              ]}
              onChange={setOnError}
            />
          </Row>

          <div className="dbx-form-sect">
            {t('db.imp.mapping')} ({mapped.length}/{mode === 'new' ? newCols.length : targetCols.length})
          </div>
          <div className="dbx-x-cols">
            {mode === 'new'
              ? newCols.map((c, i) => (
                  <div key={i} className={`dbx-imp-col${c.on ? '' : ' off'}`}>
                    <Switch checked={c.on} onChange={(on) => setNewCols((cs) => cs.map((x, j) => (j === i ? { ...x, on } : x)))} />
                    <span className="dbx-x-type" title={fields[i]}>
                      {fields[i]}
                    </span>
                    <TextInput
                      value={c.name}
                      disabled={!c.on}
                      onChange={(e) => setNewCols((cs) => cs.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
                    />
                    <TextInput
                      list="dbx-imp-types"
                      value={c.type}
                      disabled={!c.on}
                      onChange={(e) => setNewCols((cs) => cs.map((x, j) => (j === i ? { ...x, type: e.target.value } : x)))}
                    />
                  </div>
                ))
              : targetCols.map((c, i) => (
                  <div key={c.name} className={`dbx-imp-col${(map[i] ?? -1) >= 0 ? '' : ' off'}`}>
                    <span />
                    <span className="dbx-x-name" title={c.name}>
                      {c.name}
                    </span>
                    <span className="dbx-x-type">{c.type}</span>
                    <Select value={map[i] ?? -1} onChange={(e) => setMap((m) => m.map((x, j) => (j === i ? Number(e.target.value) : x)))}>
                      <option value={-1}>{c.default !== null || c.nullable ? t('db.imp.skipCol') : t('db.imp.skipColReq')}</option>
                      {fields.map((f, j) => (
                        <option key={j} value={j}>
                          {j + 1}. {f}
                        </option>
                      ))}
                    </Select>
                  </div>
                ))}
            <datalist id="dbx-imp-types">
              {TYPES.map((x) => (
                <option key={x} value={x} />
              ))}
            </datalist>
          </div>
          {dupName && <div className="dbx-form-status err">{t('db.imp.dupName')}</div>}

          {shownCols.length > 0 && sample.length > 0 && (
            <>
              <div className="dbx-form-sect">
                {t('db.imp.preview')}
                {preview?.more ? '' : ` (${data.length.toLocaleString()} ${t('db.imp.rows')})`}
              </div>
              <div className="dbx-x-preview">
                <table className="dbx-table">
                  <thead>
                    <tr>
                      {shownCols.map((c) => (
                        <th key={c.name}>{c.name}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {sample.map((r, i) => (
                      <tr key={i}>
                        {shownCols.map((c) => {
                          const v = r[c.source as number]
                          const isNull = v === undefined || (emptyAsNull && v === '') || (!!nullText && v === nullText)
                          return (
                            <td key={c.name} className={isNull ? 'dbx-dim' : undefined}>
                              {isNull ? 'NULL' : v.slice(0, 80)}
                            </td>
                          )
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
        {busy ? (
          <div className="dbx-form-status">
            <div className="dbx-imp-bar">
              <div style={{ width: `${busy.pct}%` }} />
            </div>
            {t('db.imp.running', { n: busy.rows.toLocaleString(), p: busy.pct })}
          </div>
        ) : (
          status && (
            <div className={`dbx-form-status${status.ok ? ' ok' : ' err'}`}>
              {status.text}
              {!!status.result?.errors.length && (
                <ul className="dbx-imp-errs">
                  {status.result.errors.map((er, i) => (
                    <li key={i}>
                      #{er.record}: {er.message}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )
        )}
        <div className="dbx-form-foot">
          <span className="dbx-spacer" />
          {busy ? (
            <Button onClick={() => void window.api.db.import.cancel(connId, busy.queryId)}>{t('db.cancel')}</Button>
          ) : (
            <Button variant="ghost" onClick={onClose}>
              {status?.ok ? t('common.close') : t('common.cancel')}
            </Button>
          )}
          <Button variant="primary" disabled={!ready || status?.ok === true} onClick={() => void run()}>
            {t('db.imp.run')}
          </Button>
        </div>
      </div>
    </div>,
    document.body
  )
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 ** 3).toFixed(2)} GB`
}
