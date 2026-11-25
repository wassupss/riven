import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import type { DockviewPanelApi } from 'dockview-core'
import TerminalPane from '../../components/TerminalPane'
import { useT } from '../../i18n'
import { pathOf, loadPaneState, setPaneState } from '../../state/session'
import { claudeConfigDirFor, getSettings } from '../../state/settings'
import { buildTurns, canSendQueued, initialModel, lastModel, MODES, modeValue, reduce, type AgentProgress, type Attachment, type CliEvent, type Turn } from '../../lib/cliChat'
import { TurnView } from './clichat/TurnView'
import { BlockedNotice, MenuCard, PermissionCard, QuestionCard } from './clichat/Cards'
import Composer, { type ComposerHandle, type Outgoing } from './clichat/Composer'
import Header, { CODEX_MODES, MODE_KEY } from './clichat/Header'
import { useClaudeCatalog } from '../../state/modelCatalog'
import { modelLabel, modelsFor, pinnedModels } from '../../lib/models'
import SessionPicker from './clichat/SessionPicker'
import { getAgentStatus, resolveAgent, setAgentStatus, useAgents, type AgentController } from '../../state/agents'
import { markPaneSeen, rosterFor, useRoster, type RosterEntry } from '../../state/roster'
import { cliLive, registerCliChatAgent } from '../../state/cliChats'
import { useDelegations, delegationsOf } from '../../state/delegations'
import { useAskUser } from '../../state/askUser'
import { useUI } from '../../state/ui'
import { mentionHandle, parseMentions } from '../../lib/mention'
import { setDelegator, takeInitialText } from '../registry'
import { useRetainedValue } from '../RetainedPanel'
import AskInline from './AskInline'
import { McpCard, ModelCard } from './chatkit/Cards'
import { modelCommand, nativeCommand } from './chatkit/slash'
import { AgentsStrip, QueueStrip, WorkStrip, useTicker, type LiveAgent } from './chatkit/Strips'
import { fmtDur } from './chatkit/format'
import { useDrainedText } from '../../lib/textDrain'
import Markdown from '../../components/Markdown'
import '../../styles/cli-chat.css'

// The CLI chat: the REAL interactive `claude` or `codex`, run by Rust in a
// hidden pty (services/clichat), drawn as a chat from its transcript. A chat
// pane whose pane state says engine 'cli' is drawn by this (Workbench); the
// headless ChatPanel stays for the panes made before. Questions, plan
// approval, Codex's approvals and the trust dialogs are answered from cards
// here; anything else in the terminal view, which shows the same pty.

export interface CliChatParams {
  chatKey: string
  sessionId?: string
  /** A name given by whoever opened the pane (an agent group member). */
  pinnedTitle?: string
  agent?: string
}

const NO_AGENTS: Record<string, AgentProgress> = {}

/** Typed while a turn ran: sent when the turn ends, or pushed in now. */
interface Queued {
  id: string
  text: string
  images: string[]
  raw: string
  atts: Attachment[]
}

// Turns drawn at once; older ones on scrolling up ("load earlier").
const WINDOW_STEP = 50
// "Working" says how long it has been quiet past this (see the chat pane's
// running foot): long silence inside one tool is normal, but worth seeing.
const QUIET_MS = 90_000
/** A finished turn whose reply never reaches the transcript: its preview goes after this. */
const UNLANDED_SETTLE_MS = 5_000

// Only a turn with an Agent/Task call needs the agents map: every other turn
// keeps a constant prop, so progress ticks do not re-render the transcript.
function agentsFor(turn: Turn, agents: Record<string, AgentProgress>): Record<string, AgentProgress> {
  return turn.blocks.some((b) => b.kind === 'tool' && agents[b.tool.toolId]) ? agents : NO_AGENTS
}

