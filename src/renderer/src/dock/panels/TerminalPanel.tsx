import { useEffect, useRef, useState } from 'react'
import type { DockviewPanelApi } from 'dockview-core'
import TerminalPane from '../../components/TerminalPane'
import { contextBus } from '../../bridge/contextBus'
import { useWorkspaceStatus } from '../../state/workspaceStatus'
import { pathOf } from '../../state/session'
import { claudeConfigDirFor } from '../../state/settings'
import { useTabBadge } from '../../state/tabBadge'
import { t as staticT } from '../../i18n'

export interface TerminalParams {
  paneId: number
  initialCommand?: string
}

// Ring at most once per this window — a terminal bell says "look at me", and
// saying it ten times in a second says nothing extra.
const BELL_COALESCE_MS = 10_000

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
      // Remove this pane's context-bus sink so the bridge never routes code into
      // its (now dead) PTY, and sinks/agentByPane don't grow for the session.
      contextBus.unregisterSink(paneId)
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
    // Attention (finished / needs input) is main's flag: it survives remounts and
    // clears when the user looks (pty:seen), not when this component guesses.
    const offStatus = window.api.pty.onStatus(({ key, busy: b, attention: a }) => {
      if (key !== sessionKey) return
      setBusy(b)
      setAttention(a !== null)
    })
    const offAgent = window.api.pty.onAgent(({ key, agent, name }) => {
      if (key !== sessionKey) return
      contextBus.setAgent(paneId, agent)
      applyAutoTitle(agent ? name : null)
    })
    // A bell is a stream, not an event: a beeping TUI can ring many times a
    // second, and one notification each is unusable. Coalesce, and apply the same
    // "is the user already looking at this terminal" rule the done path uses —
    // without it a bell notified even while the pane was on screen and focused.
    let lastBell = 0
    const offBell = window.api.pty.onBell(({ key }) => {
      if (key !== sessionKey) return
      const looking = api?.isActive && document.hasFocus()
      if (!api?.isActive) setAttention(true)
      if (looking || Date.now() - lastBell < BELL_COALESCE_MS) return
      lastBell = Date.now()
      notify(staticT('term.bell'))
    })
    const offDone = window.api.pty.onDone(({ key, reason, summary }) => {
      if (key !== sessionKey) return
      // Only fire when the user isn't already looking at this terminal (else the
      // reply is right in front of them). Body previews the agent's reply.
      const looking = api?.isActive && document.hasFocus()
      if (looking) {
        window.api.pty.seen(sessionKey)
        return
      }
      notify(
        reason === 'needs_input' ? staticT('term.needsInput') : summary?.trim() || staticT('term.done')
      )
    })
    const seen = (): void => {
      if (api?.isActive && document.hasFocus()) window.api.pty.seen(sessionKey)
    }
    const offActive = api?.onDidActiveChange?.(seen)
    const onWinFocus = (): void => seen()
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
      onMouseDown={() => window.api.pty.seen(sessionKey)}
    >
      <TerminalPane
        sessionKey={sessionKey}
        cwd={pathOf(workspace)}
        configDir={claudeConfigDirFor(workspace)}
        paneId={paneId}
        initialCommand={initialCommand}
        onReady={(ptyId) => contextBus.registerSink({ paneId, ptyId, label: staticT('term.label'), workspace })}
        onFocus={() => {
          contextBus.setActive(workspace, paneId)
          window.api.pty.seen(sessionKey)
        }}
      />
    </div>
  )
}
