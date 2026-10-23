import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  Database,
  Eye,
  Folder,
  Layers,
  Link2,
  ListOrdered,
  Lock,
  Plus,
  RefreshCw,
  Server,
  SquareFunction,
  Table2,
  Workflow
} from 'lucide-react'
import '../../styles/db-panel.css'
import type { ConnectionInfo, DbObject, ObjectKind, SchemaInfo } from '../../../../main/db/types'
import { quoteIdent } from '../../../../main/db/sqlText'
import { useDb } from '../../state/db'
import { useT } from '../../i18n'
import ContextMenu, { type MenuItem } from '../../components/ContextMenu'
import { TextInput } from '../../components/ui/Controls'
import ConnectionForm, { errText } from './db/ConnectionForm'

// =============================================================================
// DbExplorerPanel: the data source tree. connection > database > schema >
// kind group > object, each level fetched on first expand. Opening an object or
// a console hands off to the SQL console panel (shared state in state/db.ts).
// =============================================================================

const ROW_H = 22
const OVERSCAN = 10

type Group = 'tables' | 'views' | 'matviews' | 'foreign' | 'sequences' | 'functions' | 'procedures'

const GROUPS: Array<{ id: Group; kinds: ObjectKind[] }> = [
  { id: 'tables', kinds: ['table', 'partitioned'] },
  { id: 'views', kinds: ['view'] },
  { id: 'matviews', kinds: ['matview'] },
  { id: 'foreign', kinds: ['foreign'] },
  { id: 'sequences', kinds: ['sequence'] },
  { id: 'functions', kinds: ['function', 'aggregate', 'window'] },
  { id: 'procedures', kinds: ['procedure'] }
]

const GROUP_ICON: Record<Group, typeof Table2> = {
  tables: Table2,
  views: Eye,
  matviews: Layers,
  foreign: Link2,
  sequences: ListOrdered,
  functions: SquareFunction,
  procedures: Workflow
}

const isRelation = (k: ObjectKind): boolean => k === 'table' || k === 'partitioned' || k === 'view' || k === 'matview' || k === 'foreign'

type Load<T> = { loading: boolean; error?: string; data?: T }

type Row =
  | { key: string; depth: 0; type: 'conn'; conn: ConnectionInfo }
  | { key: string; depth: 1; type: 'db'; conn: ConnectionInfo; db: string }
  | { key: string; depth: 2; type: 'schema'; conn: ConnectionInfo; db: string; schema: string }
  | { key: string; depth: 3; type: 'group'; conn: ConnectionInfo; db: string; schema: string; group: Group; count: number }
  | { key: string; depth: 4; type: 'obj'; conn: ConnectionInfo; db: string; schema: string; obj: DbObject }
  | { key: string; depth: number; type: 'status'; text: string; error?: boolean }

const LS_SYS = 'db.explorer.showSystem'

