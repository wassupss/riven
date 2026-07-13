import { useEffect, useState } from 'react'
import type { DockviewPanelApi } from 'dockview-core'
import TerminalPane from '../../components/TerminalPane'
import { contextBus } from '../../bridge/contextBus'

export interface TerminalParams {
  paneId: number
  initialCommand?: string
}

// Every terminal is a shell — run claude / codex / anything inside it. Session
// survives renderer reloads (main/pty.ts). While busy the terminal area shows a
// running state; when a task finishes / bell rings on an unfocused pane, the
// terminal's border pulses and a system notification fires (if app unfocused).
export default function TerminalPanel({
  workspace,
  params,
  api
}: {
  workspace: string
  params: TerminalParams
  api?: DockviewPanelApi
}): JSX.Element {
  const { paneId, initialCommand } = params
  const sessionKey = `term-${paneId}`
  const [busy, setBusy] = useState(false)
  const [attention, setAttention] = useState(false)

  useEffect(() => {
    const notify = (body: string): void => window.api.notify.show(`riven — 터미널 ${paneId}`, body)
    const offStatus = window.api.pty.onStatus(({ key, busy: b }) => {
      if (key === sessionKey) setBusy(b)
    })
    const offBell = window.api.pty.onBell(({ key }) => {
      if (key !== sessionKey) return
      if (!api?.isActive) setAttention(true)
      notify('알림 🔔')
    })
    const offDone = window.api.pty.onDone(({ key }) => {
      if (key !== sessionKey) return
      if (!api?.isActive) setAttention(true)
      notify('작업 완료 ✓')
    })
    const offActive = api?.onDidActiveChange?.(() => {
      if (api?.isActive) setAttention(false)
    })
    // Returning to the window while this panel is active clears the badge.
    const onWinFocus = (): void => {
      if (api?.isActive) setAttention(false)
    }
    window.addEventListener('focus', onWinFocus)
    return () => {
      offStatus()
      offBell()
      offDone()
      offActive?.dispose()
      window.removeEventListener('focus', onWinFocus)
    }
  }, [sessionKey, paneId, api])

  return (
    <div
      className={`terminal-panel${attention ? ' attn' : busy ? ' busy' : ''}`}
      onMouseDown={() => setAttention(false)}
    >
      {(busy || attention) && (
        <div className={`term-status ${attention ? 'attn' : 'running'}`}>
          {attention ? '🔔 알림' : '● running'}
        </div>
      )}
      <TerminalPane
        sessionKey={sessionKey}
        cwd={workspace}
        paneId={paneId}
        initialCommand={initialCommand}
        onReady={(ptyId) => contextBus.registerSink({ paneId, ptyId, label: '터미널', workspace })}
        onFocus={() => {
          contextBus.setActive(workspace, paneId)
          setAttention(false)
        }}
      />
    </div>
  )
}
