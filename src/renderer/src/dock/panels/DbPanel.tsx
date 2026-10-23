import { useEffect, useRef, useState } from 'react'
import { PanelLeft } from 'lucide-react'
import '../../styles/db-panel.css'
import { useT } from '../../i18n'
import { useDb } from '../../state/db'
import DbExplorerPanel from './DbExplorerPanel'
import DbConsolePanel from './DbConsolePanel'

const LS_W = 'db.sidebar.w'
const LS_HIDDEN = 'db.sidebar.hidden'
const MIN_W = 160
const MAX_W = 600
// Below this panel width the tree floats over the console instead of taking a column.
const NARROW = 480

const clampW = (w: number, total: number): number => Math.max(MIN_W, Math.min(MAX_W, total - 240, w))

// One panel: connection tree on the left, console tabs on the right.
export default function DbPanel(): JSX.Element {
  const t = useT()
  const active = useDb((s) => s.active)
  const rootRef = useRef<HTMLDivElement>(null)
  const [total, setTotal] = useState(0)
  const [width, setWidth] = useState(() => Number(localStorage.getItem(LS_W)) || 260)
  const [hidden, setHidden] = useState(() => localStorage.getItem(LS_HIDDEN) === '1')
  const [overlay, setOverlay] = useState(false)

  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setTotal(el.clientWidth))
    ro.observe(el)
    setTotal(el.clientWidth)
    return () => ro.disconnect()
  }, [])

  const narrow = total > 0 && total < NARROW
  // Opening something from the floating tree hands the space back to the console.
  useEffect(() => {
    setOverlay(false)
  }, [active])

  const show = narrow ? overlay : !hidden
  const w = narrow ? Math.min(width, total - 40) : clampW(width, total || width + 240)

  const toggle = (): void => {
    if (narrow) return setOverlay((o) => !o)
    localStorage.setItem(LS_HIDDEN, hidden ? '0' : '1')
    setHidden(!hidden)
  }

  const startDrag = (e: React.MouseEvent): void => {
    e.preventDefault()
    const x0 = e.clientX
    const w0 = w
    let last = w0
    const move = (ev: MouseEvent): void => {
      last = clampW(w0 + ev.clientX - x0, total)
      setWidth(last)
    }
    const up = (): void => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      localStorage.setItem(LS_W, String(Math.round(last)))
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  return (
    <div className={`dbx-shell${narrow ? ' narrow' : ''}`} ref={rootRef}>
      {/* Kept mounted while hidden so expanded nodes and fetched metadata survive a toggle. */}
      <div className="dbx-side" style={show ? { width: w } : { display: 'none' }}>
        <DbExplorerPanel />
      </div>
      {show && !narrow && <div className="dbx-vsplit" onMouseDown={startDrag} />}
      {show && narrow && <div className="dbx-scrim" onClick={() => setOverlay(false)} />}
      <div className="dbx-main">
        <DbConsolePanel
          leading={
            <button className={`dbx-icon-btn${show ? ' on' : ''}`} title={t('db.toggleSidebar')} onClick={toggle}>
              <PanelLeft size={14} />
            </button>
          }
        />
      </div>
    </div>
  )
}