export default function DbExplorerPanel(): JSX.Element {
  const t = useT()
  const connections = useDb((s) => s.connections)
  const loaded = useDb((s) => s.loaded)
  const reload = useDb((s) => s.reload)
  const openSql = useDb((s) => s.openSql)
  const openObject = useDb((s) => s.openObject)

  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  // Fetch results per node key. A Map in state, replaced on every write.
  const [cache, setCache] = useState<Map<string, Load<unknown>>>(() => new Map())
  const [filter, setFilter] = useState('')
  const [showSystem, setShowSystem] = useState(() => localStorage.getItem(LS_SYS) === '1')
  const [selected, setSelected] = useState<string | null>(null)
  const [form, setForm] = useState<{ initial?: ConnectionInfo } | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [top, setTop] = useState(0)
  const [height, setHeight] = useState(400)
  const inflight = useRef(new Set<string>())

  useEffect(() => {
    if (!loaded) void reload()
  }, [loaded, reload])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setHeight(el.clientHeight))
    ro.observe(el)
    setHeight(el.clientHeight)
    return () => ro.disconnect()
  }, [])

  const fetchNode = useCallback((key: string, fn: () => Promise<unknown>): void => {
    if (inflight.current.has(key)) return
    inflight.current.add(key)
    setCache((m) => new Map(m).set(key, { loading: true }))
    fn()
      .then((data) => setCache((m) => new Map(m).set(key, { loading: false, data })))
      .catch((e) => setCache((m) => new Map(m).set(key, { loading: false, error: errText(e) })))
      .finally(() => inflight.current.delete(key))
  }, [])

  const keys = {
    conn: (c: string) => `c:${c}`,
    db: (c: string, d: string) => `d:${c}\u0000${d}`,
    schema: (c: string, d: string, s: string) => `s:${c}\u0000${d}\u0000${s}`,
    group: (c: string, d: string, s: string, g: Group) => `g:${c}\u0000${d}\u0000${s}\u0000${g}`
  }

  const loadChildren = useCallback(
    (row: Row): void => {
      if (row.type === 'conn') fetchNode(row.key, () => window.api.db.databases(row.conn.id))
      else if (row.type === 'db') fetchNode(row.key, () => window.api.db.schemas(row.conn.id, row.db))
      else if (row.type === 'schema') fetchNode(row.key, () => window.api.db.objects(row.conn.id, row.db, row.schema))
    },
    [fetchNode]
  )

  const toggle = (row: Row): void => {
    const open = expanded.has(row.key)
    setExpanded((s) => {
      const n = new Set(s)
      if (open) n.delete(row.key)
      else n.add(row.key)
      return n
    })
    if (!open && row.type !== 'group' && !cache.get(row.key)?.data) loadChildren(row)
  }

  // Drop the cached subtree under a key so the next expand refetches it.
  const refresh = (row: Row): void => {
    const prefix = row.key.slice(2)
    setCache((m) => {
      const n = new Map(m)
      for (const k of n.keys()) if (k.slice(2).startsWith(prefix)) n.delete(k)
      return n
    })
    if (expanded.has(row.key) || row.type === 'conn') {
      setExpanded((s) => new Set(s).add(row.key))
      // The cache delete above lands first: the fetch sees no stale data.
      setTimeout(() => loadChildren(row), 0)
    }
  }

  const rows = useMemo(() => {
    const out: Row[] = []
    const q = filter.trim().toLowerCase()
    const status = (key: string, depth: number, l: Load<unknown> | undefined): boolean => {
      if (!l || l.loading) {
        out.push({ key: `${key}#l`, depth, type: 'status', text: t('db.loading') })
        return true
      }
      if (l.error) {
        out.push({ key: `${key}#e`, depth, type: 'status', text: l.error, error: true })
        return true
      }
      return false
    }
    for (const conn of connections) {
      const ck = keys.conn(conn.id)
      out.push({ key: ck, depth: 0, type: 'conn', conn })
      if (!expanded.has(ck)) continue
      const dbl = cache.get(ck) as Load<string[]> | undefined
      if (status(ck, 1, dbl)) continue
      // The configured database first; the rest alphabetically after it.
      const dbs = [...(dbl!.data ?? [])].sort((a, b) =>
        a === conn.database ? -1 : b === conn.database ? 1 : a.localeCompare(b)
      )
      for (const db of dbs) {
        const dk = keys.db(conn.id, db)
        out.push({ key: dk, depth: 1, type: 'db', conn, db })
        if (!expanded.has(dk)) continue
        const sl = cache.get(dk) as Load<SchemaInfo[]> | undefined
        if (status(dk, 2, sl)) continue
        for (const s of sl!.data ?? []) {
          if (s.isSystem && !showSystem) continue
          const sk = keys.schema(conn.id, db, s.name)
          out.push({ key: sk, depth: 2, type: 'schema', conn, db, schema: s.name })
          if (!expanded.has(sk)) continue
          const ol = cache.get(sk) as Load<DbObject[]> | undefined
          if (status(sk, 3, ol)) continue
          const objs = q ? (ol!.data ?? []).filter((o) => o.name.toLowerCase().includes(q)) : ol!.data ?? []
          for (const g of GROUPS) {
            const items = objs.filter((o) => g.kinds.includes(o.kind))
            if (!items.length) continue
            const gk = keys.group(conn.id, db, s.name, g.id)
            out.push({ key: gk, depth: 3, type: 'group', conn, db, schema: s.name, group: g.id, count: items.length })
            // Tables start open: that's what people come for. A filter opens all.
            const open = q ? !expanded.has(`${gk}!`) : expanded.has(gk) !== (g.id === 'tables')
            if (!open) continue
            for (const obj of items) out.push({ key: `o:${gk}\u0000${obj.name}\u0000${obj.args ?? ''}`, depth: 4, type: 'obj', conn, db, schema: s.name, obj })
          }
          if (!objs.length) out.push({ key: `${sk}#0`, depth: 3, type: 'status', text: q ? t('db.noMatch') : t('db.empty') })
        }
      }
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connections, expanded, cache, filter, showSystem, t])

  const groupOpen = (row: Extract<Row, { type: 'group' }>): boolean =>
    filter.trim() ? !expanded.has(`${row.key}!`) : expanded.has(row.key) !== (row.group === 'tables')

  const toggleGroup = (row: Extract<Row, { type: 'group' }>): void => {
    const k = filter.trim() ? `${row.key}!` : row.key
    setExpanded((s) => {
      const n = new Set(s)
      if (n.has(k)) n.delete(k)
      else n.add(k)
      return n
    })
  }

  const isOpen = (row: Row): boolean => (row.type === 'group' ? groupOpen(row) : expanded.has(row.key))

  const openConsole = (conn: ConnectionInfo, db?: string, sql = '', run = false): void => {
    openSql(conn.id, db, sql, run)
  }

  const qualified = (conn: ConnectionInfo, schema: string, name: string): string =>
    `${quoteIdent(conn.kind, schema)}.${quoteIdent(conn.kind, name)}`

  const openObj = (row: Extract<Row, { type: 'obj' }>): void => {
    openObject(row.conn.id, row.db, row.schema, row.obj.name, row.obj.kind)
  }

  // Tables and views open as data (the usual double-click); routines and the
  // like have no rows, so they open their definition.
  const selectTop = (row: Extract<Row, { type: 'obj' }>): void =>
    openConsole(row.conn, row.db, `select * from ${qualified(row.conn, row.schema, row.obj.name)};`, true)

  const removeConn = async (conn: ConnectionInfo): Promise<void> => {
    if (!window.confirm(t('db.confirmDelete', { name: conn.name }))) return
    await window.api.db.delete(conn.id)
    await reload()
  }

  const menuFor = (row: Row): MenuItem[] => {
    switch (row.type) {
      case 'conn':
        return [
          { label: t('db.newConsole'), onClick: () => openConsole(row.conn, row.conn.database) },
          { label: t('db.refresh'), onClick: () => refresh(row) },
          { label: t('db.editConnection'), onClick: () => setForm({ initial: row.conn }), separator: true },
          { label: t('db.deleteConnection'), onClick: () => void removeConn(row.conn), danger: true }
        ]
      case 'db':
      case 'schema':
        return [
          {
            label: t('db.newConsole'),
            onClick: () =>
              openConsole(row.conn, row.db, row.type === 'schema' ? `set search_path to ${quoteIdent(row.conn.kind, row.schema)};\n` : '')
          },
          { label: t('db.refresh'), onClick: () => refresh(row) }
        ]
      case 'obj': {
        const q = qualified(row.conn, row.schema, row.obj.name)
        const items: MenuItem[] = [{ label: t('db.open'), onClick: () => openObj(row) }]
        if (isRelation(row.obj.kind)) items.push({ label: t('db.select100'), onClick: () => selectTop(row) })
        items.push(
          { label: t('db.copyName'), onClick: () => void navigator.clipboard.writeText(row.obj.name), separator: true },
          { label: t('db.copyQualified'), onClick: () => void navigator.clipboard.writeText(q) }
        )
        return items
      }
      default:
        return []
    }
  }

  const onRowClick = (row: Row): void => {
    setSelected(row.key)
    if (row.type === 'group') toggleGroup(row)
    else if (row.type !== 'obj' && row.type !== 'status') toggle(row)
  }

  const onRowDouble = (row: Row): void => {
    if (row.type !== 'obj') return
    if (isRelation(row.obj.kind)) selectTop(row)
    else openObj(row)
  }

  const first = Math.max(0, Math.floor(top / ROW_H) - OVERSCAN)
  const last = Math.min(rows.length, Math.ceil((top + height) / ROW_H) + OVERSCAN)

  return (
    <div className="dbx-root dbx-explorer">
      <div className="dbx-bar">
        <button className="dbx-icon-btn" title={t('db.newConnection')} onClick={() => setForm({})}>
          <Plus size={14} />
        </button>
        <button
          className="dbx-icon-btn"
          title={t('db.refreshAll')}
          onClick={() => {
            setCache(new Map())
            setExpanded(new Set())
            void reload()
          }}
        >
          <RefreshCw size={13} />
        </button>
        <TextInput className="dbx-filter" value={filter} placeholder={t('db.filter')} onChange={(e) => setFilter(e.target.value)} />
        <button
          className={`dbx-chip${showSystem ? ' on' : ''}`}
          title={t('db.showSystemHint')}
          onClick={() => {
            localStorage.setItem(LS_SYS, showSystem ? '0' : '1')
            setShowSystem(!showSystem)
          }}
        >
          {t('db.system')}
        </button>
      </div>
      <div className="dbx-tree" ref={scrollRef} onScroll={(e) => setTop(e.currentTarget.scrollTop)}>
        {loaded && connections.length === 0 && (
          <div className="dbx-empty-state">
            <Database size={28} />
            <div>{t('db.noConnections')}</div>
            <button className="dbx-link" onClick={() => setForm({})}>
              {t('db.newConnection')}
            </button>
          </div>
        )}
        <div style={{ height: rows.length * ROW_H, position: 'relative' }}>
          {rows.slice(first, last).map((row, k) => {
            const i = first + k
            return (
              <div
                key={row.key}
                className={`dbx-node dbx-node-${row.type}${selected === row.key ? ' sel' : ''}`}
                style={{ top: i * ROW_H, paddingLeft: 6 + row.depth * 14 }}
                onClick={() => onRowClick(row)}
                onDoubleClick={() => onRowDouble(row)}
                onContextMenu={(e) => {
                  const items = menuFor(row)
                  if (!items.length) return
                  e.preventDefault()
                  e.stopPropagation()
                  setSelected(row.key)
                  setMenu({ x: e.clientX, y: e.clientY, items })
                }}
                title={row.type === 'obj' ? objTitle(row.obj) : row.type === 'status' ? row.text : undefined}
              >
                {row.type === 'status' || row.type === 'obj' ? (
                  <span className="dbx-twisty" />
                ) : (
                  <span className="dbx-twisty">{isOpen(row) ? <ChevronDown size={12} /> : <ChevronRight size={12} />}</span>
                )}
                <NodeBody row={row} t={t} />
              </div>
            )
          })}
        </div>
      </div>
      {form && (
        <ConnectionForm
          initial={form.initial}
          onClose={() => setForm(null)}
          onSaved={(c) => {
            setForm(null)
            // Config changed: whatever was fetched through the old one is suspect.
            setCache((m) => {
              const n = new Map(m)
              for (const k of n.keys()) if (k.slice(2).startsWith(c.id)) n.delete(k)
              return n
            })
            void reload()
          }}
        />
      )}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  )
}

