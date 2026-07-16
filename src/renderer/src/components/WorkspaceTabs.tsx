import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useSession, workspaceName, pathOf } from '../state/session'
import { useWorkspaceStatus, rollupActivity, type PaneActivity } from '../state/workspaceStatus'
import { useT } from '../i18n'
import { Plus, X, GitBranch } from 'lucide-react'

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
  const name = useSession((s) => workspaceName(ws, s.names))
  const active = ws === activeWorkspace
  const activity = useWorkspaceStatus((s) => rollupActivity(s.panes, ws))
  const openWorkspace = useSession((s) => s.openWorkspace)
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
        <span className={`ws-card-dot ${activity}`} title={t(ACTIVITY_LABEL_KEY[activity])} />
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
        <span
          className="ws-card-close"
          title={t('ws.close')}
          onClick={(e) => {
            e.stopPropagation()
            closeWorkspace(ws)
          }}
        >
          <X size={12} />
        </span>
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
