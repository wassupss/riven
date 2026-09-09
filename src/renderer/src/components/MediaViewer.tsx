import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { mediaUrl, type MediaKind } from '../lib/mediaKind'
import { useT } from '../i18n'
import { ZoomIn, ZoomOut } from 'lucide-react'

// Shows a file the code editor can't: an image, a video, an audio track, a PDF.
// Rendered INSTEAD of Monaco for those files, so opening one from the explorer
// behaves like opening any other file rather than filling the editor with the
// mojibake of a binary read as UTF-8.
//
// The bytes come from main over the riven-media scheme (src/main/media.ts), not
// from a readFile round trip — a video must not be pulled into a JS string, and
// ranged requests are what make seeking work.

// Button stops. The wheel zooms continuously between the same two ends.
const ZOOMS = [0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8]
const MIN = ZOOMS[0]
const MAX = ZOOMS[ZOOMS.length - 1]

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export default function MediaViewer({
  path,
  kind
}: {
  path: string
  kind: Exclude<MediaKind, 'text'>
}): JSX.Element {
  const t = useT()
  const url = mediaUrl(path)
  const [zoom, setZoom] = useState(1)
  const [fit, setFit] = useState(true)
  const [meta, setMeta] = useState<{ w: number; h: number } | null>(null)
  const [size, setSize] = useState<number | null>(null)
  const [error, setError] = useState(false)
  const [panning, setPanning] = useState(false)
  const bodyRef = useRef<HTMLDivElement>(null)
  const imgRef = useRef<HTMLImageElement>(null)
  // The zoom a wheel tick should build on. A flick delivers several ticks in one
  // task, and measuring the DOM would give every one of them the same stale
  // base, so each tick records where it left off here.
  const wantRef = useRef(1)
  // Same reason for `fit`: the first tick of a burst turns fitting off, and the
  // rest must already know that, before React has re-rendered.
  const fitRef = useRef(true)
  // Where to keep the image steady, and the scale the current layout was drawn
  // at. Scroll can only be corrected after the new layout exists.
  const anchor = useRef<{ x: number; y: number } | null>(null)
  const drawnScale = useRef(1)

  // Reset per file, so switching tabs doesn't inherit the previous zoom.
  useEffect(() => {
    setZoom(1)
    setFit(true)
    setMeta(null)
    setError(false)
    setSize(null)
    wantRef.current = 1
    fitRef.current = true
    drawnScale.current = 1
    anchor.current = null
    let alive = true
    // HEAD is enough for the byte count and costs nothing; it also surfaces a
    // 403 (outside every open workspace) before the element tries to render.
    void fetch(url, { method: 'HEAD' })
      .then((r) => {
        if (!alive) return
        if (!r.ok) setError(true)
        const len = Number(r.headers.get('content-length'))
        if (Number.isFinite(len) && len > 0) setSize(len)
      })
      .catch(() => alive && setError(true))
    return () => {
      alive = false
    }
  }, [url])

  // What the image is drawn at right now. While fitted that is not `zoom` but
  // whatever the frame allowed, and a zoom has to continue from what the eye
  // sees instead of jumping back to 100%.
  const shownScale = (): number => {
    const img = imgRef.current
    if (fitRef.current && img && meta?.w) return img.clientWidth / meta.w
    return wantRef.current
  }

  const zoomTo = (next: number, at?: { x: number; y: number }): void => {
    const to = Math.min(MAX, Math.max(MIN, next))
    wantRef.current = to
    fitRef.current = false
    if (at) anchor.current = at
    setFit(false)
    setZoom(to)
  }

  // Keep the point under the cursor where it was — that is what makes a wheel
  // zoom feel like zooming rather than teleporting. The ratio is measured
  // against the scale the last layout was actually drawn at, so a burst of
  // ticks that React coalesced into one render still lands correctly.
  useLayoutEffect(() => {
    const el = bodyRef.current
    const img = imgRef.current
    if (!el || !img || !meta?.w) return
    const now = img.clientWidth / meta.w
    const a = anchor.current
    anchor.current = null
    if (a && drawnScale.current > 0) {
      const ratio = now / drawnScale.current
      el.scrollLeft = (el.scrollLeft + a.x) * ratio - a.x
      el.scrollTop = (el.scrollTop + a.y) * ratio - a.y
    }
    drawnScale.current = now
    fitRef.current = fit
    if (fit) wantRef.current = now
  }, [zoom, fit, meta])

  // Wheel, and trackpad pinch (which arrives as ctrl+wheel). Registered by hand
  // because React's onWheel is passive and a passive listener cannot
  // preventDefault the browser's own scroll/zoom.
  useEffect(() => {
    const el = bodyRef.current
    if (!el || kind !== 'image') return
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      const box = el.getBoundingClientRect()
      zoomTo(shownScale() * Math.exp(-e.deltaY * 0.0015), {
        x: e.clientX - box.left,
        y: e.clientY - box.top
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, meta, fit])

  // Drag to pan, once the image is bigger than the frame.
  const startPan = (e: React.MouseEvent): void => {
    const el = bodyRef.current
    if (!el || kind !== 'image' || e.button !== 0) return
    if (el.scrollWidth <= el.clientWidth && el.scrollHeight <= el.clientHeight) return
    e.preventDefault()
    setPanning(true)
    const x0 = e.clientX
    const y0 = e.clientY
    const l0 = el.scrollLeft
    const t0 = el.scrollTop
    const move = (m: MouseEvent): void => {
      el.scrollLeft = l0 - (m.clientX - x0)
      el.scrollTop = t0 - (m.clientY - y0)
    }
    const up = (): void => {
      setPanning(false)
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  const step = (dir: 1 | -1): void => {
    const cur = shownScale()
    const next =
      dir === 1
        ? (ZOOMS.find((z) => z > cur + 0.001) ?? MAX)
        : ([...ZOOMS].reverse().find((z) => z < cur - 0.001) ?? MIN)
    zoomTo(next)
  }

  // One control instead of a separate button that looked like fullscreen but
  // wasn't: fitted, it reads "fit" and switches to 1:1; zoomed, it reads the
  // percentage and goes back to fitting.
  const toggleFit = (): void => {
    if (fit) zoomTo(1)
    else {
      fitRef.current = true
      setFit(true)
    }
  }

  if (error) {
    return (
      <div className="media-view">
        <div className="media-empty">{t('media.failed')}</div>
      </div>
    )
  }

  const zoomed = kind === 'image' && !fit

  return (
    <div className="media-view">
      <div className="media-bar">
        <span className="media-name">{path.split('/').pop()}</span>
        <span className="media-meta">
          {meta && `${meta.w}×${meta.h}`}
          {meta && size != null && ' · '}
          {size != null && humanSize(size)}
        </span>
        {kind === 'image' && (
          <span className="media-actions">
            <button title={t('media.zoomOut')} onClick={() => step(-1)}>
              <ZoomOut size={14} />
            </button>
            <button
              className="media-zoom"
              title={fit ? t('media.actualSize') : t('media.fit')}
              onClick={toggleFit}
            >
              {fit ? t('media.fit') : `${Math.round(zoom * 100)}%`}
            </button>
            <button title={t('media.zoomIn')} onClick={() => step(1)}>
              <ZoomIn size={14} />
            </button>
          </span>
        )}
      </div>
      <div
        ref={bodyRef}
        className={`media-body${zoomed ? ' scroll' : ''}${panning ? ' panning' : ''}`}
        onMouseDown={startPan}
        onDoubleClick={kind === 'image' ? toggleFit : undefined}
      >
        {kind === 'image' && (
          <img
            ref={imgRef}
            src={url}
            alt={path}
            draggable={false}
            className={fit ? 'fit' : ''}
            // Explicit pixels, so 100% is one image pixel per screen pixel; a
            // percentage width would only ever mean "share of the frame".
            style={fit || !meta ? undefined : { width: meta.w * zoom, height: meta.h * zoom }}
            onLoad={(e) =>
              setMeta({
                w: (e.target as HTMLImageElement).naturalWidth,
                h: (e.target as HTMLImageElement).naturalHeight
              })
            }
            onError={() => setError(true)}
          />
        )}
        {kind === 'video' && (
          <video
            src={url}
            controls
            className="fit"
            onLoadedMetadata={(e) =>
              setMeta({
                w: (e.target as HTMLVideoElement).videoWidth,
                h: (e.target as HTMLVideoElement).videoHeight
              })
            }
            onError={() => setError(true)}
          />
        )}
        {kind === 'audio' && <audio src={url} controls onError={() => setError(true)} />}
        {/* Chromium's own PDF viewer (main enables `plugins`), so page nav,
            search and printing come for free rather than being reimplemented. */}
        {kind === 'pdf' && <iframe className="media-pdf" src={url} title={path} />}
      </div>
    </div>
  )
}