export default function CliChatPanel({
  workspace,
  params,
  api
}: {
  workspace: string
  params: CliChatParams
  api: DockviewPanelApi
}): JSX.Element {
  const t = useT()
  const key = params.chatKey
  const [model, dispatch] = useReducer(reduce, undefined, initialModel)
  const [error, setError] = useState<string | null>(null)
  const [epoch, setEpoch] = useState(0) // bumped by "restart"
  const [sessionsOpen, setSessionsOpen] = useState(false)
  const pane0 = useMemo(() => loadPaneState(workspace, key), [workspace, key])
  // Which CLI runs here (pane state, set when the pane was made).
  const cli: 'claude' | 'codex' = pane0.cli === 'codex' ? 'codex' : 'claude'
  const [pickedModel, setPickedModel] = useState(pane0.model || getSettings().defaultChatModel || 'default')
  const [pickedMode, setPickedMode] = useState(pane0.mode || getSettings().defaultPermissionMode || 'acceptEdits')
  const scrollRef = useRef<HTMLDivElement>(null)
  const composerRef = useRef<ComposerHandle>(null)
  const atBottom = useRef(true)
  const cwd = pathOf(workspace)
  const configDir = claudeConfigDirFor(workspace)
  const { state } = model

  const remember = useCallback(
    (sessionId: string) => {
      // Remembered so a restart of riven resumes this conversation.
      setPaneState(workspace, key, { session: sessionId })
      if (params.sessionId !== sessionId) api.updateParameters({ ...params, sessionId })
    },
    [workspace, key, api, params]
  )

  // Settings > AI, read at each launch (a restart picks up a change), as the
  // chat pane does: the global prompt with a group member's persona appended
  // (a system prompt, never a chat turn), riven's tools switched off, the
  // built-ins held back from the allow list, a custom agent (.claude/agents) and the workspace's account profile.
  const opts = (extra: { resume?: string; fork?: boolean } = {}): Parameters<typeof window.api.cliChat.start>[1] => {
    const st = getSettings()
    const persona = (pane0.persona ?? '').trim()
    return {
      cwd,
      configDir,
      model: pickedModel !== 'default' ? pickedModel : undefined,
      permissionMode: pickedMode,
      mcpDisabled: st.mcpDisabledTools,
      toolsDenied: st.deniedTools,
      globalPrompt: persona ? [st.globalPrompt?.trim(), persona].filter(Boolean).join('\n\n') : st.globalPrompt,
      agent: params.agent || pane0.agent || undefined,
      cli,
      ...extra
    }
  }

  // Events first, then start: nothing the session says on start is missed.
  // An existing session (page reload) is reattached, not restarted.
  useEffect(() => {
    const off = window.api.cliChat.onEvent((e) => {
      if (e.key === key) dispatch(e as unknown as CliEvent)
    })
    const resume = loadPaneState(workspace, key).session ?? params.sessionId
    started.current = false
    window.api.cliChat
      .start(key, opts({ resume: resume ?? undefined }))
      .then((r) => {
        setError(null)
        if (r.sessionId) remember(r.sessionId)
        started.current = true
        // The message the pane was opened with (addChat), then anything an
        // agent or a job sent before the session was up. Rust queues them
        // until the CLI is ready.
        const first = takeInitialText(key)
        for (const m of [...(first ? [{ text: first, images: [] }] : []), ...pendingSends.current.splice(0)])
          window.api.cliChat.send(key, m.text, m.images)
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
    return off
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, workspace, epoch])

  // The session's name (/rename, else the CLI's own) on the tab. A pinned
  // name (an agent group member, a tab renamed by hand: registry.setChatTitle)
  // stays in front of it, as in the chat pane: "member · group · title".
  const pinned = params.pinnedTitle || pane0.title || ''
  useEffect(() => {
    const pin = loadPaneState(workspace, key).title || params.pinnedTitle || ''
    const next = pin && model.title ? `${pin} · ${model.title}` : pin || model.title
    if (next && api.title !== next) api.setTitle(next)
    useAgents.getState().bump()
  }, [model.title, api, workspace, key, params.pinnedTitle])

  // This pane as a delegatable agent (riven_agents, riven_ask_agent(s), agent
  // groups, pipelines, scheduled jobs, a phone). Busy and the answers come
  // from state/cliChats, which follows the session even while this panel is
  // unmounted.
  const started = useRef(false)
  const pendingSends = useRef<Array<{ text: string; images: string[] }>>([])
  const sendRef = useRef<(text: string, images?: string[]) => void>(() => {})
  sendRef.current = (text: string, images: string[] = []): void => {
    if (!text.trim() && images.length === 0) return
    if (!started.current) {
      pendingSends.current.push({ text, images })
      return
    }
    // The CLI exited: a message brings it back, resuming the conversation.
    if (cliLive(key)?.dead) {
      pendingSends.current.push({ text, images })
      restart()
      return
    }
    atBottom.current = true
    window.api.cliChat.send(key, text, images)
  }
  const fallbackTitle = cli === 'codex' ? 'Codex' : t('clichat.title')
  const titleRef = useRef(pinned || fallbackTitle)
  useEffect(() => {
    titleRef.current = api.title || pinned || fallbackTitle
  })
  useEffect(
    () =>
      registerCliChatAgent({
        chatKey: key,
        workspace,
        getTitle: () => api.title || titleRef.current,
        setTitle: (title) => {
          titleRef.current = title
        },
        send: (text) => sendRef.current(text),
        attach: (text) => composerRef.current?.append(text),
        // A paired phone (state/remote): the header's own pickers.
        remote: {
          info: () => remoteRef.current.info(),
          setModel: (m) => remoteRef.current.setModel(m),
          setMode: (m) => remoteRef.current.setMode(m),
          stop: () => remoteRef.current.stop()
        }
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key, workspace]
  )

  // The id moves on a fork, and after a restart that started a new one.
  useEffect(() => {
    if (state.sessionId && state.sessionId !== loadPaneState(workspace, key).session) remember(state.sessionId)
  }, [state.sessionId, workspace, key, remember])

  const turns = useMemo(() => buildTurns(model.items), [model.items])
  const usedModel = useMemo(() => lastModel(model.items), [model.items])
  const hiddenText = useMemo(() => new Set(model.previewHides), [model.previewHides])

  // Follow the conversation unless the person scrolled up to read.
  const [pinnedBottom, setPinnedBottom] = useState(true)
  const followBottom = useCallback((): void => {
    const el = scrollRef.current
    if (el && atBottom.current) el.scrollTop = el.scrollHeight
  }, [])
  // The reply in flight: streamed text drawn out toward the transcript's text (the tail of the last turn).
  const livePreview = model.preview ? (
    <LivePreview
      text={model.preview}
      final={!state.busy}
      landed={model.previewHides.length > 0}
      onGrow={followBottom}
      onSettled={() => dispatch({ key, kind: 'settle' })}
    />
  ) : null
  useEffect(() => {
    followBottom()
  }, [turns, model.preview, model.permissions, model.questions, state.busy, state.menu, followBottom])

  // Only the recent turns are drawn (a long transcript is thousands of DOM
  // nodes); scrolling to the top shows more. Frozen while the pane is hidden:
  // a background agent's updates are drawn when it is shown again.
  const [limit, setLimit] = useState(WINDOW_STEP)
  const shown = useRetainedValue(limit >= turns.length ? turns : turns.slice(-limit), api.isVisible)

  const toggleTerminal = (): void => window.api.cliChat.terminal(key, !state.terminal)
  const toTerminal = (): void => {
    if (!state.terminal) window.api.cliChat.terminal(key, true)
  }

  // ---- typed while a turn runs -------------------------------------------------
  //
  // Held here and sent when the turn ends, one per turn, in order (the chat
  // pane's queue): a turn halfway through a migration is not cut short
  // because the next instruction was typed early. "Send now" (or Cmd/Ctrl+
  // Enter) pushes one into the running turn instead: typed into the CLI and
  // its own send-now key (services/clichat steer).
  const [queue, setQueueState] = useState<Queued[]>([])
  const queueRef = useRef<Queued[]>([])
  const setQueue = (next: Queued[]): void => {
    queueRef.current = next
    setQueueState(next)
  }
  const lastDrain = useRef(0)
  const [, poke] = useState(0)
  useEffect(() => {
    if (queue.length === 0 || !started.current || !canSendQueued(state)) return
    // The last one has not shown up as a turn yet (the CLI's busy state is
    // an event away): look again in a moment.
    const wait = 1500 - (Date.now() - lastDrain.current)
    if (wait > 0) {
      const id = setTimeout(() => poke((n) => n + 1), wait)
      return () => clearTimeout(id)
    }
    const [next, ...rest] = queueRef.current
    setQueue(rest)
    lastDrain.current = Date.now()
    sendRef.current(next.text, next.images)
    return undefined
  })
  const steer = (q: Queued): void => {
    setQueue(queueRef.current.filter((x) => x.id !== q.id))
    atBottom.current = true
    if (!state.busy) sendRef.current(q.text, q.images)
    else window.api.cliChat.steer(key, q.text, q.images)
  }
  const editQueued = (id: string): void => {
    const q = queueRef.current.find((x) => x.id === id)
    if (!q) return
    setQueue(queueRef.current.filter((x) => x.id !== id))
    composerRef.current?.load(q.raw, q.atts)
  }
  // Stop means stop: the turn and anything waiting behind it.
  const stop = (): void => {
    setQueue([])
    window.api.cliChat.interrupt(key)
  }

  // ---- riven's own commands and @mentions ---------------------------------------
  const [cards, setCards] = useState<Array<{ id: string; kind: 'mcp' | 'model' }>>([])
  const [notes, setNotes] = useState<Array<{ id: string; text: string }>>([])
  const [localError, setLocalError] = useState<string | null>(null)
  const dismissCard = (id: string): void => {
    setCards((c) => c.filter((x) => x.id !== id))
    setTimeout(() => composerRef.current?.focus(), 0)
  }
  // /model is never typed into the CLI (it would save the person's global
  // default), /resume is the session list, /config Settings, /mcp riven's
  // card (Claude's MCP servers; Codex's /mcp is its own).
  const native = cli === 'codex' ? ['resume', 'model', 'config'] : ['resume', 'mcp', 'model', 'config']
  const runNative = (cmd: string): void => {
    if (cmd === 'config') useUI.getState().openSettings('ai')
    else if (cmd === 'resume') setSessionsOpen(true)
    else setCards((c) => [...c, { id: `${cmd}-${Date.now()}`, kind: cmd as 'mcp' | 'model' }])
  }
  const sendToPane = (target: RosterEntry, body: string): boolean => {
    if (target.kind === 'terminal') {
      window.api.pty.write(target.id, body + '\r')
      return true
    }
    const ctl = resolveAgent(target.id, key, workspace)
    if (ctl) {
      ctl.send(body)
      return true
    }
    setLocalError(t('chat.mentionUnreachable', { name: mentionHandle(target.title) }))
    return false
  }
  // "@teammate message": to that agent pane, not this conversation. A busy
  // one would read it as an answer to whatever it is asking: confirm first.
  const delegateMentions = (text: string): boolean => {
    const parsed = parseMentions(text, rosterFor(workspace).filter((a) => a.id !== key))
    if (!parsed) return false
    const { targets, body } = parsed
    const deliver = (): void => {
      const sent = targets.filter((tgt) => sendToPane(tgt, body)).map((tgt) => mentionHandle(tgt.title))
      if (sent.length)
        setNotes((n) => [...n.slice(-19), { id: crypto.randomUUID(), text: t('clichat.mentionSent', { names: sent.join(', '), text: body }) }])
    }
    const running = targets.filter((x) => x.busy)
    if (running.length === 0) {
      deliver()
      return true
    }
    useAskUser.getState().enqueue({
      id: Math.random().toString(36).slice(2),
      chatKey: key,
      question: t('chat.mentionBusyConfirm', { names: running.map((x) => mentionHandle(x.title)).join(', ') }),
      options: [t('common.send'), t('common.cancel')],
      resolve: (choice) => {
        if (choice === t('common.send')) deliver()
      }
    })
    return true
  }

  const submit = (msg: Outgoing, now: boolean): void => {
    setLocalError(null)
    const cmd = msg.atts.length === 0 ? nativeCommand(msg.text, native) : null
    if (cmd) return runNative(cmd)
    // "/model <name>": the header's pick (a restart), never the CLI's own.
    const asked = msg.atts.length === 0 ? modelCommand(msg.text) : undefined
    if (asked !== undefined) {
      const hit = asked && models.find((m) => m === asked || m.toLowerCase() === asked.toLowerCase())
      if (hit) return pickModel(hit)
      return runNative('model')
    }
    if (msg.atts.length === 0 && delegateMentions(msg.text)) return
    const q: Queued = { id: crypto.randomUUID(), text: msg.text, images: msg.images, raw: msg.raw, atts: msg.atts }
    if (now && state.busy) return steer(q)
    if (state.busy || queueRef.current.length > 0) return setQueue([...queueRef.current, q])
    sendRef.current(q.text, q.images)
  }

  const restart = (): void => {
    dispatch({ key, kind: 'items', reset: true, items: [] })
    setEpoch((n) => n + 1)
  }

  const openSession = (resume: string | undefined, fork = false): void => {
    setSessionsOpen(false)
    window.api.cliChat
      .restart(key, opts({ resume, fork }))
      .then((r) => {
        setError(null)
        if (r.sessionId) remember(r.sessionId)
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
  }

  const pickModel = (m: string): void => {
    setPickedModel(m)
    setPaneState(workspace, key, { model: m })
    window.api.cliChat.reconfigure(key, m === 'default' ? '' : m, null)
  }
  const pickMode = (m: string): void => {
    setPickedMode(m)
    setPaneState(workspace, key, { mode: m })
    window.api.cliChat.reconfigure(key, null, m)
  }

  // A finished turn is acknowledged only by touching the pane (a click or a
  // key in it), as in the chat pane: a completion nobody looked at stays on
  // the rail and the tab.
  const ackDone = useCallback((): void => {
    if (getAgentStatus(key) === 'done') setAgentStatus(key, 'idle')
    markPaneSeen(key)
  }, [key])

  // What the phone sees and changes: the same choices as the header.
  const catalog = useClaudeCatalog(cli === 'codex' ? undefined : configDir)
  const models = cli === 'codex' ? modelsFor('codex') : [...modelsFor('claude'), ...pinnedModels(catalog).map((p) => p.value)]
  const labelOf = (v: string): string => (cli === 'codex' ? v : modelLabel(v, catalog))
  const remoteRef = useRef<NonNullable<AgentController['remote']>>(null!)
  remoteRef.current = {
    info: () => ({
      cli,
      model: pickedModel,
      mode: cli === 'codex' ? pickedMode : modeValue(state.mode ?? pickedMode),
      models: models.map((v) => ({ value: v, label: labelOf(v) })),
      modes: (cli === 'codex' ? CODEX_MODES : MODES).map((m) => ({ value: m, label: t(MODE_KEY[m]) }))
    }),
    setModel: pickModel,
    setMode: pickMode,
    stop
  }

  // A running turn is the "delegator": teammates it spawns open beside this
  // pane, not wherever the dock focus is. Its start is what "working" counts
  // from.
  const turnStart = useRef(0)
  useEffect(() => {
    turnStart.current = state.busy ? Date.now() : 0
    if (state.busy) setDelegator(key)
  }, [state.busy, key])

  // The caret goes to the composer when the pane becomes the active one,
  // unless something inside it already has focus (a selection, a card).
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const focus = (): void => {
      if (!api.isActive) return
      const root = rootRef.current
      const active = root?.ownerDocument.activeElement
      if (root && active && root.contains(active)) return
      composerRef.current?.focus()
    }
    const first = setTimeout(focus, 50)
    const d = api.onDidActiveChange((e) => {
      if (e.isActive) setTimeout(focus, 0)
    })
    return () => {
      clearTimeout(first)
      d.dispose()
    }
  }, [api])

  // The finished-turn ring, until the person touches the pane (as the chat
  // pane draws it; the roster remembers it across an unmount).
  useAgents((s) => s.version)
  const paneStatus = getAgentStatus(key)
  const rosterDone = useRoster((s) => !!s.live[key]?.done)
  const [dragOver, setDragOver] = useState(false)

  // Work going on elsewhere: background commands, delegated agents,
  // subagents still running.
  const delegations = useDelegations((s) => delegationsOf(s, key))
  const bgSince = useRef(new Map<string, number>())
  const bg = (state.background ?? [])
    .filter((b) => b.status !== 'completed')
    .map((b) => {
      if (!bgSince.current.has(b.id)) bgSince.current.set(b.id, Date.now())
      return { id: b.id, label: b.description || b.type || b.id }
    })
  const liveAgents: LiveAgent[] = Object.values(model.agents)
    .filter((a) => !a.done)
    .map((a) => ({ id: a.toolId, label: a.description || a.agentType, steps: a.tools }))

  const lastNotice = model.notices[model.notices.length - 1]
  const showNotice = lastNotice && (lastNotice.level === 'error' || lastNotice.level === 'update') && Date.now() - lastNotice.at < 60_000

  return (
    <div
      ref={rootRef}
      className={`chat-panel cli-chat${state.busy ? ' busy' : ''}${dragOver ? ' drop-active' : ''}`}
      onPointerDownCapture={() => {
        if (!api.isActive) api.setActive()
        ackDone()
      }}
      onKeyDownCapture={ackDone}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && state.busy && !state.terminal) {
          e.preventDefault()
          stop()
        }
      }}
      onDragOver={(e) => {
        if (state.terminal || !(e.dataTransfer.types.includes('Files') || e.dataTransfer.types.includes('text/plain'))) return
        e.preventDefault()
        if (!dragOver) setDragOver(true)
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false)
      }}
      onDrop={(e) => {
        setDragOver(false)
        if (!state.terminal) composerRef.current?.drop(e)
      }}
    >
      {paneStatus !== 'busy' && (paneStatus === 'done' || rosterDone) && <span className="chat-ring" aria-hidden />}
      <Header
        cli={cli}
        state={state}
        title={model.title}
        usedModel={usedModel}
        model={pickedModel}
        mode={pickedMode}
        configDir={configDir}
        sessionsOpen={sessionsOpen}
        onSessions={() => setSessionsOpen((o) => !o)}
        onModel={pickModel}
        onMode={pickMode}
        onTerminal={toggleTerminal}
        onRestart={restart}
      />
      {sessionsOpen && (
        <SessionPicker
          chatKey={key}
          cli={cli}
          cwd={cwd}
          configDir={configDir}
          current={state.sessionId}
          onOpen={(id, fork) => openSession(id, fork)}
          onNew={() => openSession(undefined)}
          onClose={() => setSessionsOpen(false)}
        />
      )}

      {state.terminal && !state.dead ? (
        <div className="cli-chat-term">
          {/* The same pty, attached by its key: whatever the chat view cannot
              draw is answered here. */}
          <TerminalPane sessionKey={key} cwd={cwd} configDir={configDir} />
        </div>
      ) : (
        <>
          <div
            className="chat-scroll"
            ref={scrollRef}
            onScroll={(e) => {
              const el = e.currentTarget
              const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
              atBottom.current = bottom
              if (bottom !== pinnedBottom) setPinnedBottom(bottom)
              // Near the top: draw older turns, keeping the reading position.
              if (el.scrollTop < 60 && limit < turns.length) {
                const prev = el.scrollHeight
                setLimit((n) => Math.min(turns.length, n + WINDOW_STEP))
                requestAnimationFrame(() => {
                  const cur = scrollRef.current
                  if (cur) cur.scrollTop += cur.scrollHeight - prev
                })
              }
            }}
          >
            {limit < turns.length && (
              <button className="chat-loadmore" onClick={() => setLimit((n) => Math.min(turns.length, n + WINDOW_STEP))}>
                {t('chat.loadEarlier', { n: turns.length - limit })}
              </button>
            )}
            {turns.length === 0 && !model.preview && <div className="cli-chat-empty">{t('clichat.empty')}</div>}
            {shown.map((turn, i) => (
              <TurnView
                key={turn.key}
                chatKey={key}
                turn={turn}
                agents={agentsFor(turn, model.agents)}
                hidden={hiddenText}
                // The reply in flight lives at the end of the last turn, where its
                // transcript text goes: the swap is the same spot, not a second block.
                tail={i === shown.length - 1 && model.preview ? livePreview : undefined}
              />
            ))}
            {!shown.length && model.preview && <div className="chat-turn assistant cli-chat-assistant">{livePreview}</div>}
            {!model.preview && state.busy && <Working chatKey={key} since={turnStart.current} />}
            {cards.map((c) =>
              c.kind === 'mcp' ? (
                <McpCard key={c.id} cwd={cwd} configDir={configDir} onDismiss={() => dismissCard(c.id)} />
              ) : (
                <ModelCard
                  key={c.id}
                  models={models}
                  label={labelOf}
                  current={pickedModel}
                  onPick={(m) => {
                    pickModel(m)
                    dismissCard(c.id)
                  }}
                  onDismiss={() => dismissCard(c.id)}
                />
              )
            )}
            {state.menu ? (
              <MenuCard chatKey={key} menu={state.menu} plan={state.plan ?? null} onTerminal={toTerminal} />
            ) : (
              state.blocked && <BlockedNotice blocked={state.blocked} onTerminal={toTerminal} />
            )}
            {model.questions.map((q) => (
              <QuestionCard key={q.id} chatKey={key} q={q} onTerminal={toTerminal} />
            ))}
            {model.permissions.map((p) => (
              <PermissionCard key={p.id} chatKey={key} p={p} onTerminal={toTerminal} />
            ))}
            {/* riven's own ask_user tool, asked by this pane's agent. */}
            <AskInline chatKey={key} />
            {notes.map((n) => (
              <div key={n.id} className="cli-chat-note mention">
                {n.text}
              </div>
            ))}
            {state.parked && <div className="cli-chat-note parked">{t('clichat.parkedNote')}</div>}
            {showNotice && (
              <div className={`cli-chat-note ${lastNotice.level}`}>
                {lastNotice.level === 'update' ? t('clichat.updated') : lastNotice.text}
              </div>
            )}
            {(error || localError) && <div className="cli-chat-note error">{error || localError}</div>}
          </div>

          {!pinnedBottom && (
            <button
              className="chat-jump-bottom"
              title={t('chat.jumpBottom')}
              onClick={() => {
                const el = scrollRef.current
                if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
                atBottom.current = true
                setPinnedBottom(true)
              }}
            >
              <ChevronDown size={16} />
            </button>
          )}

          <AgentsStrip agents={liveAgents} />
          <QueueStrip
            items={queue.map((q) => ({ id: q.id, text: q.text, images: q.images.length }))}
            sendNowHint={t('clichat.sendNowHint')}
            onSendNow={(id) => {
              const q = queueRef.current.find((x) => x.id === id)
              if (q) steer(q)
            }}
            onEdit={editQueued}
            onDrop={(id) => setQueue(queueRef.current.filter((x) => x.id !== id))}
          />
          <WorkStrip tasks={bg} since={(id) => bgSince.current.get(id)} delegations={delegations} />

          <Composer
            ref={composerRef}
            chatKey={key}
            workspace={workspace}
            cli={cli}
            cwd={cwd}
            configDir={configDir}
            busy={state.busy}
            dead={state.dead}
            parked={!!state.parked}
            getTitle={() => api.title || titleRef.current}
            onSubmit={(msg, now) => {
              atBottom.current = true
              // A card on the screen is the CLI waiting for an answer: a message over it stops that turn first (its Esc).
              if (model.questions.length || model.permissions.length || state.menu) window.api.cliChat.interrupt(key)
              submit(msg, now)
            }}
            onStop={stop}
          />
        </>
      )}
    </div>
  )
}

