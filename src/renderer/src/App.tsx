import { useEffect, useState } from 'react'
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels'
import Workbench from './dock/Workbench'
import ExplorerPanel from './dock/panels/ExplorerPanel'
import WorkspaceTabs from './components/WorkspaceTabs'
import { PanelTop, Folder, Settings as SettingsIcon } from 'lucide-react'
import UsageWidget from './components/UsageWidget'
import StatusBar from './components/StatusBar'
import ErrorBoundary from './components/ErrorBoundary'
import AgentWatch from './components/AgentWatch'
import SettingsModal from './components/SettingsModal'
import Palette from './components/Palette'
import QuickPanel from './components/QuickPanel'
import AgentPicker from './components/AgentPicker'
import AskUserModal from './components/AskUserModal'
import { useAskUser } from './state/askUser'
import { initBrowserEvents } from './state/browser'
import { registerMcpToolHandler } from './state/mcpTools'
import { startScheduler } from './state/scheduledMessages'
import { useUI } from './state/ui'
import { useSession, loadPersistedSessions, pathOf } from './state/session'
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
import { useUpdate } from './state/update'
import { getEditorCloser, initFocusTracking } from './keybindings/focus'
import { getActiveApi, confirmTerminalClose } from './dock/registry'
import { useT } from './i18n'

