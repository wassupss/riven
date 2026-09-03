import { useCallback, useEffect, useRef, useState } from 'react'
import { useSession, pathOf } from '../../state/session'
import { useAgentEdits, cacheSet, cacheGet } from '../../state/agentEdits'
import { ensureEditor } from '../registry'
import { useT } from '../../i18n'
import GitGraphPanel from './GitGraphPanel'
import {
  GitBranch,
  RefreshCw,
  Plus,
  Minus,
  ArrowUp,
  ArrowDown,
  Trash2,
  DownloadCloud,
  Archive,
  ChevronDown,
  Check
} from 'lucide-react'

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
  ahead: number
  behind: number
  hasUpstream: boolean
  files: GitFile[]
}

export default function GitPanel({ workspace: wid }: { workspace: string }): JSX.Element {
  // Git operates on the real folder; several workspaces can share one path.
  const workspace = pathOf(wid)
  const t = useT()
  const statusLabel = (ch: string): string => t(`git.status.${ch === '?' ? 'Q' : ch}`, ch)
  const [status, setStatus] = useState<Status>({
    branch: null,
    isRepo: true,
    ahead: 0,
    behind: 0,
    hasUpstream: false,
    files: []
  })
  const [message, setMessage] = useState('')
  const [committing, setCommitting] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [tab, setTab] = useState<'changes' | 'graph'>('changes')
  const [branchMenu, setBranchMenu] = useState(false)
  const [branches, setBranches] = useState<Array<{ name: string; current: boolean }>>([])
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
    // Never overwrite a pending agent edit review with a transient git diff —
    // doing so would drop the agent's original `before` baseline and break its
    // revert. If an agent review is open for this file, leave it in place (the
    // user resolves it via the Changes panel first).
    const existing = useAgentEdits.getState().edits[abs]
    if (existing && existing.source !== 'git') return
    const [before, after] = await Promise.all([
      window.api.git.showFile(workspace, rel),
      window.api.workspace.readFile(abs).catch(() => '')
    ])
    // Only seed the diff baseline cache when there's no agent baseline yet, so a
    // git view can't repoint the "last known content" an agent edit diffs from.
    if (cacheGet(abs) == null) cacheSet(abs, after)
    if (before != null) setEdit(abs, { before, after, hasBaseline: true, source: 'git' })
  }

  const stage = async (rel: string): Promise<void> => {
    const r = await window.api.git.stage(workspace, rel)
    if (!r.ok) window.alert(r.error ?? 'git stage failed')
    refresh()
  }
  const unstage = async (rel: string): Promise<void> => {
    const r = await window.api.git.unstage(workspace, rel)
    if (!r.ok) window.alert(r.error ?? 'git unstage failed')
    refresh()
  }
  const stageAll = async (): Promise<void> => {
    const r = await window.api.git.stageAll(workspace)
    if (!r.ok) window.alert(r.error ?? 'git stage failed')
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
      window.alert(t('git.commitFailed', { err: res.error ?? '' }))
    }
  }

  const discard = async (f: GitFile): Promise<void> => {
    if (!window.confirm(t('git.discardConfirm', { name: f.path.split('/').pop() ?? f.path }))) return
    await window.api.git.discard(workspace, f.path, f.untracked)
    refresh()
  }
  const push = async (): Promise<void> => {
    setSyncing(true)
    const res = await window.api.git.push(workspace)
    setSyncing(false)
    if (!res.ok) window.alert(t('git.syncFailed', { err: res.error ?? '' }))
    refresh()
  }
  const pull = async (): Promise<void> => {
    setSyncing(true)
    const res = await window.api.git.pull(workspace)
    setSyncing(false)
    if (!res.ok) window.alert(t('git.syncFailed', { err: res.error ?? '' }))
    refresh()
  }
  const fetch = async (): Promise<void> => {
    setSyncing(true)
    const res = await window.api.git.fetch(workspace)
    setSyncing(false)
    if (!res.ok) window.alert(t('git.syncFailed', { err: res.error ?? '' }))
    refresh()
  }
  const stash = async (): Promise<void> => {
    const res = await window.api.git.stash(workspace)
    if (!res.ok) window.alert(res.error ?? 'stash failed')
    refresh()
  }
  const stashPop = async (): Promise<void> => {
    const res = await window.api.git.stashPop(workspace)
    if (!res.ok) window.alert(res.error ?? 'stash pop failed')
    refresh()
  }
  const openBranchMenu = async (): Promise<void> => {
    setBranches(await window.api.git.branches(workspace))
    setBranchMenu((v) => !v)
  }
  const checkout = async (name: string): Promise<void> => {
    setBranchMenu(false)
    const res = await window.api.git.checkout(workspace, name)
    if (!res.ok) window.alert(res.error ?? 'checkout failed')
    refresh()
  }
  const newBranch = async (): Promise<void> => {
    setBranchMenu(false)
    const name = window.prompt(t('git.newBranchPrompt'))
    if (!name?.trim()) return
    const res = await window.api.git.createBranch(workspace, name.trim())
    if (!res.ok) window.alert(res.error ?? 'branch failed')
    refresh()
  }

  const staged = status.files.filter((f) => f.staged)
  const changed = status.files.filter((f) => f.unstaged)

  if (!status.isRepo) {
    return <div className="git-panel empty-hint center">{t('git.notRepo')}</div>
  }

  const row = (f: GitFile, kind: 'staged' | 'changed'): JSX.Element => {
    const ch = kind === 'staged' ? f.x : f.y
    return (
      <div key={kind + f.path} className="git-row">
        <span className={`git-badge s-${ch === '?' ? 'U' : ch}`}>{statusLabel(ch)}</span>
        <span className="git-file" title={f.path} onClick={() => openDiff(f.path)}>
          {f.path.split('/').pop()}
          <span className="git-dir">{f.path.includes('/') ? ' · ' + f.path.slice(0, f.path.lastIndexOf('/')) : ''}</span>
        </span>
        {kind === 'staged' ? (
          <button className="git-act" title={t('git.unstage')} onClick={() => unstage(f.path)}>
            <Minus size={13} />
          </button>
        ) : (
          <>
            <button className="git-act danger" title={t('git.discard')} onClick={() => discard(f)}>
              <Trash2 size={13} />
            </button>
            <button className="git-act" title={t('git.stage')} onClick={() => stage(f.path)}>
              <Plus size={13} />
            </button>
          </>
        )}
      </div>
    )
  }

  return (
    <div className="git-panel">
      <div className="git-head">
        <span className="git-branch-wrap">
          <button className="git-branch" onClick={openBranchMenu} title={t('git.switchBranch')}>
            <GitBranch size={13} /> {status.branch}
            <ChevronDown size={11} />
          </button>
          {status.hasUpstream && (status.ahead > 0 || status.behind > 0) && (
            <span className="git-sync-count">
              {status.ahead > 0 && (
                <span>
                  <ArrowUp size={11} />
                  {status.ahead}
                </span>
              )}
              {status.behind > 0 && (
                <span>
                  <ArrowDown size={11} />
                  {status.behind}
                </span>
              )}
            </span>
          )}
          {branchMenu && (
            <div className="git-branch-menu">
              {branches.map((b) => (
                <button key={b.name} className="git-branch-item" onClick={() => checkout(b.name)}>
                  {b.current ? <Check size={12} /> : <span className="git-branch-spacer" />}
                  {b.name}
                </button>
              ))}
              <button className="git-branch-item new" onClick={newBranch}>
                <Plus size={12} /> {t('git.newBranch')}
              </button>
            </div>
          )}
        </span>
        <span className="git-head-actions">
          <button className="git-act" disabled={syncing} title={t('git.fetch')} onClick={fetch}>
            <DownloadCloud size={13} />
          </button>
          {status.hasUpstream && (
            <>
              <button className="git-act" disabled={syncing} title={t('git.pull')} onClick={pull}>
                <ArrowDown size={13} />
              </button>
              <button className="git-act" disabled={syncing} title={t('git.push')} onClick={push}>
                <ArrowUp size={13} />
              </button>
            </>
          )}
          <button className="git-act" title={t('git.stash')} onClick={stash}>
            <Archive size={13} />
          </button>
          <button className="git-act" title={t('git.stashPop')} onClick={stashPop}>
            <Archive size={13} style={{ transform: 'scaleY(-1)' }} />
          </button>
          <button className="git-act" title={t('common.refresh')} onClick={refresh}>
            <RefreshCw size={13} />
          </button>
        </span>
      </div>

      <div className="git-tabs">
        <button
          className={`git-tab${tab === 'changes' ? ' active' : ''}`}
          onClick={() => setTab('changes')}
        >
          {t('git.tab.changes')}
        </button>
        <button
          className={`git-tab${tab === 'graph' ? ' active' : ''}`}
          onClick={() => setTab('graph')}
        >
          {t('git.tab.graph')}
        </button>
      </div>

      {tab === 'graph' ? (
        <GitGraphPanel workspace={wid} />
      ) : (
        <>
      <div className="git-commit">
        <textarea
          className="git-msg"
          placeholder={t('git.commitMessage')}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
        />
        <button className="btn-small primary" disabled={committing || !message.trim() || staged.length === 0} onClick={commit}>
          {t('git.commit', { n: staged.length })}
        </button>
      </div>

      <div className="git-scroll">
        {staged.length > 0 && (
          <>
            <div className="git-section">{t('git.staged', { n: staged.length })}</div>
            {staged.map((f) => row(f, 'staged'))}
          </>
        )}
        <div className="git-section">
          {t('git.changed', { n: changed.length })}
          {changed.length > 0 && (
            <button className="git-act" title={t('git.stageAll')} onClick={stageAll}>
              {t('git.stageAllShort')}
            </button>
          )}
        </div>
        {changed.map((f) => row(f, 'changed'))}
        {staged.length === 0 && changed.length === 0 && (
          <div className="empty-hint">{t('git.noChanges')}</div>
        )}
      </div>
        </>
      )}
    </div>
  )
}
