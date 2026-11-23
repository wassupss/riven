import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import type { DockviewPanelApi } from 'dockview-core'
import TerminalPane from '../../components/TerminalPane'
import { useT } from '../../i18n'
import { pathOf, loadPaneState, setPaneState } from '../../state/session'
import { claudeConfigDirFor, getSettings } from '../../state/settings'
import { buildTurns, initialModel, lastModel, reduce, type AgentProgress, type CliEvent, type Turn } from '../../lib/cliChat'
import { TurnView } from './clichat/TurnView'
import { BlockedNotice, MenuCard, PermissionCard, QuestionCard } from './clichat/Cards'
import Composer, { type ComposerHandle } from './clichat/Composer'
import Header from './clichat/Header'
import SessionPicker from './clichat/SessionPicker'
import { getAgentStatus, setAgentStatus } from '../../state/agents'
import { markPaneSeen } from '../../state/roster'
import '../../styles/cli-chat.css'

// Experimental CLI chat: the REAL interactive `claude`, run by Rust in a
// hidden pty (services/clichat), drawn as a chat from its transcript. The
// regular ChatPanel (headless driver) is untouched. Questions, plan approval
// and the trust dialog are answered from cards here; anything else is
// answered in the terminal view, which shows the same pty.

export interface CliChatParams {
  chatKey: string
  sessionId?: string
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
  const [pickedModel, setPickedModel] = useState(pane0.model || 'default')
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

  const opts = (extra: { resume?: string; fork?: boolean } = {}): Parameters<typeof window.api.cliChat.start>[1] => ({
    cwd,
    configDir,
    model: pickedModel !== 'default' ? pickedModel : undefined,
    permissionMode: pickedMode,
    ...extra
  })

  // Events first, then start: nothing the session says on start is missed.
  // An existing session (page reload) is reattached, not restarted.
  useEffect(() => {
    const off = window.api.cliChat.onEvent((e) => {
      if (e.key === key) dispatch(e as unknown as CliEvent)
    })
    const resume = loadPaneState(workspace, key).session ?? params.sessionId
    window.api.cliChat
      .start(key, opts({ resume: resume ?? undefined }))
      .then((r) => {
        setError(null)
        remember(r.sessionId)
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
    return off
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, workspace, epoch])

  // The session's name (/rename, else the CLI's own) on the tab, unless the
  // person named the tab itself (a pinned title, registry.setChatTitle).
  useEffect(() => {
    if (model.title && !loadPaneState(workspace, key).title) api.setTitle(model.title)
  }, [model.title, api, workspace, key])

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
