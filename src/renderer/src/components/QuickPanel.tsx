import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  TerminalSquare,
  Bot,
  Sparkles,
  FileCode,
  GitBranch,
  Search,
  Globe,
  History,
  PanelLeft,
  ExternalLink,
  StickyNote,
  Send
} from 'lucide-react'
import { useUI } from '../state/ui'
import { useSettings } from '../state/settings'
import { useSession, pathOf } from '../state/session'
import {
  addTerminal,
  togglePanel,
  popoutActive,
  launchAgent,
  openAgentChat,
  openNamedPanel,
  type NamedPanel
} from '../dock/registry'
import { keymap } from '../keybindings/keys'
import { useT } from '../i18n'

interface Item {
  id: string
  label: string
  hint?: string
  section: string
  icon: JSX.Element
  run: () => void
  // Panel kind this item opens — set for anything that can be placed in a split.
  panelId?: NamedPanel
}

// Keyboard-driven quick actions dialog (new terminal / chat / agent / panels /
// view). Type to filter, ↑/↓ to move, Enter to run, Esc to close.
export default function QuickPanel(): JSX.Element | null {
  const t = useT()
  const open = useUI((s) => s.quickPanel)
  const splitDir = useUI((s) => s.quickSplitDir)
  const setOpen = useUI((s) => s.setQuickPanel)
  const toggleExplorer = useUI((s) => s.toggleExplorer)
  const toggleSidebar = useUI((s) => s.toggleSidebar)
  const profiles = useSettings((s) => s.settings.terminalProfiles)
  const [clis, setClis] = useState<Array<{ name: string; cmd: string }>>([])
  const [agents, setAgents] = useState<Array<{ name: string; description: string }>>([])
  const [idx, setIdx] = useState(0)
  const [query, setQuery] = useState('')
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])
  const inputRef = useRef<HTMLInputElement>(null)

  const all = useMemo<Item[]>(() => {
    const sPanel = t('qp.section.panel')
    const sAgent = t('qp.section.agent')
    const sView = t('qp.section.view')
    const arr: Item[] = [
      {
        id: 'new-terminal',
        label: t('toolbar.newTerminal'),
        hint: '⌘T',
        section: sPanel,
        icon: <TerminalSquare size={15} />,
        panelId: 'terminal',
        run: () => addTerminal()
      },
      {
        id: 'editor',
        label: t('toolbar.panel.editor'),
        section: sPanel,
        icon: <FileCode size={15} />,
        panelId: 'editor',
        run: () => togglePanel('editor')
      },
      {
        id: 'preview',
        label: t('qp.browser'),
        hint: '⌘⇧V',
        section: sPanel,
        icon: <Globe size={15} />,
        panelId: 'preview',
        run: () => togglePanel('preview')
      },
      {
        id: 'search',
        label: t('toolbar.panel.search'),
        hint: '⌘⇧F',
        section: sPanel,
        icon: <Search size={15} />,
        panelId: 'search',
        run: () => togglePanel('search')
      },
      {
        id: 'git',
        label: 'Git',
        hint: '⌘⇧G',
        section: sPanel,
        icon: <GitBranch size={15} />,
        panelId: 'git',
        run: () => togglePanel('git')
      },
      {
        id: 'changes',
        label: t('toolbar.panel.changes'),
        section: sPanel,
        icon: <History size={15} />,
        panelId: 'changes',
        run: () => togglePanel('changes')
      },
      {
        id: 'notes',
        label: t('title.notes'),
        section: sPanel,
        icon: <StickyNote size={15} />,
        panelId: 'notes',
        run: () => togglePanel('notes')
      },
      {
        id: 'api',
        label: t('title.api'),
        section: sPanel,
        icon: <Send size={15} />,
        panelId: 'api',
        run: () => togglePanel('api')
      }
    ]
    // Agent group panel: compose/manage a team of agents inside a dockable panel.
    arr.push({
      id: 'agentgroup',
      label: t('title.agentgroup'),
      section: sAgent,
      icon: <Bot size={15} />,
      panelId: 'agentgroup',
      run: () => togglePanel('agentgroup')
    })
    // Agents: the AI CLIs actually installed on this machine, each opening its own
    // panel (native chat for Claude, a terminal running the CLI otherwise). Custom
    // terminal profiles that just relaunch a detected CLI are skipped so the same
    // agent doesn't appear twice (e.g. "Claude Code" + a "claude" profile).
    const cliCmds = new Set(clis.map((c) => c.cmd))
    for (const c of clis) {
      arr.push({
        id: `agent:${c.cmd}`,
        label: c.name,
        section: sAgent,
        icon: <Bot size={15} />,
        run: () => launchAgent(c.cmd)
      })
    }
    for (const p of profiles) {
      const base = p.command.trim().split(/\s+/)[0]
      if (cliCmds.has(base)) continue // already listed as a detected CLI
      arr.push({
        id: `profile:${p.name}`,
        label: p.name,
        section: sAgent,
        icon: <TerminalSquare size={15} />,
        run: () => launchAgent(p.command)
      })
    }
    // Custom agents defined in .claude/agents/*.md (project + ~) — each opens a new
    // native chat pane running `claude --agent <name>`, like Claude Code's agents.
    for (const a of agents) {
      arr.push({
        id: `customagent:${a.name}`,
        label: a.name,
        hint: a.description || undefined,
        section: sAgent,
        icon: <Sparkles size={15} />,
        run: () => openAgentChat(a.name)
      })
    }
    arr.push(
      {
        id: 'sidebar',
        label: t('toolbar.toggleSidebar'),
        hint: '⌘B',
        section: sView,
        icon: <PanelLeft size={15} />,
        run: () => toggleSidebar()
      },
      {
        id: 'explorer',
        label: t('toolbar.toggleExplorer'),
        hint: '⌘⇧B',
        section: sView,
        icon: <PanelLeft size={15} />,
        run: () => toggleExplorer()
      },
      {
        id: 'popout',
        label: t('toolbar.popout'),
        hint: '⌘⇧P',
        section: sView,
        icon: <ExternalLink size={15} />,
        run: () => popoutActive()
      }
    )
    return arr
  }, [profiles, clis, agents, t, toggleExplorer, toggleSidebar])

  const items = useMemo(() => {
    // In split mode only panels can be placed beside the active one.
    const base = splitDir ? all.filter((it) => it.panelId) : all
    const q = query.trim().toLowerCase()
    return q ? base.filter((it) => it.label.toLowerCase().includes(q)) : base
  }, [all, query, splitDir])

  useEffect(() => {
    keymap.setModalOpen(open)
    if (open) {
      setIdx(0)
      setQuery('')
      // Refresh the installed-CLI list each time the picker opens.
      window.api.chat.detectClis().then((r) => setClis(r.map((c) => ({ name: c.name, cmd: c.cmd }))))
      // And this workspace's custom agents (.claude/agents). Guard the method in
      // case the preload is stale (dev reload before a full app restart).
      const ws = useSession.getState().activeWorkspace
      if (ws && typeof window.api.chat.agents === 'function')
        window.api.chat.agents(pathOf(ws)).then(setAgents).catch(() => setAgents([]))
      setTimeout(() => inputRef.current?.focus(), 20)
    }
    return () => keymap.setModalOpen(false)
  }, [open])

  useEffect(() => setIdx(0), [query])

  const run = (i: number): void => {
    const it = items[i]
    if (!it) return
    setOpen(false)
    // In split mode, place the chosen panel beside the active one.
    if (splitDir && it.panelId) openNamedPanel(it.panelId, splitDir)
    else it.run()
  }

  useEffect(() => {
    if (open) itemRefs.current[idx]?.scrollIntoView({ block: 'nearest' })
  }, [idx, open])

  if (!open) return null

  // Render grouped by section while keeping a flat index for keyboard nav.
  let flat = -1
  const sections: string[] = []
  for (const it of items) if (!sections.includes(it.section)) sections.push(it.section)

  return createPortal(
    <div className="qp-backdrop" onClick={() => setOpen(false)}>
      <div className="qp-dialog" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="qp-input"
          value={query}
          placeholder={
            splitDir
              ? t(splitDir === 'right' ? 'qp.splitRightPick' : 'qp.splitDownPick')
              : t('qp.placeholder')
          }
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setIdx((i) => (i + 1) % Math.max(1, items.length))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setIdx((i) => (i - 1 + items.length) % Math.max(1, items.length))
            } else if (e.key === 'Enter') {
              e.preventDefault()
              run(idx)
            } else if (e.key === 'Escape') {
              e.preventDefault()
              setOpen(false)
            }
          }}
        />
        <div className="qp-list">
          {items.length === 0 && <div className="qp-empty">{t('common.noResults')}</div>}
          {sections.map((sec) => (
            <div key={sec} className="qp-group">
              <div className="qp-group-label">{sec}</div>
              {items
                .filter((it) => it.section === sec)
                .map((it) => {
                  flat++
                  const i = flat
                  return (
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
                  )
                })}
            </div>
          ))}
        </div>
        <div className="qp-foot">↑↓ 이동 · ↵ 실행 · esc 닫기</div>
      </div>
    </div>,
    document.body
  )
}
