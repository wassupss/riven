import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as monaco from 'monaco-editor'
import { Check, Database, FileCode2, Lock, PencilRuler, Play, Plus, ShieldCheck, Square, Table2, Undo2, Users, X } from 'lucide-react'
import '../../styles/db-panel.css'
import type { DbKind, QueryResult } from '../../../../main/db/types'
import { splitStatements, statements, unsafeStatement } from '../../../../main/db/sqlText'
import { editorTheme } from '../../editor/highlight'
import { useT } from '../../i18n'
import { dbUid, useDb, type RunResult, type RunState, type SqlTab } from '../../state/db'
import { Button, Select, Switch } from '../../components/ui/Controls'
import ResultPane from './db/ResultPane'
import ObjectView from './db/ObjectView'
import TableDesigner from './db/TableDesigner'
import RolesView from './db/RolesView'
import PrivsView from './db/PrivsView'
import { errText } from './db/ConnectionForm'

// =============================================================================
// DbConsolePanel: tabbed SQL consoles and object views. One Monaco editor is
// shared by every SQL tab (a model per tab), so ten open consoles cost one
// editor. Each run executes statement by statement (the engine's cursor runs a
// single statement per call) and stops at the first error.
// =============================================================================

const LIMITS = [100, 500, 1000, 5000, 10000]
const LS_LIMIT = 'db.console.limit'
const LS_SPLIT = 'db.console.split'

/** The statement under (or just before) the cursor. */
function statementAt(text: string, offset: number, kind: DbKind): string[] {
  const ranges = splitStatements(text, kind)
  if (!ranges.length) return []
  let pick = ranges[0]
  for (const r of ranges) {
    const body = text.slice(r[0], r[1])
    const start = r[0] + body.length - body.trimStart().length
    if (start <= offset) pick = r
    else break
  }
  return [text.slice(pick[0], pick[1]).trim()]
}

