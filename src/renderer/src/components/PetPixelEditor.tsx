import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type PointerEvent as ReactPointerEvent } from 'react'
import {
  Eraser,
  FlipHorizontal2,
  Grid3x3,
  PaintBucket,
  Pencil,
  Pipette,
  Plus,
  Redo2,
  Scissors,
  Slash,
  Square,
  Undo2
} from 'lucide-react'
import { useT } from '../i18n'
import { Button, Segmented } from './ui/Controls'
import { hexToRgb, minPhotoCells } from '../state/petSpecies'
import PetAiAsk from './PetAiAsk'
import { pngOf, scaleFor } from '../lib/petAi'
import { PIXEL_SYSTEM, buildPixelPrompt, parsePixelAnswer, rgbaOfDoc } from '../lib/petAiPixels'
import type { Rgba } from '../lib/petPhoto'
import {
  EMPTY,
  MAX_COLORS,
  addColor,
  cloneDoc,
  countDots,
  emptyHistory,
  floodFill,
  keepBiggest,
  lineCells,
  piecesOf,
  pushHistory,
  rectCells,
  redo,
  replaceColor,
  stamp,
  stampAll,
  undo,
  type History,
  type PixelDoc
} from '../lib/pixelEdit'

// ---------------------------------------------------------------------------
// The species maker's editor (PetMaker.tsx): a small pixel editor over the
// picture, on one 2D canvas (never a node per dot), redrawn only when
// something changes, once a frame at most. The pure half (fill, lines,
// mirror, palette, undo) is lib/pixelEdit.ts.
//
// It lays out the maker's two columns: the toolbar, the canvas, the palette
// and the AI line in the middle, and the side column the maker composes
// (`side`), handed the real-size picture and the dot count to put in it.
//
// The document lives in a ref and is changed in place while a stroke runs;
// a finished stroke is one undo step and is handed up with onChange. A new
// `seed` (the photo remade, a blank canvas) replaces it without a remount,
// so the tool, colour and zoom stay as they were.
// ---------------------------------------------------------------------------

export type PixelTool = 'pencil' | 'eraser' | 'fill' | 'picker' | 'line' | 'rect'
type Zoom = '1' | '2' | '4'

const TOOLS: Array<{ id: PixelTool; key: string; icon: ReactNode }> = [
  { id: 'pencil', key: 'b', icon: <Pencil size={15} /> },
  { id: 'eraser', key: 'e', icon: <Eraser size={15} /> },
  { id: 'fill', key: 'g', icon: <PaintBucket size={15} /> },
  { id: 'picker', key: 'i', icon: <Pipette size={15} /> },
  { id: 'line', key: 'l', icon: <Slash size={15} /> },
  { id: 'rect', key: 'r', icon: <Square size={15} /> }
]

const typing = (el: EventTarget | null): boolean => {
  const e = el as HTMLElement | null
  if (!e) return false
  const tag = e.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.isContentEditable
}

interface Stroke {
  before: PixelDoc
  value: number
  last: [number, number]
  /** Line and rectangle: where the drag began and the cells under the shape. */
  anchor: [number, number]
  base: Uint8Array | null
  changed: boolean
}

/** A picture at its own size on a canvas (CSS scales it up, pixelated). */
function DocCanvas({ doc, label }: { doc: PixelDoc; label: string }): JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const ctx = ref.current?.getContext('2d')
    if (!ctx) return
    const img = ctx.createImageData(doc.n, doc.n)
    img.data.set(rgbaOfDoc(doc, hexToRgb))
    ctx.putImageData(img, 0, 0)
  }, [doc])
  return <canvas ref={ref} width={doc.n} height={doc.n} className="pm-pixels pai-canvas" aria-label={label} />
}

