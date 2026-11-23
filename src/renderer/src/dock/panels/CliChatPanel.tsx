import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import type { DockviewPanelApi } from 'dockview-core'
import TerminalPane from '../../components/TerminalPane'
import { useT } from '../../i18n'
import { pathOf, loadPaneState, setPaneState } from '../../state/session'
import { claudeConfigDirFor, getSettings } from '../../state/settings'
import { buildTurns, initialModel, lastModel, MODES, modeValue, reduce, type AgentProgress, type CliEvent, type Turn } from '../../lib/cliChat'
import { TurnView } from './clichat/TurnView'
import { BlockedNotice, MenuCard, PermissionCard, QuestionCard } from './clichat/Cards'
import Composer, { type ComposerHandle } from './clichat/Composer'
import Header, { MODE_KEY } from './clichat/Header'
import { useClaudeCatalog } from '../../state/modelCatalog'
import { modelLabel, modelsFor, pinnedModels } from '../../lib/models'
import SessionPicker from './clichat/SessionPicker'
import { getAgentStatus, setAgentStatus, useAgents, type AgentController } from '../../state/agents'
import { markPaneSeen } from '../../state/roster'
import { cliLive, registerCliChatAgent } from '../../state/cliChats'
import { takeInitialText } from '../registry'
import AskInline from './AskInline'
import '../../styles/cli-chat.css'

// Experimental CLI chat: the REAL interactive `claude`, run by Rust in a
// hidden pty (services/clichat), drawn as a chat from its transcript. The
// regular ChatPanel (headless driver) is untouched. Questions, plan approval
// and the trust dialog are answered from cards here; anything else is
// answered in the terminal view, which shows the same pty.

export interface CliChatParams {
  chatKey: string
  sessionId?: string
  /** A name given by whoever opened the pane (an agent group member). */
  pinnedTitle?: string
  agent?: string
}

const NO_AGENTS: Record<string, AgentProgress> = {}

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
      // `fresh` only meant "do not adopt another conversation" until this
      // pane had one of its own.
      setPaneState(workspace, key, { session: sessionId, fresh: undefined })
      if (params.sessionId !== sessionId) api.updateParameters({ ...params, sessionId })
    },
    [workspace, key, api, params]
  )

  // Settings > AI, read at each launch (a restart picks up a change), as the
  // chat pane does: the global prompt with a group member's persona appended
  // (a system prompt, never a chat turn), riven's tools switched off, the
  // built-ins held back from the allow list, the autocompact window, a
  // custom agent (.claude/agents) and the workspace's account profile.
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
      autocompact: st.autocompact,
      globalPrompt: persona ? [st.globalPrompt?.trim(), persona].filter(Boolean).join('\n\n') : st.globalPrompt,
      agent: params.agent || pane0.agent || undefined,
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
        remember(r.sessionId)
        started.current = true
        // The message the pane was opened with (addChat), then anything an
        // agent or a job sent before the session was up. Rust queues them
        // until the CLI is ready.
        const first = takeInitialText(key)
        for (const text of [...(first ? [first] : []), ...pendingSends.current.splice(0)])
          window.api.cliChat.send(key, text, [])
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
  const pendingSends = useRef<string[]>([])
  const sendRef = useRef<(text: string) => void>(() => {})
  sendRef.current = (text: string): void => {
    if (!text.trim()) return
    if (!started.current) {
      pendingSends.current.push(text)
      return
    }
    // The CLI exited: a message brings it back, resuming the conversation.
    if (cliLive(key)?.dead) {
      pendingSends.current.push(text)
      restart()
      return
    }
    atBottom.current = true
    window.api.cliChat.send(key, text, [])
  }
  const titleRef = useRef(pinned || t('clichat.title'))
  useEffect(() => {
    titleRef.current = api.title || pinned || t('clichat.title')
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

  // Follow the conversation unless the person scrolled up to read.
  useEffect(() => {
    const el = scrollRef.current
    if (el && atBottom.current) el.scrollTop = el.scrollHeight
  }, [turns, model.preview, model.permissions, model.questions, state.busy, state.menu])

  const toggleTerminal = (): void => window.api.cliChat.terminal(key, !state.terminal)
  const toTerminal = (): void => {
    if (!state.terminal) window.api.cliChat.terminal(key, true)
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
        remember(r.sessionId)
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
  const catalog = useClaudeCatalog(configDir)
  const remoteRef = useRef<NonNullable<AgentController['remote']>>(null!)
  remoteRef.current = {
    info: () => ({
      cli: 'claude',
      model: pickedModel,
      mode: modeValue(state.mode ?? pickedMode),
      models: [...modelsFor('claude'), ...pinnedModels(catalog).map((p) => p.value)].map((v) => ({
        value: v,
        label: modelLabel(v, catalog)
      })),
      modes: MODES.map((m) => ({ value: m, label: t(MODE_KEY[m]) }))
    }),
    setModel: pickModel,
    setMode: pickMode,
    stop: () => window.api.cliChat.interrupt(key)
  }

  const lastNotice = model.notices[model.notices.length - 1]
  const showNotice = lastNotice && (lastNotice.level === 'error' || lastNotice.level === 'update') && Date.now() - lastNotice.at < 60_000

  return (
    <div
      className={`chat-panel cli-chat${state.busy ? ' busy' : ''}`}
      onPointerDownCapture={() => {
        if (!api.isActive) api.setActive()
        ackDone()
      }}
      onKeyDownCapture={ackDone}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && state.busy && !state.terminal) {
          e.preventDefault()
          window.api.cliChat.interrupt(key)
        }
      }}
    >
      <Header
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
              atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
            }}
          >
            {turns.length === 0 && !model.preview && <div className="cli-chat-empty">{t('clichat.empty')}</div>}
            {turns.map((turn) => (
              <TurnView key={turn.key} chatKey={key} turn={turn} agents={agentsFor(turn, model.agents)} />
            ))}
            {state.busy &&
              (model.preview ? (
                // Best-effort text of the reply still streaming (hook lines /
                // screen); the transcript's version replaces it.
                <div className="chat-turn assistant cli-chat-assistant">
                  <div className="chat-assistant-text cli-chat-preview">{model.preview}</div>
                </div>
              ) : (
                <div className="cli-chat-working">
                  <span className="chat-shimmer-text">{t('clichat.working')}</span>
                </div>
              ))}
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
            {state.parked && <div className="cli-chat-note parked">{t('clichat.parkedNote')}</div>}
            {showNotice && (
              <div className={`cli-chat-note ${lastNotice.level}`}>
                {lastNotice.level === 'update' ? t('clichat.updated') : lastNotice.text}
              </div>
            )}
            {error && <div className="cli-chat-note error">{error}</div>}
          </div>

          <Composer
            ref={composerRef}
            chatKey={key}
            busy={state.busy}
            dead={state.dead}
            parked={!!state.parked}
            onSent={() => (atBottom.current = true)}
          />
        </>
      )}
    </div>
  )
}
