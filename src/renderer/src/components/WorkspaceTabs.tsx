import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useSession, workspaceName, pathOf, loadPaneState } from '../state/session'
import { useWorkspaceStatus, rollupActivity, type PaneActivity } from '../state/workspaceStatus'
import { useAgents, agentsForWorkspace } from '../state/agents'
import { useUI } from '../state/ui'
import { getActiveApi } from '../dock/registry'
import { tintStyle, decodeAvatar, hueColor, encodeAvatar, AVATAR_COLOR_COUNT } from '../lib/avatar'
import { useT } from '../i18n'
import { Plus, GitBranch, ChevronRight, ChevronDown } from 'lucide-react'

// Vertical workspace rail — cmux-style cards. Workspaces are the primary
// navigation unit (each is an agent/project context), so each card surfaces its
// live activity, path, and git state at a glance.
export default function WorkspaceTabs(): JSX.Element {
  const t = useT()
  const openWorkspaces = useSession((s) => s.openWorkspaces)
  const openWorkspace = useSession((s) => s.openWorkspace)
  const reorderWorkspace = useSession((s) => s.reorderWorkspace)
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [overIndex, setOverIndex] = useState<number | null>(null)

  const pick = useCallback(async () => {
    const picked = await window.api.workspace.pickFolder()
    if (!picked) return
    // If the folder is already open, add another independent instance instead of
    // just refocusing — that's the obvious way to make a same-path workspace.
    const alreadyOpen = useSession.getState().openWorkspaces.some((w) => pathOf(w) === picked)
    openWorkspace(picked, alreadyOpen)
  }, [openWorkspace])

  const endDrag = (): void => {
    setDragIndex(null)
    setOverIndex(null)
  }
  const drop = (to: number): void => {
    if (dragIndex != null && dragIndex !== to) reorderWorkspace(dragIndex, to)
    endDrag()
  }

  return (
    <div className="ws-rail">
      <div className="ws-rail-head">
        <span className="ws-rail-title">{t('ws.title')}</span>
        <button className="ws-rail-add" title={t('ws.openFolder')} onClick={pick}>
          <Plus size={14} />
        </button>
      </div>
      <div className="ws-list">
        {openWorkspaces.map((ws, i) => (
          <WorkspaceCard
            key={ws}
            ws={ws}
            index={i}
            dragging={dragIndex === i}
            dropTarget={overIndex === i && dragIndex != null && dragIndex !== i}
            onDragStart={() => setDragIndex(i)}
            onDragEnter={() => setOverIndex(i)}
            onDrop={() => drop(i)}
            onDragEnd={endDrag}
          />
        ))}
        {openWorkspaces.length === 0 && <div className="ws-empty">{t('ws.empty')}</div>}
      </div>
    </div>
  )
}

const ACTIVITY_LABEL_KEY: Record<PaneActivity, string> = {
  attn: 'ws.activity.attn',
  busy: 'ws.activity.busy',
  idle: 'ws.activity.idle'
}

function shortenPath(p: string): string {
  return p.replace(/^\/(?:Users|home)\/[^/]+/, '~')
}

// Agent status indicator, matching native's rail (StatusIndicator):
//   idle → static dot · busy → radar-pulse rings · waiting → breathing dot ·
//   done → a checkmark that draws itself.
type DotActivity = 'idle' | 'busy' | 'waiting' | 'done'
function StatusDot({
  activity,
  color,
  title
}: {
  activity: DotActivity
  color?: string
  title?: string
}): JSX.Element {
  if (activity === 'done') {
    return (
      <span className="ws-stat done" title={title} aria-hidden>
        <svg viewBox="0 0 12 12">
          <path className="ws-check-path" d="M2.6 6.3 L5 8.7 L9.4 3.3" />
        </svg>
      </span>
    )
  }
  return (
    <span
      className={`ws-stat ${activity}`}
      title={title}
      // The colour drives the dot AND the busy radar rings (CSS reads --dot), so a
      // workspace's pulse matches the colour the user picked for it.
      style={color ? ({ '--dot': color } as React.CSSProperties) : undefined}
      aria-hidden
    >
      {activity === 'busy' && (
        <>
          <i className="ws-ring" />
          <i className="ws-ring d2" />
        </>
      )}
      <i className="ws-core" />
    </span>
  )
}

