import { useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ArchiveInfo, BackupOptions, DumpContent, DumpFormat, RestoreOptions, ToolInfo } from '../../../../../main/db/dumpArgs'
import { useT } from '../../../i18n'
import { dbUid } from '../../../state/db'
import { Button, NumberInput, Segmented, Select, Switch, TextInput } from '../../../components/ui/Controls'
import { Row, errText } from './ConnectionForm'

type Scope = 'db' | 'schemas' | 'table'
const LS_TOOL = 'db.backup.tool'
const LS_DIR = 'db.backup.toolDir'
const LS_FMT = 'db.backup.format'
const FORMATS: DumpFormat[] = ['custom', 'plain', 'directory', 'tar']

// Backup with pg_dump, restore with pg_restore (archives) or psql (plain SQL).
// The tools run in main; this picks what to dump or restore and shows progress.
export default function BackupDialog({
  mode,
  connId,
  db,
  schema,
  table,
  onClose,
  onRestored
}: {
  mode: 'backup' | 'restore'
  connId: string
  db: string
  /** Backup: start with only this schema selected. */
  schema?: string
  /** Backup: only this table (in `schema`). */
  table?: string
  onClose: () => void
  onRestored?: () => void
}): JSX.Element | null {
  const t = useT()
  const [tools, setTools] = useState<ToolInfo[] | null>(null)
  const [toolDir, setToolDir] = useState(() => localStorage.getItem(LS_TOOL) ?? '')
  const [extra, setExtra] = useState(() => localStorage.getItem(LS_DIR) ?? '')
  const [server, setServer] = useState<number | null>(null)
  const [busy, setBusy] = useState<{ jobId: string; obj: string | null; lines: number } | null>(null)
  const [status, setStatus] = useState<{ ok: boolean; text: string; details?: string[] } | null>(null)

  // Backup
  const [scope, setScope] = useState<Scope>(table ? 'table' : schema ? 'schemas' : 'db')
  const [allSchemas, setAllSchemas] = useState<string[]>([])
  const [picked, setPicked] = useState<Set<string>>(() => new Set(schema ? [schema] : []))
  const [format, setFormat] = useState<DumpFormat>(() => {
    const f = localStorage.getItem(LS_FMT) as DumpFormat | null
    return f && FORMATS.includes(f) ? f : 'custom'
  })
  const [content, setContent] = useState<DumpContent>('all')
  const [noOwner, setNoOwner] = useState(false)
  const [noPrivileges, setNoPrivileges] = useState(false)
  const [clean, setClean] = useState(false)
  const [create, setCreate] = useState(false)
  const [rows, setRows] = useState<BackupOptions['rows']>('copy')
  const [compress, setCompress] = useState(6)
  const [jobs, setJobs] = useState(1)

  // Restore
  const [path, setPath] = useState<string | null>(null)
  const [info, setInfo] = useState<ArchiveInfo | null>(null)
  const [rSchemas, setRSchemas] = useState<Set<string>>(() => new Set())
  const [single, setSingle] = useState(false)
  const [exitOnError, setExitOnError] = useState(false)

  const loadTools = useCallback(
    (refresh: boolean): void => {
      setTools(null)
      window.api.db.backup
        .tools(extra.trim() || undefined, refresh)
        .then(setTools)
        .catch((e) => {
          setTools([])
          setStatus({ ok: false, text: errText(e) })
        })
    },
    [extra]
  )

  useEffect(() => {
    loadTools(false)
    // Only on open; the folder field reloads explicitly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    let alive = true
    window.api.db.backup
      .serverMajor(connId, db)
      .then((m) => alive && setServer(m))
      .catch(() => {})
    if (mode === 'backup')
      window.api.db
        .schemas(connId, db)
        .then((ss) => alive && setAllSchemas(ss.map((s) => s.name)))
        .catch(() => {})
    return () => {
      alive = false
    }
  }, [connId, db, mode])

  useEffect(() => window.api.db.backup.onProgress((id, obj, lines) => setBusy((b) => (b && b.jobId === id ? { ...b, obj, lines } : b))), [])

  useEffect(() => {
    const esc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', esc)
    return () => window.removeEventListener('keydown', esc)
  }, [busy, onClose])

  const tool = useMemo(() => tools?.find((x) => x.dir === toolDir) ?? tools?.[0], [tools, toolDir])
  // pg_dump refuses servers newer than itself.
  const tooOld = !!tool && server !== null && tool.major < server

  const pickArchive = useCallback(
    async (dir: boolean): Promise<void> => {
      const p = await window.api.db.backup.pick(dir)
      if (!p) return
      setPath(p)
      setInfo(null)
      setStatus(null)
      try {
        const a = await window.api.db.backup.inspect(p, tool?.dir, extra.trim() || undefined)
        setInfo(a)
        setRSchemas(new Set())
        if (a.format === 'plain') setSingle(true)
      } catch (e) {
        setStatus({ ok: false, text: errText(e) })
      }
    },
    [tool, extra]
  )

  const toggle = (set: Set<string>, v: string): Set<string> => {
    const n = new Set(set)
    if (n.has(v)) n.delete(v)
    else n.add(v)
    return n
  }

  const backupOpts = (): BackupOptions => ({
    format,
    content,
    schemas: scope === 'schemas' ? [...picked] : [],
    tables: scope === 'table' && schema && table ? [[schema, table]] : [],
    noOwner,
    noPrivileges,
    clean,
    create,
    rows,
    compress,
    jobs
  })

  const ready =
    !!tool &&
    !busy &&
    (mode === 'backup' ? scope !== 'schemas' || picked.size > 0 : !!info && (info.format === 'plain' ? !!tool.psql : !!tool.pgRestore))

  const run = async (): Promise<void> => {
    if (!ready || !tool) return
    localStorage.setItem(LS_TOOL, tool.dir)
    localStorage.setItem(LS_DIR, extra.trim())
    const jobId = dbUid()
    setBusy({ jobId, obj: null, lines: 0 })
    setStatus(null)
    try {
      if (mode === 'backup') {
        localStorage.setItem(LS_FMT, format)
        const name = scope === 'table' && table ? `${db}_${table}` : scope === 'schemas' && picked.size === 1 ? `${db}_${[...picked][0]}` : db
        const r = await window.api.db.backup.run(connId, db, tool.dir, extra.trim() || undefined, name, backupOpts(), jobId)
        if (r) setStatus({ ok: true, text: t('db.bk.done', { path: r.path, size: fmtSize(r.size) }) })
      } else if (info) {
        const o: RestoreOptions = {
          path: info.path,
          format: info.format,
          content,
          schemas: info.format === 'plain' ? [] : [...rSchemas],
          clean: info.format !== 'plain' && clean,
          noOwner,
          noPrivileges,
          singleTransaction: single,
          exitOnError,
          jobs
        }
        const r = await window.api.db.backup.restore(connId, db, tool.dir, extra.trim() || undefined, o, jobId)
        setStatus(
          r.ignored
            ? { ok: true, text: t('db.bk.restoredWarn', { n: r.ignored }), details: r.errors }
            : { ok: true, text: t('db.bk.restored') }
        )
        onRestored?.()
      }
    } catch (e) {
      const text = errText(e)
      setStatus({ ok: false, text: text === 'Cancelled' ? t('db.bk.cancelled') : text })
    } finally {
      setBusy(null)
    }
  }

  const plain = mode === 'restore' ? info?.format === 'plain' : format === 'plain'
  const archive = mode === 'restore' && !!info && info.format !== 'plain'

  return createPortal(
    <div className="modal-overlay" onClick={() => !busy && onClose()}>
      <div className="modal dbx-form dbx-export dbx-bk" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span>
            {mode === 'backup' ? t('db.bk.title') : t('db.bk.restoreTitle')} · {db}
          </span>
        </div>
        <div className="dbx-form-body">
          <Row label={t('db.bk.tool')} hint={t('db.bk.toolHint')}>
            <div className="dbx-imp-file">
              {tools === null ? (
                <span className="dbx-meta">{t('db.bk.searching')}</span>
              ) : tools.length ? (
                <Select value={tool?.dir ?? ''} onChange={(e) => setToolDir(e.target.value)}>
                  {tools.map((x) => (
                    <option key={x.dir} value={x.dir}>
                      {x.version} · {x.dir}
                    </option>
                  ))}
                </Select>
              ) : (
                <span className="dbx-form-status err dbx-bk-inline">{t('db.bk.noTool')}</span>
              )}
            </div>
          </Row>
          <Row label={t('db.bk.toolDir')}>
            <div className="dbx-imp-file">
              <TextInput value={extra} placeholder={t('db.bk.toolDirPh')} onChange={(e) => setExtra(e.target.value)} />
              <Button disabled={!!busy} onClick={() => loadTools(true)}>
                {t('db.bk.rescan')}
              </Button>
            </div>
          </Row>
          {tooOld && tool && <div className="dbx-form-status err">{t('db.bk.tooOld', { tool: tool.version, server: String(server) })}</div>}

          {mode === 'backup' ? (
            <>
              <Row label={t('db.bk.scope')}>
                {table ? (
                  <span className="dbx-x-name">
                    {schema}.{table}
                  </span>
                ) : (
                  <Segmented
                    value={scope}
                    options={[
                      { value: 'db', label: t('db.bk.wholeDb') },
                      { value: 'schemas', label: t('db.bk.someSchemas') }
                    ]}
                    onChange={setScope}
                  />
                )}
              </Row>
              {scope === 'schemas' && (
                <div className="dbx-bk-chips">
                  {allSchemas.map((s) => (
                    <button key={s} className={`dbx-chip${picked.has(s) ? ' on' : ''}`} onClick={() => setPicked((p) => toggle(p, s))}>
                      {s}
                    </button>
                  ))}
                </div>
              )}
              <Row label={t('db.bk.format')}>
                <Segmented
                  value={format}
                  options={FORMATS.map((f) => ({ value: f, label: t(`db.bk.fmt.${f}`) }))}
                  onChange={setFormat}
                />
              </Row>
              <div className="dbx-form-hint dbx-bk-note">{t(`db.bk.fmtHint.${format}`)}</div>
            </>
          ) : (
            <>
              <Row label={t('db.bk.file')}>
                <div className="dbx-imp-file">
                  <span className="dbx-x-name" title={path ?? ''}>
                    {path ?? t('db.bk.noFile')}
                  </span>
                  {info && <span className="dbx-meta">{fmtSize(info.size)}</span>}
                  <Button disabled={!!busy} onClick={() => void pickArchive(false)}>
                    {t('db.bk.pickFile')}
                  </Button>
                  <Button disabled={!!busy} onClick={() => void pickArchive(true)}>
                    {t('db.bk.pickDir')}
                  </Button>
                </div>
              </Row>
              {info && (
                <div className="dbx-bk-info">
                  <span>{t(`db.bk.fmt.${info.format}`)}</span>
                  {info.database && <span>DB {info.database}</span>}
                  {info.serverVersion && <span>{t('db.bk.from', { v: info.serverVersion })}</span>}
                  {info.dumpVersion && <span>pg_dump {info.dumpVersion}</span>}
                  {Object.entries(info.counts)
                    .filter(([k]) => ['TABLE', 'TABLE DATA', 'VIEW', 'INDEX', 'FUNCTION', 'SEQUENCE'].includes(k))
                    .map(([k, n]) => (
                      <span key={k}>
                        {k} {n}
                      </span>
                    ))}
                </div>
              )}
              {archive && info && info.schemas.length > 0 && (
                <Row label={t('db.bk.rSchemas')} hint={t('db.bk.rSchemasHint')}>
                  <div className="dbx-bk-chips">
                    {info.schemas.map((s) => (
                      <button key={s} className={`dbx-chip${rSchemas.has(s) ? ' on' : ''}`} onClick={() => setRSchemas((p) => toggle(p, s))}>
                        {s}
                      </button>
                    ))}
                  </div>
                </Row>
              )}
            </>
          )}

          {(mode === 'backup' || archive) && (
            <>
              <Row label={t('db.bk.content')}>
                <Segmented
                  value={content}
                  options={[
                    { value: 'all', label: t('db.bk.cAll') },
                    { value: 'schema', label: t('db.bk.cSchema') },
                    { value: 'data', label: t('db.bk.cData') }
                  ]}
                  onChange={setContent}
                />
              </Row>
              <Row label={t('db.bk.noOwner')} hint={t('db.bk.noOwnerHint')}>
                <Switch checked={noOwner} onChange={setNoOwner} />
              </Row>
              <Row label={t('db.bk.noPrivileges')}>
                <Switch checked={noPrivileges} onChange={setNoPrivileges} />
              </Row>
            </>
          )}

          {((mode === 'backup' && plain) || archive) && content !== 'data' && (
            <Row label={t('db.bk.clean')} hint={mode === 'restore' ? t('db.bk.cleanHintR') : t('db.bk.cleanHint')}>
              <Switch checked={clean} onChange={setClean} />
            </Row>
          )}
          {mode === 'backup' && plain && content !== 'data' && (
            <Row label={t('db.bk.create')}>
              <Switch checked={create} onChange={setCreate} />
            </Row>
          )}
          {mode === 'backup' && content !== 'schema' && (
            <Row label={t('db.bk.rows')}>
              <Segmented
                value={rows}
                options={[
                  { value: 'copy', label: 'COPY' },
                  { value: 'inserts', label: 'INSERT' },
                  { value: 'column-inserts', label: t('db.bk.colInserts') }
                ]}
                onChange={setRows}
              />
            </Row>
          )}
          {mode === 'backup' && (format === 'custom' || format === 'directory') && (
            <Row label={t('db.bk.compress')}>
              <NumberInput min={0} max={9} value={compress} onChange={(e) => setCompress(Math.min(9, Math.max(0, Number(e.target.value) || 0)))} />
            </Row>
          )}
          {mode === 'restore' && info && (
            <>
              <Row label={t('db.bk.single')} hint={t('db.bk.singleHint')}>
                <Switch checked={single} onChange={setSingle} />
              </Row>
              <Row label={t('db.bk.exitOnError')}>
                <Switch checked={exitOnError} onChange={setExitOnError} />
              </Row>
            </>
          )}
          {((mode === 'backup' && format === 'directory') || (archive && !single)) && (
            <Row label={t('db.bk.jobs')}>
              <NumberInput min={1} max={16} value={jobs} onChange={(e) => setJobs(Math.min(16, Math.max(1, Number(e.target.value) || 1)))} />
            </Row>
          )}
          {mode === 'restore' && info && <div className="dbx-form-status err">{t('db.bk.restoreWarn', { db })}</div>}
        </div>
        {busy ? (
          <div className="dbx-form-status">
            <div className="dbx-imp-bar dbx-bk-bar">
              <div />
            </div>
            {busy.obj ? t('db.bk.working', { obj: busy.obj }) : t('db.bk.starting')}
          </div>
        ) : (
          status && (
            <div className={`dbx-form-status${status.ok ? ' ok' : ' err'}`}>
              <span className="dbx-bk-msg">{status.text}</span>
              {!!status.details?.length && (
                <ul className="dbx-imp-errs">
                  {status.details.map((d, i) => (
                    <li key={i}>{d}</li>
                  ))}
                </ul>
              )}
            </div>
          )
        )}
        <div className="dbx-form-foot">
          <span className="dbx-spacer" />
          {busy ? (
            <Button onClick={() => void window.api.db.backup.cancel(busy.jobId)}>{t('db.cancel')}</Button>
          ) : (
            <Button variant="ghost" onClick={onClose}>
              {status?.ok ? t('common.close') : t('common.cancel')}
            </Button>
          )}
          <Button variant="primary" disabled={!ready || status?.ok === true} onClick={() => void run()}>
            {mode === 'backup' ? t('db.bk.run') : t('db.bk.restoreRun')}
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
