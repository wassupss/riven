import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ArrowDown, ArrowUp, Ban, Copy, FileCode2, Power, RefreshCw, RotateCcw, Wrench } from 'lucide-react'
import {
  blocking,
  databaseSettable,
  deadPct,
  fmtAge,
  fmtBytes,
  fmtCount,
  hitRatio,
  maintenanceSql,
  needsRestart,
  readOnlySetting,
  reindexIndexSql,
  settingSql,
  unusedIndex,
  type IndexStat,
  type LockInfo,
  type Maintenance,
  type MonitorView as View,
  type ServerOverview,
  type SessionInfo,
  type SettingInfo,
  type SettingScope,
  type TableStat
} from '../../../../../main/db/monitor'
import { dropSql } from '../../../../../main/db/ddl'
import { useT } from '../../../i18n'
import { useDb, type MonitorTab } from '../../../state/db'
import { Button, Segmented, Select, Switch, TextInput } from '../../../components/ui/Controls'
import DdlDialog, { type DdlAction } from './DdlDialog'
import { errText } from './ConnectionForm'

// Server monitor: overview counters, live sessions (cancel / terminate), lock
// waits, table and index stats with maintenance, and pg_settings with
// ALTER SYSTEM. Auto-refresh polls only the visible view, only while the tab
// is mounted and the window is visible, and never overlaps two reads.

type Data = {
  overview?: ServerOverview
  sessions?: SessionInfo[]
  locks?: LockInfo[]
  tables?: TableStat[]
  indexes?: IndexStat[]
  settings?: SettingInfo[]
}

const INTERVALS = [0, 2, 5, 10, 30]
/** Views worth polling; stats and settings change slowly and reload on demand. */
const LIVE: View[] = ['overview', 'sessions', 'locks']

// ---- a small sortable table ------------------------------------------------------

interface Col<R> {
  key: string
  label: string
  /** Sort value. */
  value: (r: R) => number | string
  render?: (r: R) => ReactNode
  num?: boolean
  title?: string
}

