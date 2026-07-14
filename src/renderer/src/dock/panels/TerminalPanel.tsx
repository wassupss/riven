import { useEffect, useRef, useState } from 'react'
import type { DockviewPanelApi } from 'dockview-core'
import TerminalPane from '../../components/TerminalPane'
import { contextBus } from '../../bridge/contextBus'
import { useWorkspaceStatus } from '../../state/workspaceStatus'
import { useTabBadge } from '../../state/tabBadge'
import { t as staticT } from '../../i18n'

export interface TerminalParams {
  paneId: number
  initialCommand?: string
}

// Every terminal is a shell — run claude / codex / anything inside it. The tab
// title auto-follows the running agent (unless renamed); a status dot on the tab
// shows busy/attention (no more blinking overlay chip).
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

  // Auto-title state: remember the title we set so a manual rename disables it.
  const autoSetRef = useRef<string | null>(null)
  const manualRef = useRef(false)
  const defaultTitleRef = useRef(api?.title ?? '❯')

  // Reflect activity on the dockview tab (dot) + per-workspace rollup (rail cards).
  useEffect(() => {
    useTabBadge.getState().set(sessionKey, attention ? 'attn' : busy ? 'busy' : null)
    useWorkspaceStatus.getState().setPane(workspace, paneId, { busy, attention })
  }, [sessionKey, workspace, paneId, busy, attention])
  useEffect(
    () => () => {
      useTabBadge.getState().set(sessionKey, null)
      useWorkspaceStatus.getState().clearPane(workspace, paneId)
    },
    [sessionKey, workspace, paneId]
  )

  // Detect a manual rename so we stop auto-titling this pane.
  useEffect(() => {
    if (!api) return
    const d = api.onDidTitleChange(() => {
      if (autoSetRef.current !== null && api.title !== autoSetRef.current) manualRef.current = true
    })
    return () => d.dispose()
  }, [api])

  const applyAutoTitle = (name?: string | null): void => {
    if (!api || manualRef.current) return
    const title = name ? name : defaultTitleRef.current
    if (api.title !== title) {
      autoSetRef.current = title
      api.setTitle(title)
    }
  }

  useEffect(() => {
    const notify = (body: string): void => window.api.notify.show(staticT('term.notifyTitle', { n: paneId }), body)
    const offStatus = window.api.pty.onStatus(({ key, busy: b }) => {
      if (key === sessionKey) setBusy(b)
    })
    const offAgent = window.api.pty.onAgent(({ key, agent, name }) => {
      if (key !== sessionKey) return
      contextBus.setAgent(paneId, agent)
      applyAutoTitle(agent ? name : null)
    })
    const offBell = window.api.pty.onBell(({ key }) => {
      if (key !== sessionKey) return
      if (!api?.isActive) setAttention(true)
      notify(staticT('term.bell'))
    })
    const offDone = window.api.pty.onDone(({ key }) => {
      if (key !== sessionKey) return
      if (!api?.isActive) setAttention(true)
      notify(staticT('term.done'))
    })
    const offActive = api?.onDidActiveChange?.(() => {
      if (api?.isActive) setAttention(false)
    })
    const onWinFocus = (): void => {
      if (api?.isActive) setAttention(false)
    }
    window.addEventListener('focus', onWinFocus)
    return () => {
      offStatus()
      offAgent()
      offBell()
      offDone()
      offActive?.dispose()
      window.removeEventListener('focus', onWinFocus)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionKey, paneId, api])

  return (
    <div
      className={`terminal-panel${attention ? ' attn' : busy ? ' busy' : ''}`}
      onMouseDown={() => setAttention(false)}
    >
      <TerminalPane
        sessionKey={sessionKey}
        cwd={workspace}
        paneId={paneId}
        initialCommand={initialCommand}
        onReady={(ptyId) => contextBus.registerSink({ paneId, ptyId, label: staticT('term.label'), workspace })}
        onFocus={() => {
          contextBus.setActive(workspace, paneId)
          setAttention(false)
        }}
      />
    </div>
  )
}
