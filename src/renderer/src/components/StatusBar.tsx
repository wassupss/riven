import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useSession, workspaceName, pathOf } from '../state/session'
import { useUI } from '../state/ui'
import { useAgentEdits } from '../state/agentEdits'
import { useUpdate } from '../state/update'
import { togglePanel } from '../dock/registry'
import { useApiTarget } from '../state/apiTarget'
import { useT } from '../i18n'
import ScriptRunner from './ScriptRunner'
import { Folder, FolderOpen, GitBranch, Plug, FileDiff, ArrowDownToLine } from 'lucide-react'

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
  const updateReady = useUpdate((s) => s.status.state === 'downloaded')
  const [info, setInfo] = useState<Info | null>(null)
  const [ports, setPorts] = useState<Array<{ port: number; pid: number; name: string }>>([])

  // Poll running ports for this repo.
  useEffect(() => {
    if (!folder) {
      setPorts([])
      return
    }
    let cancelled = false
    const poll = (): void => {
      window.api.ports.list(pathOf(folder)).then((p) => {
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

  // Clicking a port asks WHERE to open it: the API client (to poke an endpoint),
  // the in-app browser, or the system browser. Previously it always hijacked the
  // browser panel, which is rarely what you want for an API server.
  const [portMenu, setPortMenu] = useState<{ port: number; x: number; y: number } | null>(null)
  const openPortIn = (port: number, where: 'api' | 'browser' | 'external'): void => {
    const url = `http://localhost:${port}`
    setPortMenu(null)
    if (where === 'external') {
      window.api.openExternal(url)
      return
    }
    if (where === 'api') {
      useApiTarget.getState().setUrl(url)
      togglePanel('api')
      return
    }
    if (folder) patch(folder, { previewUrl: url })
    togglePanel('preview')
  }

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
          {ports.length > 0 && (
            <span className="status-item ports" title={t('status.ports')}>
              <Plug size={13} />
              {ports.map((p) => (
                <span
                  key={p.port}
                  className="port-chip"
                  // Say WHAT is listening, not just the number — several dev servers
                  // look identical otherwise.
                  title={`${p.name} · pid ${p.pid} · :${p.port}`}
                  onClick={(e) => {
                    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
                    setPortMenu({ port: p.port, x: r.left, y: r.top })
                  }}
                >
                  <i className="port-dot" />
                  {p.port}
                  <span className="port-name">{p.name}</span>
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
      {portMenu &&
        createPortal(
          <div className="ctx-backdrop" onClick={() => setPortMenu(null)}>
            <div
              className="context-menu port-menu"
              style={{ left: portMenu.x, top: Math.max(8, portMenu.y - 108) }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="context-label">localhost:{portMenu.port}</div>
              <div className="context-item" onClick={() => openPortIn(portMenu.port, 'api')}>
                {t('port.openApi')}
              </div>
              <div className="context-item" onClick={() => openPortIn(portMenu.port, 'browser')}>
                {t('port.openBrowser')}
              </div>
              <div className="context-item" onClick={() => openPortIn(portMenu.port, 'external')}>
                {t('port.openExternal')}
              </div>
            </div>
          </div>,
          document.body
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
