import { Loader2 } from 'lucide-react'
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { Button, Segmented } from './ui/Controls'
import { useT } from '../i18n'
import { backgroundUrl, importBackground, scheduleBackgroundGc } from '../lib/panelBackground'
import {
  MAX_BLUR,
  MAX_SIZE,
  MIN_OPACITY,
  MIN_SIZE,
  PANEL_BG_ANCHORS,
  PANEL_BG_LOOK,
  clampPos,
  dragDelta,
  drawnSize,
  placementCss,
  round1,
  type PanelBg,
  type PanelBgFit
} from '../state/panelBackground'
import '../styles/panel-background.css'

// One background's editor: image (pick, replace, remove), layout, size, a live
// placement preview with a 3x3 anchor grid, strength and blur. Used for a kind
// default (Settings > general) and for one panel's own (tab menu > 배경 설정).
//
// `value` null = no image yet: only the picker shows. Every change goes out
// through onChange right away, so the panels behind follow live; while
// dragging or wheeling the preview that is at most once per frame.

const BG_ACCEPT = 'image/png,image/jpeg,image/gif,image/webp,image/avif,image/bmp'
const ANCHOR_LABEL = ['tl', 't', 'tr', 'l', 'c', 'r', 'bl', 'b', 'br'].map((k) => `bg.anchor.${k}`)

function Line({ title, children }: { title: string; children: ReactNode }): JSX.Element {
  return (
    <div className="set-row">
      <div className="set-rowinfo">
        <span className="set-rowtitle">{title}</span>
      </div>
      <div className="set-rowctl">{children}</div>
    </div>
  )
}

function useImageSize(url: string): { w: number; h: number } | null {
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null)
  useEffect(() => {
    let live = true
    setDims(null)
    const img = new Image()
    img.onload = () => {
      if (live) setDims({ w: img.naturalWidth, h: img.naturalHeight })
    }
    img.src = url
    return () => {
      live = false
      img.onload = null
    }
  }, [url])
  return dims
}