export default function App(): JSX.Element {
  const t = useT()
  const ready = useSession((s) => s.ready)
  const openWorkspaces = useSession((s) => s.openWorkspaces)
  const activeWorkspace = useSession((s) => s.activeWorkspace)
  const wsNames = useSession((s) => s.names)
  const showExplorer = useUI((s) => s.showExplorer)
  const showSidebar = useUI((s) => s.showSidebar)
  const setQuickPanel = useUI((s) => s.setQuickPanel)
  const openSettings = useUI((s) => s.openSettings)
  const wsName = activeWorkspace
    ? wsNames[activeWorkspace] ?? pathOf(activeWorkspace).split('/').pop() ?? ''
    : ''
  const wsPath = activeWorkspace ? pathOf(activeWorkspace).replace(/^\/Users\/[^/]+/, '~') : ''

  // Mount a workspace's dockview only once it has been activated (i.e. visible),
  // then keep it mounted. Restoring a saved layout into a hidden (0×0) dockview
  // mangles it — panels drop / positions collapse — and that corrupted layout
  // then overwrites the good save. Lazy-mounting means every restore happens at a
  // real size. Already-open terminals still persist across switches.
  // Keep only the N most-recently-active workspaces mounted. Previously EVERY
  // visited workspace stayed mounted forever (hidden), so its panels — chats,
  // xterm terminals, Monaco editors — all stayed live. With several heavy
  // workspaces this ballooned the renderer heap (measured 2.5GB) and thrashed the
  // GC, making the whole app lag on every action. An LRU bounds the live set;
  // switching back re-mounts (PTYs survive in main, chat transcripts reload from
  // the session tree), so no state is lost.
  const MAX_MOUNTED = 3
  const [activated, setActivated] = useState<string[]>([])
  useEffect(() => {
    if (!activeWorkspace) return
    setActivated((a) => {
      const recent = [...a.filter((w) => w !== activeWorkspace && openWorkspaces.includes(w)), activeWorkspace]
      return recent.slice(-MAX_MOUNTED)
    })
  }, [activeWorkspace, openWorkspaces])

  // Always watch the active workspace (independent of whether the editor is open)
  // so agent edits are detected reliably.
  useEffect(() => {
    if (activeWorkspace) window.api.bridge.watchStart(pathOf(activeWorkspace))
  }, [activeWorkspace])

  const usagePinned = useSettings((s) => s.settings.usagePinned)

  useEffect(() => {
    registerDefaultActions()
    registerInlineComplete()
    registerSnippets()
    useUpdate.getState().init()
    void (async () => {
      await loadEnv()
      await loadSettings()
      injectImportedFonts()
      applyTheme(getSettings().theme)
      window.api.setZoom(getSettings().uiScale || 1)
      await loadEditorKeymap()
      applyEditorKeymap(getSettings().editorKeymap)
      await keymap.load()
      await loadPersistedSessions()
      // Settings are loaded — now restore any cloud session and start sync.
      void useAuth.getState().initAuth()
    })()
    window.addEventListener('keydown', keymap.handle, { capture: true })
    // riven's own MCP tools (agent → main → here): open files/panels, ask_user, …
    const offMcp = registerMcpToolHandler()
    // Fire due scheduled messages (명령 예약).
    startScheduler()
    // Reflect Chromium browser navigation events into the tab chrome.
    const offBrowser = initBrowserEvents()
    // A focused browser view swallows keyboard; main forwards Cmd/Ctrl chords here
    // so global shortcuts (pane nav, new terminal, …) keep working while browsing.
    const offBrowserKey = window.api.browser.onKey((input) => {
      const synthetic = {
        key: input.key,
        code: input.code,
        metaKey: input.meta,
        ctrlKey: input.control,
        altKey: input.alt,
        shiftKey: input.shift,
        keyCode: 0,
        nativeEvent: { isComposing: false },
        preventDefault: () => {},
        stopPropagation: () => {}
      } as unknown as KeyboardEvent
      keymap.handle(synthetic)
    })
    // Peek the workspace ⌘N hints only while ⌘ is held.
    const onMetaDown = (e: KeyboardEvent): void => {
      if (e.metaKey || e.ctrlKey) useUI.getState().setMetaHeld(true)
    }
    const onMetaUp = (e: KeyboardEvent): void => {
      if (!e.metaKey && !e.ctrlKey) useUI.getState().setMetaHeld(false)
    }
    const onBlurMeta = (): void => useUI.getState().setMetaHeld(false)
    window.addEventListener('keydown', onMetaDown, true)
    window.addEventListener('keyup', onMetaUp, true)
    window.addEventListener('blur', onBlurMeta)
    initFocusTracking()
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
      } else if (confirmTerminalClose(active.id)) {
        api.removePanel(active)
      }
    })
    return () => {
      window.removeEventListener('keydown', keymap.handle, { capture: true })
      offClose()
      offMcp()
      offBrowser()
      offBrowserKey()
      window.removeEventListener('keydown', onMetaDown, true)
      window.removeEventListener('keyup', onMetaUp, true)
      window.removeEventListener('blur', onBlurMeta)
    }
  }, [])

  // A renderer overlay (settings/palette/quick panel/agent picker/ask_user) paints
  // BEHIND the main-process browser views, so hide those views while one is up.
  const overlayOpen = useUI(
    (s) => s.settingsOpen || s.keybindingsOpen || !!s.palette || s.quickPanel || !!s.agentPicker
  )
  const askOpen = useAskUser((s) => !!s.current)
  useEffect(() => {
    window.api.browser.hideAll(overlayOpen || askOpen)
  }, [overlayOpen, askOpen])

  return (
    <div className="app">
      <PanelGroup direction="horizontal" className="body">
        {showSidebar && (
        <Panel id="sidebar" order={1} defaultSize={17} minSize={11} maxSize={40} className="sidebar">
          <div className="sidebar-inner">
            {/* Sidebar top zone: traffic-light drag area + the "add panel" action
                (right-aligned), matching native. */}
            <div className="sidebar-head">
              <div className="sidebar-head-spacer" />
              <button
                className="sidebar-head-btn"
                disabled={!activeWorkspace}
                title={t('toolbar.openPanel')}
                onClick={() => setQuickPanel(true)}
              >
                <PanelTop size={12} /> {t('toolbar.addPanel')}
              </button>
            </div>
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
        )}
        {showSidebar && <PanelResizeHandle className="resize-handle-v" />}
        {/* One dockview workbench per open workspace; only the active is visible so
            switching projects never tears down running terminals. Closing dock
            panels never grows the sidebar (it's a separate panel). */}
        <Panel id="dock" order={2} className="dock-col">
          {/* Dock top bar (right zone): folder icon + workspace name + path on the
              left, today's cost on the right — matches native. When the sidebar is
              hidden its traffic-light drag zone is gone, so this bar reserves that
              space itself (else the macOS window buttons cover the workspace name). */}
          <div className={`dock-topbar${showSidebar ? '' : ' no-sidebar'}`}>
            {activeWorkspace && (
              <span className="dock-topbar-ws">
                <Folder size={13} />
                <span className="dock-topbar-ws-name">{wsName}</span>
                <span className="dock-topbar-ws-path">{wsPath}</span>
              </span>
            )}
            <div className="dock-topbar-spacer" />
            <UsageWidget />
            <button
              className="dock-topbar-icon"
              title={t('status.settingsTitle')}
              onClick={() => openSettings('general')}
            >
              <SettingsIcon size={14} />
            </button>
          </div>
          <div className="grid-host">
            {ready && openWorkspaces.length === 0 && (
              <div className="empty-hint center">{t('app.emptyHint')}</div>
            )}
            {openWorkspaces
              .filter((ws) => activated.includes(ws))
              .map((ws) => (
                <div
                  key={ws}
                  className="grid-layer"
                  style={{ display: ws === activeWorkspace ? 'block' : 'none' }}
                >
                  <ErrorBoundary label={pathOf(ws).split('/').pop()}>
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
      <QuickPanel />
      <AgentPicker />
      <AskUserModal />
      <AgentWatch />
    </div>
  )
}
