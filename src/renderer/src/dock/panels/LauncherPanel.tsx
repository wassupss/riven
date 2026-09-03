import { useEffect, useState } from 'react'
import type { DockviewPanelApi } from 'dockview-core'
import {
  TerminalSquare,
  Bot,
  FileCode,
  Globe,
  StickyNote,
  Server,
  Search,
  GitBranch,
  GitCompare,
  Users,
  Sparkles,
  type LucideIcon
} from 'lucide-react'
import { pickInLauncher, pickAgentInLauncher, pickCliInLauncher, type NamedPanel } from '../registry'
import { pathOf } from '../../state/session'
import { useT } from '../../i18n'
import '../../styles/launcher.css'

// The empty "what do you want here?" panel shown as a new workspace's first pane
// and for ⌘D / ⌘⇧D splits. Picking a tile replaces this launcher with that panel.
export default function LauncherPanel({
  workspace,
  api
}: {
  workspace: string
  api: DockviewPanelApi
}): JSX.Element {
  const t = useT()
  const [clis, setClis] = useState<Array<{ name: string; cmd: string }>>([])
  const [agents, setAgents] = useState<Array<{ name: string; description: string }>>([])
  useEffect(() => {
    let live = true
    window.api.chat
      .detectClis()
      .then((r) => live && setClis(r.map((c) => ({ name: c.name, cmd: c.cmd }))))
      .catch(() => {})
    const af = window.api.chat.agents
    if (typeof af === 'function')
      af(pathOf(workspace))
        .then((a) => live && setAgents(a))
        .catch(() => live && setAgents([]))
    return () => {
      live = false
    }
  }, [workspace])

  // Panels (not agents): terminal + the singleton tools.
  const panels: Array<{ kind: NamedPanel; label: string; Icon: LucideIcon }> = [
    { kind: 'terminal', label: t('title.terminal'), Icon: TerminalSquare },
    { kind: 'editor', label: t('title.editor'), Icon: FileCode },
    { kind: 'preview', label: t('title.preview'), Icon: Globe },
    { kind: 'agentgroup', label: t('title.agentgroup'), Icon: Users },
    { kind: 'notes', label: t('title.notes'), Icon: StickyNote },
    { kind: 'api', label: t('title.api'), Icon: Server },
    { kind: 'search', label: t('title.search'), Icon: Search },
    { kind: 'git', label: t('title.git'), Icon: GitBranch },
    { kind: 'changes', label: t('title.changes'), Icon: GitCompare }
  ]

  return (
    <div className="launcher">
      <div className="launcher-inner">
        <div className="launcher-title">{t('launcher.title')}</div>

        {/* Detected AI agents (Claude Code, Codex, …) — the mapped CLIs. */}
        <div className="launcher-sub">{t('qp.section.agent')}</div>
        <div className="launcher-grid">
          {clis.map((c) => (
            <button
              key={c.cmd}
              className="launcher-tile"
              onClick={() => pickCliInLauncher(api.id, c.cmd)}
            >
              <Bot size={20} />
              <span>{c.name}</span>
            </button>
          ))}
        </div>

        {/* Custom agents defined in .claude/agents. */}
        {agents.length > 0 && (
          <>
            <div className="launcher-sub">{t('launcher.agents')}</div>
            <div className="launcher-agents">
              {agents.map((a) => (
                <button
                  key={a.name}
                  className="launcher-agent"
                  title={a.description}
                  onClick={() => pickAgentInLauncher(api.id, a.name)}
                >
                  <Sparkles size={14} />
                  <span>{a.name}</span>
                </button>
              ))}
            </div>
          </>
        )}

        {/* Panels. */}
        <div className="launcher-sub">{t('qp.section.panel')}</div>
        <div className="launcher-grid">
          {panels.map(({ kind, label, Icon }) => (
            <button key={kind} className="launcher-tile" onClick={() => pickInLauncher(api.id, kind)}>
              <Icon size={20} />
              <span>{label}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
