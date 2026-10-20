import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { QueryColumn } from '../../../../../main/db/types'
import { useT } from '../../../i18n'

type Cell = string | number | boolean | null

const ROW_H = 22
const NUM_W = 44
const OVERSCAN = 8

const show = (v: Cell): string => (v === null ? 'NULL' : typeof v === 'string' ? v : String(v))

// First line only, capped: a multi-KB json cell must not lay out in full.
const cellText = (v: Cell): string => {
  const s = show(v)
  const nl = s.indexOf('\n')
  const one = nl < 0 ? s : s.slice(0, nl) + ' …'
  return one.length > 300 ? one.slice(0, 300) + '…' : one
}

function csvField(v: Cell, sep: string): string {
  if (v === null) return ''
  const s = String(v)
  return s.includes(sep) || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s
}

export function toDelimited(columns: QueryColumn[], rows: Cell[][], sep: string): string {
  const lines = [columns.map((c) => csvField(c.name, sep)).join(sep)]
  for (const r of rows) lines.push(r.map((v) => csvField(v, sep)).join(sep))
  return lines.join('\n')
}

function initialWidths(columns: QueryColumn[], rows: Cell[][]): number[] {
  return columns.map((c, i) => {
    let len = Math.max(c.name.length, c.type.length * 0.8)
    for (let r = 0; r < Math.min(rows.length, 60); r++) len = Math.max(len, cellText(rows[r][i]).length)
    return Math.round(Math.min(Math.max(len * 7 + 18, 64), 360))
  })
}

// A read-only, row-virtualized result table: only the rows in view are in the
// DOM, so a 100k-row result scrolls like a 10-row one.
export default function ResultGrid({ columns, rows }: { columns: QueryColumn[]; rows: Cell[][] }): JSX.Element {
  const t = useT()
  const scrollRef = useRef<HTMLDivElement>(null)
  const [top, setTop] = useState(0)
  const [height, setHeight] = useState(300)
  const [widths, setWidths] = useState(() => initialWidths(columns, rows))
  const [sel, setSel] = useState<{ r: number; c: number } | null>(null)
  const [viewer, setViewer] = useState<string | null>(null)

  useEffect(() => {
    setWidths(initialWidths(columns, rows))
    setSel(null)
    setTop(0)
    if (scrollRef.current) scrollRef.current.scrollTop = 0
  }, [columns, rows])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setHeight(el.clientHeight))
    ro.observe(el)
    setHeight(el.clientHeight)
    return () => ro.disconnect()
  }, [])

  const totalW = useMemo(() => NUM_W + widths.reduce((a, b) => a + b, 0), [widths])
  const template = useMemo(() => `${NUM_W}px ${widths.map((w) => `${w}px`).join(' ')}`, [widths])
  const first = Math.max(0, Math.floor(top / ROW_H) - OVERSCAN)
  const last = Math.min(rows.length, Math.ceil((top + height) / ROW_H) + OVERSCAN)

  const startResize = (i: number, e: React.MouseEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    const x0 = e.clientX
    const w0 = widths[i]
    const move = (ev: MouseEvent): void =>
      setWidths((ws) => ws.map((w, j) => (j === i ? Math.max(40, w0 + ev.clientX - x0) : w)))
    const up = (): void => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  const onKey = useCallback(
    (e: React.KeyboardEvent): void => {
      if (!sel) return
      if ((e.metaKey || e.ctrlKey) && e.key === 'c') {
        e.preventDefault()
        void navigator.clipboard.writeText(sel.c < 0 ? rows[sel.r].map(show).join('\t') : show(rows[sel.r][sel.c]))
        return
      }
      const move = (r: number, c: number): void => {
        e.preventDefault()
        const nr = Math.min(Math.max(r, 0), rows.length - 1)
        const nc = Math.min(Math.max(c, 0), columns.length - 1)
        setSel({ r: nr, c: nc })
        const el = scrollRef.current
        if (!el) return
        const y = nr * ROW_H
        if (y < el.scrollTop) el.scrollTop = y
        else if (y + ROW_H * 2 > el.scrollTop + el.clientHeight) el.scrollTop = y + ROW_H * 2 - el.clientHeight
      }
      if (e.key === 'ArrowDown') move(sel.r + 1, sel.c)
      else if (e.key === 'ArrowUp') move(sel.r - 1, sel.c)
      else if (e.key === 'ArrowRight') move(sel.r, sel.c + 1)
      else if (e.key === 'ArrowLeft') move(sel.r, sel.c - 1)
      else if (e.key === 'Enter' && sel.c >= 0) {
        e.preventDefault()
        setViewer(show(rows[sel.r][sel.c]))
      }
    },
    [sel, rows, columns.length]
  )

  return (
    <div className="dbx-grid" tabIndex={0} onKeyDown={onKey}>
      <div className="dbx-grid-scroll" ref={scrollRef} onScroll={(e) => setTop(e.currentTarget.scrollTop)}>
        <div style={{ width: totalW, minWidth: '100%' }}>
          <div className="dbx-grid-head" style={{ gridTemplateColumns: template }}>
            <div className="dbx-grid-num">#</div>
            {columns.map((c, i) => (
              <div key={i} className="dbx-grid-th" title={`${c.name} ${c.type}`}>
                <span className="dbx-grid-th-name">{c.name}</span>
                {c.type && <span className="dbx-grid-th-type">{c.type}</span>}
                <span className="dbx-grid-resize" onMouseDown={(e) => startResize(i, e)} />
              </div>
            ))}
          </div>
          <div style={{ height: rows.length * ROW_H, position: 'relative' }}>
            {rows.slice(first, last).map((row, k) => {
              const r = first + k
              return (
                <div
                  key={r}
                  className={`dbx-grid-row${sel?.r === r ? ' sel-row' : ''}`}
                  style={{ top: r * ROW_H, gridTemplateColumns: template }}
                >
                  <div className="dbx-grid-num" onClick={() => setSel({ r, c: -1 })}>
                    {r + 1}
                  </div>
                  {row.map((v, c) => (
                    <div
                      key={c}
                      className={`dbx-grid-td${v === null ? ' null' : ''}${typeof v === 'number' ? ' num' : ''}${
                        sel?.r === r && sel.c === c ? ' sel' : ''
                      }`}
                      onClick={() => setSel({ r, c })}
                      onDoubleClick={() => setViewer(show(v))}
                    >
                      {cellText(v)}
                    </div>
                  ))}
                </div>
              )
            })}
          </div>
        </div>
        {rows.length === 0 && <div className="dbx-empty">{t('db.noRows')}</div>}
      </div>
      {viewer !== null && (
        <div className="dbx-viewer">
          <div className="dbx-viewer-bar">
            <span>{t('db.cellValue')}</span>
            <button className="dbx-link" onClick={() => void navigator.clipboard.writeText(viewer)}>
              {t('db.copy')}
            </button>
            <button className="dbx-link" onClick={() => setViewer(null)}>
              {t('common.close')}
            </button>
          </div>
          <pre className="dbx-viewer-body">{viewer}</pre>
        </div>
      )}
    </div>
  )
}
