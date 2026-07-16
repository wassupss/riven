import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import MonacoEditorPane from '../../editor/MonacoEditorPane'
import type { EditorPaneComponent, OpenFile } from '../../editor/EditorPane'
import { closeDocument } from '../../lsp/client'
import { setEditorCloser } from '../../keybindings/focus'
import { useSession } from '../../state/session'
import { useExplorerReveal } from '../../state/explorerReveal'
import { useAgentEdits, cacheSet } from '../../state/agentEdits'
import DiffModal from '../../components/DiffModal'
import { useT, t as staticT } from '../../i18n'
import { X, Bot } from 'lucide-react'

const EditorPane: EditorPaneComponent = MonacoEditorPane

export default function EditorPanel({ workspace }: { workspace: string }): JSX.Element {
  const t = useT()
  const activeWorkspace = useSession((s) => s.activeWorkspace)
  const session = useSession((s) => s.sessions[workspace])
  const openFile = useSession((s) => s.openFile)
  const closeTabAction = useSession((s) => s.closeTab)

  const openTabs = session?.openTabs ?? []
  const activePath = session?.activePath ?? null

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
    if (!isActiveWs) return
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

  return (
    <div className="editor-panel">
      {openTabs.length > 0 && (
        <div className="file-tabs" ref={fileTabsRef}>
          {openTabs.map((p) => (
            <div
              key={p}
              ref={p === activePath ? activeTabRef : undefined}
              className={`file-tab${p === activePath ? ' active' : ''}`}
              onClick={() => openFile(p)}
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