function objTitle(o: DbObject): string {
  const parts = [o.name + (o.args !== undefined ? `(${o.args})` : '')]
  if (o.result) parts[0] += ` -> ${o.result}`
  if (o.comment) parts.push(o.comment)
  return parts.join('\n')
}

function NodeBody({ row, t }: { row: Row; t: (k: string) => string }): JSX.Element {
  switch (row.type) {
    case 'conn':
      return (
        <>
          <span className="dbx-dot" style={row.conn.color ? { background: row.conn.color } : undefined} />
          <Server size={13} className="dbx-ico" />
          <span className="dbx-label">{row.conn.name}</span>
          {row.conn.readOnly && (
            <span className="dbx-badge" title={t('db.readOnly')}>
              <Lock size={10} />
            </span>
          )}
          <span className="dbx-meta">
            {row.conn.host}:{row.conn.port}
          </span>
        </>
      )
    case 'db':
      return (
        <>
          <Database size={13} className="dbx-ico g-db" />
          <span className="dbx-label">{row.db}</span>
          {row.db === row.conn.database && <span className="dbx-meta">{t('db.default')}</span>}
        </>
      )
    case 'schema':
      return (
        <>
          <Folder size={13} className="dbx-ico g-schema" />
          <span className="dbx-label">{row.schema}</span>
        </>
      )
    case 'group': {
      const Icon = GROUP_ICON[row.group]
      return (
        <>
          <Icon size={13} className={`dbx-ico g-${row.group}`} />
          <span className="dbx-label dim">{t(`db.g.${row.group}`)}</span>
          <span className="dbx-meta">{row.count}</span>
        </>
      )
    }
    case 'obj': {
      const g = GROUPS.find((x) => x.kinds.includes(row.obj.kind))!
      const Icon = GROUP_ICON[g.id]
      return (
        <>
          <Icon size={13} className={`dbx-ico g-${g.id}`} />
          <span className="dbx-label">{row.obj.name}</span>
          {row.obj.args !== undefined && <span className="dbx-meta">({row.obj.args})</span>}
          {row.obj.comment && <span className="dbx-meta">{row.obj.comment}</span>}
          {row.obj.rows != null && row.obj.rows >= 0 && <span className="dbx-meta right">{fmtRows(row.obj.rows)}</span>}
        </>
      )
    }
    case 'status':
      return <span className={`dbx-status${row.error ? ' err' : ''}`}>{row.text}</span>
  }
}

function fmtRows(n: number): string {
  if (n >= 1e9) return `~${(n / 1e9).toFixed(1)}B`
  if (n >= 1e6) return `~${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `~${(n / 1e3).toFixed(1)}K`
  return `~${n}`
}
