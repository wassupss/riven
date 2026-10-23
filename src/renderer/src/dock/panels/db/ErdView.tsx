import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Copy, Download, KeyRound, Maximize, RefreshCw, RotateCcw } from 'lucide-react'
import {
  bounds,
  edgePath,
  erdMermaid,
  ERD_HEAD,
  ERD_ROW,
  layoutErd,
  nodeHeight,
  shownColumns,
  type Box,
  type ErdModel,
  type ErdTable
} from '../../../../../main/db/erd'
import { useT } from '../../../i18n'
import { useDb, type ErdTab } from '../../../state/db'
import { TextInput } from '../../../components/ui/Controls'
import { errText } from './ConnectionForm'

// ER diagram of a schema: an SVG canvas with auto layout, pan and zoom,
// draggable tables (positions kept per schema), key-only mode, search and
// hover highlighting. Colors are written as attributes, not CSS, so the SVG
// export stands on its own.

const LS_KEYS = 'db.erd.keysOnly'
const posKey = (tab: ErdTab): string => `db.erd.pos.${tab.connId}/${tab.db ?? ''}/${tab.schema}`
const FONT = 12
const MIN_K = 0.1
const MAX_K = 2.5

type Pos = Record<string, { x: number; y: number }>
type View = { x: number; y: number; k: number }

interface Palette {
  fg: string
  dim: string
  line: string
  bg: string
  head: string
  accent: string
  pk: string
  fk: string
  font: string
  mono: string
}

function readPalette(el: Element): Palette {
  const cs = getComputedStyle(el)
  const v = (name: string, fallback: string): string => cs.getPropertyValue(name).trim() || fallback
  return {
    fg: v('--fg', '#ddd'),
    dim: v('--fg-dim', '#888'),
    line: v('--hairline', '#444'),
    bg: v('--bg-2', '#1e1e1e'),
    head: v('--bg-3', '#2a2a2a'),
    accent: v('--accent', '#4c8dff'),
    pk: v('--warning', '#d9a400'),
    fk: v('--info', '#3fa7d6'),
    font: v('--font-ui', 'system-ui, sans-serif'),
    mono: v('--font-mono', 'ui-monospace, monospace')
  }
}

function loadPos(tab: ErdTab): Pos {
  try {
    const p = JSON.parse(localStorage.getItem(posKey(tab)) ?? '{}') as unknown
    return p && typeof p === 'object' ? (p as Pos) : {}
  } catch {
    return {}
  }
}

/** Text widths for sizing nodes, from one offscreen canvas. */
function measurer(font: string, mono: string): (t: ErdTable, keysOnly: boolean) => { w: number; h: number } {
  const ctx = document.createElement('canvas').getContext('2d')
  const width = (s: string, f: string): number => {
    if (!ctx) return s.length * 7
    ctx.font = f
    return ctx.measureText(s).width
  }
  return (t, keysOnly) => {
    const cols = shownColumns(t, keysOnly)
    let w = width(t.external ? t.key : t.name, `600 ${FONT}px ${font}`) + 28
    for (const c of cols) w = Math.max(w, 26 + width(c.name, `${FONT}px ${font}`) + 18 + width(c.type, `${FONT - 1}px ${mono}`) + 10)
    return { w: Math.ceil(Math.min(420, Math.max(150, w))), h: nodeHeight(cols.length) }
  }
}

