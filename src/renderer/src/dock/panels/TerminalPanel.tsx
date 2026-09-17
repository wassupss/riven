import { useEffect, useRef, useState } from 'react'
import type { DockviewPanelApi } from 'dockview-core'
import TerminalPane from '../../components/TerminalPane'
import { contextBus } from '../../bridge/contextBus'
import { useWorkspaceStatus } from '../../state/workspaceStatus'
import { pathOf, loadPaneState, setPaneState } from '../../state/session'
import { claudeConfigDirFor } from '../../state/settings'
import { useTabBadge } from '../../state/tabBadge'
import { markPaneSeen } from '../../state/roster'
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
  // What the CLI in this terminal was last talking to, read ONCE at mount. On a
  // fresh app start that is the conversation the pane had before quitting, so it
  // can come back to it instead of to a bare shell — the terminal equivalent of
  // a chat pane's --resume. A pane the user closed is gone from the layout and
  // never gets here, so a closed conversation is not reopened.
  const [resumeSession] = useState(() => loadPaneState(workspace, sessionKey).session ?? null)
  const [busy, setBusy] = useState(false)
  // The REASON, not a boolean: 'needs_input' wants the user, 'finished' is a
  // result waiting to be read. Collapsing them made a finished CLI show the
  // same "needs you" dot forever instead of turning into done.
  const [attention, setAttention] = useState<'finished' | 'needs_input' | null>(null)

  // Auto-title state: remember the title we set so a manual rename disables it.
  const autoSetRef = useRef<string | null>(null)
  const manualRef = useRef(false)
  const defaultTitleRef = useRef(api?.title ?? '❯')

  // Reflect activity on the dockview tab (dot) + per-workspace rollup (rail cards).
  useEffect(() => {
    useTabBadge
      .getState()
      .set(
        sessionKey,
        attention === 'needs_input' ? 'attn' : attention === 'finished' ? 'done' : busy ? 'busy' : null
      )
    useWorkspaceStatus.getState().setPane(workspace, paneId, { busy, attention: attention !== null })
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

  // Ten tabs all reading "claude" say nothing about which is which. The CLI is
  // no help directly — measured: Claude Code sets NO terminal title (OSC 0/2),
  // so a plain shell reports "user@host:~/dir" and a running claude reports
  // nothing at all. What riven does have is the CLI's session id, from its hook
  // payloads, and that names a conversation whose title is in the transcript.
  const convoTitleRef = useRef<string | null>(null)
  const agentRef = useRef(false)
  const agentNameRef = useRef<string | null>(null)
  // The conversation this pane's CLI is in, plus the machinery to keep asking
  // for its name. A generation counter invalidates in-flight reads when the
  // session changes, so a slow answer for the previous conversation can never
  // land on the new one.
  const sessionIdRef = useRef<string | null>(null)
  const titleGenRef = useRef(0)
  const titleTimersRef = useRef<Array<ReturnType<typeof setTimeout>>>([])
  const clearTitleTimers = (): void => {
    for (const t of titleTimersRef.current) clearTimeout(t)
    titleTimersRef.current = []
  }

  const applyAutoTitle = (name?: string | null): void => {
    if (!api || manualRef.current) return
    // The conversation's title outlives the process. A one-shot `claude -p`
    // exits the moment it finishes, and reverting to "❯ 터미널" right as the done
    // badge appears leaves the tab unable to say WHAT finished — while the pane
    // still holds that session and will resume it on restart. It is cleared when
    // the session itself ends (SessionEnd), not when the process goes.
    const title = convoTitleRef.current ?? (name ? name : null) ?? defaultTitleRef.current
    if (api.title !== title) {
      autoSetRef.current = title
      api.setTitle(title)
    }
  }

  // Ask what this conversation is called, and keep asking.
  //
  // The hook that tells riven the session id fires when the user SUBMITS a
  // prompt — before the CLI has written that turn to the transcript. A single
  // read right then usually finds no file at all, and reading once per session
  // id meant that miss was permanent: the tab stayed "claude" for the whole
  // conversation. So an empty answer is retried on a short backoff, and every
  // finished turn refreshes it — the CLI replaces the opening line with a
  // summarised title later, and that is the name worth showing.
  const refreshConvoTitle = (sessionId: string, gen: number, backoff: number[]): void => {
    void window.api.chat
      .sessionTitle(pathOf(workspace), sessionId, claudeConfigDirFor(workspace))
      .then((title) => {
        if (gen !== titleGenRef.current) return // a different conversation now
        const clean = title?.trim()
        if (clean) {
          if (clean === convoTitleRef.current) return
          convoTitleRef.current = clean
          if (agentRef.current) applyAutoTitle(agentNameRef.current)
          return
        }
        const [next, ...rest] = backoff
        if (next === undefined) return
        titleTimersRef.current.push(setTimeout(() => refreshConvoTitle(sessionId, gen, rest), next))
      })
      .catch(() => {})
  }

  useEffect(() => {
    // paneId is what makes this a notification ABOUT a pane rather than a bare
    // banner: main suppresses it when that pane is the focused one, keys the
    // cooldown on it, and sends notify:click back with it so the click lands on
    // this terminal. Omitting it (as this did) meant terminal bell/done
    // notifications were never suppressed by the plan and did nothing when
    // clicked — the chat panel had been passing it all along.
    // The notification names the PANEL, not "terminal 96". The tab already says
    // what this pane is (the CLI's own title, or a name the user typed); a pane
    // number tells the user nothing about which of ten terminals finished.
    const notify = (body: string): void =>
      window.api.notify.show(api?.title?.trim() || staticT('term.notifyTitle', { n: paneId }), body, {
        paneId: sessionKey
      })
    // Attention (finished / needs input) is main's flag: it survives remounts and
    // clears when the user looks (pty:seen), not when this component guesses.
    let wasBusy = false
    const offStatus = window.api.pty.onStatus(({ key, busy: b, attention: a }) => {
      if (key !== sessionKey) return
      setBusy(b)
      setAttention(a)
      // A finished turn is when the CLI has just written to the transcript, and
      // eventually when it replaces the opening line with a summarised title.
      if (wasBusy && !b && sessionIdRef.current) {
        refreshConvoTitle(sessionIdRef.current, titleGenRef.current, [])
      }
      wasBusy = b
    })
    const offAgent = window.api.pty.onAgent(({ key, agent, name }) => {
      if (key !== sessionKey) return
      agentRef.current = agent
      agentNameRef.current = name ?? null
      contextBus.setAgent(paneId, agent)
      applyAutoTitle(agent ? name : null)
    })
    // Main learns the CLI's session id from its hook payloads and clears it when
    // that session ends, so persisting it verbatim keeps "resume to this
    // conversation" and "come back to a plain shell" both truthful.
    const offAgentSession = window.api.pty.onAgentSession(({ key, sessionId }) => {
      if (key !== sessionKey) return
      setPaneState(workspace, sessionKey, { session: sessionId })
      if (sessionId === sessionIdRef.current) return
      // A different conversation: abandon the old one's pending reads and its
      // name. Keeping the name would leave the PREVIOUS conversation's title on
      // a tab that has moved on — which is what happened whenever the new
      // conversation's transcript wasn't readable yet.
      titleGenRef.current++
      clearTitleTimers()
      sessionIdRef.current = sessionId
      convoTitleRef.current = null
      applyAutoTitle(agentNameRef.current)
      // The CLI session ended, so the tab is a plain terminal again.
      if (!sessionId) return
      refreshConvoTitle(sessionId, titleGenRef.current, [800, 2000, 5000, 12000, 30000])
    })
    // A bell is a stream, not an event: a beeping TUI can ring many times a
    // second, and one notification each is unusable. Coalesce, and apply the same
    // "is the user already looking at this terminal" rule the done path uses —
    // without it a bell notified even while the pane was on screen and focused.
    let lastBell = 0
    const offBell = window.api.pty.onBell(({ key }) => {
      if (key !== sessionKey) return
      const looking = api?.isActive && document.hasFocus()
      if (!api?.isActive) setAttention((a) => a ?? 'needs_input')
      if (looking || Date.now() - lastBell < BELL_COALESCE_MS) return
      lastBell = Date.now()
      notify(staticT('term.bell'))
    })
    const offDone = window.api.pty.onDone(({ key, reason, summary }) => {
      if (key !== sessionKey) return
      // Don't NOTIFY when the reply is already in front of the user — but don't
      // mark it seen either. Only a real interaction does that (see below), so a
      // completion still shows on the tab and on the workspace card until the
      // user actually turns to it.
      if (api?.isActive && document.hasFocus()) return
      notify(
        reason === 'needs_input' ? staticT('term.needsInput') : summary?.trim() || staticT('term.done')
      )
    })
    return () => {
      offStatus()
      offAgent()
      offBell()
      offAgentSession()
      offDone()
      clearTitleTimers()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionKey, paneId, api])

  return (
    <div
        className={`terminal-panel${attention === 'needs_input' ? ' attn' : busy ? ' busy' : ''}`}
      // A click or a keystroke in this pane is the only "I've seen it" signal.
      // Becoming the active tab or the window regaining focus deliberately are
      // NOT: neither means the user looked at this terminal.
      onMouseDown={() => markPaneSeen(sessionKey)}
      onKeyDownCapture={() => markPaneSeen(sessionKey)}
    >
      {/* A finished turn, or a CLI waiting on you, wears the same travelling
          ember ring as a chat pane, until someone looks — the native rule: the
          ring means "done or needs you", the tab dot says which. (A finished
          terminal had no ring at all, and "needs you" had its own ring that
          repainted every frame.) */}
      {(attention === 'finished' || attention === 'needs_input') && <span className="chat-ring" aria-hidden />}
      <TerminalPane
        sessionKey={sessionKey}
        cwd={pathOf(workspace)}
        configDir={claudeConfigDirFor(workspace)}
        paneId={paneId}
        initialCommand={
          // A recorded session wins over the command the pane was opened with:
          // re-running a bare `claude` would start a NEW conversation, which is
          // exactly the thing being fixed. main ignores this entirely when the
          // PTY is still alive (⌘R), so it only applies to a real restart.
          resumeSession ? `claude --resume ${resumeSession}` : initialCommand
        }
        onReady={(ptyId) => contextBus.registerSink({ paneId, ptyId, label: staticT('term.label'), workspace })}
        onFocus={() => contextBus.setActive(workspace, paneId)}
      />
    </div>
  )
}
