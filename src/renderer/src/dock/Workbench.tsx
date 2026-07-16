import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { DockviewReact, type DockviewReadyEvent, type IDockviewPanelProps } from 'dockview-react'
import { themeAbyss, type DockviewApi } from 'dockview-core'
import 'dockview-core/dist/styles/dockview.css'
import { SquareTerminal, FileCode } from 'lucide-react'
import EditorPanel from './panels/EditorPanel'
import PreviewPanel from './panels/PreviewPanel'
import SearchPanel from './panels/SearchPanel'
import GitPanel from './panels/GitPanel'
import ChangesPanel from './panels/ChangesPanel'
import TerminalPanel, { type TerminalParams } from './panels/TerminalPanel'
import RivenTab from './RivenTab'
import { useSession } from '../state/session'
import { setActiveApi, nextPaneId, bumpPaneSeq, addTerminal, togglePanel } from './registry'
import { useT } from '../i18n'

export default function Workbench({ workspace }: { workspace: string }): JSX.Element {
  const t = useT()
  const apiRef = useRef<DockviewApi | null>(null)
  const activeWorkspace = useSession((s) => s.activeWorkspace)
  const patch = useSession((s) => s.patch)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [empty, setEmpty] = useState(false)

  const components = useMemo(
    () => ({
      editor: () => <EditorPanel workspace={workspace} />,
      preview: () => <PreviewPanel workspace={workspace} />,
      search: () => <SearchPanel workspace={workspace} />,
      git: () => <GitPanel workspace={workspace} />,
      changes: () => <ChangesPanel />,
      terminal: (props: IDockviewPanelProps<TerminalParams>) => (
        <TerminalPanel workspace={workspace} params={props.params} api={props.api} />
      )
    }),
    [workspace]
  )

  const buildDefault = useCallback((api: DockviewApi) => {
    // Terminal is the main area; the editor opens to its right when a file is
    // selected. The explorer lives outside dockview (a fixed sidebar).
    const pid = nextPaneId()
    api.addPanel({
      id: `term-${pid}`,
      component: 'terminal',
      title: '❯ 터미널',
      params: { paneId: pid },
      renderer: 'always'
    })
  }, [])

  const onReady = useCallback(
    (event: DockviewReadyEvent) => {
      const api = event.api
      apiRef.current = api

      const saved = useSession.getState().sessions[workspace]?.dockLayout
      // Skip a restore that references components we no longer have (e.g. an old
      // layout with an in-dock 'explorer' panel) so it can't crash the workbench.
      const KNOWN = new Set(['editor', 'preview', 'search', 'terminal'])
      const components = saved
        ? [...JSON.stringify(saved).matchAll(/"component":"([^"]+)"/g)].map((m) => m[1])
        : []
      const stale = components.some((c) => !KNOWN.has(c))

      let restored = false
      if (saved && !stale) {
        try {
          api.fromJSON(saved as Parameters<DockviewApi['fromJSON']>[0])
          bumpPaneSeq(api.panels.map((p) => p.id))
          restored = true
        } catch {
          restored = false
        }
      }
      if (!restored) buildDefault(api)
      setEmpty(api.panels.length === 0)

      if (workspace === useSession.getState().activeWorkspace) setActiveApi(api)

      // Kill a terminal's PTY session only when its panel is actually removed
      // (user close) — NOT on renderer reload, so sessions survive ⌘R.
      api.onDidRemovePanel((panel) => {
        if (panel.id.startsWith('term-')) window.api.pty.kill(panel.id)
      })

      // Persist layout changes (debounced), after initial build.
      api.onDidLayoutChange(() => {
        setEmpty(api.panels.length === 0)
        if (saveTimer.current) clearTimeout(saveTimer.current)
        saveTimer.current = setTimeout(() => patch(workspace, { dockLayout: api.toJSON() }), 500)
      })
    },
    [workspace, buildDefault, patch]
  )

  // Point the registry at the active workspace's api. dockview relayouts itself
  // via its container ResizeObserver when this workspace becomes visible.
  useEffect(() => {
    if (workspace === activeWorkspace && apiRef.current) setActiveApi(apiRef.current)
  }, [activeWorkspace, workspace])

  // On real workspace close, dockview disposes WITHOUT firing onDidRemovePanel,
  // so the per-panel PTY kill above never runs and shells/agents orphan. Kill
  // this workspace's PTYs on unmount — but only when the workspace is genuinely
  // gone (closeWorkspace removed it from openWorkspaces before this unmount);
  // skip StrictMode/HMR transient remounts, which keep it open, so ⌘R still
  // preserves sessions.
  useEffect(() => {
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current)
      if (useSession.getState().openWorkspaces.includes(workspace)) return
      const api = apiRef.current
      if (!api) return
      for (const p of api.panels) {
        if (p.id.startsWith('term-')) window.api.pty.kill(p.id)
      }
    }
  }, [workspace])

  return (
    <div className="workbench-wrap">
      <DockviewReact
        className="workbench"
        theme={themeAbyss}
        defaultRenderer="always"
        defaultTabComponent={RivenTab}
        components={components}
        onReady={onReady}
      />
      {empty && (
        <div className="dock-empty">
          <div className="dock-empty-inner">
            <div className="dock-empty-mark">riven</div>
            <div className="dock-empty-tag">{t('empty.tagline')}</div>
            <div className="dock-empty-actions">
              <button className="dock-empty-btn primary" onClick={() => addTerminal()}>
                <SquareTerminal size={15} /> {t('empty.addTerminal')}
              </button>
              <button className="dock-empty-btn" onClick={() => togglePanel('editor')}>
                <FileCode size={15} /> {t('empty.addEditor')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
