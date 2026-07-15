import { useCallback, useEffect, useRef, useState } from 'react'
import { useSession, workspaceName, pathOf } from '../state/session'
import { useWorkspaceStatus, rollupActivity, type PaneActivity } from '../state/workspaceStatus'
import { useT } from '../i18n'
import { Plus, X, GitBranch, CopyPlus } from 'lucide-react'

// Vertical workspace rail — cmux-style cards. Workspaces are the primary
// navigation unit (each is an agent/project context), so each card surfaces its
// live activity, path, and git state at a glance.
export default function WorkspaceTabs(): JSX.Element {
  const t = useT()
  const openWorkspaces = useSession((s) => s.openWorkspaces)
  const openWorkspace = useSession((s) => s.openWorkspace)
  const recents = useSession((s) => s.recents)
  // A recent (a path) is "closed" only if no open instance points at it.
  const recentClosed = recents.filter((r) => !openWorkspaces.some((w) => pathOf(w) === r))

  const pick = useCallback(async () => {
    const picked = await window.api.workspace.pickFolder()
    if (picked) openWorkspace(picked)
  }, [openWorkspace])

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
          <WorkspaceCard key={ws} ws={ws} index={i} />
        ))}
        {openWorkspaces.length === 0 && <div className="ws-empty">{t('ws.empty')}</div>}
        {recentClosed.length > 0 && (
          <div className="ws-recents">
            <div className="ws-recents-head">{t('ws.recent')}</div>
            {recentClosed.map((r) => (
              <div
                key={r}
                className="ws-recent"
                title={r}
                onClick={() => openWorkspace(r)}
              >
                <span className="ws-recent-name">{r.split('/').pop()}</span>
                <span className="ws-recent-path">{shortenPath(r)}</span>
              </div>
            ))}
          </div>
        )}
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

function WorkspaceCard({ ws, index }: { ws: string; index: number }): JSX.Element {
  const t = useT()
  const activeWorkspace = useSession((s) => s.activeWorkspace)
  const setActiveWorkspace = useSession((s) => s.setActiveWorkspace)
  const closeWorkspace = useSession((s) => s.closeWorkspace)
  const openWorkspace = useSession((s) => s.openWorkspace)
  const renameWorkspace = useSession((s) => s.renameWorkspace)
  const name = useSession((s) => workspaceName(ws, s.names))
  const active = ws === activeWorkspace
  const activity = useWorkspaceStatus((s) => rollupActivity(s.panes, ws))
  const [git, setGit] = useState<GitState | null>(null)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(name)
  const cardRef = useRef<HTMLDivElement>(null)

  const beginRename = (): void => {
    setDraft(name)
    setEditing(true)
  }
  const commitRename = (): void => {
    setEditing(false)
    renameWorkspace(ws, draft)
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
      className={`ws-card${active ? ' active' : ''} ${activity}`}
      title={`${pathOf(ws)}  (⌘${index + 1})`}
      onClick={() => setActiveWorkspace(ws)}
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
          className="ws-card-dup"
          title={t('ws.duplicate')}
          onClick={(e) => {
            e.stopPropagation()
            openWorkspace(pathOf(ws), true)
          }}
        >
          <CopyPlus size={12} />
        </span>
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
    </div>
  )
}
