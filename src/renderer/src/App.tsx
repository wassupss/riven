import { useEffect } from 'react'
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels'
import Workbench from './dock/Workbench'
import ExplorerPanel from './dock/panels/ExplorerPanel'
import WorkspaceTabs from './components/WorkspaceTabs'
import Toolbar from './components/Toolbar'
import StatusBar from './components/StatusBar'
import ErrorBoundary from './components/ErrorBoundary'
import AgentWatch from './components/AgentWatch'
import SettingsModal from './components/SettingsModal'
import Palette from './components/Palette'
import AgentPicker from './components/AgentPicker'
import { useUI } from './state/ui'
import { useSession, loadPersistedSessions } from './state/session'
import { loadEnv } from './state/env'
import { loadSettings, getSettings, useSettings } from './state/settings'
import { useAuth } from './state/auth'
import { applyTheme } from './state/themes'
import { applyEditorKeymap, loadEditorKeymap } from './state/editorKeymaps'
import { registerInlineComplete } from './editor/inlineComplete'
import { registerSnippets } from './editor/snippets'
import { injectImportedFonts } from './state/fonts'
import UsagePinned from './components/UsagePinned'
import { keymap } from './keybindings/keys'
import { registerDefaultActions } from './keybindings/actions'
import { getEditorCloser } from './keybindings/focus'
import { getActiveApi } from './dock/registry'
import { useT } from './i18n'

export default function App(): JSX.Element {
  const t = useT()
  const ready = useSession((s) => s.ready)
  const openWorkspaces = useSession((s) => s.openWorkspaces)
  const activeWorkspace = useSession((s) => s.activeWorkspace)
  const showExplorer = useUI((s) => s.showExplorer)

  // Always watch the active workspace (independent of whether the editor is open)
  // so agent edits are detected reliably.
  useEffect(() => {
    if (activeWorkspace) window.api.bridge.watchStart(activeWorkspace)
  }, [activeWorkspace])

  const usagePinned = useSettings((s) => s.settings.usagePinned)

  useEffect(() => {
    registerDefaultActions()
    registerInlineComplete()
    registerSnippets()
    void (async () => {
      await loadEnv()
      await loadSettings()
      injectImportedFonts()
      applyTheme(getSettings().theme)
      await loadEditorKeymap()
      applyEditorKeymap(getSettings().editorKeymap)
      await keymap.load()
      await loadPersistedSessions()
      // Settings are loaded — now restore any cloud session and start sync.
      void useAuth.getState().initAuth()
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
      <PanelGroup direction="horizontal" className="body">
        <Panel id="sidebar" order={1} defaultSize={17} minSize={11} maxSize={40} className="sidebar">
          <div className="sidebar-inner">
            {/* Header reaches the top of the window: traffic-light drag area on the
                left, the toolbar collected on the right. */}
            <div className="sidebar-head">
              <Toolbar />
            </div>
            {/* The stacked regions (workspaces / explorer / usage) are each
                independently resizable. */}
            <PanelGroup direction="vertical" className="sidebar-stack">
              <Panel id="ws" order={1} defaultSize={34} minSize={12} className="sidebar-region">
                <WorkspaceTabs />
              </Panel>
              {showExplorer && activeWorkspace && (
                <>
                  <PanelResizeHandle className="resize-handle-h" />
                  <Panel id="explorer" order={2} minSize={12} className="sidebar-region">
                    <div className="sidebar-explorer">
                      <ExplorerPanel workspace={activeWorkspace} />
                    </div>
                  </Panel>
                </>
              )}
              {usagePinned && (
                <>
                  <PanelResizeHandle className="resize-handle-h" />
                  <Panel id="usage" order={3} defaultSize={22} minSize={10} maxSize={50} className="sidebar-region">
                    <UsagePinned />
                  </Panel>
                </>
              )}
            </PanelGroup>
          </div>
        </Panel>
        <PanelResizeHandle className="resize-handle-v" />
        {/* One dockview workbench per open workspace; only the active is visible so
            switching projects never tears down running terminals. Closing dock
            panels never grows the sidebar (it's a separate panel). */}
        <Panel id="dock" order={2} className="dock-col">
          <div className="grid-host">
            {ready && openWorkspaces.length === 0 && (
              <div className="empty-hint center">{t('app.emptyHint')}</div>
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

      <ErrorBoundary label={t('app.statusBarLabel')}>
        <StatusBar />
      </ErrorBoundary>
      <SettingsModal />
      <Palette />
      <AgentPicker />
      <AgentWatch />
    </div>
  )
}
