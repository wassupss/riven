import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { DockviewReact, type DockviewReadyEvent, type IDockviewPanelProps } from 'dockview-react'
import { themeAbyss, type DockviewApi } from 'dockview-core'
import 'dockview-core/dist/styles/dockview.css'
import EditorPanel from './panels/EditorPanel'
import PreviewPanel from './panels/PreviewPanel'
import AgentGroupPanel from './panels/AgentGroupPanel'
import SearchPanel from './panels/SearchPanel'
import GitPanel from './panels/GitPanel'
import ChangesPanel from './panels/ChangesPanel'
import NotesPanel from './panels/NotesPanel'
import ApiClientPanel from './panels/ApiClientPanel'
import ChatPanel from './panels/ChatPanel'
import LauncherPanel from './panels/LauncherPanel'
import TerminalPanel, { type TerminalParams } from './panels/TerminalPanel'
import RivenTab from './RivenTab'
import ErrorBoundary from '../components/ErrorBoundary'
import { useSession, flushSessionSaveSync, clearPaneState } from '../state/session'
import {
  setActiveApi,
  getActiveApi,
  registerApiWorkspace,
  unregisterApiWorkspace,
  nextPaneId,
  bumpPaneSeq
} from './registry'
import { useT } from '../i18n'

type SavedLayout = Parameters<DockviewApi['fromJSON']>[0]

// Drop only the panels whose component is no longer known (e.g. an old in-dock
// 'explorer', or a chat/team panel not yet ported) and keep the rest of the
// layout, mirroring native's per-node skip (Dock.swift buildNode). Returns the
// pruned layout, or null when nothing survives. All-or-nothing wipe was the
// cause of "one unknown panel loses the whole workspace layout".
function pruneUnknownComponents(
  saved: SavedLayout,
  known: Set<string>
): { layout: SavedLayout | null; removed: string[] } {
  // Deep clone so we never mutate the persisted store object.
  const layout = structuredClone(saved) as {
    panels?: Record<string, { contentComponent?: string }>
    grid?: { root?: GridNode }
    activeGroup?: string
    floatingGroups?: Array<{ data?: LeafData }>
    popoutGroups?: unknown[]
  }
  type LeafData = { views?: string[]; activeView?: string; id?: string }
  type GridNode = { type: 'branch' | 'leaf'; data: GridNode[] | LeafData; size?: number }

  const panels = layout.panels ?? {}
  const dead = new Set(
    Object.keys(panels).filter((id) => !known.has(panels[id]?.contentComponent ?? ''))
  )
  if (dead.size === 0) return { layout: saved, removed: [] }
  for (const id of dead) delete panels[id]

  const walk = (node: GridNode | undefined): GridNode | null => {
    if (!node) return null
    if (node.type === 'leaf') {
      const d = node.data as LeafData
      d.views = (d.views ?? []).filter((v) => !dead.has(v))
      if (d.activeView && dead.has(d.activeView)) d.activeView = d.views[0]
      return d.views.length ? node : null
    }
    const children = (node.data as GridNode[]).map(walk).filter(Boolean) as GridNode[]
    if (children.length === 0) return null
    node.data = children
    return node
  }

  const root = walk(layout.grid?.root)
  if (!root) return { layout: null, removed: [...dead] }
  if (layout.grid) layout.grid.root = root

  // Drop floating groups that lost all their panels; popout groups aren't
  // reliably restorable, so drop any that referenced a dead panel outright.
  if (Array.isArray(layout.floatingGroups)) {
    layout.floatingGroups = layout.floatingGroups.filter((g) => {
      const d = g?.data as LeafData | undefined
      if (!d) return false
      d.views = (d.views ?? []).filter((v) => !dead.has(v))
      if (d.activeView && dead.has(d.activeView)) d.activeView = d.views[0]
      return d.views.length > 0
    })
  }
  return { layout: layout as SavedLayout, removed: [...dead] }
}

