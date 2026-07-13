import { useEffect, useState } from 'react'
import { useSession } from '../state/session'
import { useUI } from '../state/ui'
import { togglePanel } from '../dock/registry'

interface Info {
  repoName: string
  branch: string | null
  isRepo: boolean
}

export default function StatusBar(): JSX.Element {
  const folder = useSession((s) => s.activeWorkspace)
  const patch = useSession((s) => s.patch)
  const setKeybindingsOpen = useUI((s) => s.setKeybindingsOpen)
  const setSettingsOpen = useUI((s) => s.setSettingsOpen)
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
            📁 {info?.repoName ?? folder.split('/').pop()}
          </span>
          {info?.isRepo && (
            <span className="status-item branch" title="현재 브랜치">
              ⑂ {info.branch}
            </span>
          )}
          {info && !info.isRepo && <span className="status-item dim">git 아님</span>}
          {ports.length > 0 && (
            <span className="status-item ports" title="이 레포에서 리스닝 중인 포트 (클릭: 프리뷰)">
              🔌
              {ports.map((p) => (
                <span key={p} className="port-chip" onClick={() => openPort(p)}>
                  {p}
                </span>
              ))}
            </span>
          )}
        </>
      ) : (
        <span className="status-item dim">📂 열린 폴더 없음 — 폴더를 열어주세요</span>
      )}
      <span className="status-spacer" />
      <span className="status-item click" title="설정" onClick={() => setSettingsOpen(true)}>
        ⚙ 설정
      </span>
      <span
        className="status-item click"
        title="단축키 설정 (⌥⌘K)"
        onClick={() => setKeybindingsOpen(true)}
      >
        ⌨ 단축키
      </span>
    </div>
  )
}
