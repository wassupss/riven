import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useHost } from '../lib/hostWindow'

export interface MenuItem {
  label: string
  onClick: () => void
  danger?: boolean
  separator?: boolean
  /** A read-only line (details shown in the menu): dim, not clickable. */
  info?: boolean
  /** Second column, right-aligned (info rows). */
  detail?: string
}

export default function ContextMenu({
  x,
  y,
  items,
  onClose
}: {
  x: number
  y: number
  items: MenuItem[]
  onClose: () => void
}): JSX.Element {
  // The window this menu belongs to: a popped-out panel's, not always main's.
  const { doc, win } = useHost()
  useEffect(() => {
    const close = (): void => onClose()
    win.addEventListener('click', close)
    win.addEventListener('contextmenu', close)
    win.addEventListener('resize', close)
    const onEsc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    win.addEventListener('keydown', onEsc, true)
    return () => {
      win.removeEventListener('click', close)
      win.removeEventListener('contextmenu', close)
      win.removeEventListener('resize', close)
      win.removeEventListener('keydown', onEsc, true)
    }
  }, [onClose, win])

  // Clamp within the viewport so the menu never overflows off-screen.
  const left = Math.min(x, win.innerWidth - 190)
  const top = Math.min(y, win.innerHeight - items.length * 26 - 12)

  // Portal to body: dockview transforms panels, which would otherwise offset a
  // position:fixed menu placed inside a panel.
  return createPortal(
    <div
      className="context-menu"
      style={{ left: Math.max(4, left), top: Math.max(4, top) }}
      onClick={(e) => e.stopPropagation()}
    >
      {items.map((it, i) =>
        it.separator ? (
          <div key={i} className="context-sep" />
        ) : it.info ? (
          <div key={i} className="context-info" title={it.detail ? `${it.label} ${it.detail}` : it.label}>
            <span>{it.label}</span>
            {it.detail && <span className="context-info-detail">{it.detail}</span>}
          </div>
        ) : (
          <div
            key={i}
            className={`context-item${it.danger ? ' danger' : ''}`}
            onClick={() => {
              it.onClick()
              onClose()
            }}
          >
            {it.label}
          </div>
        )
      )}
    </div>,
    doc.body
  )
}