export default function ErdView({ tab }: { tab: ErdTab }): JSX.Element {
  const t = useT()
  const openObject = useDb((s) => s.openObject)
  const seq = useDb((s) =>
    s.changed && s.changed.connId === tab.connId && s.changed.db === tab.db && (s.changed.schema === undefined || s.changed.schema === tab.schema)
      ? s.changed.seq
      : 0
  )
  const [model, setModel] = useState<ErdModel | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [keysOnly, setKeysOnly] = useState(() => localStorage.getItem(LS_KEYS) === '1')
  const [q, setQ] = useState('')
  const [pos, setPos] = useState<Pos>(() => loadPos(tab))
  const posRef = useRef(pos)
  posRef.current = pos
  const [view, setView] = useState<View>({ x: 20, y: 20, k: 1 })
  const [hover, setHover] = useState<string | null>(null)
  const [palette, setPalette] = useState<Palette | null>(null)
  const wrap = useRef<HTMLDivElement>(null)
  const svg = useRef<SVGSVGElement>(null)
  const fitted = useRef(false)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const load = useCallback(async (): Promise<void> => {
    setBusy(true)
    try {
      const m = await window.api.db.erd(tab.connId, tab.db, tab.schema)
      if (!alive.current) return
      setModel(m)
      setError(null)
    } catch (e) {
      if (alive.current) setError(errText(e))
    } finally {
      if (alive.current) setBusy(false)
    }
  }, [tab.connId, tab.db, tab.schema])

  useEffect(() => {
    void load()
  }, [load, seq])

  useLayoutEffect(() => {
    if (wrap.current) setPalette(readPalette(wrap.current))
  }, [])

  const size = useMemo(() => (palette ? measurer(palette.font, palette.mono) : null), [palette])
  const auto = useMemo(
    () => (model && size ? layoutErd(model, (x) => size(x, keysOnly)) : null),
    [model, size, keysOnly]
  )
  const boxes = useMemo(() => {
    if (!auto) return null
    const out: Record<string, Box> = {}
    for (const [k, b] of Object.entries(auto)) {
      const p = pos[k]
      out[k] = p ? { ...b, x: p.x, y: p.y } : b
    }
    return out
  }, [auto, pos])

  const fit = useCallback((): void => {
    const el = wrap.current
    if (!el || !boxes) return
    const b = bounds(Object.values(boxes))
    const r = el.getBoundingClientRect()
    if (!b.w || !r.width) return
    const k = Math.max(MIN_K, Math.min(1, (r.width - 40) / b.w, (r.height - 40) / b.h))
    setView({ k, x: (r.width - b.w * k) / 2 - b.x * k, y: Math.max(20, (r.height - b.h * k) / 2) - b.y * k })
  }, [boxes])

  useEffect(() => {
    if (boxes && !fitted.current) {
      fitted.current = true
      fit()
    }
  }, [boxes, fit])

  // Wheel: pan, or zoom around the cursor with ctrl/cmd (and trackpad pinch).
  useEffect(() => {
    const el = wrap.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      const r = el.getBoundingClientRect()
      const mx = e.clientX - r.left
      const my = e.clientY - r.top
      if (e.ctrlKey || e.metaKey) {
        setView((v) => {
          const k = Math.min(MAX_K, Math.max(MIN_K, v.k * Math.exp(-e.deltaY * 0.01)))
          return { k, x: mx - ((mx - v.x) * k) / v.k, y: my - ((my - v.y) * k) / v.k }
        })
      } else setView((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  // Background drag pans; a table drag moves it.
  const drag = useRef<{ kind: 'pan' | 'node'; key?: string; sx: number; sy: number; ox: number; oy: number; moved: boolean } | null>(null)
  const viewRef = useRef(view)
  viewRef.current = view
  const onPointerDown = (e: React.PointerEvent): void => {
    if (e.button !== 0 || !boxes) return
    const node = (e.target as Element).closest('[data-key]')
    const key = node?.getAttribute('data-key') ?? undefined
    if (key && boxes[key]) drag.current = { kind: 'node', key, sx: e.clientX, sy: e.clientY, ox: boxes[key].x, oy: boxes[key].y, moved: false }
    else drag.current = { kind: 'pan', sx: e.clientX, sy: e.clientY, ox: view.x, oy: view.y, moved: false }
    ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
  }
  const onPointerMove = (e: React.PointerEvent): void => {
    const d = drag.current
    if (!d) return
    const dx = e.clientX - d.sx
    const dy = e.clientY - d.sy
    if (!d.moved && Math.abs(dx) + Math.abs(dy) < 3) return
    d.moved = true
    if (d.kind === 'pan') setView((v) => ({ ...v, x: d.ox + dx, y: d.oy + dy }))
    else {
      const k = viewRef.current.k
      const key = d.key!
      setPos((p) => ({ ...p, [key]: { x: Math.round(d.ox + dx / k), y: Math.round(d.oy + dy / k) } }))
    }
  }
  const onPointerUp = (): void => {
    const d = drag.current
    drag.current = null
    if (d?.kind === 'node' && d.moved) localStorage.setItem(posKey(tab), JSON.stringify(posRef.current))
  }

  const resetLayout = (): void => {
    localStorage.removeItem(posKey(tab))
    setPos({})
    fitted.current = false
  }

  const toggleKeys = (): void => {
    setKeysOnly((v) => {
      localStorage.setItem(LS_KEYS, v ? '0' : '1')
      return !v
    })
  }

  const needle = q.trim().toLowerCase()
  const matches = useMemo(() => {
    if (!model || !needle) return null
    return new Set(
      model.tables
        .filter((x) => x.key.toLowerCase().includes(needle) || x.columns.some((c) => c.name.toLowerCase().includes(needle)))
        .map((x) => x.key)
    )
  }, [model, needle])

  // Hovering a table lights it, its references and the tables on the other end.
  const lit = useMemo(() => {
    if (!model || !hover) return null
    const s = new Set([hover])
    for (const r of model.refs) if (r.from === hover || r.to === hover) s.add(r.from).add(r.to)
    return s
  }, [model, hover])

  const tables = useMemo(() => new Map(model?.tables.map((x) => [x.key, x]) ?? []), [model])

  const edges = useMemo(() => {
    if (!model || !boxes) return []
    return model.refs.flatMap((r) => {
      const a = boxes[r.from]
      const b = boxes[r.to]
      const ta = tables.get(r.from)
      const tb = tables.get(r.to)
      if (!a || !b || !ta || !tb) return []
      const ra = shownColumns(ta, keysOnly).findIndex((c) => c.name === r.fromCols[0])
      const rb = shownColumns(tb, keysOnly).findIndex((c) => c.name === r.toCols[0])
      return [{ ref: r, ...edgePath(a, ra, b, rb) }]
    })
  }, [model, boxes, tables, keysOnly])

  const open = useCallback(
    (x: ErdTable): void => void openObject(tab.connId, tab.db, x.schema, x.name, x.kind),
    [openObject, tab.connId, tab.db]
  )

  const exportSvg = async (): Promise<void> => {
    const el = svg.current
    if (!el || !boxes) return
    const b = bounds(Object.values(boxes))
    const pad = 24
    const clone = el.cloneNode(true) as SVGSVGElement
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
    clone.setAttribute('viewBox', `${b.x - pad} ${b.y - pad} ${b.w + pad * 2} ${b.h + pad * 2}`)
    clone.setAttribute('width', String(Math.ceil(b.w + pad * 2)))
    clone.setAttribute('height', String(Math.ceil(b.h + pad * 2)))
    clone.removeAttribute('class')
    clone.querySelector('g[data-root]')?.removeAttribute('transform')
    const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
    bg.setAttribute('x', String(b.x - pad))
    bg.setAttribute('y', String(b.y - pad))
    bg.setAttribute('width', String(b.w + pad * 2))
    bg.setAttribute('height', String(b.h + pad * 2))
    bg.setAttribute('fill', palette?.bg ?? '#fff')
    clone.insertBefore(bg, clone.firstChild)
    const text = `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(clone)}\n`
    try {
      const path = await window.api.db.saveText(`${tab.schema}-erd`, 'svg', text)
      if (path) setStatus({ ok: true, text: t('db.erd.saved', { path }) })
    } catch (e) {
      setStatus({ ok: false, text: errText(e) })
    }
  }

  const copyMermaid = async (): Promise<void> => {
    if (!model) return
    await navigator.clipboard.writeText(erdMermaid(model))
    setStatus({ ok: true, text: t('db.erd.copied') })
  }

  const own = model ? model.tables.filter((x) => !x.external).length : 0

  return (
    <div className="dbx-obj dbx-erd">
      <div className="dbx-obj-head">
        <span className="dbx-obj-title">{t('db.erd.erd')}</span>
        <span className="dbx-meta">{tab.schema}</span>
        {model && <span className="dbx-meta">{t('db.erd.counts', { tables: String(own), refs: String(model.refs.length) })}</span>}
        <span className="dbx-spacer" />
        <TextInput className="dbx-erd-q" placeholder={t('db.erd.search')} value={q} onChange={(e) => setQ(e.target.value)} />
        <button className={`dbx-chip${keysOnly ? ' on' : ''}`} onClick={toggleKeys} title={t('db.erd.keysOnlyHint')}>
          <KeyRound size={12} /> {t('db.erd.keysOnly')}
        </button>
        <span className="dbx-meta dbx-erd-zoom">{Math.round(view.k * 100)}%</span>
        <button className="dbx-icon-btn" title={t('db.erd.fit')} onClick={fit} disabled={!boxes}>
          <Maximize size={13} />
        </button>
        <button className="dbx-icon-btn" title={t('db.erd.resetLayout')} onClick={resetLayout} disabled={!Object.keys(pos).length}>
          <RotateCcw size={13} />
        </button>
        <button className="dbx-icon-btn" title={t('db.erd.copyMermaid')} onClick={() => void copyMermaid()} disabled={!model}>
          <Copy size={13} />
        </button>
        <button className="dbx-icon-btn" title={t('db.erd.exportSvg')} onClick={() => void exportSvg()} disabled={!boxes}>
          <Download size={13} />
        </button>
        <button className="dbx-icon-btn" title={t('db.refresh')} onClick={() => void load()} disabled={busy}>
          <RefreshCw size={13} className={busy ? 'dbx-spin' : undefined} />
        </button>
      </div>
      {status && <div className={`dbx-form-status ${status.ok ? 'ok' : 'err'}`}>{status.text}</div>}
      {error && <div className="dbx-error">{error}</div>}
      <div
        ref={wrap}
        className="dbx-erd-canvas"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        {model && !model.tables.length && <div className="dbx-empty-state">{t('db.erd.empty')}</div>}
        {palette && boxes && model && (
          <svg ref={svg} className="dbx-erd-svg" width="100%" height="100%" fontFamily={palette.font} fontSize={FONT}>
            <g data-root="" transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
              {edges.map((e) => {
                const on = lit ? lit.has(e.ref.from) && lit.has(e.ref.to) && (e.ref.from === hover || e.ref.to === hover) : false
                const faded = (lit && !on) || (matches && !(matches.has(e.ref.from) || matches.has(e.ref.to)))
                const color = on ? palette.accent : palette.dim
                const { x1, y1, x2, y2, dir1, dir2 } = e
                return (
                  <g key={e.ref.name + e.ref.from} opacity={faded ? 0.15 : on ? 1 : 0.75}>
                    <title>{`${e.ref.name}: ${e.ref.from}(${e.ref.fromCols.join(', ')}) → ${e.ref.to}(${e.ref.toCols.join(', ')})`}</title>
                    <path d={e.d} fill="none" stroke={color} strokeWidth={on ? 1.8 : 1.2} />
                    {/* many: crow's foot at the referencing end */}
                    <path
                      d={`M${x1 + dir1 * 10},${y1} L${x1},${y1 - 5} M${x1 + dir1 * 10},${y1} L${x1},${y1} M${x1 + dir1 * 10},${y1} L${x1},${y1 + 5}`}
                      fill="none"
                      stroke={color}
                      strokeWidth={1.2}
                    />
                    {/* one: a bar at the referenced end */}
                    <path d={`M${x2 + dir2 * 7},${y2 - 5} L${x2 + dir2 * 7},${y2 + 5}`} fill="none" stroke={color} strokeWidth={1.4} />
                  </g>
                )
              })}
              {model.tables.map((x) => {
                const b = boxes[x.key]
                if (!b) return null
                const faded = (lit && !lit.has(x.key)) || (matches && !matches.has(x.key))
                return (
                  <ErdNode
                    key={x.key}
                    table={x}
                    box={b}
                    keysOnly={keysOnly}
                    palette={palette}
                    hot={hover === x.key || (!!matches && matches.has(x.key))}
                    faded={!!faded}
                    onHover={setHover}
                    onOpen={open}
                  />
                )
              })}
            </g>
          </svg>
        )}
      </div>
    </div>
  )
}

const ErdNode = memo(function ErdNode({
  table: x,
  box: b,
  keysOnly,
  palette: p,
  hot,
  faded,
  onHover,
  onOpen
}: {
  table: ErdTable
  box: Box
  keysOnly: boolean
  palette: Palette
  hot: boolean
  faded: boolean
  onHover: (k: string | null) => void
  onOpen: (x: ErdTable) => void
}): JSX.Element {
  const cols = shownColumns(x, keysOnly)
  const hidden = x.columns.length - cols.length
  return (
    <g
      data-key={x.key}
      transform={`translate(${b.x},${b.y})`}
      opacity={faded ? 0.3 : 1}
      style={{ cursor: 'grab' }}
      onPointerEnter={() => onHover(x.key)}
      onPointerLeave={() => onHover(null)}
      onDoubleClick={() => onOpen(x)}
    >
      {x.comment && <title>{x.comment}</title>}
      <rect
        width={b.w}
        height={b.h}
        rx={6}
        fill={p.bg}
        stroke={hot ? p.accent : p.line}
        strokeWidth={hot ? 1.6 : 1}
        strokeDasharray={x.external ? '4 3' : undefined}
      />
      <path d={`M0,${ERD_HEAD} H${b.w}`} stroke={p.line} />
      <text x={10} y={ERD_HEAD / 2} dominantBaseline="central" fill={x.external ? p.dim : p.fg} fontWeight={600}>
        {x.external ? x.key : x.name}
      </text>
      {x.kind !== 'table' && (
        <text x={b.w - 8} y={ERD_HEAD / 2} dominantBaseline="central" textAnchor="end" fill={p.dim} fontSize={FONT - 2}>
          {x.kind === 'partitioned' ? 'P' : 'F'}
        </text>
      )}
      {cols.map((c, i) => {
        const y = ERD_HEAD + ERD_ROW * i + ERD_ROW / 2
        return (
          <g key={c.name}>
            {(c.pk || c.fk) && (
              <text x={9} y={y} dominantBaseline="central" fill={c.pk ? p.pk : p.fk} fontSize={FONT - 3} fontWeight={700}>
                {c.pk ? 'PK' : 'FK'}
              </text>
            )}
            <text x={28} y={y} dominantBaseline="central" fill={p.fg} fontWeight={c.pk ? 600 : undefined}>
              {c.name}
              {!c.notNull && !c.pk && <tspan fill={p.dim}>?</tspan>}
            </text>
            <text x={b.w - 10} y={y} dominantBaseline="central" textAnchor="end" fill={p.dim} fontFamily={p.mono} fontSize={FONT - 1}>
              {c.type}
            </text>
          </g>
        )
      })}
      {keysOnly && hidden > 0 && !cols.length && (
        <text x={10} y={ERD_HEAD + ERD_ROW / 2} dominantBaseline="central" fill={p.dim} fontSize={FONT - 1}>
          +{hidden}
        </text>
      )}
    </g>
  )
})
