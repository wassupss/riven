import { useEffect } from 'react'
import { createPortal } from 'react-dom'

export interface MenuItem {
  label: string
  onClick: () => void
  danger?: boolean
  separator?: boolean
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
  useEffect(() => {
    const close = (): void => onClose()
    window.addEventListener('click', close)
    window.addEventListener('contextmenu', close)
    window.addEventListener('resize', close)
    const onEsc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onEsc, true)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('contextmenu', close)
      window.removeEventListener('resize', close)
      window.removeEventListener('keydown', onEsc, true)
    }
  }, [onClose])

  // Clamp within the viewport so the menu never overflows off-screen.
  const left = Math.min(x, window.innerWidth - 190)
  const top = Math.min(y, window.innerHeight - items.length * 26 - 12)

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
    document.body
  )
}