export default function PetPixelEditor({
  seed,
  onChange,
  side,
  photo
}: {
  /** The picture to edit; a new `gen` replaces what is there (and its undo). */
  seed: { gen: number; doc: PixelDoc }
  onChange: (doc: PixelDoc) => void
  /** The side column, given the picture at its real size and the dot count. */
  side: (parts: { real: ReactNode; status: ReactNode }) => ReactNode
  /** The square photo crop the picture was made from, if there is one (the AI sees it too). */
  photo?: Rgba | null
}): JSX.Element {
  const t = useT()
  const doc = useRef<PixelDoc>(cloneDoc(seed.doc))
  const history = useRef<History<PixelDoc>>(emptyHistory())
  // Bumped on every commit: what the controls read (palette, counts, undo).
  const [version, setVersion] = useState(0)
  const [tool, setTool] = useState<PixelTool>('pencil')
  const [color, setColor] = useState(0)
  const [size, setSize] = useState(1)
  const [mirror, setMirror] = useState(false)
  const [grid, setGrid] = useState(true)
  const [zoom, setZoom] = useState<Zoom>('1')
  const [adding, setAdding] = useState(false)
  const [newHex, setNewHex] = useState('#ffffff')
  const [fullAsk, setFullAsk] = useState(false)

  const stageRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const small1 = useRef<HTMLCanvasElement>(null)
  const source = useRef<HTMLCanvasElement | null>(null)
  const [fit, setFit] = useState(320)
  const hover = useRef<[number, number] | null>(null)
  const stroke = useRef<Stroke | null>(null)
  const frame = useRef(0)
  const n = doc.current.n

  // The "fit" size is the largest square the stage has room for; zoom makes
  // the canvas bigger and the view scrolls.
  useEffect(() => {
    // Measured on the stage, not the view, so the view's own size never feeds back into it.
    const el = stageRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setFit(Math.max(96, Math.floor(Math.min(el.clientWidth, el.clientHeight)) - 2)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // ---- drawing ----
  const accent = useRef('#4c8bf5')
  useEffect(() => {
    const v = canvasRef.current && getComputedStyle(canvasRef.current).getPropertyValue('--accent').trim()
    if (v) accent.current = v
  }, [])

  const paint = useCallback((): void => {
    frame.current = 0
    const d = doc.current
    const N = d.n
    const rgb = d.palette.map(hexToRgb)
    // The picture at its own size: the source the big view scales up, and the real-size preview.
    const src = (source.current ??= document.createElement('canvas'))
    if (src.width !== N) {
      src.width = N
      src.height = N
    }
    const sctx = src.getContext('2d')
    if (!sctx) return
    const img = sctx.createImageData(N, N)
    for (let i = 0; i < N * N; i++) {
      const v = d.cells[i]
      if (!v) continue
      const c = rgb[v - 1]
      if (!c) continue
      img.data[i * 4] = c[0]
      img.data[i * 4 + 1] = c[1]
      img.data[i * 4 + 2] = c[2]
      img.data[i * 4 + 3] = 255
    }
    sctx.putImageData(img, 0, 0)
    small1.current?.getContext('2d')?.putImageData(img, 0, 0)

    const cv = canvasRef.current
    const ctx = cv?.getContext('2d')
    if (!cv || !ctx) return
    const W = cv.width
    const k = W / N
    ctx.clearRect(0, 0, W, W)
    ctx.imageSmoothingEnabled = false
    ctx.drawImage(src, 0, 0, W, W)
    const at = (i: number): number => Math.round(i * k) + 0.5
    if (grid && k >= 4) {
      ctx.strokeStyle = 'rgba(128,128,128,0.22)'
      ctx.lineWidth = 1
      ctx.beginPath()
      for (let i = 1; i < N; i++) {
        ctx.moveTo(at(i), 0)
        ctx.lineTo(at(i), W)
        ctx.moveTo(0, at(i))
        ctx.lineTo(W, at(i))
      }
      ctx.stroke()
    }
    if (mirror) {
      ctx.strokeStyle = accent.current
      ctx.lineWidth = Math.max(1, Math.round(window.devicePixelRatio || 1))
      ctx.beginPath()
      ctx.moveTo(W / 2, 0)
      ctx.lineTo(W / 2, W)
      ctx.stroke()
    }
    // Where the brush would land.
    const h = hover.current
    if (h && (tool === 'pencil' || tool === 'eraser' || tool === 'line' || tool === 'rect')) {
      const from = -Math.floor((size - 1) / 2)
      ctx.strokeStyle = accent.current
      ctx.lineWidth = Math.max(1, Math.round(window.devicePixelRatio || 1))
      const box = (x: number): void => ctx.strokeRect(Math.round(x * k) + 0.5, Math.round((h[1] + from) * k) + 0.5, Math.round(size * k) - 1, Math.round(size * k) - 1)
      box(h[0] + from)
      if (mirror) box(N - 1 - (h[0] + from) - (size - 1))
    } else if (h) {
      ctx.strokeStyle = accent.current
      ctx.lineWidth = 1
      ctx.strokeRect(Math.round(h[0] * k) + 0.5, Math.round(h[1] * k) + 0.5, Math.round(k) - 1, Math.round(k) - 1)
    }
  }, [grid, mirror, tool, size])

  const schedule = useCallback((): void => {
    if (!frame.current) frame.current = requestAnimationFrame(paint)
  }, [paint])
  useEffect(() => () => cancelAnimationFrame(frame.current), [])

  // The big canvas's backing store follows its css size and the screen's density.
  const css = fit * Number(zoom)
  useEffect(() => {
    const cv = canvasRef.current
    if (!cv) return
    const px = Math.round(css * (window.devicePixelRatio || 1))
    if (cv.width !== px) {
      cv.width = px
      cv.height = px
    }
    schedule()
  }, [css, schedule, version])

  // ---- commits and undo ----
  // The maker's handler changes every render; the keys listener should not re-subscribe for it.
  const changed = useRef(onChange)
  changed.current = onChange
  const commit = useCallback(
    (before: PixelDoc, key: string | null = null): void => {
      history.current = pushHistory(history.current, before, key)
      setVersion((v) => v + 1)
      changed.current(cloneDoc(doc.current))
    },
    []
  )
  const step = useCallback(
    (dir: 'undo' | 'redo'): void => {
      const r = (dir === 'undo' ? undo : redo)(history.current, cloneDoc(doc.current))
      if (!r) return
      history.current = r.history
      doc.current = r.state
      setColor((c) => Math.min(c, Math.max(0, r.state.palette.length - 1)))
      setVersion((v) => v + 1)
      changed.current(cloneDoc(doc.current))
    },
    []
  )

  // A new seed: the picture replaced, its undo with it (what it replaced is gone).
  const seedGen = useRef(seed.gen)
  useEffect(() => {
    if (seed.gen === seedGen.current) return
    seedGen.current = seed.gen
    doc.current = cloneDoc(seed.doc)
    history.current = emptyHistory()
    stroke.current = null
    setColor((c) => Math.min(c, Math.max(0, seed.doc.palette.length - 1)))
    setVersion((v) => v + 1)
  }, [seed])

  // A whole new picture (the AI's, applied): one undo step.
  const applyDoc = (next: PixelDoc): void => {
    if (next.n !== doc.current.n) return
    const before = cloneDoc(doc.current)
    doc.current = cloneDoc(next)
    setColor((c) => Math.min(c, Math.max(0, next.palette.length - 1)))
    commit(before)
    schedule()
  }

  // ---- pointer ----
  const cellOf = (e: ReactPointerEvent<HTMLCanvasElement>): [number, number] => {
    const r = e.currentTarget.getBoundingClientRect()
    return [Math.floor(((e.clientX - r.left) / r.width) * n), Math.floor(((e.clientY - r.top) / r.height) * n)]
  }
  const inGrid = ([x, y]: [number, number]): boolean => x >= 0 && y >= 0 && x < n && y < n

  const pick = ([x, y]: [number, number]): void => {
    const v = doc.current.cells[y * n + x]
    if (v) setColor(v - 1)
  }

  const onDown = (e: ReactPointerEvent<HTMLCanvasElement>): void => {
    if (e.button !== 0 && e.button !== 2) return
    const pt = cellOf(e)
    if (!inGrid(pt)) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    const d = doc.current
    if (tool === 'picker') {
      pick(pt)
      stroke.current = { before: d, value: 0, last: pt, anchor: pt, base: null, changed: false }
      return
    }
    // A right click rubs out, whatever draws.
    const value = tool === 'eraser' || e.button === 2 ? EMPTY : color + 1
    const before = cloneDoc(d)
    if (tool === 'fill') {
      if (floodFill(d.cells, n, pt[0], pt[1], value, mirror)) {
        commit(before)
        schedule()
      }
      return
    }
    const s: Stroke = { before, value, last: pt, anchor: pt, base: null, changed: false }
    if (tool === 'line' || tool === 'rect') s.base = d.cells.slice()
    s.changed = stamp(d.cells, n, pt[0], pt[1], size, value, mirror)
    stroke.current = s
    schedule()
  }

  const onMove = (e: ReactPointerEvent<HTMLCanvasElement>): void => {
    const pt = cellOf(e)
    const h = hover.current
    const s = stroke.current
    if (!s) {
      const next = inGrid(pt) ? pt : null
      if (h?.[0] !== next?.[0] || h?.[1] !== next?.[1]) {
        hover.current = next
        schedule()
      }
      return
    }
    hover.current = inGrid(pt) ? pt : null
    if (pt[0] === s.last[0] && pt[1] === s.last[1]) return
    const d = doc.current
    if (tool === 'picker') {
      if (inGrid(pt)) pick(pt)
    } else if (s.base) {
      // The shape is drawn again over what was under it, every move.
      d.cells.set(s.base)
      const pts = tool === 'line' ? lineCells(s.anchor[0], s.anchor[1], pt[0], pt[1]) : rectCells(s.anchor[0], s.anchor[1], pt[0], pt[1])
      stampAll(d.cells, n, pts, size, s.value, mirror)
      s.changed = true
    } else if (stampAll(d.cells, n, lineCells(s.last[0], s.last[1], pt[0], pt[1]), size, s.value, mirror)) {
      // Every cell between the last event and this one: no gaps however fast the drag.
      s.changed = true
    }
    s.last = pt
    schedule()
  }

  const onUp = (): void => {
    const s = stroke.current
    stroke.current = null
    if (!s) return
    if (tool === 'picker') {
      // Picked: back to drawing with it.
      setTool('pencil')
      return
    }
    const now = doc.current.cells
    if (s.changed && s.before.cells.some((v, i) => v !== now[i])) commit(s.before)
  }

  // ---- keys ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (typing(e.target)) return
      const mod = e.metaKey || e.ctrlKey
      const k = e.key.toLowerCase()
      if (mod && k === 'z') {
        e.preventDefault()
        step(e.shiftKey ? 'redo' : 'undo')
        return
      }
      if (mod && k === 'y') {
        e.preventDefault()
        step('redo')
        return
      }
      if (mod || e.altKey) return
      const hit = TOOLS.find((x) => x.key === k)
      if (hit) setTool(hit.id)
      else if (k === 'm') setMirror((m) => !m)
      else if (k === '1' || k === '2' || k === '3') setSize(Number(k))
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [step])

  // ---- palette ----
  const palette = doc.current.palette
  const choose = (i: number): void => {
    setColor(i)
    if (tool === 'eraser' || tool === 'picker') setTool('pencil')
  }
  const recolor = (i: number, hex: string): void => {
    const before = cloneDoc(doc.current)
    doc.current.palette = replaceColor(doc.current.palette, i, hex)
    // Dragging through a picker is one undo step.
    commit(before, `recolor:${i}`)
    schedule()
  }
  const add = (): void => {
    const r = addColor(doc.current.palette, newHex)
    if (!r) return setFullAsk(true)
    if (r.palette !== doc.current.palette) {
      const before = cloneDoc(doc.current)
      doc.current.palette = r.palette
      commit(before)
    }
    choose(r.index)
    setAdding(false)
  }
  const replaceSelected = (): void => {
    recolor(color, newHex)
    setFullAsk(false)
    setAdding(false)
    choose(color)
  }

  // ---- what the controls show ----
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const dots = useMemo(() => countDots(doc.current.cells), [version])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const pieces = useMemo(() => piecesOf(doc.current.cells, n).length, [version, n])
  const need = minPhotoCells(n)
  const canUndo = history.current.past.length > 0
  const canRedo = history.current.future.length > 0
  const toolName = (id: PixelTool): string => t(`pet.px.tool.${id}`)
  const zoomLabel = (z: Zoom): string => (z === '1' ? t('pet.px.zoomFit') : `${z}x`)
  const tip = (name: string, key: string): string => `${name} (${key})`

  return (
    <>
      <div className="pmk-main">
        <div className="pmx-bar" role="toolbar" aria-label={t('pet.px.tools')}>
          {TOOLS.map((x) => (
            <button
              key={x.id}
              type="button"
              className={`pmx-btn${tool === x.id ? ' on' : ''}`}
              aria-pressed={tool === x.id}
              aria-label={toolName(x.id)}
              title={`${tip(toolName(x.id), x.key.toUpperCase())}\n${t(`pet.px.hint.${x.id}`)}`}
              onClick={() => setTool(x.id)}
            >
              {x.icon}
            </button>
          ))}
          <span className="pmx-sep" />
          {[1, 2, 3].map((s) => (
            <button
              key={s}
              type="button"
              className={`pmx-btn${size === s ? ' on' : ''}`}
              aria-pressed={size === s}
              aria-label={t('pet.px.sizeN', { n: s })}
              title={tip(t('pet.px.sizeN', { n: s }), String(s))}
              onClick={() => setSize(s)}
            >
              <span className="pmx-dot" style={{ width: 2 + s * 3, height: 2 + s * 3 }} />
            </button>
          ))}
          <button
            type="button"
            className={`pmx-btn${mirror ? ' on' : ''}`}
            aria-pressed={mirror}
            aria-label={t('pet.px.mirror')}
            title={tip(t('pet.px.mirror'), 'M')}
            onClick={() => setMirror((m) => !m)}
          >
            <FlipHorizontal2 size={15} />
          </button>
          <span className="pmx-sep" />
          <button type="button" className="pmx-btn" disabled={!canUndo} aria-label={t('pet.px.undo')} title={tip(t('pet.px.undo'), '⌘Z')} onClick={() => step('undo')}>
            <Undo2 size={15} />
          </button>
          <button type="button" className="pmx-btn" disabled={!canRedo} aria-label={t('pet.px.redo')} title={tip(t('pet.px.redo'), '⇧⌘Z')} onClick={() => step('redo')}>
            <Redo2 size={15} />
          </button>
          <span className="pm-gap" />
          <button
            type="button"
            className={`pmx-btn${grid ? ' on' : ''}`}
            aria-pressed={grid}
            aria-label={t('pet.px.grid')}
            title={t('pet.px.grid')}
            onClick={() => setGrid((g) => !g)}
          >
            <Grid3x3 size={15} />
          </button>
          <Segmented<Zoom> value={zoom} onChange={setZoom} options={(['1', '2', '4'] as Zoom[]).map((z) => ({ value: z, label: zoomLabel(z) }))} />
        </div>

        <div ref={stageRef} className="pmk-stage">
          <div className={`pmx-view${zoom !== '1' ? ' zoomed' : ''}`} style={{ width: fit, height: fit }}>
            <canvas
              ref={canvasRef}
              className={`pmx-canvas tool-${tool}`}
              style={{ width: css, height: css }}
              onPointerDown={onDown}
              onPointerMove={onMove}
              onPointerUp={onUp}
              onPointerCancel={onUp}
              onPointerLeave={() => {
                if (!stroke.current && hover.current) {
                  hover.current = null
                  schedule()
                }
              }}
              onContextMenu={(e) => e.preventDefault()}
            />
          </div>
        </div>

        <div className="pmk-palette" role="group" aria-label={t('pet.maker.colors')}>
          {palette.map((c, i) => (
            <span key={i} className={`pm-tool${color === i && tool !== 'eraser' ? ' on' : ''}`}>
              <button
                type="button"
                className="pm-swatch"
                title={t('pet.maker.photoColor', { n: i + 1 })}
                aria-label={t('pet.maker.photoColor', { n: i + 1 })}
                aria-pressed={color === i}
                style={{ background: c }}
                onClick={() => choose(i)}
              />
              <input
                type="color"
                className="pm-color"
                title={t('pet.px.recolor', { n: i + 1 })}
                aria-label={t('pet.px.recolor', { n: i + 1 })}
                value={c}
                onChange={(e) => recolor(i, e.target.value)}
              />
            </span>
          ))}
          <button
            type="button"
            className={`pm-swatch pmx-add${adding ? ' on' : ''}`}
            title={t('pet.px.newColor')}
            aria-label={t('pet.px.newColor')}
            aria-expanded={adding}
            onClick={() => {
              if (!adding) setNewHex(palette[color] ?? '#ffffff')
              setAdding((a) => !a)
              setFullAsk(false)
            }}
          >
            <Plus size={14} />
          </button>
          {adding && (
            <span className="pmx-add-row">
              <input
                type="color"
                className="pmx-pick"
                aria-label={t('pet.px.newColor')}
                value={newHex}
                onChange={(e) => {
                  setNewHex(e.target.value.toLowerCase())
                  setFullAsk(false)
                }}
              />
              <code>{newHex}</code>
              <Button onClick={add}>{t('pet.px.addColor')}</Button>
            </span>
          )}
        </div>
        {adding && fullAsk && (
          <div className="pmx-ask" role="alert">
            <p>{t('pet.px.paletteFull', { max: MAX_COLORS, n: color + 1 })}</p>
            <div className="pmx-ask-row">
              <Button variant="ghost" onClick={() => setFullAsk(false)}>
                {t('pet.maker.cancel')}
              </Button>
              <Button variant="primary" onClick={replaceSelected}>
                {t('pet.px.replaceColor', { n: color + 1 })}
              </Button>
            </div>
          </div>
        )}

        <PetAiAsk<PixelDoc>
          compact
          title={t('pet.ai.title')}
          placeholder={t('pet.ai.pixelHint')}
          build={(q) => {
            const d = doc.current
            const scale = scaleFor(d.n)
            const images = [pngOf(d.n, d.n, rgbaOfDoc(d, hexToRgb), scale)]
            if (photo) images.push(pngOf(photo.width, photo.height, new Uint8ClampedArray(photo.data), 1))
            return { system: PIXEL_SYSTEM, prompt: buildPixelPrompt(d, q, { scale, photo: !!photo }), images }
          }}
          check={(text) => {
            const r = parsePixelAnswer(text, doc.current)
            return r.ok ? { ok: true, result: r.doc } : r
          }}
          preview={(next) => (
            <div className="pai-compare">
              <figure>
                <DocCanvas doc={cloneDoc(doc.current)} label={t('pet.ai.now')} />
                <figcaption>{t('pet.ai.now')}</figcaption>
              </figure>
              <figure>
                <DocCanvas doc={next} label={t('pet.ai.after')} />
                <figcaption>{t('pet.ai.after')}</figcaption>
              </figure>
            </div>
          )}
          onApply={applyDoc}
        />
      </div>

      <aside className="pmk-side">
        {side({
          real: <canvas ref={small1} width={n} height={n} className="pm-pixels pmx-real1" aria-label={t('pet.px.realSize')} />,
          status: (
            <>
              {dots < need && <p className="pmk-note pmx-warn">{t('pet.px.dots', { n: dots, min: need })}</p>}
              {pieces > 1 && (
                <div className="pmx-ask">
                  <p>{t('pet.px.pieces', { n: pieces })}</p>
                  <div className="pmx-ask-row">
                    <Button
                      onClick={() => {
                        const before = cloneDoc(doc.current)
                        if (keepBiggest(doc.current.cells, n)) {
                          commit(before)
                          schedule()
                        }
                      }}
                    >
                      <Scissors size={14} /> {t('pet.px.keepBiggest')}
                    </Button>
                  </div>
                </div>
              )}
            </>
          )
        })}
      </aside>
    </>
  )
}
