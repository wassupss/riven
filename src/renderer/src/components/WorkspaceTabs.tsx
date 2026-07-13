import { useCallback } from 'react'
import { useSession } from '../state/session'

export default function WorkspaceTabs(): JSX.Element {
  const openWorkspaces = useSession((s) => s.openWorkspaces)
  const activeWorkspace = useSession((s) => s.activeWorkspace)
  const openWorkspace = useSession((s) => s.openWorkspace)
  const closeWorkspace = useSession((s) => s.closeWorkspace)
  const setActiveWorkspace = useSession((s) => s.setActiveWorkspace)

  const pick = useCallback(async () => {
    const picked = await window.api.workspace.pickFolder()
    if (picked) openWorkspace(picked)
  }, [openWorkspace])

  return (
    <div className="ws-tabs">
      {openWorkspaces.map((ws, i) => (
        <div
          key={ws}
          className={`ws-tab${ws === activeWorkspace ? ' active' : ''}`}
          title={`${ws}  (⌘${i + 1})`}
          onClick={() => setActiveWorkspace(ws)}
        >
          <span className="ws-tab-name">🗂 {ws.split('/').pop()}</span>
          <span
            className="ws-tab-close"
            title="워크스페이스 닫기"
            onClick={(e) => {
              e.stopPropagation()
              closeWorkspace(ws)
            }}
          >
            ✕
          </span>
        </div>
      ))}
      <button className="ws-add" title="폴더 열기" onClick={pick}>
        +
      </button>
    </div>
  )
}
