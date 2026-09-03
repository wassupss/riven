import { Fragment, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels'
import MonacoEditorPane from '../../editor/MonacoEditorPane'
import type { EditorPaneComponent, OpenFile } from '../../editor/EditorPane'
import { closeDocument } from '../../lsp/client'
import { setEditorCloser } from '../../keybindings/focus'
import { useSession } from '../../state/session'
import { useEditorSplit, type Edge, type SplitNode } from '../../state/editorSplit'
import { openEditorSplit } from '../registry'
import { useExplorerReveal } from '../../state/explorerReveal'
import { useAgentEdits, cacheSet } from '../../state/agentEdits'
import { useEditorBottom } from '../../state/editorBottomPanel'
import EditorBottomDrawer from './EditorBottomDrawer'
import EditorStatusBar from './EditorStatusBar'
import DiffModal from '../../components/DiffModal'
import { useT, t as staticT } from '../../i18n'
import { X, Bot } from 'lucide-react'
import '../../styles/editor-bottom.css'

const EditorPane: EditorPaneComponent = MonacoEditorPane

const PRIMARY = 'editor'

// One editor group (its own tab strip + Monaco). The primary group (`editor`) is
// backed by the workspace session; every split group by the editorSplit store.
// Groups can be freely split in any direction by dragging a tab onto an edge.
function EditorGroupView({
  workspace,
  groupId
}: {
  workspace: string
  groupId: string
}): JSX.Element {
  const t = useT()
  const isSplit = groupId !== PRIMARY
  const activeWorkspace = useSession((s) => s.activeWorkspace)
  const session = useSession((s) => s.sessions[workspace])
  const groupData = useEditorSplit((s) => s.byWs[workspace]?.groups[groupId])
  const activeGroup = useEditorSplit((s) => s.byWs[workspace]?.activeGroup ?? PRIMARY)
  const drag = useEditorSplit((s) => s.drag)
  const sessOpenFile = useSession((s) => s.openFile)
  const sessClose = useSession((s) => s.closeTab)
  const sessReorder = useSession((s) => s.reorderTabs)

  // The split groups keep their own tab set; the primary uses the session.
  const openTabs = (isSplit ? groupData?.openTabs : session?.openTabs) ?? []
  const activePath = (isSplit ? groupData?.activePath : session?.activePath) ?? null
  const openFile = isSplit
    ? (p: string) => useEditorSplit.getState().openInGroup(workspace, groupId, p)
    : sessOpenFile
  const closeTabAction = isSplit
    ? (p: string) => useEditorSplit.getState().closeInGroup(workspace, groupId, p)
    : sessClose
  const reorderTabs = isSplit
    ? (a: number, b: number) => useEditorSplit.getState().reorderInGroup(workspace, groupId, a, b)
    : sessReorder

  // Receive a tab dragged from another group onto THIS group's tab strip.
  const receiveTab = (path: string, sourceGroup: string): void => {
    if (sourceGroup === groupId) return
    if (!isSplit) sessOpenFile(path)
    useEditorSplit.getState().moveTab(workspace, sourceGroup, groupId, path)
    if (sourceGroup === PRIMARY) sessClose(path)
  }
  // Split THIS group by dropping the dragged tab onto one of its four edges.
  const splitEdge = (edge: Edge): void => {
    const d = useEditorSplit.getState().drag
    if (!d) return
    useEditorSplit.getState().splitWith(workspace, groupId, edge, d.group, d.path)
    if (d.group === PRIMARY) sessClose(d.path)
    useEditorSplit.getState().setDrag(null)
  }

  const agentEdit = useAgentEdits((s) => (activePath ? s.edits[activePath] : undefined))
  const editsMap = useAgentEdits((s) => s.edits)
  const clearEdit = useAgentEdits((s) => s.clear)
  const setEdit = useAgentEdits((s) => s.set)
  const appliedAgentAfter = useRef<string | null>(null)

  const revealInExplorer = useExplorerReveal((s) => s.reveal)
  const [file, setFile] = useState<OpenFile | null>(null)
  const [dirty, setDirty] = useState(false)
  const [showDiff, setShowDiff] = useState(false)
  const [tabMenu, setTabMenu] = useState<{ x: number; y: number; path: string } | null>(null)
  const [dragTab, setDragTab] = useState<number | null>(null)
  const [overTab, setOverTab] = useState<number | null>(null)
  const revisions = useRef(new Map<string, number>())
  const fileTabsRef = useRef<HTMLDivElement>(null)
  const activeTabRef = useRef<HTMLDivElement>(null)

  // Scroll the open file's tab into view when it changes.
  useEffect(() => {
    activeTabRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [activePath])

  const isActiveWs = workspace === activeWorkspace
  const stateRef = useRef({ activePath, dirty, isActiveWs })
  stateRef.current = { activePath, dirty, isActiveWs }

  // Load the active file.
  useEffect(() => {
    let cancelled = false
    appliedAgentAfter.current = null
    if (activePath) {
      window.api.workspace.readFile(activePath).then((content) => {
        if (!cancelled) {
          cacheSet(activePath, content)
          setFile({ path: activePath, content, revision: revisions.current.get(activePath) ?? 0 })
        }
      })
    } else {
      setFile(null)
    }
    return () => {
      cancelled = true
    }
  }, [activePath])

  // Force the editor to show the agent's version (bump revision) whenever the
  // reviewed edit's `after` changes — guarantees decorations align with content.
  useEffect(() => {
    if (!activePath || !agentEdit || dirty) return
    if (appliedAgentAfter.current === agentEdit.after) return
    appliedAgentAfter.current = agentEdit.after
    const rev = (revisions.current.get(activePath) ?? 0) + 1
    revisions.current.set(activePath, rev)
    setFile({ path: activePath, content: agentEdit.after, revision: rev })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentEdit, activePath, dirty])

  // Revert a single hunk (host writes the new content + updates review state).
  const onAgentRevert = async (newAfter: string): Promise<void> => {
    if (!activePath || !agentEdit) return
    appliedAgentAfter.current = newAfter
    cacheSet(activePath, newAfter)
    await window.api.workspace.writeFile(activePath, newAfter)
    const rev = (revisions.current.get(activePath) ?? 0) + 1
    revisions.current.set(activePath, rev)
    setFile({ path: activePath, content: newAfter, revision: rev })
    if (newAfter === agentEdit.before) clearEdit(activePath)
    else setEdit(activePath, { before: agentEdit.before, after: newAfter, hasBaseline: true })
  }

  const reloadFromDisk = async (): Promise<void> => {
    if (!activePath) return
    const disk = await window.api.workspace.readFile(activePath)
    cacheSet(activePath, disk)
    const rev = (revisions.current.get(activePath) ?? 0) + 1
    revisions.current.set(activePath, rev)
    setFile({ path: activePath, content: disk, revision: rev })
    clearEdit(activePath)
  }

  const handleSave = async (path: string, content: string): Promise<void> => {
    await window.api.workspace.writeFile(path, content)
    cacheSet(path, content)
    clearEdit(path)
    setFile({ path, content, revision: revisions.current.get(path) ?? 0 })
  }

  // The Changes panel can revert a file that's open here; reload from disk when
  // it bumps this path's reload nonce (only for the SAME path, not on tab switch).
  const reloadNonce = useAgentEdits((s) => (activePath ? (s.reloadNonce[activePath] ?? 0) : 0))
  const lastReload = useRef<{ path: string | null; nonce: number }>({ path: null, nonce: 0 })
  useEffect(() => {
    const prev = lastReload.current
    lastReload.current = { path: activePath, nonce: reloadNonce }
    if (activePath && prev.path === activePath && reloadNonce > prev.nonce) reloadFromDisk()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadNonce, activePath])

  const revertAgentEdit = async (): Promise<void> => {
    if (!activePath || !agentEdit) return
    const before = agentEdit.before
    cacheSet(activePath, before)
    await window.api.workspace.writeFile(activePath, before)
    const rev = (revisions.current.get(activePath) ?? 0) + 1
    revisions.current.set(activePath, rev)
    setFile({ path: activePath, content: before, revision: rev })
    clearEdit(activePath)
  }

  const closeTab = (path: string): void => {
    if (
      path === activePath &&
      dirty &&
      !window.confirm(staticT('editor.unsavedConfirm'))
    ) {
      return
    }
    closeTabAction(path)
    closeDocument(path)
  }
  const closeTabRef = useRef(closeTab)
  closeTabRef.current = closeTab

  // Bulk close (others / to the right / all). Prompts once if the dirty active
  // file is in the set.
  const closeMany = (paths: string[]): void => {
    if (
      activePath &&
      dirty &&
      paths.includes(activePath) &&
      !window.confirm(staticT('editor.unsavedConfirm'))
    ) {
      return
    }
    for (const p of paths) {
      closeTabAction(p)
      closeDocument(p)
    }
  }

  const openTabMenu = (e: React.MouseEvent, path: string): void => {
    e.preventDefault()
    setTabMenu({
      x: Math.min(e.clientX, window.innerWidth - 210),
      y: Math.min(e.clientY, window.innerHeight - 250),
      path
    })
  }

  useEffect(() => {
    if (!isActiveWs || isSplit) return
    setEditorCloser(() => {
      const s = stateRef.current
      if (!s.activePath) return false
      closeTabRef.current(s.activePath)
      return true
    })
  }, [isActiveWs])

  const showConflict = !!agentEdit && dirty
  // With a baseline we show inline hunks (nav + hover) instead of a banner; the
  // banner remains only as a fallback for whole-file edits with no baseline.
  const showAgentBar = !!agentEdit && !dirty && !agentEdit.hasBaseline

  const isActiveGroup = isSplit ? activeGroup === groupId : activeGroup === PRIMARY
  const focus = (): void => useEditorSplit.getState().focusGroup(workspace, groupId)

  return (
    <div
      className={`editor-panel${isActiveGroup ? ' group-active' : ''}`}
      onMouseDown={focus}
    >
      {openTabs.length > 0 && (
        <div
          className="file-tabs"
          ref={fileTabsRef}
          onDragOver={(e) => {
            // Accept a tab dragged from ANOTHER group onto this strip.
            if (drag && drag.group !== groupId) e.preventDefault()
          }}
          onDrop={(e) => {
            if (drag && drag.group !== groupId) {
              e.preventDefault()
              receiveTab(drag.path, drag.group)
              useEditorSplit.getState().setDrag(null)
            }
          }}
        >
          {openTabs.map((p, i) => (
            <div
              key={p}
              ref={p === activePath ? activeTabRef : undefined}
              className={`file-tab${p === activePath ? ' active' : ''}${overTab === i && dragTab !== null && dragTab !== i ? ' drag-over' : ''}`}
              draggable
              onDragStart={() => {
                setDragTab(i)
                useEditorSplit.getState().setDrag({ ws: workspace, group: groupId, path: p })
              }}
              onDragOver={(e) => {
                e.preventDefault()
                if (overTab !== i) setOverTab(i)
              }}
              onDrop={(e) => {
                e.preventDefault()
                // Cross-group drop: move the tab here. Same-group: reorder.
                if (drag && drag.group !== groupId) receiveTab(drag.path, drag.group)
                else if (dragTab !== null && dragTab !== i) reorderTabs(dragTab, i)
                setDragTab(null)
                setOverTab(null)
                useEditorSplit.getState().setDrag(null)
              }}
              onDragEnd={() => {
                setDragTab(null)
                setOverTab(null)
                useEditorSplit.getState().setDrag(null)
              }}
              onClick={() => {
                focus()
                openFile(p)
              }}
              onContextMenu={(e) => openTabMenu(e, p)}
              title={p}
            >
              <span className="file-tab-name">
                {p in editsMap && <span className="tab-edit-dot">●</span>}
                {p.split('/').pop()}
                {p === activePath && dirty && <span className="tab-dirty-dot">●</span>}
              </span>
              <span
                className="file-tab-close"
                onClick={(e) => {
                  e.stopPropagation()
                  closeTab(p)
                }}
              >
                <X size={12} />
              </span>
            </div>
          ))}
        </div>
      )}

      {showConflict && (
        <div className="ext-banner">
          <span className="banner-label">
            <Bot size={14} /> {t('editor.conflictBanner')}
          </span>
          <span className="agent-banner-actions">
            <button className="btn-small" onClick={reloadFromDisk}>
              {t('editor.loadDisk')}
            </button>
            <button
              className="btn-small"
              title={t('common.close')}
              onClick={() => activePath && clearEdit(activePath)}
            >
              <X size={12} />
            </button>
          </span>
        </div>
      )}
      {showAgentBar && (
        <div className="agent-banner">
          <span className="banner-label">
            <Bot size={14} /> {t('editor.agentEditedFull')}
          </span>
          <span className="agent-banner-actions">
            <button className="btn-small" onClick={revertAgentEdit}>
              {t('editor.revert')}
            </button>
            <button className="btn-small" onClick={() => activePath && clearEdit(activePath)}>
              <X size={12} />
            </button>
          </span>
        </div>
      )}

      <EditorPane
        file={file}
        onSave={handleSave}
        onDirtyChange={setDirty}
        agentEdit={
          agentEdit && agentEdit.hasBaseline && !dirty
            ? { before: agentEdit.before, after: agentEdit.after }
            : null
        }
        onAgentRevert={onAgentRevert}
        onDismiss={() => activePath && clearEdit(activePath)}
      />

      {/* Edge drop-zones: drag a file tab (from this or any group) onto an edge
          to split THIS group in that direction. Shown only while dragging. */}
      {drag && (
        <div className="editor-drop-edges">
          {(['left', 'right', 'top', 'bottom'] as const).map((edge) => (
            <div
              key={edge}
              className={`editor-drop-edge ${edge}`}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault()
                splitEdge(edge)
              }}
            />
          ))}
        </div>
      )}

      {showDiff && agentEdit && activePath && (
        <DiffModal
          path={activePath}
          original={agentEdit.before}
          modified={agentEdit.after}
          onClose={() => setShowDiff(false)}
        />
      )}

      {tabMenu &&
        createPortal(
          <div
            className="ctx-backdrop"
            onClick={() => setTabMenu(null)}
            onContextMenu={(e) => {
              e.preventDefault()
              setTabMenu(null)
            }}
          >
          <div
            className="ctx-menu"
            style={{ left: tabMenu.x, top: tabMenu.y }}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className="ctx-item"
              onClick={() => {
                closeTab(tabMenu.path)
                setTabMenu(null)
              }}
            >
              {t('tab.close')}
            </button>
            <button
              className="ctx-item"
              disabled={openTabs.length < 2}
              onClick={() => {
                closeMany(openTabs.filter((x) => x !== tabMenu.path))
                setTabMenu(null)
              }}
            >
              {t('tab.closeOthers')}
            </button>
            <button
              className="ctx-item"
              disabled={openTabs.indexOf(tabMenu.path) >= openTabs.length - 1}
              onClick={() => {
                closeMany(openTabs.slice(openTabs.indexOf(tabMenu.path) + 1))
                setTabMenu(null)
              }}
            >
              {t('tab.closeRight')}
            </button>
            <button
              className="ctx-item"
              onClick={() => {
                closeMany([...openTabs])
                setTabMenu(null)
              }}
            >
              {t('tab.closeAll')}
            </button>
            <div className="ctx-sep" />
            {!isSplit && (
              <button
                className="ctx-item"
                onClick={() => {
                  openEditorSplit(tabMenu.path)
                  setTabMenu(null)
                }}
              >
                {t('tab.splitEditor')}
              </button>
            )}
            <button
              className="ctx-item"
              onClick={() => {
                navigator.clipboard.writeText(tabMenu.path)
                setTabMenu(null)
              }}
            >
              {t('tab.copyPath')}
            </button>
            <button
              className="ctx-item"
              onClick={() => {
                revealInExplorer(tabMenu.path)
                setTabMenu(null)
              }}
            >
              {t('tab.revealExplorer')}
            </button>
          </div>
        </div>,
          document.body
        )}
    </div>
  )
}

