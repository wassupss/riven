import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  TerminalSquare,
  Bot,
  FileCode,
  GitBranch,
  Search,
  Eye,
  History,
  PanelLeft,
  ExternalLink
} from 'lucide-react'
import { useUI } from '../state/ui'
import { useSession } from '../state/session'
import { useSettings } from '../state/settings'
import { addTerminal, togglePanel, popoutActive } from '../dock/registry'
import { keymap } from '../keybindings/keys'
import { useT } from '../i18n'

interface Item {
  id: string
  label: string
  hint?: string
  icon: JSX.Element
  run: () => void
}

const PANEL_ICON: Record<string, JSX.Element> = {
  editor: <FileCode size={15} />,
  changes: <History size={15} />,
  preview: <Eye size={15} />,
  search: <Search size={15} />,
  git: <GitBranch size={15} />
}

const PANELS: Array<{ id: 'editor' | 'changes' | 'preview' | 'search' | 'git'; labelKey: string; key: string }> = [
  { id: 'editor', labelKey: 'toolbar.panel.editor', key: '' },
  { id: 'changes', labelKey: 'toolbar.panel.changes', key: '' },
  { id: 'preview', labelKey: 'toolbar.panel.preview', key: '⌘⇧V' },
  { id: 'search', labelKey: 'toolbar.panel.search', key: '⌘⇧F' },
  { id: 'git', labelKey: 'Git', key: '⌘⇧G' }
]

// Keyboard-driven quick actions dialog (new terminal / agent / panels / view),
// replacing the old toolbar dropdown. ↑/↓ to move, Enter to run, Esc to close.
export default function QuickPanel(): JSX.Element | null {
  const t = useT()
  const open = useUI((s) => s.quickPanel)
  const setOpen = useUI((s) => s.setQuickPanel)
  const setAgentPicker = useUI((s) => s.setAgentPicker)
  const toggleExplorer = useUI((s) => s.toggleExplorer)
  const activeWorkspace = useSession((s) => s.activeWorkspace)
  const profiles = useSettings((s) => s.settings.terminalProfiles)
  const [idx, setIdx] = useState(0)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])

  const items = useMemo<Item[]>(() => {
    const arr: Item[] = [
      {
        id: 'new-terminal',
        label: t('toolbar.newTerminal'),
        hint: '⌘T',
        icon: <TerminalSquare size={15} />,
        run: () => addTerminal()
      }
    ]
    for (const p of profiles) {
      arr.push({
        id: `profile:${p.name}`,
        label: p.name,
        icon: <TerminalSquare size={15} />,
        run: () => addTerminal(p.command)
      })
    }
    arr.push({
      id: 'agent',
      label: t('toolbar.openAgent'),
      icon: <Bot size={15} />,
      run: () => activeWorkspace && setAgentPicker(activeWorkspace)
    })
    for (const p of PANELS) {
      arr.push({
        id: p.id,
        label: t(p.labelKey),
        hint: p.key || undefined,
        icon: PANEL_ICON[p.id],
        run: () => togglePanel(p.id)
      })
    }
    arr.push({
      id: 'explorer',
      label: t('toolbar.toggleExplorer'),
      hint: '⌘B',
      icon: <PanelLeft size={15} />,
      run: () => toggleExplorer()
    })
    arr.push({
      id: 'popout',
      label: t('toolbar.popout'),
      hint: '⌘⇧P',
      icon: <ExternalLink size={15} />,
      run: () => popoutActive()
    })
    return arr
  }, [profiles, activeWorkspace, t, setAgentPicker, toggleExplorer])

  // Suspend the global keymap while open so ⌘T/arrows/etc. don't also fire behind
  // the dialog; reset the selection each time it opens.
  useEffect(() => {
    keymap.setModalOpen(open)
    if (open) setIdx(0)
    return () => keymap.setModalOpen(false)
  }, [open])

  const run = (i: number): void => {
    const it = items[i]
    if (!it) return
    setOpen(false)
    it.run()
  }

  useEffect(() => {
    if (!open) return
    const nav = new Set(['Escape', 'ArrowDown', 'ArrowUp', 'Enter'])
    const onKey = (e: KeyboardEvent): void => {
      if (!nav.has(e.key)) return
      // Capture-phase + stopPropagation so the keys drive the dialog only, not
      // the terminal/editor that still holds DOM focus behind it.
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') setOpen(false)
      else if (e.key === 'ArrowDown') setIdx((i) => (i + 1) % items.length)
      else if (e.key === 'ArrowUp') setIdx((i) => (i - 1 + items.length) % items.length)
      else if (e.key === 'Enter') run(idx)
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, items, idx])

  useEffect(() => {
    if (open) itemRefs.current[idx]?.scrollIntoView({ block: 'nearest' })
  }, [idx, open])

  if (!open) return null
  return createPortal(
    <div className="qp-backdrop" onClick={() => setOpen(false)}>
      <div className="qp-dialog" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="qp-title">{t('toolbar.addPanel')}</div>
        <div className="qp-list">
          {items.map((it, i) => (
            <button
              key={it.id}
              ref={(el) => (itemRefs.current[i] = el)}
              className={`qp-item${i === idx ? ' active' : ''}`}
              onMouseMove={() => setIdx(i)}
              onClick={() => run(i)}
            >
              <span className="qp-icon">{it.icon}</span>
              <span className="qp-label">{it.label}</span>
              {it.hint && <span className="qp-hint">{it.hint}</span>}
            </button>
          ))}
        </div>
        <div className="qp-foot">↑↓ 이동 · ↵ 실행 · esc 닫기</div>
      </div>
    </div>,
    document.body
  )
}