// Drag moves the image (position in %, so it scales with any panel), the
// wheel or a pinch resizes it, double-click centres it, arrow keys nudge it.
function Placement({ value, onChange }: { value: PanelBg; onChange: (v: PanelBg) => void }): JSX.Element {
  const t = useT()
  const url = backgroundUrl(value.image)
  const boxRef = useRef<HTMLDivElement>(null)
  const dims = useImageSize(url)
  const valueRef = useRef(value)
  valueRef.current = value
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const drag = useRef<{ x: number; y: number; px: number; py: number; w: number; h: number; dw: number; dh: number } | null>(
    null
  )
  const pending = useRef<Partial<PanelBg> | null>(null)
  const frame = useRef(0)

  // One write per frame, however fast the pointer or wheel events come.
  const queue = (patch: Partial<PanelBg>): void => {
    pending.current = { ...pending.current, ...patch }
    if (frame.current) return
    frame.current = requestAnimationFrame(() => {
      frame.current = 0
      const p = pending.current
      pending.current = null
      if (p) onChangeRef.current({ ...valueRef.current, ...p })
    })
  }
  useEffect(() => () => cancelAnimationFrame(frame.current), [])
  const set = (patch: Partial<PanelBg>): void => onChange({ ...value, ...patch })

  // A native listener: React's wheel handler is passive and cannot keep the
  // page behind from scrolling.
  useEffect(() => {
    const el = boxRef.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      const cur = { ...valueRef.current, ...pending.current }
      const sized = cur.fit === 'size' || cur.fit === 'tile'
      // Over a cover/contain image a plain wheel still scrolls the page; a
      // pinch (ctrlKey) switches to a custom size that starts where it is.
      if (!sized && !e.ctrlKey) return
      e.preventDefault()
      let base = cur.size
      if (!sized) {
        const r = el.getBoundingClientRect()
        const d = dims ? drawnSize(cur.fit, base, r.width, r.height, dims.w, dims.h) : { w: r.width }
        base = r.width > 0 ? (d.w / r.width) * 100 : base
      }
      const k = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.002))
      const next = round1(Math.min(MAX_SIZE, Math.max(MIN_SIZE, base * k)))
      queue(sized ? { size: next } : { fit: 'size', size: next })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [dims])

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    const r = e.currentTarget.getBoundingClientRect()
    const d = dims ? drawnSize(value.fit, value.size, r.width, r.height, dims.w, dims.h) : { w: r.width, h: r.height }
    drag.current = { x: e.clientX, y: e.clientY, px: value.x, py: value.y, w: r.width, h: r.height, dw: d.w, dh: d.h }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const g = drag.current
    if (!g) return
    queue({
      x: clampPos(g.px + dragDelta(e.clientX - g.x, g.w, g.dw)),
      y: clampPos(g.py + dragDelta(e.clientY - g.y, g.h, g.dh))
    })
  }
  const endDrag = (): void => {
    drag.current = null
  }
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    const step = e.shiftKey ? 10 : 1
    const d: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step]
    }
    const m = d[e.key]
    if (!m) return
    e.preventDefault()
    set({ x: clampPos(value.x + m[0]), y: clampPos(value.y + m[1]) })
  }
  const centre = (): void => set({ x: 50, y: 50 })
  const css = placementCss(value)

  return (
    <div className="pbg-place">
      <div
        ref={boxRef}
        className="pbg-preview"
        role="group"
        tabIndex={0}
        aria-label={t('bg.preview')}
        title={t('bg.previewHint')}
        style={{
          backgroundImage: `url("${url}")`,
          backgroundSize: css.size,
          backgroundPosition: css.pos,
          backgroundRepeat: css.repeat
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={centre}
        onKeyDown={onKeyDown}
      />
      <div className="pbg-place-side">
        <div className="pbg-anchors" role="group" aria-label={t('bg.position')}>
          {PANEL_BG_ANCHORS.map(([x, y], i) => (
            <button
              key={i}
              type="button"
              className={`pbg-anchor${value.x === x && value.y === y ? ' on' : ''}`}
              aria-label={t(ANCHOR_LABEL[i])}
              title={t(ANCHOR_LABEL[i])}
              onClick={() => set({ x, y })}
            />
          ))}
        </div>
        <Button onClick={centre}>{t('bg.center')}</Button>
      </div>
    </div>
  )
}

/** The stored image's thumbnail, or "없음". */
export function BgThumb({ bg }: { bg: PanelBg | null | undefined }): JSX.Element {
  const t = useT()
  if (!bg) return <span className="pbg-none">{t('bg.none')}</span>
  return <span className="pbg-thumb" style={{ backgroundImage: `url("${backgroundUrl(bg.image)}")` }} />
}

export default function PanelBgEditor({
  value,
  onChange,
  seed
}: {
  value: PanelBg | null
  onChange: (v: PanelBg | null) => void
  /** The look a first pick starts from (a panel starts from its kind's default). */
  seed?: Omit<PanelBg, 'image'>
}): JSX.Element {
  const t = useT()
  const fileRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const set = (patch: Partial<PanelBg>): void => {
    if (value) onChange({ ...value, ...patch })
  }

  const pick = async (file: File | undefined): Promise<void> => {
    if (!file) return
    setBusy(true)
    setError('')
    try {
      const image = await importBackground(file)
      const look = value ?? { ...PANEL_BG_LOOK, ...seed }
      onChange({ ...look, image })
    } catch (e) {
      setError(t('bg.failed', { msg: e instanceof Error ? e.message : String(e) }))
    } finally {
      setBusy(false)
      if (fileRef.current) fileRef.current.value = ''
      // A replaced image (or a failed import's copy) may now be unused.
      scheduleBackgroundGc()
    }
  }

  const remove = (): void => {
    setError('')
    onChange(null)
    scheduleBackgroundGc()
  }

  return (
    <div className="pbg-editor">
      <Line title={t('bg.image')}>
        {value && <BgThumb bg={value} />}
        <input ref={fileRef} type="file" accept={BG_ACCEPT} hidden onChange={(e) => void pick(e.target.files?.[0])} />
        <Button disabled={busy} onClick={() => fileRef.current?.click()}>
          {busy ? <Loader2 size={12} className="spin" /> : null}
          {value ? t('bg.change') : t('bg.choose')}
        </Button>
        {value && <Button onClick={remove}>{t('bg.remove')}</Button>}
      </Line>
      {error && <div className="pbg-error">{error}</div>}
      {value && (
        <>
          <Line title={t('bg.fit')}>
            <Segmented<PanelBgFit>
              value={value.fit}
              onChange={(v) => set({ fit: v })}
              options={[
                { value: 'cover', label: t('bg.fitCover') },
                { value: 'contain', label: t('bg.fitContain') },
                { value: 'size', label: t('bg.fitSize') },
                { value: 'tile', label: t('bg.fitTile') }
              ]}
            />
          </Line>
          {(value.fit === 'size' || value.fit === 'tile') && (
            <Line title={t('bg.size')}>
              <input
                type="range"
                className="pbg-range"
                min={MIN_SIZE}
                max={MAX_SIZE}
                value={Math.round(value.size)}
                onChange={(e) => set({ size: Number(e.target.value) })}
              />
              <span className="pbg-range-val">{Math.round(value.size)}%</span>
            </Line>
          )}
          <Line title={t('bg.position')}>
            <Placement value={value} onChange={onChange} />
          </Line>
          <Line title={t('bg.opacity')}>
            <input
              type="range"
              className="pbg-range"
              min={Math.round(MIN_OPACITY * 100)}
              max={100}
              value={Math.round(value.opacity * 100)}
              onChange={(e) => set({ opacity: Number(e.target.value) / 100 })}
            />
            <span className="pbg-range-val">{Math.round(value.opacity * 100)}%</span>
          </Line>
          <Line title={t('bg.blur')}>
            <input
              type="range"
              className="pbg-range"
              min={0}
              max={MAX_BLUR}
              value={value.blur}
              onChange={(e) => set({ blur: Number(e.target.value) })}
            />
            <span className="pbg-range-val">{value.blur}px</span>
          </Line>
        </>
      )}
    </div>
  )
}