function Grid<R>({
  cols,
  rows,
  rowKey,
  initialSort,
  selected,
  onRow,
  rowClass,
  limit = 2000
}: {
  cols: Col<R>[]
  rows: R[]
  rowKey: (r: R) => string
  initialSort?: { key: string; desc: boolean }
  selected?: (r: R) => boolean
  onRow?: (r: R, e: React.MouseEvent) => void
  rowClass?: (r: R) => string
  limit?: number
}): JSX.Element {
  const [sort, setSort] = useState<{ key: string; desc: boolean } | null>(initialSort ?? null)
  const sorted = useMemo(() => {
    const c = sort && cols.find((x) => x.key === sort.key)
    if (!c || !sort) return rows
    const dir = sort.desc ? -1 : 1
    return [...rows].sort((a, b) => {
      const x = c.value(a)
      const y = c.value(b)
      return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y))) * dir
    })
  }, [rows, cols, sort])
  const shown = sorted.length > limit ? sorted.slice(0, limit) : sorted
  return (
    <div className="dbx-table-wrap">
      <table className="dbx-table dbx-mon-table">
        <thead>
          <tr>
            {cols.map((c) => (
              <th
                key={c.key}
                className={c.num ? 'num' : undefined}
                title={c.title}
                onClick={() =>
                  setSort((s) => (s?.key === c.key ? (s.desc ? { key: c.key, desc: false } : null) : { key: c.key, desc: !!c.num }))
                }
              >
                {c.label}
                {sort?.key === c.key && (sort.desc ? <ArrowDown size={10} /> : <ArrowUp size={10} />)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {shown.map((r) => (
            <tr
              key={rowKey(r)}
              className={`${onRow ? 'clickable' : ''}${selected?.(r) ? ' sel' : ''} ${rowClass?.(r) ?? ''}`}
              onClick={onRow ? (e) => onRow(r, e) : undefined}
            >
              {cols.map((c) => (
                <td key={c.key} className={c.num ? 'num' : undefined}>
                  {c.render ? c.render(r) : c.value(r)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ---- the view ------------------------------------------------------------------

export default function MonitorView({ tab }: { tab: MonitorTab }): JSX.Element {
  const t = useT()
  const conn = useDb((s) => s.connections.find((c) => c.id === tab.connId))
  const openSql = useDb((s) => s.openSql)
  const readOnly = !!conn?.readOnly
  const [view, setView] = useState<View>('overview')
  const [data, setData] = useState<Data>({})
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null)
  const [every, setEvery] = useState(5)
  const [at, setAt] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [action, setAction] = useState<DdlAction | null>(null)
  const inflight = useRef(false)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const load = useCallback(
    async (v: View): Promise<void> => {
      if (inflight.current) return
      inflight.current = true
      setBusy(true)
      const m = window.api.db.monitor
      const { connId, db } = tab
      try {
        const patch: Data = {}
        if (v === 'overview') patch.overview = await m.overview(connId, db)
        else if (v === 'sessions') patch.sessions = await m.sessions(connId, db)
        else if (v === 'locks') {
          // One after the other: run side by side, each would list the other's catalog locks.
          patch.locks = await m.locks(connId, db)
          patch.sessions = await m.sessions(connId, db)
        }
        else if (v === 'tables') patch.tables = await m.tables(connId, db)
        else if (v === 'indexes') patch.indexes = await m.indexes(connId, db)
        else patch.settings = await m.settings(connId, db)
        if (!alive.current) return
        setData((d) => ({ ...d, ...patch }))
        setError(null)
        setAt(Date.now())
      } catch (e) {
        if (alive.current) setError(errText(e))
      } finally {
        inflight.current = false
        if (alive.current) setBusy(false)
      }
    },
    [tab]
  )

  useEffect(() => {
    void load(view)
  }, [view, load])

  // Poll the live views; skip ticks while the window is hidden.
  useEffect(() => {
    if (!every || !LIVE.includes(view)) return
    const id = window.setInterval(() => {
      if (!document.hidden) void load(view)
    }, every * 1000)
    return () => window.clearInterval(id)
  }, [every, view, load])

  const reload = (): void => void load(view)
  const flash = (ok: boolean, text: string): void => setStatus({ ok, text })

  const signal = async (s: Pick<SessionInfo, 'pid' | 'user' | 'query'>, terminate: boolean): Promise<void> => {
    const q = s.query.trim().slice(0, 200)
    const msg = t(terminate ? 'db.mon.terminateConfirm' : 'db.mon.cancelConfirm', { pid: String(s.pid), user: s.user })
    if (!window.confirm(q ? `${msg}\n\n${q}` : msg)) return
    try {
      const ok = await window.api.db.monitor.signal(tab.connId, tab.db, s.pid, terminate)
      flash(ok, t(ok ? (terminate ? 'db.mon.terminated' : 'db.mon.cancelled') : 'db.mon.signalFailed', { pid: String(s.pid) }))
    } catch (e) {
      flash(false, errText(e))
    }
    reload()
  }

  const openInConsole = (sql: string): void => void openSql(tab.connId, tab.db, sql)

  return (
    <div className="dbx-obj dbx-mon">
      <div className="dbx-obj-head dbx-mon-head">
        <span className="dbx-obj-title">{t('db.mon.monitor')}</span>
        <span className="dbx-meta">{tab.db ?? conn?.database ?? ''}</span>
        <Segmented
          value={view}
          onChange={(v) => {
            setStatus(null)
            setView(v)
          }}
          options={(['overview', 'sessions', 'locks', 'tables', 'indexes', 'settings'] as View[]).map((v) => ({
            value: v,
            label: t(`db.mon.v.${v}`)
          }))}
        />
        <span className="dbx-spacer" />
        {at !== null && <span className="dbx-meta">{new Date(at).toLocaleTimeString()}</span>}
        {LIVE.includes(view) && (
          <Select
            value={String(every)}
            title={t('db.mon.autoRefresh')}
            onChange={(e) => setEvery(Number(e.target.value))}
          >
            {INTERVALS.map((n) => (
              <option key={n} value={n}>
                {n ? t('db.mon.every', { n: String(n) }) : t('db.mon.manual')}
              </option>
            ))}
          </Select>
        )}
        <button className="dbx-icon-btn" title={t('db.refresh')} onClick={reload} disabled={busy}>
          <RefreshCw size={13} className={busy ? 'dbx-spin' : undefined} />
        </button>
      </div>
      {status && <div className={`dbx-form-status dbx-mon-status ${status.ok ? 'ok' : 'err'}`}>{status.text}</div>}
      {error && (
        <div className="dbx-error">
          <pre>{error}</pre>
        </div>
      )}
      <div className="dbx-obj-body">
        {view === 'overview' && data.overview && <Overview o={data.overview} onSessions={() => setView('sessions')} onLocks={() => setView('locks')} />}
        {view === 'sessions' && data.sessions && (
          <Sessions rows={data.sessions} readOnly={readOnly} onSignal={signal} onOpen={openInConsole} />
        )}
        {view === 'locks' && data.locks && (
          <Locks locks={data.locks} sessions={data.sessions ?? []} readOnly={readOnly} onSignal={signal} />
        )}
        {view === 'tables' && data.tables && (
          <Tables rows={data.tables} connId={tab.connId} db={tab.db} readOnly={readOnly} setAction={setAction} after={reload} />
        )}
        {view === 'indexes' && data.indexes && (
          <Indexes rows={data.indexes} connId={tab.connId} db={tab.db} readOnly={readOnly} setAction={setAction} after={reload} />
        )}
        {view === 'settings' && data.settings && (
          <Settings
            rows={data.settings}
            connId={tab.connId}
            db={tab.db ?? conn?.database ?? 'postgres'}
            readOnly={readOnly}
            flash={flash}
            after={reload}
          />
        )}
      </div>
      {action && <DdlDialog action={action} onClose={() => setAction(null)} />}
    </div>
  )
}

// ---- overview ----------------------------------------------------------------------

function Overview({ o, onSessions, onLocks }: { o: ServerOverview; onSessions: () => void; onLocks: () => void }): JSX.Element {
  const t = useT()
  const hit = hitRatio(o)
  const used = o.maxConnections > 0 ? (o.connections / o.maxConnections) * 100 : 0
  const maxDb = Math.max(1, ...o.databases.map((d) => d.size))
  const card = (label: string, value: ReactNode, sub?: ReactNode, tone?: 'warn' | 'bad', onClick?: () => void): JSX.Element => (
    <div className={`dbx-mon-card${tone ? ` ${tone}` : ''}${onClick ? ' clickable' : ''}`} onClick={onClick}>
      <div className="dbx-mon-card-label">{label}</div>
      <div className="dbx-mon-card-value">{value}</div>
      {sub !== undefined && <div className="dbx-mon-card-sub">{sub}</div>}
    </div>
  )
  const states = Object.entries(o.states).sort((a, b) => b[1] - a[1])
  return (
    <div className="dbx-mon-scroll">
      <div className="dbx-mon-version" title={o.version}>
        {o.version.split(',')[0]}
        <span className="dbx-meta">
          {t('db.mon.uptime')} {fmtAge(o.uptime)}
          {o.superuser ? ` · ${t('db.mon.superuser')}` : ''}
        </span>
      </div>
      <div className="dbx-mon-cards">
        {card(
          t('db.mon.connections'),
          `${o.connections} / ${o.maxConnections}`,
          <span className="dbx-mon-bar">
            <span style={{ width: `${Math.min(100, used)}%` }} />
          </span>,
          used >= 90 ? 'bad' : used >= 75 ? 'warn' : undefined,
          onSessions
        )}
        {card(
          t('db.mon.states'),
          String(o.states.active ?? 0),
          states.map(([k, n]) => `${k} ${n}`).join(' · ') || '-',
          (o.states['idle in transaction'] ?? 0) > 0 ? 'warn' : undefined,
          onSessions
        )}
        {card(t('db.mon.blocked'), String(o.blocked), t('db.mon.blockedHint'), o.blocked > 0 ? 'bad' : undefined, onLocks)}
        {card(
          t('db.mon.oldestXact'),
          o.oldestXact === null ? '-' : fmtAge(o.oldestXact),
          t('db.mon.oldestXactHint'),
          (o.oldestXact ?? 0) > 3600 ? 'bad' : (o.oldestXact ?? 0) > 300 ? 'warn' : undefined
        )}
        {card(
          t('db.mon.cacheHit'),
          hit === null ? '-' : `${hit.toFixed(2)}%`,
          t('db.mon.cacheHitHint'),
          hit !== null && hit < 90 ? 'bad' : hit !== null && hit < 99 ? 'warn' : undefined
        )}
        {card(t('db.mon.dbSize'), fmtBytes(o.dbSize), o.database)}
        {card(
          t('db.mon.xacts'),
          fmtCount(o.commits),
          t('db.mon.rollbacks', { n: fmtCount(o.rollbacks) }),
          o.commits > 0 && o.rollbacks / o.commits > 0.05 ? 'warn' : undefined
        )}
        {card(t('db.mon.deadlocks'), fmtCount(o.deadlocks), t('db.mon.conflicts', { n: fmtCount(o.conflicts) }), o.deadlocks > 0 ? 'warn' : undefined)}
        {card(t('db.mon.tempBytes'), fmtBytes(o.tempBytes), t('db.mon.tempHint'), o.tempBytes > 1024 ** 3 ? 'warn' : undefined)}
        {card(
          t('db.mon.tuples'),
          fmtCount(o.tupFetched),
          `ins ${fmtCount(o.tupInserted)} · upd ${fmtCount(o.tupUpdated)} · del ${fmtCount(o.tupDeleted)}`
        )}
      </div>
      {o.databases.length > 0 && (
        <>
          <div className="dbx-form-sect">{t('db.mon.databases')}</div>
          <div className="dbx-mon-dbs">
            {o.databases.map((d) => (
              <div key={d.name} className={`dbx-mon-db${d.name === o.database ? ' cur' : ''}`}>
                <span className="dbx-mon-db-name">{d.name}</span>
                <span className="dbx-mon-bar">
                  <span style={{ width: `${(d.size / maxDb) * 100}%` }} />
                </span>
                <span className="dbx-mon-db-size">{fmtBytes(d.size)}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

// ---- sessions ----------------------------------------------------------------------

type Signal = (s: Pick<SessionInfo, 'pid' | 'user' | 'query'>, terminate: boolean) => void

const stateClass = (s: string): string =>
  s === 'active' ? 'active' : s.startsWith('idle in transaction') ? 'idletx' : s === 'idle' ? 'idle' : ''

function Sessions({
  rows,
  readOnly,
  onSignal,
  onOpen
}: {
  rows: SessionInfo[]
  readOnly: boolean
  onSignal: Signal
  onOpen: (sql: string) => void
}): JSX.Element {
  const t = useT()
  const [q, setQ] = useState('')
  const [hideIdle, setHideIdle] = useState(true)
  const [hideSystem, setHideSystem] = useState(true)
  const [sel, setSel] = useState<number | null>(null)
  const needle = q.trim().toLowerCase()
  const shown = useMemo(
    () =>
      rows.filter(
        (s) =>
          (!hideIdle || s.state !== 'idle') &&
          (!hideSystem || s.backendType === 'client backend') &&
          (!needle ||
            [s.user, s.database, s.application, s.client, s.query, String(s.pid)].some((x) => x.toLowerCase().includes(needle)))
      ),
    [rows, hideIdle, hideSystem, needle]
  )
  const cur = rows.find((s) => s.pid === sel)
  const cols: Col<SessionInfo>[] = [
    { key: 'pid', label: 'PID', value: (s) => s.pid, num: true },
    { key: 'user', label: t('db.mon.user'), value: (s) => s.user },
    { key: 'db', label: t('db.mon.database'), value: (s) => s.database },
    { key: 'app', label: t('db.mon.app'), value: (s) => s.application || (s.backendType !== 'client backend' ? s.backendType : '') },
    { key: 'client', label: t('db.mon.client'), value: (s) => s.client },
    {
      key: 'state',
      label: t('db.mon.state'),
      value: (s) => s.state,
      render: (s) => (
        <span className={`dbx-mon-state ${stateClass(s.state)}`}>
          {s.state || '-'}
          {s.blockedBy.length > 0 && <span className="dbx-tag bad">{t('db.mon.waitingOn', { pids: s.blockedBy.join(', ') })}</span>}
        </span>
      )
    },
    { key: 'wait', label: t('db.mon.wait'), value: (s) => (s.waitType ? `${s.waitType}: ${s.wait}` : '') },
    { key: 'xact', label: t('db.mon.xactAge'), value: (s) => s.xactAge ?? -1, render: (s) => fmtAge(s.xactAge), num: true },
    {
      key: 'query',
      label: t('db.mon.queryAge'),
      value: (s) => (s.state === 'active' ? (s.queryAge ?? -1) : -1),
      render: (s) => (s.state === 'active' ? fmtAge(s.queryAge) : <span className="dbx-dim">{fmtAge(s.stateAge)}</span>),
      num: true,
      title: t('db.mon.queryAgeHint')
    },
    {
      key: 'sql',
      label: t('db.mon.query'),
      value: (s) => s.query,
      render: (s) => <span className="dbx-mon-sql">{s.query.replace(/\s+/g, ' ').slice(0, 200)}</span>
    },
    {
      key: 'act',
      label: '',
      value: () => '',
      render: (s) =>
        s.backendType === 'client backend' && !readOnly ? (
          <span className="dbx-mon-acts">
            <button
              className="dbx-icon-btn"
              title={t('db.mon.cancel')}
              disabled={s.state !== 'active'}
              onClick={(e) => (e.stopPropagation(), onSignal(s, false))}
            >
              <Ban size={12} />
            </button>
            <button className="dbx-icon-btn danger" title={t('db.mon.terminate')} onClick={(e) => (e.stopPropagation(), onSignal(s, true))}>
              <Power size={12} />
            </button>
          </span>
        ) : null
    }
  ]
  return (
    <>
      <div className="dbx-obj-subs">
        <TextInput className="dbx-mon-q" placeholder={t('db.mon.search')} value={q} onChange={(e) => setQ(e.target.value)} />
        <button className={`dbx-chip${hideIdle ? ' on' : ''}`} onClick={() => setHideIdle((v) => !v)}>
          {t('db.mon.hideIdle')}
        </button>
        <button className={`dbx-chip${hideSystem ? ' on' : ''}`} onClick={() => setHideSystem((v) => !v)}>
          {t('db.mon.hideSystem')}
        </button>
        <span className="dbx-spacer" />
        <span className="dbx-meta">{t('db.mon.count', { n: String(shown.length), total: String(rows.length) })}</span>
      </div>
      {shown.length ? (
        <Grid
          cols={cols}
          rows={shown}
          rowKey={(s) => String(s.pid)}
          selected={(s) => s.pid === sel}
          onRow={(s) => setSel((p) => (p === s.pid ? null : s.pid))}
          rowClass={(s) => (s.blockedBy.length ? 'blocked' : '')}
        />
      ) : (
        <div className="dbx-empty">{t('db.mon.noSessions')}</div>
      )}
      {cur && (
        <div className="dbx-mon-detail">
          <div className="dbx-mon-detail-head">
            <span>
              PID {cur.pid} · {cur.user}@{cur.database} · {cur.application || cur.backendType}
              {cur.backendAge !== null && ` · ${t('db.mon.connectedFor', { age: fmtAge(cur.backendAge) })}`}
            </span>
            <span className="dbx-spacer" />
            <button className="dbx-icon-btn" title={t('db.mon.copy')} onClick={() => void navigator.clipboard.writeText(cur.query)}>
              <Copy size={12} />
            </button>
            <button className="dbx-icon-btn" title={t('db.mon.openConsole')} onClick={() => onOpen(cur.query)}>
              <FileCode2 size={12} />
            </button>
          </div>
          <pre>{cur.query || '-'}</pre>
        </div>
      )}
    </>
  )
}

// ---- locks -------------------------------------------------------------------------

function Locks({
  locks,
  sessions,
  readOnly,
  onSignal
}: {
  locks: LockInfo[]
  sessions: SessionInfo[]
  readOnly: boolean
  onSignal: Signal
}): JSX.Element {
  const t = useT()
  const [waitingOnly, setWaitingOnly] = useState(false)
  const byPid = useMemo(() => new Map(sessions.map((s) => [s.pid, s])), [sessions])
  const blocked = sessions.filter((s) => s.blockedBy.length > 0)
  const shown = waitingOnly ? locks.filter((l) => !l.granted) : locks
  const who = (pid: number): JSX.Element => {
    const s = byPid.get(pid)
    return (
      <span className="dbx-mon-who">
        <b>{pid}</b> {s ? `${s.user} · ${s.state || s.backendType}` : ''}
        {s && <span className="dbx-mon-sql">{s.query.replace(/\s+/g, ' ').slice(0, 160)}</span>}
      </span>
    )
  }
  const cols: Col<LockInfo>[] = [
    { key: 'pid', label: 'PID', value: (l) => l.pid, num: true },
    { key: 'type', label: t('db.mon.lockType'), value: (l) => l.locktype },
    { key: 'rel', label: t('db.mon.relation'), value: (l) => l.relation || l.target },
    { key: 'mode', label: t('db.mon.mode'), value: (l) => l.mode },
    {
      key: 'granted',
      label: t('db.mon.granted'),
      value: (l) => (l.granted ? 1 : 0),
      render: (l) => (l.granted ? t('db.mon.yes') : <span className="dbx-tag bad">{t('db.mon.waiting')}</span>)
    },
    { key: 'user', label: t('db.mon.user'), value: (l) => l.user },
    { key: 'age', label: t('db.mon.queryAge'), value: (l) => l.queryAge ?? -1, render: (l) => fmtAge(l.queryAge), num: true },
    { key: 'sql', label: t('db.mon.query'), value: (l) => l.query, render: (l) => <span className="dbx-mon-sql">{l.query.replace(/\s+/g, ' ').slice(0, 160)}</span> }
  ]
  return (
    <>
      <div className="dbx-mon-chains">
        <div className="dbx-form-sect">{t('db.mon.chains')}</div>
        {blocked.length ? (
          blocked.map((s) => (
            <div key={s.pid} className="dbx-mon-chain">
              <div className="dbx-mon-chain-row">
                <span className="dbx-tag bad">{t('db.mon.waitingFor', { age: fmtAge(s.queryAge) })}</span>
                {who(s.pid)}
              </div>
              {s.blockedBy.map((b) => (
                <div key={b} className="dbx-mon-chain-row by">
                  <span className="dbx-tag">{t('db.mon.blockedBy')}</span>
                  {who(b)}
                  {!readOnly && (
                    <span className="dbx-mon-acts">
                      <button
                        className="dbx-icon-btn"
                        title={t('db.mon.cancel')}
                        onClick={() => onSignal({ pid: b, user: byPid.get(b)?.user ?? '', query: byPid.get(b)?.query ?? '' }, false)}
                      >
                        <Ban size={12} />
                      </button>
                      <button
                        className="dbx-icon-btn danger"
                        title={t('db.mon.terminate')}
                        onClick={() => onSignal({ pid: b, user: byPid.get(b)?.user ?? '', query: byPid.get(b)?.query ?? '' }, true)}
                      >
                        <Power size={12} />
                      </button>
                    </span>
                  )}
                </div>
              ))}
            </div>
          ))
        ) : (
          <div className="dbx-empty">{t('db.mon.noBlocking')}</div>
        )}
      </div>
      <div className="dbx-obj-subs">
        <span className="dbx-form-sect inline">{t('db.mon.allLocks')}</span>
        <button className={`dbx-chip${waitingOnly ? ' on' : ''}`} onClick={() => setWaitingOnly((v) => !v)}>
          {t('db.mon.waitingOnly')}
        </button>
        <span className="dbx-spacer" />
        <span className="dbx-meta">{t('db.mon.count', { n: String(shown.length), total: String(locks.length) })}</span>
      </div>
      <Grid cols={cols} rows={shown} rowKey={(l) => `${l.pid}:${l.locktype}:${l.relation}:${l.target}:${l.mode}:${l.granted}`} />
    </>
  )
}

// ---- tables ------------------------------------------------------------------------

type SetAction = (a: DdlAction | null) => void

const MAINT: Maintenance[] = ['vacuum', 'vacuumAnalyze', 'analyze', 'vacuumFull', 'reindex']

function Tables({
  rows,
  connId,
  db,
  readOnly,
  setAction,
  after
}: {
  rows: TableStat[]
  connId: string
  db: string | undefined
  readOnly: boolean
  setAction: SetAction
  after: () => void
}): JSX.Element {
  const t = useT()
  const [q, setQ] = useState('')
  const [sel, setSel] = useState<Set<string>>(() => new Set())
  const key = (r: TableStat): string => `${r.schema}.${r.name}`
  const needle = q.trim().toLowerCase()
  const shown = useMemo(() => (needle ? rows.filter((r) => key(r).toLowerCase().includes(needle)) : rows), [rows, needle])
  const picked = rows.filter((r) => sel.has(key(r)))

  const run = (m: Maintenance): void => {
    const tables = picked.map((r) => ({ schema: r.schema, name: r.name }))
    if (!tables.length) return
    const fields: DdlAction['fields'] = [{ key: 'verbose', label: 'VERBOSE', kind: 'switch' }]
    if (m === 'reindex') fields.push({ key: 'concurrently', label: 'CONCURRENTLY', kind: 'switch', hint: t('db.mon.concurrentlyHint') })
    setAction({
      title: t(`db.mon.m.${m}`),
      connId,
      db,
      fields,
      initial: m === 'reindex' ? { concurrently: true } : undefined,
      build: (v) => maintenanceSql(m, tables, { verbose: v.verbose === true, concurrently: v.concurrently === true }),
      danger: blocking(m, false),
      confirm: m === 'vacuumFull' && tables.length === 1 ? tables[0].name : undefined,
      applyLabel: t('db.mon.run'),
      onDone: () => after()
    })
  }

  const cols: Col<TableStat>[] = [
    {
      key: 'name',
      label: t('db.mon.table'),
      value: (r) => key(r),
      render: (r) => (
        <span className="dbx-mon-name">
          <span className="dbx-dim">{r.schema}.</span>
          {r.name}
          {r.kind === 'm' && <span className="dbx-tag">MV</span>}
          {r.kind === 'p' && <span className="dbx-tag">P</span>}
        </span>
      )
    },
    { key: 'total', label: t('db.mon.total'), value: (r) => r.total, render: (r) => fmtBytes(r.total), num: true },
    { key: 'table', label: t('db.mon.heap'), value: (r) => r.table, render: (r) => fmtBytes(r.table), num: true },
    { key: 'idx', label: t('db.mon.indexSize'), value: (r) => r.indexes, render: (r) => fmtBytes(r.indexes), num: true },
    { key: 'toast', label: 'TOAST', value: (r) => r.toast, render: (r) => (r.toast ? fmtBytes(r.toast) : ''), num: true },
    { key: 'live', label: t('db.mon.live'), value: (r) => r.live, render: (r) => fmtCount(r.live), num: true },
    {
      key: 'dead',
      label: t('db.mon.dead'),
      value: (r) => deadPct(r),
      render: (r) => {
        const p = deadPct(r)
        return (
          <span className={p >= 20 && r.dead > 1000 ? 'dbx-mon-bad' : p >= 10 ? 'dbx-warn' : undefined}>
            {fmtCount(r.dead)} <span className="dbx-dim">({p.toFixed(1)}%)</span>
          </span>
        )
      },
      num: true,
      title: t('db.mon.deadHint')
    },
    {
      key: 'seq',
      label: t('db.mon.scans'),
      value: (r) => r.seqScan,
      render: (r) => (
        <span title={t('db.mon.scansHint')}>
          {fmtCount(r.seqScan)} / {fmtCount(r.idxScan)}
        </span>
      ),
      num: true
    },
    { key: 'mod', label: t('db.mon.modSinceAnalyze'), value: (r) => r.modSinceAnalyze, render: (r) => fmtCount(r.modSinceAnalyze), num: true },
    {
      key: 'vac',
      label: t('db.mon.lastVacuum'),
      value: (r) => r.vacuumAge ?? Number.MAX_SAFE_INTEGER,
      render: (r) => (r.vacuumAge === null ? <span className="dbx-dim">{t('db.mon.never')}</span> : `${fmtAge(r.vacuumAge)}${r.autoVacuumed ? ' (auto)' : ''}`),
      num: true
    },
    {
      key: 'ana',
      label: t('db.mon.lastAnalyze'),
      value: (r) => r.analyzeAge ?? Number.MAX_SAFE_INTEGER,
      render: (r) =>
        r.analyzeAge === null ? <span className="dbx-dim">{t('db.mon.never')}</span> : `${fmtAge(r.analyzeAge)}${r.autoAnalyzed ? ' (auto)' : ''}`,
      num: true
    }
  ]
  const totals = rows.reduce((a, r) => a + r.total, 0)
  return (
    <>
      <div className="dbx-obj-subs">
        <TextInput className="dbx-mon-q" placeholder={t('db.mon.search')} value={q} onChange={(e) => setQ(e.target.value)} />
        <span className="dbx-meta">
          {t('db.mon.tablesTotal', { n: String(rows.length), size: fmtBytes(totals) })}
          {picked.length > 0 && ` · ${t('db.mon.selected', { n: String(picked.length) })}`}
        </span>
        <span className="dbx-spacer" />
        {!readOnly &&
          MAINT.map((m) => (
            <Button key={m} variant={m === 'vacuumFull' ? 'ghost' : 'default'} disabled={!picked.length} onClick={() => run(m)} title={t(`db.mon.m.${m}Hint`)}>
              {m === 'vacuum' && <Wrench size={11} />} {t(`db.mon.m.${m}`)}
            </Button>
          ))}
      </div>
      {shown.length ? (
        <Grid
          cols={cols}
          rows={shown}
          rowKey={key}
          initialSort={{ key: 'total', desc: true }}
          selected={(r) => sel.has(key(r))}
          onRow={(r, e) =>
            setSel((s) => {
              const k = key(r)
              // Modifier toggles one row; a plain click selects just this row (or clears it).
              if (e.metaKey || e.ctrlKey || e.shiftKey) {
                const x = new Set(s)
                if (!x.delete(k)) x.add(k)
                return x
              }
              return s.has(k) && s.size === 1 ? new Set() : new Set([k])
            })
          }
        />
      ) : (
        <div className="dbx-empty">{t('db.mon.noTables')}</div>
      )}
      <div className="dbx-mon-foot dbx-meta">{t('db.mon.selectHint')}</div>
    </>
  )
}

// ---- indexes -----------------------------------------------------------------------

function Indexes({
  rows,
  connId,
  db,
  readOnly,
  setAction,
  after
}: {
  rows: IndexStat[]
  connId: string
  db: string | undefined
  readOnly: boolean
  setAction: SetAction
  after: () => void
}): JSX.Element {
  const t = useT()
  const [q, setQ] = useState('')
  const [unusedOnly, setUnusedOnly] = useState(false)
  const needle = q.trim().toLowerCase()
  const shown = useMemo(
    () =>
      rows.filter(
        (r) => (!unusedOnly || unusedIndex(r)) && (!needle || `${r.schema}.${r.table}.${r.name}`.toLowerCase().includes(needle))
      ),
    [rows, unusedOnly, needle]
  )
  const unused = rows.filter(unusedIndex)
  const wasted = unused.reduce((a, r) => a + r.size, 0)

  const reindex = (r: IndexStat): void =>
    setAction({
      title: t('db.mon.m.reindex'),
      connId,
      db,
      fields: [{ key: 'concurrently', label: 'CONCURRENTLY', kind: 'switch', hint: t('db.mon.concurrentlyHint') }],
      initial: { concurrently: true },
      build: (v) => reindexIndexSql(r.schema, r.name, v.concurrently === true),
      applyLabel: t('db.mon.run'),
      onDone: () => after()
    })
  const drop = (r: IndexStat): void =>
    setAction({
      title: t('db.mon.dropIndex'),
      connId,
      db,
      fields: [{ key: 'cascade', label: 'CASCADE', kind: 'switch' }],
      build: (v) => dropSql('index', r.schema, r.name, { cascade: v.cascade === true }),
      danger: true,
      confirm: r.name,
      onDone: () => after()
    })

  const cols: Col<IndexStat>[] = [
    {
      key: 'name',
      label: t('db.mon.index'),
      value: (r) => r.name,
      render: (r) => (
        <span className="dbx-mon-name" title={r.def}>
          {r.name}
          {r.primary ? <span className="dbx-tag">PK</span> : r.unique ? <span className="dbx-tag">UQ</span> : null}
          {!r.valid && <span className="dbx-tag bad">{t('db.mon.invalid')}</span>}
          {unusedIndex(r) && <span className="dbx-tag warn">{t('db.mon.unused')}</span>}
        </span>
      )
    },
    { key: 'table', label: t('db.mon.table'), value: (r) => `${r.schema}.${r.table}` },
    { key: 'size', label: t('db.mon.size'), value: (r) => r.size, render: (r) => fmtBytes(r.size), num: true },
    { key: 'scans', label: t('db.mon.idxScans'), value: (r) => r.scans, render: (r) => fmtCount(r.scans), num: true },
    { key: 'read', label: t('db.mon.tupRead'), value: (r) => r.tupRead, render: (r) => fmtCount(r.tupRead), num: true },
    { key: 'def', label: t('db.mon.definition'), value: (r) => r.def, render: (r) => <span className="dbx-mon-sql">{r.def}</span> },
    {
      key: 'act',
      label: '',
      value: () => '',
      render: (r) =>
        readOnly ? null : (
          <span className="dbx-mon-acts">
            <button className="dbx-icon-btn" title={t('db.mon.m.reindex')} onClick={() => reindex(r)}>
              <RotateCcw size={12} />
            </button>
            {!r.primary && (
              <button className="dbx-icon-btn danger" title={t('db.mon.dropIndex')} onClick={() => drop(r)}>
                <Ban size={12} />
              </button>
            )}
          </span>
        )
    }
  ]
  return (
    <>
      <div className="dbx-obj-subs">
        <TextInput className="dbx-mon-q" placeholder={t('db.mon.search')} value={q} onChange={(e) => setQ(e.target.value)} />
        <button className={`dbx-chip${unusedOnly ? ' on' : ''}`} onClick={() => setUnusedOnly((v) => !v)} title={t('db.mon.unusedHint')}>
          {t('db.mon.unusedOnly')}
        </button>
        <span className="dbx-spacer" />
        <span className="dbx-meta">
          {t('db.mon.unusedSummary', { n: String(unused.length), size: fmtBytes(wasted) })}
        </span>
      </div>
      {shown.length ? (
        <Grid cols={cols} rows={shown} rowKey={(r) => `${r.schema}.${r.name}`} initialSort={{ key: 'size', desc: true }} />
      ) : (
        <div className="dbx-empty">{t('db.mon.noIndexes')}</div>
      )}
    </>
  )
}

// ---- settings ----------------------------------------------------------------------

/** pg_reload_conf only signals the postmaster; give backends a moment to re-read before pg_settings is queried. */
async function reloadConf(connId: string, db: string): Promise<boolean> {
  const ok = await window.api.db.monitor.reload(connId, db)
  await new Promise((r) => setTimeout(r, 400))
  return ok
}

function Settings({
  rows,
  connId,
  db,
  readOnly,
  flash,
  after
}: {
  rows: SettingInfo[]
  connId: string
  db: string
  readOnly: boolean
  flash: (ok: boolean, text: string) => void
  after: () => void
}): JSX.Element {
  const t = useT()
  const [q, setQ] = useState('')
  const [changed, setChanged] = useState(false)
  const [sel, setSel] = useState<string | null>(null)
  const needle = q.trim().toLowerCase()
  const shown = useMemo(
    () =>
      rows.filter(
        (s) =>
          (!changed || (s.source !== 'default' && s.source !== 'override')) &&
          (!needle || s.name.includes(needle) || s.category.toLowerCase().includes(needle) || s.description.toLowerCase().includes(needle))
      ),
    [rows, changed, needle]
  )
  const pending = rows.filter((s) => s.pendingRestart)
  const cur = rows.find((s) => s.name === sel)

  const reload = async (): Promise<void> => {
    try {
      const ok = await reloadConf(connId, db)
      flash(ok, t(ok ? 'db.mon.reloaded' : 'db.mon.reloadFailed'))
    } catch (e) {
      flash(false, errText(e))
    }
    after()
  }

  const cols: Col<SettingInfo>[] = [
    {
      key: 'name',
      label: t('db.mon.setting'),
      value: (s) => s.name,
      render: (s) => (
        <span className="dbx-mon-name">
          {s.name}
          {s.pendingRestart && <span className="dbx-tag warn">{t('db.mon.pendingRestart')}</span>}
        </span>
      )
    },
    { key: 'value', label: t('db.mon.value'), value: (s) => s.setting, render: (s) => `${s.setting}${s.unit ? ` ${s.unit}` : ''}` },
    { key: 'source', label: t('db.mon.source'), value: (s) => s.source, render: (s) => <span className={s.source === 'default' ? 'dbx-dim' : undefined}>{s.source}</span> },
    { key: 'context', label: t('db.mon.context'), value: (s) => s.context, title: t('db.mon.contextHint') },
    { key: 'cat', label: t('db.mon.category'), value: (s) => s.category, render: (s) => <span className="dbx-dim">{s.category}</span> },
    { key: 'desc', label: t('db.mon.description'), value: (s) => s.description, render: (s) => <span className="dbx-mon-desc">{s.description}</span> }
  ]
  return (
    <>
      <div className="dbx-obj-subs">
        <TextInput className="dbx-mon-q" placeholder={t('db.mon.searchSettings')} value={q} onChange={(e) => setQ(e.target.value)} />
        <button className={`dbx-chip${changed ? ' on' : ''}`} onClick={() => setChanged((v) => !v)} title={t('db.mon.changedHint')}>
          {t('db.mon.changedOnly')}
        </button>
        {pending.length > 0 && <span className="dbx-tag warn">{t('db.mon.pendingCount', { n: String(pending.length) })}</span>}
        <span className="dbx-spacer" />
        <span className="dbx-meta">{t('db.mon.count', { n: String(shown.length), total: String(rows.length) })}</span>
        {!readOnly && (
          <Button onClick={() => void reload()} title={t('db.mon.reloadHint')}>
            <RefreshCw size={11} /> {t('db.mon.reload')}
          </Button>
        )}
      </div>
      <Grid cols={cols} rows={shown} rowKey={(s) => s.name} selected={(s) => s.name === sel} onRow={(s) => setSel((p) => (p === s.name ? null : s.name))} />
      {cur && <SettingEditor key={cur.name} s={cur} connId={connId} db={db} readOnly={readOnly} flash={flash} after={after} />}
    </>
  )
}

function SettingEditor({
  s,
  connId,
  db,
  readOnly,
  flash,
  after
}: {
  s: SettingInfo
  connId: string
  db: string
  readOnly: boolean
  flash: (ok: boolean, text: string) => void
  after: () => void
}): JSX.Element {
  const t = useT()
  const [value, setValue] = useState(s.setting)
  const [scope, setScope] = useState<SettingScope>('system')
  const [busy, setBusy] = useState(false)
  const locked = readOnly || readOnlySetting(s)
  const canDb = databaseSettable(s)
  const sc: SettingScope = canDb ? scope : 'system'

  const apply = async (v: string | null): Promise<void> => {
    setBusy(true)
    try {
      await window.api.db.ddlApply(connId, db, settingSql(sc, s.name, v, db))
      // ALTER SYSTEM only writes postgresql.auto.conf; reload so non-restart settings apply now.
      if (sc === 'system' && !needsRestart(s)) await reloadConf(connId, db)
      flash(
        true,
        t(sc === 'system' ? (needsRestart(s) ? 'db.mon.savedRestart' : 'db.mon.savedReloaded') : 'db.mon.savedDb', { name: s.name, db })
      )
      after()
    } catch (e) {
      flash(false, errText(e))
    } finally {
      setBusy(false)
    }
  }

  const input =
    s.vartype === 'bool' ? (
      <Switch checked={value === 'on'} onChange={(on) => setValue(on ? 'on' : 'off')} disabled={locked} />
    ) : s.vartype === 'enum' ? (
      <Select value={value} onChange={(e) => setValue(e.target.value)} disabled={locked}>
        {s.enumvals.map((v) => (
          <option key={v} value={v}>
            {v}
          </option>
        ))}
      </Select>
    ) : (
      <TextInput className="dbx-mon-val" value={value} onChange={(e) => setValue(e.target.value)} disabled={locked} />
    )

  return (
    <div className="dbx-mon-detail dbx-mon-setting">
      <div className="dbx-mon-detail-head">
        <b>{s.name}</b>
        <span className="dbx-meta">{s.description}</span>
      </div>
      <div className="dbx-mon-setting-meta">
        <span>
          {t('db.mon.context')}: <b>{s.context}</b>
          {needsRestart(s) && <span className="dbx-tag warn">{t('db.mon.restartNeeded')}</span>}
        </span>
        <span>
          {t('db.mon.source')}: {s.source}
        </span>
        <span>
          {t('db.mon.default')}: {s.boot}
          {s.unit ? ` ${s.unit}` : ''}
        </span>
        {(s.min || s.max) && (
          <span>
            {t('db.mon.range')}: {s.min} .. {s.max}
            {s.unit ? ` ${s.unit}` : ''}
          </span>
        )}
      </div>
      {locked ? (
        <div className="dbx-meta">{readOnly ? t('db.mon.readOnlyConn') : t('db.mon.internal')}</div>
      ) : (
        <div className="dbx-mon-setting-edit">
          {input}
          {s.unit && <span className="dbx-meta">{s.unit}</span>}
          {canDb && (
            <Segmented
              value={scope}
              onChange={setScope}
              options={[
                { value: 'system', label: 'ALTER SYSTEM' },
                { value: 'database', label: t('db.mon.scopeDb', { db }) }
              ]}
            />
          )}
          <span className="dbx-spacer" />
          <Button variant="ghost" disabled={busy} onClick={() => void apply(null)} title={t('db.mon.resetHint')}>
            {t('db.mon.reset')}
          </Button>
          <Button variant="primary" disabled={busy || value === s.setting} onClick={() => void apply(value)}>
            {t('db.mon.apply')}
          </Button>
        </div>
      )}
      {!locked && <code className="dbx-mon-preview">{settingSql(sc, s.name, value, db).stmts[0]}</code>}
    </div>
  )
}
