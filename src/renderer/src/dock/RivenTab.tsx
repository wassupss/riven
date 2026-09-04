import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import type { IDockviewPanelHeaderProps } from 'dockview-react'
import { useTabBadge } from '../state/tabBadge'
import { confirmTerminalClose, setTabColor, widForApi } from './registry'
import { useAgents, getAgentStatus } from '../state/agents'
import { loadPaneState, useSession } from '../state/session'
import { tintStyle, hueColor, encodeAvatar, AVATAR_COLOR_COUNT, AVATAR_NONE } from '../lib/avatar'
import { useT } from '../i18n'
import { X } from 'lucide-react'

// Custom dockview tab: double-click the title to rename the panel. The name is
// persisted with the layout (dockview serializes the title). Chat panes also show
// a deterministic agent avatar (same face as the org chart / native dock tabs).
export default function RivenTab(props: IDockviewPanelHeaderProps): JSX.Element {
  const { api, containerApi } = props
  const t = useT()
  const activeWorkspace = useSession((s) => s.activeWorkspace)
  // The workspace this tab belongs to (its dockview), so colours are stored/read
  // under the right workspace even for singleton ids ('git') that repeat per ws.
  const workspace = widForApi(containerApi) ?? activeWorkspace ?? ''
  const [title, setTitle] = useState(api.title ?? '')
  const [editing, setEditing] = useState(false)
  const [avatarRev, setAvatarRev] = useState(0) // bump to re-read the override
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const badge = useTabBadge((s) => s.badges[api.id])
  const isChat = api.id.startsWith('chat-')
  // Re-read the pane's agent status on every roster change so the tab title can
  // shimmer while it's running (native dock-tab parity).
  useAgents((s) => s.version)
  const status = isChat ? getAgentStatus(api.id) : 'idle'

  useEffect(() => {
    const d = api.onDidTitleChange(() => setTitle(api.title ?? ''))
    return () => d.dispose()
  }, [api])

  // Re-read the colour override when it changes for this pane (any panel kind).
  useEffect(() => {
    const onAvatar = (e: Event): void => {
      if ((e as CustomEvent).detail === api.id) setAvatarRev((n) => n + 1)
    }
    window.addEventListener('riven:chatavatar', onAvatar)
    return () => window.removeEventListener('riven:chatavatar', onAvatar)
  }, [api])

  const commit = (v: string): void => {
    const tv = v.trim()
    if (tv) api.setTitle(tv)
    setEditing(false)
  }

  // Close every tab in this tab's group.
  const closeGroup = (): void => {
    const panels = api.group?.panels ? [...api.group.panels] : []
    for (const p of panels) if (confirmTerminalClose(p.id)) p.api.close()
  }

  // Whole-tab tint (avatarRev re-reads after an edit). Any panel can be coloured
  // via the right-click menu; chat panes also get a deterministic default tint.
  void avatarRev
  const override = loadPaneState(workspace, api.id).avatar ?? null
  const nameKey = title.split(' · ')[0] || title
  // Tint only when a colour was explicitly chosen (tintStyle returns null for no
  // override / "none"). No auto colour on new chats.
  const tint = tintStyle(nameKey, override)

  return (
    <div
      className={`riven-tab${status === 'done' ? ' done' : ''}${tint ? ' tinted' : ''}`}
      style={tint ? { background: tint.background, color: tint.color } : undefined}
      onDoubleClick={() => setEditing(true)}
      onContextMenu={(e) => {
        e.preventDefault()
        e.stopPropagation()
        setMenu({ x: e.clientX, y: e.clientY })
      }}
      title="더블클릭하여 이름 변경"
    >
      {editing ? (
        <input
          className="riven-tab-input"
          autoFocus
          defaultValue={title}
          onClick={(e) => e.stopPropagation()}
          onBlur={(e) => commit(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit(e.currentTarget.value)
            else if (e.key === 'Escape') setEditing(false)
          }}
        />
      ) : (
        <span className="riven-tab-title">
          {badge && <span className={`tab-dot ${badge}`} />}
          <span className={`riven-tab-label${status === 'busy' ? ' shimmer' : ''}`}>{title}</span>
        </span>
      )}
      <span
        className="riven-tab-close"
        title="닫기"
        onClick={(e) => {
          e.stopPropagation()
          if (confirmTerminalClose(api.id)) api.close()
        }}
      >
        <X size={11} />
      </span>
      {menu &&
        createPortal(
          <div
            className="ctx-backdrop"
            onClick={() => setMenu(null)}
            onContextMenu={(e) => {
              e.preventDefault()
              setMenu(null)
            }}
          >
            <div
              className="context-menu"
              style={{ left: Math.min(menu.x, window.innerWidth - 200), top: Math.min(menu.y, window.innerHeight - 160) }}
              onClick={(e) => e.stopPropagation()}
            >
              <div
                className="context-item"
                onClick={() => {
                  setMenu(null)
                  if (confirmTerminalClose(api.id)) api.close()
                }}
              >
                {t('tab.closePanel')}
              </div>
              <div
                className="context-item"
                onClick={() => {
                  setMenu(null)
                  closeGroup()
                }}
              >
                {t('tab.closeAllTabs')}
              </div>
              <div className="context-sep" />
              <div className="context-label">{t('tab.color')}</div>
              <div className="tab-swatches">
                {Array.from({ length: AVATAR_COLOR_COUNT }, (_, c) => (
                  <button
                    key={c}
                    className="tab-swatch"
                    style={{ background: hueColor(c) }}
                    aria-label={`color ${c}`}
                    onClick={() => {
                      setTabColor(workspace, api.id, encodeAvatar(0, c))
                      setMenu(null)
                    }}
                  />
                ))}
              </div>
              <div
                className="context-item"
                onClick={() => {
                  setTabColor(workspace, api.id, AVATAR_NONE)
                  setMenu(null)
                }}
              >
                {t('tab.colorNone')}
              </div>
            </div>
          </div>,
          document.body
        )}
    </div>
  )
}
