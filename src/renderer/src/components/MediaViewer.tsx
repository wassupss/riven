import { useEffect, useState } from 'react'
import { mediaUrl, type MediaKind } from '../lib/mediaKind'
import { useT } from '../i18n'
import { ZoomIn, ZoomOut, Maximize2 } from 'lucide-react'

// Shows a file the code editor can't: an image, a video, an audio track, a PDF.
// Rendered INSTEAD of Monaco for those files, so opening one from the explorer
// behaves like opening any other file rather than filling the editor with the
// mojibake of a binary read as UTF-8.
//
// The bytes come from main over the riven-media scheme (src/main/media.ts), not
// from a readFile round trip — a video must not be pulled into a JS string, and
// ranged requests are what make seeking work.

const ZOOMS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4]

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

  // Reset per file, so switching tabs doesn't inherit the previous zoom.
  useEffect(() => {
    setZoom(1)
    setFit(true)
    setMeta(null)
    setError(false)
    setSize(null)
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

  // Functional update: rapid clicks land in one React batch, and reading `zoom`
  // from the closure would make the second click recompute from the same value.
  const step = (dir: 1 | -1): void => {
    setFit(false)
    setZoom((z) => {
      const i = ZOOMS.findIndex((v) => v >= z)
      return ZOOMS[Math.min(ZOOMS.length - 1, Math.max(0, (i < 0 ? ZOOMS.length - 1 : i) + dir))]
    })
  }

  if (error) {
    return (
      <div className="media-view">
        <div className="media-empty">{t('media.failed')}</div>
      </div>
    )
  }

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
            <span className="media-zoom">{fit ? t('media.fit') : `${Math.round(zoom * 100)}%`}</span>
            <button title={t('media.zoomIn')} onClick={() => step(1)}>
              <ZoomIn size={14} />
            </button>
            <button title={t('media.fit')} onClick={() => setFit(true)}>
              <Maximize2 size={14} />
            </button>
          </span>
        )}
      </div>
      <div className={`media-body${kind === 'image' && !fit ? ' scroll' : ''}`}>
        {kind === 'image' && (
          <img
            src={url}
            alt={path}
            className={fit ? 'fit' : ''}
            style={fit ? undefined : { width: `${zoom * 100}%` }}
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
