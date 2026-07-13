import { useCallback, useEffect, useRef, useState } from 'react'
import { useSession } from '../../state/session'
import { useAgentEdits, cacheSet } from '../../state/agentEdits'
import { ensureEditor } from '../registry'

interface GitFile {
  path: string
  x: string
  y: string
  staged: boolean
  unstaged: boolean
  untracked: boolean
}
interface Status {
  branch: string | null
  isRepo: boolean
  files: GitFile[]
}

const STATUS_LABEL: Record<string, string> = {
  M: '수정',
  A: '추가',
  D: '삭제',
  R: '이름변경',
  '?': '미추적',
  C: '복사',
  U: '충돌'
}

export default function GitPanel({ workspace }: { workspace: string }): JSX.Element {
  const [status, setStatus] = useState<Status>({ branch: null, isRepo: true, files: [] })
  const [message, setMessage] = useState('')
  const [committing, setCommitting] = useState(false)
  const openFile = useSession((s) => s.openFile)
  const setEdit = useAgentEdits((s) => s.set)
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const refresh = useCallback(() => {
    window.api.git.status(workspace).then(setStatus)
  }, [workspace])

  useEffect(() => {
    refresh()
    return window.api.bridge.onFsChanged(() => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current)
      refreshTimer.current = setTimeout(refresh, 400)
    })
  }, [refresh])

  const openDiff = async (rel: string): Promise<void> => {
    const abs = `${workspace}/${rel}`
    openFile(abs)
    ensureEditor()
    const [before, after] = await Promise.all([
      window.api.git.showFile(workspace, rel),
      window.api.workspace.readFile(abs).catch(() => '')
    ])
    cacheSet(abs, after)
    if (before != null) setEdit(abs, { before, after, hasBaseline: true })
  }

  const stage = async (rel: string): Promise<void> => {
    await window.api.git.stage(workspace, rel)
    refresh()
  }
  const unstage = async (rel: string): Promise<void> => {
    await window.api.git.unstage(workspace, rel)
    refresh()
  }
  const stageAll = async (): Promise<void> => {
    await window.api.git.stageAll(workspace)
    refresh()
  }
  const commit = async (): Promise<void> => {
    if (!message.trim()) return
    setCommitting(true)
    const res = await window.api.git.commit(workspace, message.trim())
    setCommitting(false)
    if (res.ok) {
      setMessage('')
      refresh()
    } else {
      window.alert(`커밋 실패:\n${res.error ?? ''}`)
    }
  }

  const staged = status.files.filter((f) => f.staged)
  const changed = status.files.filter((f) => f.unstaged)

  if (!status.isRepo) {
    return <div className="git-panel empty-hint center">git 저장소가 아니야.</div>
  }

  const row = (f: GitFile, kind: 'staged' | 'changed'): JSX.Element => {
    const ch = kind === 'staged' ? f.x : f.y
    return (
      <div key={kind + f.path} className="git-row">
        <span className={`git-badge s-${ch === '?' ? 'U' : ch}`}>{STATUS_LABEL[ch] ?? ch}</span>
        <span className="git-file" title={f.path} onClick={() => openDiff(f.path)}>
          {f.path.split('/').pop()}
          <span className="git-dir">{f.path.includes('/') ? ' · ' + f.path.slice(0, f.path.lastIndexOf('/')) : ''}</span>
        </span>
        {kind === 'staged' ? (
          <button className="git-act" title="언스테이지" onClick={() => unstage(f.path)}>
            −
          </button>
        ) : (
          <button className="git-act" title="스테이지" onClick={() => stage(f.path)}>
            +
          </button>
        )}
      </div>
    )
  }

  return (
    <div className="git-panel">
      <div className="git-head">
        <span className="git-branch">⑂ {status.branch}</span>
        <button className="btn-small" title="새로고침" onClick={refresh}>
          ↻
        </button>
      </div>

      <div className="git-commit">
        <textarea
          className="git-msg"
          placeholder="커밋 메시지"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
        />
        <button className="btn-small primary" disabled={committing || !message.trim() || staged.length === 0} onClick={commit}>
          커밋 ({staged.length})
        </button>
      </div>

      <div className="git-scroll">
        {staged.length > 0 && (
          <>
            <div className="git-section">스테이지됨 ({staged.length})</div>
            {staged.map((f) => row(f, 'staged'))}
          </>
        )}
        <div className="git-section">
          변경됨 ({changed.length})
          {changed.length > 0 && (
            <button className="git-act" title="모두 스테이지" onClick={stageAll}>
              + 전체
            </button>
          )}
        </div>
        {changed.map((f) => row(f, 'changed'))}
        {staged.length === 0 && changed.length === 0 && (
          <div className="empty-hint">변경 사항 없음</div>
        )}
      </div>
    </div>
  )
}
