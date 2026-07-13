import { useEffect, useRef, useState } from 'react'
import MonacoEditorPane from '../../editor/MonacoEditorPane'
import type { EditorPaneComponent, OpenFile } from '../../editor/EditorPane'
import { closeDocument } from '../../lsp/client'
import { setEditorCloser } from '../../keybindings/focus'
import { useSession } from '../../state/session'
import { useAgentEdits, cacheSet } from '../../state/agentEdits'
import DiffModal from '../../components/DiffModal'

const EditorPane: EditorPaneComponent = MonacoEditorPane

export default function EditorPanel({ workspace }: { workspace: string }): JSX.Element {
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

  const [file, setFile] = useState<OpenFile | null>(null)
  const [dirty, setDirty] = useState(false)
  const [showDiff, setShowDiff] = useState(false)
  const revisions = useRef(new Map<string, number>())

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
      !window.confirm('저장하지 않은 변경이 있어. 그래도 닫을까?')
    ) {
      return
    }
    closeTabAction(path)
    closeDocument(path)
  }
  const closeTabRef = useRef(closeTab)
  closeTabRef.current = closeTab

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
  const showAgentBar = !!agentEdit && !dirty

  return (
    <div className="editor-panel">
      {openTabs.length > 0 && (
        <div className="file-tabs">
          {openTabs.map((p) => (
            <div
              key={p}
              className={`file-tab${p === activePath ? ' active' : ''}`}
              onClick={() => openFile(p)}
              title={p}
            >
              <span className="file-tab-name">
                {p in editsMap && <span className="tab-edit-dot">●</span>}
                {p.split('/').pop()}
                {p === activePath && dirty ? ' •' : ''}
              </span>
              <span
                className="file-tab-close"
                onClick={(e) => {
                  e.stopPropagation()
                  closeTab(p)
                }}
              >
                ✕
              </span>
            </div>
          ))}
        </div>
      )}

      {showConflict && (
        <div className="ext-banner">
          🤖 에이전트가 수정함 · 저장 안 한 변경과 충돌
          <button className="btn-small" onClick={reloadFromDisk}>
            디스크 버전 불러오기
          </button>
        </div>
      )}
      {showAgentBar && (
        <div className="agent-banner">
          <span>🤖 에이전트가 이 파일을 수정함{agentEdit?.hasBaseline ? '' : ' (전체)'}</span>
          <span className="agent-banner-actions">
            {agentEdit?.hasBaseline && (
              <button className="btn-small" onClick={() => setShowDiff(true)}>
                비교
              </button>
            )}
            <button className="btn-small" onClick={revertAgentEdit}>
              되돌리기
            </button>
            <button className="btn-small" onClick={() => activePath && clearEdit(activePath)}>
              ✕
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
      />

      {showDiff && agentEdit && activePath && (
        <DiffModal
          path={activePath}
          original={agentEdit.before}
          modified={agentEdit.after}
          onClose={() => setShowDiff(false)}
        />
      )}
    </div>
  )
}
