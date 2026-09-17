import { useEffect, useState } from 'react'
import { useSession, workspaceName, pathOf } from '../state/session'
import { useUI } from '../state/ui'
import { useAgentEdits, timelineFor, unseenFor } from '../state/agentEdits'
import { useUpdate } from '../state/update'
import { togglePanel } from '../dock/registry'
import { useT } from '../i18n'
import UsageWidget from './UsageWidget'
import { Folder, FolderOpen, GitBranch, FileDiff, ArrowDownToLine } from 'lucide-react'

interface Info {
  repoName: string
  branch: string | null
  isRepo: boolean
}

export default function StatusBar(): JSX.Element {
  const t = useT()
  const folder = useSession((s) => s.activeWorkspace)
  const openSettings = useUI((s) => s.openSettings)
  const wsName = useSession((s) => (folder ? workspaceName(folder, s.names) : null))
  // Scoped to the workspace on screen. This counted EVERY workspace's edits, so
  // the pill in one project reported files an agent had touched in another.
  const changeCount = useAgentEdits((s) => timelineFor(s.timeline, folder).length)
  const unseen = useAgentEdits((s) => unseenFor(s.timeline, s.seenAt, folder))
  const updateReady = useUpdate((s) => s.status.state === 'downloaded')
  const [info, setInfo] = useState<Info | null>(null)

  useEffect(() => {
    if (!folder) {
      setInfo(null)
      return
    }
    let cancelled = false
    const refresh = (): void => {
      window.api.git.info(pathOf(folder)).then((i) => {
        if (!cancelled) setInfo(i)
      })
    }
    refresh()
    window.api.git.watch(pathOf(folder))
    const off = window.api.git.onChanged(refresh)
    return () => {
      cancelled = true
      off()
    }
  }, [folder])

  return (
    <div className="status-bar">
      {folder ? (
        <>
          <span className="status-item repo" title={pathOf(folder)}>
            <Folder size={13} /> {wsName ?? info?.repoName ?? pathOf(folder).split('/').pop()}
          </span>
          {info?.isRepo && (
            <span className="status-item branch" title={t('status.branch')}>
              <GitBranch size={13} /> {info.branch}
            </span>
          )}
          {info && !info.isRepo && <span className="status-item dim">{t('status.notGit')}</span>}
        </>
      ) : (
        <span className="status-item dim">
          <FolderOpen size={13} /> {t('status.noFolder')}
        </span>
      )}
      {/* Usage lives down here, next to where the work is, rather than in the
          header: glancing at it mid-task is the whole point. */}
      <UsageWidget />
      <span className="status-spacer" />
      {changeCount > 0 && (
        <span
          className="status-item click changes-pill"
          title={t('changes.pillTitle')}
          onClick={() => togglePanel('changes')}
        >
          <FileDiff size={13} /> {changeCount}
          {unseen > 0 && <span className="changes-pill-dot" />}
        </span>
      )}
      {updateReady && (
        <span
          className="status-item click update-pill"
          title={t('status.updateReady')}
          onClick={() => openSettings('about')}
        >
          <ArrowDownToLine size={13} /> {t('status.updateReady')}
        </span>
      )}
    </div>
  )
}