// "Working" while a turn runs with nothing streaming yet: for how long, and,
// past QUIET_MS without a sign of life, for how long it has been silent.
// The reply still streaming, revealed at the input rate instead of dumped whole
// each time the preview updates (lib/textDrain.ts).
export function LivePreview({
  text,
  final,
  landed,
  onGrow,
  onSettled
}: {
  text: string
  /** The turn has ended: once drawn out, the preview is done. */
  final: boolean
  /** The transcript copy of the reply is in (its text is hidden under the preview). */
  landed: boolean
  onGrow: () => void
  onSettled: () => void
}): JSX.Element {
  const shown = useDrainedText(text, onGrow)
  useEffect(() => {
    if (!final) return
    // Done only once the transcript has the reply too: giving up the preview before
    // that leaves a gap, and the whole answer then pops in after it.
    if (landed && shown === text) {
      onSettled()
      return
    }
    // Fallback for a turn whose reply never reaches the transcript (interrupted, errors).
    if (!landed) {
      const t = window.setTimeout(onSettled, UNLANDED_SETTLE_MS)
      return () => window.clearTimeout(t)
    }
  }, [final, landed, shown, text, onSettled])
  return (
    <div className="chat-assistant-text cli-chat-preview">
      <Markdown text={shown} />
    </div>
  )
}

function Working({ chatKey, since }: { chatKey: string; since: number }): JSX.Element {
  const t = useT()
  const now = useTicker(true)
  const mounted = useRef(Date.now())
  const from = since || mounted.current
  const last = Math.max(cliLive(chatKey)?.lastActivityAt ?? 0, from)
  const quiet = now - last
  return (
    <div className="cli-chat-working">
      <span className="chat-shimmer-text">{t('clichat.working')}</span>
      <span className="chat-foot-live">{fmtDur(now - from)}</span>
      {quiet > QUIET_MS && (
        <span className="chat-foot-quiet" title={t('chat.quietHint')}>
          {t('chat.quiet', { d: fmtDur(quiet) })}
        </span>
      )}
    </div>
  )
}