export default function Workbench({ workspace }: { workspace: string }): JSX.Element {
  const t = useT()
  const apiRef = useRef<DockviewApi | null>(null)
  const activeWorkspace = useSession((s) => s.activeWorkspace)
  const patch = useSession((s) => s.patch)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Last persisted panel count — a change means a structural edit (open/close),
  // which we persist immediately instead of debouncing (see onDidLayoutChange).
  const lastPanelCount = useRef(-1)
  // Becomes true once onReady has restored (or defaulted) this workspace's layout.
  // Before that a 0-panel report is a transient mount artifact and must NOT persist;
  // after it, 0 panels means the user genuinely closed everything and we DO persist.
  const restoredRef = useRef(false)
  const disposers = useRef<Array<{ dispose: () => void }>>([])
  const [empty, setEmpty] = useState(false)

  const components = useMemo(() => {
    // Wrap every panel in its own ErrorBoundary so a single panel's render/mount
    // crash shows an inline error INSTEAD of blanking the whole workspace dock.
    const boxed = (label: string, node: JSX.Element): JSX.Element => (
      <ErrorBoundary label={label}>{node}</ErrorBoundary>
    )
    return {
      editor: () => boxed('editor', <EditorPanel workspace={workspace} />),
      preview: (props: IDockviewPanelProps) =>
        boxed('preview', <PreviewPanel workspace={workspace} api={props.api} />),
      search: () => boxed('search', <SearchPanel workspace={workspace} />),
      git: () => boxed('git', <GitPanel workspace={workspace} />),
      changes: () => boxed('changes', <ChangesPanel />),
      notes: () => boxed('notes', <NotesPanel workspace={workspace} />),
      api: () => boxed('api', <ApiClientPanel />),
      agentgroup: () => boxed('agentgroup', <AgentGroupPanel workspace={workspace} />),
      chat: (
        props: IDockviewPanelProps<{
          chatKey: string
          pinnedTitle?: string
          agent?: string
        }>
      ) =>
        boxed(
          'chat',
          <ChatPanel
            workspace={workspace}
            chatKey={props.params.chatKey}
            pinnedTitle={props.params.pinnedTitle}
            agent={props.params.agent}
            setTitle={(title) => props.api.setTitle(title)}
            api={props.api}
          />
        ),
      terminal: (props: IDockviewPanelProps<TerminalParams>) =>
        boxed('terminal', <TerminalPanel workspace={workspace} params={props.params} api={props.api} />),
      launcher: (props: IDockviewPanelProps) =>
        boxed('launcher', <LauncherPanel workspace={workspace} api={props.api} />)
    }
  }, [workspace])

  const buildDefault = useCallback((api: DockviewApi) => {
    // A new/empty workspace opens a launcher (pick the first panel) instead of
    // defaulting to a terminal — the user chooses what goes here.
    api.addPanel({
      id: `launcher-${nextPaneId()}`,
      component: 'launcher',
      title: t('title.launcher'),
      renderer: 'always'
    })
  }, [t])

  const onReady = useCallback(
    (event: DockviewReadyEvent) => {
      const api = event.api
      apiRef.current = api
      registerApiWorkspace(api, workspace) // so tab headers can resolve their workspace
      // onReady fires once per dockview INSTANCE. Refs survive a StrictMode
      // remount (and a renderer reload remounts too), so a stale `restoredRef`
      // from the previous instance made tryRestore() bail out — the new dock never
      // got fromJSON and every panel vanished on ⌘R. Reset it per instance.
      restoredRef.current = false

      // KNOWN is derived from the live component registry so it can never drift
      // out of sync (the old hardcoded list omitted 'git'/'changes', wiping any
      // layout that contained them). Unknown panels are pruned per-node instead
      // of discarding the whole layout.
      const KNOWN = new Set(Object.keys(components))
      const restore = (): void => {
        const saved = useSession.getState().sessions[workspace]?.dockLayout
        let restored = false
        if (saved) {
          const { layout } = pruneUnknownComponents(saved as SavedLayout, KNOWN)
          if (layout) {
            try {
              api.fromJSON(layout)
              bumpPaneSeq(api.panels.map((p) => p.id))
              restored = api.panels.length > 0
            } catch {
              restored = false
            }
          }
        }
        if (!restored) buildDefault(api)
        setEmpty(api.panels.length === 0)
        restoredRef.current = true
      }
      // Restore ONLY once the dock has a real size. On a cold start the dockview's
      // onReady can fire before the flex layout has sized its container (0×0);
      // fromJSON into a 0×0 dock mangles group positions — panels pile at the top
      // and become unusable. Wait for a non-zero size (retry a few frames, then
      // restore anyway as a backstop).
      let tries = 0
      const tryRestore = (): void => {
        if (restoredRef.current) return
        if ((api.width > 0 && api.height > 0) || tries++ >= 30) restore()
        else requestAnimationFrame(tryRestore)
      }
      tryRestore()

      if (workspace === useSession.getState().activeWorkspace) setActiveApi(api)

      // Kill a terminal's PTY session only when its panel is actually removed
      // (user close) — NOT on renderer reload, so sessions survive ⌘R.
      disposers.current.push(
        api.onDidRemovePanel((panel) => {
          if (panel.id.startsWith('term-')) window.api.pty.kill(panel.id)
          else if (panel.id.startsWith('chat-')) {
            window.api.chat.stop(panel.id)
            clearPaneState(workspace, panel.id)
          }
          // A pure close does NOT reliably fire onDidLayoutChange in dockview, so the
          // debounced/structural save below can miss it and the closed panel revives
          // on restart (this is the "agent group comes back" bug). Persist the post-
          // removal layout here too — null when the last panel is gone. Guard on
          // restore + active workspace so teardown/switch transients can't clobber.
          if (workspace === useSession.getState().activeWorkspace && restoredRef.current) {
            // Exclude the just-removed panel in case dockview hasn't pruned api.panels
            // yet, so closing the LAST panel is correctly detected as empty.
            const remaining = api.panels.filter((p) => p.id !== panel.id).length
            lastPanelCount.current = remaining
            // NEVER persist an empty layout. A renderer reload (⌘R) tears the dock
            // down panel-by-panel, and saving the 0-panel state on the last removal
            // wiped the workspace's layout. An intentionally emptied dock re-opens
            // the launcher anyway, so "empty" is never a state worth storing.
            if (remaining > 0) {
              patch(workspace, { dockLayout: api.toJSON() })
              flushSessionSaveSync()
            }
          }
        })
      )

      // Persist layout changes. Cosmetic changes (resize/move) are debounced;
      // STRUCTURAL changes (a panel opened/closed) persist immediately, so a hard
      // renderer reload right after a close can't resurrect the just-closed panel
      // (a debounced save would be dropped by the reload before it fired).
      disposers.current.push(
        api.onDidLayoutChange(() => {
          setEmpty(api.panels.length === 0)
          // Closing the last panel drops back to the launcher (same UI as adding a
          // panel), instead of a separate empty-state screen.
          if (api.panels.length === 0 && restoredRef.current) buildDefault(api)
          const save = (): void => {
            // Only the active (visible) workspace persists its layout. A hidden
            // dockview can momentarily report a degenerate/empty layout; saving it
            // would clobber the good one (this lost terminals on restart).
            if (workspace !== useSession.getState().activeWorkspace) return
            // A 0-panel layout is only real once we've restored; before that it's a
            // transient mount artifact. After restore, an empty layout means the
            // user closed everything and MUST persist (else the old panels revive).
            if (api.panels.length === 0) return // never store an empty dock (see above)
            patch(workspace, { dockLayout: api.toJSON() })
          }
          const count = api.panels.length
          const structural = count !== lastPanelCount.current
          lastPanelCount.current = count
          if (saveTimer.current) clearTimeout(saveTimer.current)
          if (structural) {
            saveTimer.current = null
            save()
            // A panel opened/closed: force the snapshot to disk NOW so the change
            // survives even if the app quits before the debounced write fires
            // (this is why closed agent-group panes were coming back on restart).
            // Also flush an empty layout — closing the LAST panel must be durable.
            if (workspace === useSession.getState().activeWorkspace && restoredRef.current)
              flushSessionSaveSync()
          } else {
            saveTimer.current = setTimeout(save, 500)
          }
        })
      )
    },
    [workspace, buildDefault, patch, components]
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
      // FLUSH (not cancel) a pending debounced layout save before teardown. A
      // panel close/move made in the last 500ms would otherwise be lost when an
      // HMR reload / StrictMode remount cancels the timer, and the just-closed
      // panel would reappear on restore. Only persist a still-open, active,
      // non-empty workspace's layout (same guards as the debounced save).
      unregisterApiWorkspace(workspace)
      if (saveTimer.current) {
        clearTimeout(saveTimer.current)
        saveTimer.current = null
        const cur = apiRef.current
        if (
          cur &&
          useSession.getState().openWorkspaces.includes(workspace) &&
          workspace === useSession.getState().activeWorkspace &&
          cur.panels.length > 0
        ) {
          try {
            patch(workspace, { dockLayout: cur.toJSON() })
          } catch {
            /* api may already be tearing down */
          }
        }
      }
      // Always drop our dockview listeners so a disposed api can never receive a
      // late layout-change and call patch() on a stale workspace.
      for (const d of disposers.current) d.dispose()
      disposers.current = []
      if (useSession.getState().openWorkspaces.includes(workspace)) return
      const api = apiRef.current
      if (!api) return
      // This dockview is about to be disposed. If the registry still points at
      // it, clear it so global actions (⌘T / toolbar "new terminal") can't call
      // into a disposed api and throw once the last workspace is closed.
      if (getActiveApi() === api) setActiveApi(null)
      for (const p of api.panels) {
        if (p.id.startsWith('term-')) window.api.pty.kill(p.id)
        else if (p.id.startsWith('chat-')) window.api.chat.stop(p.id)
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
      {/* No bespoke empty state: closing every panel re-opens the launcher, so the
          "nothing open" screen is exactly the same picker as adding a new panel. */}
    </div>
  )
}