export default function DbConsolePanel({ leading }: { leading?: JSX.Element }): JSX.Element {
  const t = useT()
  const tabs = useDb((s) => s.tabs)
  const active = useDb((s) => s.active)
  const connections = useDb((s) => s.connections)
  const loaded = useDb((s) => s.loaded)
  const reload = useDb((s) => s.reload)
  const setActive = useDb((s) => s.setActive)
  const closeTab = useDb((s) => s.closeTab)
  const openSql = useDb((s) => s.openSql)

  useEffect(() => {
    if (!loaded) void reload()
  }, [loaded, reload])

  const tab = tabs.find((x) => x.id === active) ?? null

  const newTab = (): void => {
    const connId = tab?.connId ?? connections[0]?.id
    if (connId) openSql(connId, tab?.db)
  }

  return (
    <div className="dbx-root dbx-console">
      <div className="dbx-tabs">
        {leading}
        {tabs.map((x) => {
          const conn = connections.find((c) => c.id === x.connId)
          return (
            <div
              key={x.id}
              className={`dbx-tab${x.id === active ? ' on' : ''}`}
              onClick={() => setActive(x.id)}
              onMouseDown={(e) => {
                if (e.button === 1) {
                  e.preventDefault()
                  closeTab(x.id)
                }
              }}
              title={conn ? `${conn.name}${x.db ? ` / ${x.db}` : ''}` : undefined}
            >
              {conn?.color && <span className="dbx-dot" style={{ background: conn.color }} />}
              {x.kind === 'sql' ? (
                <FileCode2 size={12} className="dbx-tab-ico sql" />
              ) : x.kind === 'design' ? (
                <PencilRuler size={12} className="dbx-tab-ico design" />
              ) : x.kind === 'roles' ? (
                <Users size={12} className="dbx-tab-ico roles" />
              ) : x.kind === 'privs' ? (
                <ShieldCheck size={12} className="dbx-tab-ico roles" />
              ) : (
                <Table2 size={12} className="dbx-tab-ico obj" />
              )}
              <span className="dbx-tab-title">{x.title}</span>
              <button
                className="dbx-tab-x"
                onClick={(e) => {
                  e.stopPropagation()
                  closeTab(x.id)
                }}
              >
                <X size={11} />
              </button>
            </div>
          )
        })}
        <button className="dbx-icon-btn" title={t('db.newConsole')} disabled={!connections.length} onClick={newTab}>
          <Plus size={14} />
        </button>
      </div>
      <div className="dbx-console-body">
        {/* Always mounted: the editor and its models outlive tab switches. */}
        <SqlView tab={tab?.kind === 'sql' ? tab : null} hidden={tab?.kind !== 'sql'} />
        {tab?.kind === 'object' && <ObjectView key={tab.id} tab={tab} />}
        {tab?.kind === 'design' && <TableDesigner key={tab.id} tab={tab} />}
        {tab?.kind === 'roles' && <RolesView key={tab.id} tab={tab} />}
        {tab?.kind === 'privs' && <PrivsView key={tab.id} tab={tab} />}
        {!tab && (
          <div className="dbx-empty-state">
            <Database size={28} />
            <div>{connections.length ? t('db.consoleEmpty') : t('db.noConnections')}</div>
            {connections.length > 0 && (
              <button className="dbx-link" onClick={newTab}>
                {t('db.newConsole')}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function SqlView({ tab, hidden }: { tab: SqlTab | null; hidden: boolean }): JSX.Element {
  const t = useT()
  const connections = useDb((s) => s.connections)
  const tabs = useDb((s) => s.tabs)
  const patchTab = useDb((s) => s.patchTab)
  const setRun = useDb((s) => s.setRun)
  const runState = useDb((s) => (tab ? s.runs[tab.id] : undefined))
  const autoRun = useDb((s) => s.autoRun)
  const clearAutoRun = useDb((s) => s.clearAutoRun)
  const tx = useDb((s) => (tab ? s.tx[tab.id] : undefined))
  const setTx = useDb((s) => s.setTx)
  const syncTx = useDb((s) => s.syncTx)
  const [ending, setEnding] = useState(false)
  const conn = connections.find((c) => c.id === tab?.connId)

  const hostRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const edRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const models = useRef(new Map<string, { model: monaco.editor.ITextModel; view: monaco.editor.ICodeEditorViewState | null; sub: monaco.IDisposable }>())
  const shownId = useRef<string | null>(null)
  const [limit, setLimit] = useState(() => Number(localStorage.getItem(LS_LIMIT)) || 1000)
  const [split, setSplit] = useState(() => Number(localStorage.getItem(LS_SPLIT)) || 0.3)
  const [dbs, setDbs] = useState<Record<string, string[]>>({})

  // Latest values for the Monaco command closure, which is bound once.
  const live = useRef({ tab, conn, limit, runState })
  live.current = { tab, conn, limit, runState }

  useEffect(() => {
    const ed = monaco.editor.create(hostRef.current!, {
      model: null,
      theme: editorTheme(),
      automaticLayout: true,
      minimap: { enabled: false },
      fontSize: 12,
      scrollBeyondLastLine: false,
      wordWrap: 'off',
      tabSize: 2
    })
    edRef.current = ed
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => void runRef.current())
    const ms = models.current
    return () => {
      ed.dispose()
      for (const m of ms.values()) {
        m.sub.dispose()
        m.model.dispose()
      }
      ms.clear()
      edRef.current = null
    }
  }, [])

  // Swap the editor onto this tab's model, keeping each tab's cursor and scroll.
  useEffect(() => {
    const ed = edRef.current
    if (!ed) return
    const prev = shownId.current && models.current.get(shownId.current)
    if (prev) prev.view = ed.saveViewState()
    if (!tab) {
      shownId.current = null
      return
    }
    let entry = models.current.get(tab.id)
    if (!entry) {
      const model = monaco.editor.createModel(tab.sql, 'sql')
      const id = tab.id
      let timer: ReturnType<typeof setTimeout> | null = null
      const sub = model.onDidChangeContent(() => {
        if (timer) clearTimeout(timer)
        timer = setTimeout(() => {
          timer = null
          if (!model.isDisposed()) patchTab(id, { sql: model.getValue() })
        }, 300)
      })
      entry = { model, view: null, sub }
      models.current.set(tab.id, entry)
    }
    shownId.current = tab.id
    ed.setModel(entry.model)
    if (entry.view) ed.restoreViewState(entry.view)
    if (!hidden) ed.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab?.id])

  // A closed tab's model goes with it.
  useEffect(() => {
    const ids = new Set(tabs.map((x) => x.id))
    for (const [id, m] of models.current) {
      if (ids.has(id)) continue
      if (shownId.current === id) {
        edRef.current?.setModel(null)
        shownId.current = null
      }
      m.sub.dispose()
      m.model.dispose()
      models.current.delete(id)
    }
  }, [tabs])

  // Databases on this tab's server, for the picker.
  useEffect(() => {
    const id = conn?.id
    if (!id || dbs[id]) return
    window.api.db
      .databases(id)
      .then((list) => setDbs((m) => ({ ...m, [id]: list })))
      .catch(() => setDbs((m) => ({ ...m, [id]: [] })))
  }, [conn?.id, dbs])

  const run = useCallback(async (): Promise<void> => {
    const { tab, conn, limit, runState } = live.current
    const ed = edRef.current
    const model = ed?.getModel()
    if (!tab || !conn || !ed || !model || runState?.running) return
    const sel = ed.getSelection()
    const list =
      sel && !sel.isEmpty()
        ? statements(model.getValueInRange(sel), conn.kind)
        : statementAt(model.getValue(), model.getOffsetAt(ed.getPosition() ?? { lineNumber: 1, column: 1 }), conn.kind)
    if (!list.length) return
    if (!conn.readOnly) {
      for (const sql of list) {
        const why = unsafeStatement(sql, conn.kind)
        if (why && !window.confirm(`${why}\n\n${sql.slice(0, 400)}\n\n${t('db.confirmRun')}`)) return
      }
    }
    const queryId = dbUid()
    const results: RunResult[] = []
    const session = tab.manual ? tab.id : undefined
    setRun(tab.id, { running: true, queryId, results, shown: 0 })
    for (const sql of list) {
      try {
        const result = await window.api.db.query(conn.id, tab.db, sql, { limit, queryId, session })
        results.push({ sql, result })
      } catch (e) {
        results.push({ sql, error: errText(e) })
        break
      }
      if (results.length < list.length) setRun(tab.id, { running: true, queryId, results: [...results], shown: results.length - 1 })
    }
    // Show the error if there was one, else the last result that has rows.
    const err = results.findIndex((r) => r.error)
    let shown = err
    if (shown < 0) {
      shown = results.length - 1
      for (let i = results.length - 1; i >= 0; i--)
        if (results[i].result?.columns.length) {
          shown = i
          break
        }
    }
    setRun(tab.id, { running: false, queryId, results: [...results], shown })
    if (session) void syncTx(tab.id)
  }, [setRun, syncTx, t])

  const runRef = useRef(run)
  runRef.current = run

  useEffect(() => {
    if (tab && autoRun === tab.id && edRef.current?.getModel()) {
      clearAutoRun()
      void run()
    }
  }, [autoRun, tab, run, clearAutoRun])

  const cancel = (): void => {
    if (conn && runState?.queryId) void window.api.db.cancel(conn.id, runState.queryId)
  }

  const startDrag = (e: React.MouseEvent): void => {
    e.preventDefault()
    const box = bodyRef.current!.getBoundingClientRect()
    let last = split
    const move = (ev: MouseEvent): void => {
      last = Math.min(0.85, Math.max(0.12, (ev.clientY - box.top) / box.height))
      setSplit(last)
    }
    const up = (): void => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      localStorage.setItem(LS_SPLIT, String(last))
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  const shown = runState?.results[runState.shown]
  const runId = runState?.queryId
  const shownIdx = runState?.shown ?? -1
  // Updates to the shown result (paging, sort, filter, count), dropped once a
  // new run or another result replaces it.
  const patchShown = useMemo(() => {
    const id = tab?.id
    const sql = shown?.sql
    return (fn: (r: RunResult) => RunResult): void => {
      if (!id) return
      setRun(id, (prev) => {
        if (!prev || prev.queryId !== runId || prev.results[shownIdx]?.sql !== sql) return prev as RunState
        const results = [...prev.results]
        results[shownIdx] = fn(results[shownIdx])
        return { ...prev, results }
      })
    }
  }, [tab?.id, runId, shownIdx, shown?.sql, setRun])
  const inTx = tx === 'active' || tx === 'failed'
  const endTx = (action: 'commit' | 'rollback'): void => {
    if (!tab || ending) return
    const id = tab.id
    setEnding(true)
    window.api.db.session[action](id)
      .then((s) => setTx(id, s))
      .catch((e) => {
        window.alert(errText(e))
        void syncTx(id)
      })
      .finally(() => setEnding(false))
  }
  const setManual = (manual: boolean): void => {
    if (!tab || inTx) return
    patchTab(tab.id, { manual })
    // Back to auto-commit: the idle session's connection is no longer needed.
    if (!manual) {
      void window.api.db.session.close(tab.id)
      setTx(tab.id, 'none')
    }
  }
  const dbList = conn ? dbs[conn.id] ?? [] : []
  const curDb = tab?.db ?? conn?.database ?? ''

  return (
    <div className="dbx-sql" style={hidden ? { display: 'none' } : undefined} ref={bodyRef}>
      <div className="dbx-bar">
        <Select
          className="dbx-conn-select"
          disabled={inTx}
          title={inTx ? t('db.tx.locked') : undefined}
          value={tab?.connId ?? ''}
          onChange={(e) => tab && patchTab(tab.id, { connId: e.target.value, db: undefined })}
        >
          {!conn && <option value={tab?.connId ?? ''}>{t('db.missingConnection')}</option>}
          {connections.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
        <Select
          className="dbx-db-select"
          disabled={inTx}
          title={inTx ? t('db.tx.locked') : undefined}
          value={curDb} onChange={(e) => tab && patchTab(tab.id, { db: e.target.value })}>
          {!dbList.includes(curDb) && <option value={curDb}>{curDb}</option>}
          {dbList.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </Select>
        {conn?.readOnly && (
          <span className="dbx-badge" title={t('db.readOnly')}>
            <Lock size={10} /> {t('db.readOnlyShort')}
          </span>
        )}
        {conn && !conn.readOnly && (
          <label className="dbx-autocommit" title={inTx ? t('db.tx.locked') : t('db.tx.autoHint')}>
            <Switch checked={!tab?.manual} disabled={inTx} onChange={(v) => setManual(!v)} />
            {t('db.tx.auto')}
          </label>
        )}
        {tab?.manual && (
          <>
            {inTx && (
              <span className={`dbx-tx${tx === 'failed' ? ' failed' : ''}`} title={tx === 'failed' ? t('db.tx.failedHint') : undefined}>
                {tx === 'failed' ? t('db.tx.failed') : t('db.tx.active')}
              </span>
            )}
            <Button disabled={!inTx || ending || tx === 'failed' || runState?.running} onClick={() => endTx('commit')} title={t('db.tx.commitHint')}>
              <Check size={11} /> {t('db.tx.commit')}
            </Button>
            <Button disabled={!inTx || ending || runState?.running} onClick={() => endTx('rollback')} title={t('db.tx.rollbackHint')}>
              <Undo2 size={11} /> {t('db.tx.rollback')}
            </Button>
          </>
        )}
        <span className="dbx-spacer" />
        <Select
          className="dbx-limit"
          value={String(limit)}
          title={t('db.limit')}
          onChange={(e) => {
            setLimit(Number(e.target.value))
            localStorage.setItem(LS_LIMIT, e.target.value)
          }}
        >
          {LIMITS.map((n) => (
            <option key={n} value={n}>
              {t('db.limitN', { n: String(n) })}
            </option>
          ))}
        </Select>
        {runState?.running ? (
          <Button onClick={cancel}>
            <Square size={11} /> {t('db.cancel')}
          </Button>
        ) : (
          <Button variant="primary" disabled={!conn} onClick={() => void run()} title={t('db.runHint')}>
            <Play size={11} /> {t('db.run')}
          </Button>
        )}
      </div>
      <div className="dbx-editor" style={{ flexBasis: `${split * 100}%` }}>
        <div className="dbx-monaco" ref={hostRef} />
      </div>
      <div className="dbx-split" onMouseDown={startDrag} />
      <div className="dbx-results">
        {runState && runState.results.length > 1 && (
          <div className="dbx-result-tabs">
            {runState.results.map((r, i) => (
              <button
                key={i}
                className={`dbx-chip${i === runState.shown ? ' on' : ''}${r.error ? ' err' : ''}`}
                title={r.sql}
                onClick={() => tab && setRun(tab.id, { ...runState, shown: i })}
              >
                {i + 1}. {r.error ? t('db.error') : r.result?.command || 'OK'}
              </button>
            ))}
          </div>
        )}
        {shown?.result && shown.result.columns.length > 0 && conn && tab ? (
          <ResultPane
            key={`${runId}:${shownIdx}`}
            connId={conn.id}
            db={tab.db}
            kind={conn.kind}
            limit={limit}
            entry={shown as RunResult & { result: QueryResult }}
            patch={patchShown}
            name={tab.title}
            session={tab.manual ? tab.id : undefined}
            onTx={() => void syncTx(tab.id)}
            editable={!conn.readOnly}
            lead={runState?.running && <span className="dbx-spin">{t('db.running')}</span>}
          />
        ) : (
          <>
            <div className="dbx-result-body">
              {!runState ? (
                <div className="dbx-empty">{t('db.runHint')}</div>
              ) : !shown ? (
                <div className="dbx-empty">{t('db.running')}</div>
              ) : shown.error ? (
                <div className="dbx-error">
                  <pre>{shown.error}</pre>
                  <pre className="dbx-error-sql">{shown.sql}</pre>
                </div>
              ) : (
                <div className="dbx-empty">
                  {shown.result?.command} {shown.result?.rowCount ?? ''}
                </div>
              )}
            </div>
            <div className="dbx-status">
              {runState?.running && <span className="dbx-spin">{t('db.running')}</span>}
              {shown?.result && (
                <>
                  <span>
                    {shown.result.command}
                    {shown.result.rowCount != null && ` ${shown.result.rowCount}`}
                  </span>
                  <span className="dbx-meta dbx-ms">{shown.result.timeMs} ms</span>
                </>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