// A stable React key for a subtree (group ids are unique across the layout).
function nodeKey(n: SplitNode): string {
  return n.type === 'leaf' ? n.group : `b:${n.children.map(nodeKey).join(',')}`
}

// Render the split tree recursively: leaves are editor groups, branches are
// nested resizable row/column PanelGroups. Any depth, any direction.
function SplitTree({ ws, node }: { ws: string; node: SplitNode }): JSX.Element {
  if (node.type === 'leaf') return <EditorGroupView workspace={ws} groupId={node.group} />
  const horizontal = node.dir === 'row'
  return (
    <PanelGroup direction={horizontal ? 'horizontal' : 'vertical'} className="editor-split">
      {node.children.map((c, i) => (
        <Fragment key={nodeKey(c)}>
          {i > 0 && (
            <PanelResizeHandle className={horizontal ? 'resize-handle-v' : 'resize-handle-h'} />
          )}
          <Panel defaultSize={node.sizes[i] ?? 100 / node.children.length} minSize={12}>
            <SplitTree ws={ws} node={c} />
          </Panel>
        </Fragment>
      ))}
    </PanelGroup>
  )
}

// The editor panel: a free-form tree of editor groups you split by dragging a
// tab onto a group's edge (VS Code-style), nestable in any direction.
export default function EditorPanel({ workspace }: { workspace: string }): JSX.Element {
  const tree = useEditorSplit((s) => s.byWs[workspace]?.tree)
  const bottomOpen = useEditorBottom((s) => s.open)
  const editorArea =
    !tree || tree.type === 'leaf' ? (
      <EditorGroupView workspace={workspace} groupId={tree?.type === 'leaf' ? tree.group : 'editor'} />
    ) : (
      <SplitTree ws={workspace} node={tree} />
    )
  return (
    <div className="editor-shell">
      {bottomOpen ? (
        <PanelGroup direction="vertical" className="editor-shell-split" autoSaveId="riven:editor-bottom">
          <Panel minSize={15} className="editor-shell-main">
            {editorArea}
          </Panel>
          <PanelResizeHandle className="resize-handle-h" />
          <Panel defaultSize={32} minSize={10} className="editor-shell-drawer">
            <EditorBottomDrawer workspace={workspace} />
          </Panel>
        </PanelGroup>
      ) : (
        <div className="editor-shell-main">{editorArea}</div>
      )}
      <EditorStatusBar />
    </div>
  )
}
