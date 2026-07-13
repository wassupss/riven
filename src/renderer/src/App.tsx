import { useEffect } from 'react'
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels'
import Workbench from './dock/Workbench'
import ExplorerPanel from './dock/panels/ExplorerPanel'
import WorkspaceTabs from './components/WorkspaceTabs'
import Toolbar from './components/Toolbar'
import StatusBar from './components/StatusBar'
import ErrorBoundary from './components/ErrorBoundary'
import AgentWatch from './components/AgentWatch'
import KeybindingsModal from './keybindings/KeybindingsModal'
import SettingsModal from './components/SettingsModal'
import { useUI } from './state/ui'
import { useSession, loadPersistedSessions } from './state/session'
import { loadEnv } from './state/env'
import { loadSettings, getSettings } from './state/settings'
import { applyTheme } from './state/themes'
import { keymap } from './keybindings/keys'
import { registerDefaultActions } from './keybindings/actions'
import { getEditorCloser } from './keybindings/focus'
import { getActiveApi } from './dock/registry'

export default function App(): JSX.Element {
  const ready = useSession((s) => s.ready)
  const openWorkspaces = useSession((s) => s.openWorkspaces)
  const activeWorkspace = useSession((s) => s.activeWorkspace)
  const showExplorer = useUI((s) => s.showExplorer)

  // Always watch the active workspace (independent of whether the editor is open)
  // so agent edits are detected reliably.
  useEffect(() => {
    if (activeWorkspace) window.api.bridge.watchStart(activeWorkspace)
  }, [activeWorkspace])

  useEffect(() => {
    registerDefaultActions()
    void (async () => {
      await loadEnv()
      await loadSettings()
      applyTheme(getSettings().theme)
      await keymap.load()
      await loadPersistedSessions()
    })()
    window.addEventListener('keydown', keymap.handle, { capture: true })
    // ⌘W closes whatever dockview panel is active: the editor closes its focused
    // file tab, everything else (terminal/explorer/search/preview) closes itself.
    // Read the active panel ONCE so closing can't cascade.
    const offClose = window.api.menu.onCloseTab(() => {
      const api = getActiveApi()
      const active = api?.activePanel
      if (!api || !active) return
      if (active.id === 'editor') {
        // Close the focused file tab; if the editor has no tab, close the panel.
        if (!getEditorCloser()?.()) api.removePanel(active)
      } else {
        api.removePanel(active)
      }
    })
    return () => {
      window.removeEventListener('keydown', keymap.handle, { capture: true })
      offClose()
    }
  }, [])

  return (
    <div className="app">
      <div className="titlebar">
        <WorkspaceTabs />
        <span className="titlebar-spacer" />
        <Toolbar />
      </div>

      <PanelGroup direction="horizontal" className="body">
        {showExplorer && activeWorkspace && (
          <>
            <Panel id="sidebar" order={1} defaultSize={13} minSize={8} maxSize={40} className="sidebar">
              <ExplorerPanel workspace={activeWorkspace} />
            </Panel>
            <PanelResizeHandle className="resize-handle-v" />
          </>
        )}
        {/* One dockview workbench per open workspace; only the active is visible so
            switching projects never tears down running terminals. Closing dock
            panels never grows the sidebar (it's a separate panel). */}
        <Panel id="dock" order={2} className="dock-col">
          <div className="grid-host">
            {ready && openWorkspaces.length === 0 && (
              <div className="empty-hint center">타이틀바의 + 로 폴더를 열어 프로젝트를 시작해.</div>
            )}
            {openWorkspaces.map((ws) => (
              <div
                key={ws}
                className="grid-layer"
                style={{ display: ws === activeWorkspace ? 'block' : 'none' }}
              >
                <ErrorBoundary label={ws.split('/').pop()}>
                  <Workbench workspace={ws} />
                </ErrorBoundary>
              </div>
            ))}
          </div>
        </Panel>
      </PanelGroup>

      <ErrorBoundary label="상태바">
        <StatusBar />
      </ErrorBoundary>
      <KeybindingsModal />
      <SettingsModal />
      <AgentWatch />
    </div>
  )
}
