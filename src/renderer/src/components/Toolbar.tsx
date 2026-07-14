import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Plus, ChevronDown, Bot } from 'lucide-react'
import { useSession } from '../state/session'
import { useUI } from '../state/ui'
import { addTerminal, togglePanel, popoutActive } from '../dock/registry'
import { useT } from '../i18n'

const PANELS: Array<{ id: 'search' | 'git' | 'editor' | 'preview'; labelKey: string; key: string }> = [
  { id: 'editor', labelKey: 'toolbar.panel.editor', key: '' },
  { id: 'preview', labelKey: 'toolbar.panel.preview', key: '⌘⇧V' },
  { id: 'search', labelKey: 'toolbar.panel.search', key: '⌘⇧F' },
  { id: 'git', labelKey: 'Git', key: '⌘⇧G' }
]

export default function Toolbar(): JSX.Element {
  const t = useT()
  const activeWorkspace = useSession((s) => s.activeWorkspace)
  const hasWs = activeWorkspace != null
  const toggleExplorer = useUI((s) => s.toggleExplorer)
  const setAgentPicker = useUI((s) => s.setAgentPicker)
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!pos) return
    const onDown = (e: MouseEvent): void => {
      const t = e.target as Node
      if (!btnRef.current?.contains(t) && !(t as HTMLElement).closest?.('.tb-menu')) setPos(null)
    }
    const onScrollOrResize = (): void => setPos(null)
    document.addEventListener('mousedown', onDown)
    window.addEventListener('resize', onScrollOrResize)
    return () => {
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('resize', onScrollOrResize)
    }
  }, [pos])

  const toggleMenu = (): void => {
    if (pos) {
      setPos(null)
      return
    }
    const r = btnRef.current?.getBoundingClientRect()
    if (r) setPos({ top: r.bottom + 4, right: window.innerWidth - r.right })
  }
  const close = (): void => setPos(null)

  return (
    <div className="toolbar">
      <button
        className="tb-btn primary"
        disabled={!hasWs}
        title={t('toolbar.newTerminal')}
        onClick={() => addTerminal()}
      >
        <span className="tb-plus"><Plus size={14} /></span> {t('toolbar.terminal')}
      </button>

      <button
        ref={btnRef}
        className={`tb-btn${pos ? ' on' : ''}`}
        disabled={!hasWs}
        title={t('toolbar.openPanel')}
        onClick={toggleMenu}
      >
        {t('toolbar.panels')} <span className="tb-caret"><ChevronDown size={12} /></span>
      </button>

      {pos &&
        createPortal(
          <div className="tb-menu" style={{ top: pos.top, right: pos.right }}>
            <div
              className="tb-menu-item"
              onClick={() => {
                if (activeWorkspace) setAgentPicker(activeWorkspace)
                close()
              }}
            >
              <span className="tb-menu-icon">
                <Bot size={14} /> {t('toolbar.openAgent')}
              </span>
            </div>
            <div className="tb-menu-sep" />
            {PANELS.map((p) => (
              <div
                key={p.id}
                className="tb-menu-item"
                onClick={() => {
                  togglePanel(p.id)
                  close()
                }}
              >
                <span>{t(p.labelKey)}</span>
                {p.key && <span className="tb-menu-key">{p.key}</span>}
              </div>
            ))}
            <div className="tb-menu-sep" />
            <div
              className="tb-menu-item"
              onClick={() => {
                toggleExplorer()
                close()
              }}
            >
              <span>{t('toolbar.toggleExplorer')}</span>
              <span className="tb-menu-key">⌘B</span>
            </div>
            <div
              className="tb-menu-item"
              onClick={() => {
                popoutActive()
                close()
              }}
            >
              <span>{t('toolbar.popout')}</span>
              <span className="tb-menu-key">⌘⇧P</span>
            </div>
          </div>,
          document.body
        )}
    </div>
  )
}