// Stable per-workspace identity color (like native cardColors) so cards are
// distinguishable at a glance. Derived from the path so it's consistent.
function colorFor(ws: string, override?: string): string {
  // A user-picked colour (avatar palette index) always wins; otherwise fall back to
  // the stable hash colour so untouched workspaces stay distinguishable.
  const d = decodeAvatar(override)
  if (d) return hueColor(d.color)
  let h = 0
  for (let i = 0; i < ws.length; i++) h = (h * 31 + ws.charCodeAt(i)) | 0
  return `hsl(${Math.abs(h) % 360} 62% 62%)`
}

// Persisted set of workspaces whose agent roster is collapsed.
function railCollapsed(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem('railCollapsed') || '[]') as string[])
  } catch {
    return new Set()
  }
}

interface GitState {
  branch: string | null
  dirty: number
}

interface CardProps {
  ws: string
  index: number
  dragging: boolean
  dropTarget: boolean
  onDragStart: () => void
  onDragEnter: () => void
  onDrop: () => void
  onDragEnd: () => void
}

function WorkspaceCard({
  ws,
  index,
  dragging,
  dropTarget,
  onDragStart,
  onDragEnter,
  onDrop,
  onDragEnd
}: CardProps): JSX.Element {
  const t = useT()
  const activeWorkspace = useSession((s) => s.activeWorkspace)
  const setActiveWorkspace = useSession((s) => s.setActiveWorkspace)
  const closeWorkspace = useSession((s) => s.closeWorkspace)
  const renameWorkspace = useSession((s) => s.renameWorkspace)
  const setWorkspaceColor = useSession((s) => s.setWorkspaceColor)
  const wsColor = useSession((s) => s.colors[ws])
  const name = useSession((s) => workspaceName(ws, s.names))
  const active = ws === activeWorkspace
  const activity = useWorkspaceStatus((s) => rollupActivity(s.panes, ws))
  const openWorkspace = useSession((s) => s.openWorkspace)
  const metaHeld = useUI((s) => s.metaHeld)
  // Re-read the (non-reactive) agent roster whenever it changes.
  useAgents((s) => s.version)
  const agents = agentsForWorkspace(ws)
  // The card dot also reflects a just-finished agent: busy > waiting(attn) > done.
  const cardActivity: DotActivity =
    activity === 'busy'
      ? 'busy'
      : activity === 'attn'
        ? 'waiting'
        : agents.some((a) => a.status === 'done')
          ? 'done'
          : 'idle'
  // Collapse the agent roster per workspace (persisted), like native's rail.
  const [collapsed, setCollapsed] = useState(() => railCollapsed().has(ws))
  const toggleCollapsed = (): void => {
    const set = railCollapsed()
    set.has(ws) ? set.delete(ws) : set.add(ws)
    try {
      localStorage.setItem('railCollapsed', JSON.stringify([...set]))
    } catch {
      /* ignore */
    }
    setCollapsed(set.has(ws))
  }
  const [git, setGit] = useState<GitState | null>(null)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(name)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const cardRef = useRef<HTMLDivElement>(null)

  const beginRename = (): void => {
    setDraft(name)
    setEditing(true)
  }
  const commitRename = (): void => {
    setEditing(false)
    renameWorkspace(ws, draft)
  }

  const openMenu = (e: React.MouseEvent): void => {
    e.preventDefault()
    setMenu({ x: Math.min(e.clientX, window.innerWidth - 200), y: Math.min(e.clientY, window.innerHeight - 100) })
  }

  // Scroll the active workspace card into view when it becomes active.
  useEffect(() => {
    if (active) cardRef.current?.scrollIntoView({ block: 'nearest' })
  }, [active])

  useEffect(() => {
    let alive = true
    window.api.git
      .status(pathOf(ws))
      .then((st) => {
        if (!alive) return
        setGit(st.isRepo ? { branch: st.branch, dirty: st.files.length } : null)
      })
      .catch(() => alive && setGit(null))
    return () => {
      alive = false
    }
    // Refetch when this workspace becomes active (cheap, catches commits/switches).
  }, [ws, active])

  return (
    <div
      ref={cardRef}
      className={`ws-card${active ? ' active' : ''}${dragging ? ' dragging' : ''}${dropTarget ? ' drop-target' : ''} ${activity}`}
      title={`${pathOf(ws)}  (⌘${index + 1})`}
      draggable={!editing}
      onClick={() => setActiveWorkspace(ws)}
      onContextMenu={openMenu}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move'
        onDragStart()
      }}
      onDragEnter={onDragEnter}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault()
        onDrop()
      }}
      onDragEnd={onDragEnd}
    >
      <div className="ws-card-top">
        <StatusDot
          activity={cardActivity}
          color={colorFor(ws, wsColor)}
          title={t(ACTIVITY_LABEL_KEY[activity])}
        />
        {editing ? (
          <input
            className="ws-card-rename"
            value={draft}
            autoFocus
            spellCheck={false}
            placeholder={ws.split('/').pop()}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRename()
              else if (e.key === 'Escape') setEditing(false)
            }}
          />
        ) : (
          <span
            className="ws-card-title"
            title={t('ws.renameHint')}
            onDoubleClick={(e) => {
              e.stopPropagation()
              beginRename()
            }}
          >
            {name}
          </span>
        )}
        {agents.length > 0 && (
          <button
            className="ws-card-agentcount"
            title={t('ws.agentCount', { n: agents.length })}
            onClick={(e) => {
              e.stopPropagation()
              toggleCollapsed()
            }}
          >
            {collapsed ? <ChevronRight size={10} /> : <ChevronDown size={10} />}
            {agents.length}
          </button>
        )}
        {index < 9 && metaHeld && <span className="ws-card-kbd">⌘{index + 1}</span>}
      </div>
      <div className="ws-card-meta">
        <span className="ws-card-path">{shortenPath(pathOf(ws))}</span>
      </div>
      {git && (
        <div className="ws-card-git">
          <span className="ws-card-branch"><GitBranch size={12} /> {git.branch ?? 'detached'}</span>
          {git.dirty > 0 && <span className="ws-card-dirty">±{git.dirty}</span>}
        </div>
      )}
      {agents.length > 0 && !collapsed && (
        <div className="ws-card-agents">
          {agents.map((a) => {
            // The agent's colour tints the whole row + colours the name text.
            const tint = tintStyle(a.title.split(' · ')[0] || a.title, loadPaneState(ws, a.id).avatar)
            return (
              <span
                key={a.id}
                className="ws-agent"
                title={a.title}
                style={tint ? { background: tint.background } : undefined}
                onClick={(e) => {
                  e.stopPropagation()
                  setActiveWorkspace(ws)
                  // After the dock for this workspace is active, focus the agent pane.
                  setTimeout(() => getActiveApi()?.getPanel(a.id)?.api.setActive(), 60)
                }}
              >
                <StatusDot activity={a.status} />
                <span
                  className={`ws-agent-title${a.status === 'busy' ? ' shimmer' : ''}`}
                  style={tint && a.status !== 'busy' ? { color: tint.color } : undefined}
                >
                  {a.title}
                </span>
              </span>
            )
          })}
        </div>
      )}
      {menu &&
        createPortal(
          <div className="ctx-backdrop" onClick={() => setMenu(null)} onContextMenu={(e) => { e.preventDefault(); setMenu(null) }}>
            <div className="ctx-menu" style={{ left: menu.x, top: menu.y }} onClick={(e) => e.stopPropagation()}>
              <button
                className="ctx-item"
                onClick={() => {
                  setMenu(null)
                  beginRename()
                }}
              >
                {t('ws.rename')}
              </button>
              <button
                className="ctx-item"
                onClick={() => {
                  setMenu(null)
                  openWorkspace(pathOf(ws), true)
                }}
              >
                {t('ws.newInstance')}
              </button>
              <div className="ctx-sep" />
              <div className="context-label">{t('tab.color')}</div>
              <div className="tab-swatches">
                {Array.from({ length: AVATAR_COLOR_COUNT }, (_, c) => (
                  <button
                    key={c}
                    className="tab-swatch"
                    style={{ background: hueColor(c) }}
                    aria-label={`color ${c}`}
                    onClick={() => {
                      setWorkspaceColor(ws, encodeAvatar(0, c))
                      setMenu(null)
                    }}
                  />
                ))}
              </div>
              <button
                className="ctx-item"
                onClick={() => {
                  setWorkspaceColor(ws, null)
                  setMenu(null)
                }}
              >
                {t('ws.colorReset')}
              </button>
              <div className="ctx-sep" />
              <button
                className="ctx-item"
                onClick={() => {
                  setMenu(null)
                  closeWorkspace(ws)
                }}
              >
                {t('ws.close')}
              </button>
            </div>
          </div>,
          document.body
        )}
    </div>
  )
}
