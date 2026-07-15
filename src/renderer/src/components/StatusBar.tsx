import { useEffect, useState } from 'react'
import { useSession, workspaceName } from '../state/session'
import { useUI } from '../state/ui'
import { useAgentEdits } from '../state/agentEdits'
import { togglePanel } from '../dock/registry'
import { useT } from '../i18n'
import UsageWidget from './UsageWidget'
import ScriptRunner from './ScriptRunner'
import { Folder, FolderOpen, GitBranch, Plug, Settings, FileDiff } from 'lucide-react'

interface Info {
  repoName: string
  branch: string | null
  isRepo: boolean
}

export default function StatusBar(): JSX.Element {
  const t = useT()
  const folder = useSession((s) => s.activeWorkspace)
  const patch = useSession((s) => s.patch)
  const openSettings = useUI((s) => s.openSettings)
  const wsName = useSession((s) => (folder ? workspaceName(folder, s.names) : null))
  const changeCount = useAgentEdits((s) => s.timeline.length)
  const unseen = useAgentEdits((s) => s.unseen)
  const [info, setInfo] = useState<Info | null>(null)
  const [ports, setPorts] = useState<number[]>([])

  // Poll running ports for this repo.
  useEffect(() => {
    if (!folder) {
      setPorts([])
      return
    }
    let cancelled = false
    const poll = (): void => {
      window.api.ports.list(folder).then((p) => {
        if (!cancelled) setPorts(p)
      })
    }
    poll()
    const id = setInterval(poll, 4000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [folder])

  const openPort = (port: number): void => {
    if (folder) patch(folder, { previewUrl: `http://localhost:${port}` })
    togglePanel('preview')
  }

  useEffect(() => {
    if (!folder) {
      setInfo(null)
      return
    }
    let cancelled = false
    const refresh = (): void => {
      window.api.git.info(folder).then((i) => {
        if (!cancelled) setInfo(i)
      })
    }
    refresh()
    window.api.git.watch(folder)
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
          <span className="status-item repo" title={folder}>
            <Folder size={13} /> {wsName ?? info?.repoName ?? folder.split('/').pop()}
          </span>
          {info?.isRepo && (
            <span className="status-item branch" title={t('status.branch')}>
              <GitBranch size={13} /> {info.branch}
            </span>
          )}
          {info && !info.isRepo && <span className="status-item dim">{t('status.notGit')}</span>}
          {ports.length > 0 && (
            <span className="status-item ports" title={t('status.ports')}>
              <Plug size={13} />
              {ports.map((p) => (
                <span key={p} className="port-chip" onClick={() => openPort(p)}>
                  {p}
                </span>
              ))}
            </span>
          )}
        </>
      ) : (
        <span className="status-item dim">
          <FolderOpen size={13} /> {t('status.noFolder')}
        </span>
      )}
      {folder && <ScriptRunner />}
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
      <UsageWidget />
      <span className="status-item click" title={t('status.settingsTitle')} onClick={() => openSettings('general')}>
        <Settings size={13} /> {t('status.settings')}
      </span>
    </div>
  )
}
