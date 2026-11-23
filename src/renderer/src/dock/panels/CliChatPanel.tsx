import { memo, useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import type { DockviewPanelApi } from 'dockview-core'
import { ArrowUp, Square, SquareTerminal, MessageSquare, RotateCcw, ChevronRight } from 'lucide-react'
import Markdown from '../../components/Markdown'
import TerminalPane from '../../components/TerminalPane'
import { useT } from '../../i18n'
import { pathOf, loadPaneState, setPaneState } from '../../state/session'
import { claudeConfigDirFor } from '../../state/settings'
import {
  buildTurns,
  initialModel,
  outgoing,
  reduce,
  tokens,
  toolSummary,
  type Block,
  type CliEvent,
  type Turn
} from '../../lib/cliChat'
import '../../styles/cli-chat.css'

// Experimental CLI chat: the REAL interactive `claude`, run by Rust in a
// hidden pty (services/clichat), drawn as a chat from its transcript. The
// regular ChatPanel (headless driver) is untouched. Anything this view
// cannot draw (a picker, the trust dialog) is answered in the terminal view,
// which shows the same pty.

export interface CliChatParams {
  chatKey: string
  sessionId?: string
}

const ToolRowView = memo(function ToolRowView({ block }: { block: Extract<Block, { kind: 'tool' }> }): JSX.Element {
  const { tool } = block
  const summary = toolSummary(tool.name, tool.input)
  const state = tool.result ? (tool.result.isError ? 'error' : 'done') : 'running'
  return (
    <details className={`cli-chat-tool ${state}`}>
      <summary>
        <ChevronRight size={12} className="cli-chat-chev" />
        <span className="cli-chat-tool-name">{tool.name}</span>
        {summary && <span className="cli-chat-tool-arg">{summary}</span>}
      </summary>
      {tool.result && <pre className="cli-chat-tool-result">{tool.result.text || ' '}</pre>}
    </details>
  )
})

const TurnView = memo(function TurnView({ turn }: { turn: Turn }): JSX.Element {
  const t = useT()
  return (
    <>
      {turn.user && (
        <div className="chat-turn user">
          <div className={`chat-user-bubble${turn.user.command ? ' cli-chat-command' : ''}`}>
            {turn.user.text}
            {turn.user.images > 0 && <span className="cli-chat-images"> [image ×{turn.user.images}]</span>}
          </div>
        </div>
      )}
      {(turn.blocks.length > 0 || turn.usage) && (
        <div className="chat-turn assistant cli-chat-assistant">
          {turn.blocks.map((b) => {
            switch (b.kind) {
              case 'text':
                return (
                  <div key={b.key} className="chat-assistant-text">
                    <Markdown text={b.text} />
                  </div>
                )
              case 'thinking':
                return (
                  <details key={b.key} className="cli-chat-thinking">
                    <summary>
                      <ChevronRight size={12} className="cli-chat-chev" />
                      {t('clichat.thinking')}
                    </summary>
                    <div className="cli-chat-thinking-body">{b.text || t('clichat.thinkingHidden')}</div>
                  </details>
                )
              case 'tool':
                return <ToolRowView key={b.tool.key} block={b} />
              case 'note':
                return (
                  <div key={b.key} className={`cli-chat-note ${b.level}`}>
                    {b.text}
                  </div>
                )
              case 'compact':
                return (
                  <div key={b.key} className="cli-chat-compact">
                    {t('clichat.compact', { trigger: b.trigger, tokens: tokens(b.preTokens) })}
                  </div>
                )
            }
          })}
          {turn.usage && (
            <div className="cli-chat-usage">
              {t('clichat.usage', {
                n: turn.usage.requests,
                read: tokens(turn.usage.cacheRead),
                write: tokens(turn.usage.cacheWrite),
                out: tokens(turn.usage.output)
              })}
              {turn.durationMs != null && ` · ${(turn.durationMs / 1000).toFixed(1)}s`}
            </div>
          )}
        </div>
      )}
    </>
  )
})

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
  const [input, setInput] = useState('')
  const [epoch, setEpoch] = useState(0) // bumped by "restart"
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const atBottom = useRef(true)
  const composing = useRef(false)
  const cwd = pathOf(workspace)
  const configDir = claudeConfigDirFor(workspace)
  const { state } = model

  // Events first, then start: nothing the session says on start is missed.
  useEffect(() => {
    const off = window.api.cliChat.onEvent((e) => {
      if (e.key === key) dispatch(e as unknown as CliEvent)
    })
    const resume = loadPaneState(workspace, key).session ?? params.sessionId
    window.api.cliChat
      .start(key, { cwd, resume: resume ?? undefined, configDir })
      .then((r) => {
        setError(null)
        // Remembered so a restart of riven resumes this conversation.
        setPaneState(workspace, key, { session: r.sessionId })
        if (params.sessionId !== r.sessionId) api.updateParameters({ ...params, sessionId: r.sessionId })
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
    return off
  }, [key, workspace, epoch])

  const turns = useMemo(() => buildTurns(model.items), [model.items])

  // Follow the conversation unless the person scrolled up to read.
  useEffect(() => {
    const el = scrollRef.current
    if (el && atBottom.current) el.scrollTop = el.scrollHeight
  }, [turns, model.preview, model.permissions, state.busy])

  const submit = useCallback(() => {
    const text = outgoing(inputRef.current?.value ?? input)
    if (!text || state.dead) return
    window.api.cliChat.send(key, text)
    setInput('')
    atBottom.current = true
    if (inputRef.current) inputRef.current.style.height = 'auto'
  }, [input, key, state.dead])

  const toggleTerminal = (): void => {
    const on = !state.terminal
    window.api.cliChat.terminal(key, on)
  }

  const restart = (): void => {
    dispatch({ key, kind: 'items', reset: true, items: [] })
    setEpoch((n) => n + 1)
  }

  const status = state.dead
    ? t('clichat.exited')
    : state.blocked
      ? ''
      : !state.ready
      ? t('clichat.starting')
      : state.waiting
        ? t('clichat.waiting')
        : state.busy
          ? t('clichat.working')
          : ''

  return (
    <div
      className={`chat-panel cli-chat${state.busy ? ' busy' : ''}`}
      onPointerDownCapture={() => {
        if (!api.isActive) api.setActive()
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && state.busy && !state.terminal) {
          e.preventDefault()
          window.api.cliChat.interrupt(key)
        }
      }}
    >
      <div className="cli-chat-bar">
        <span className={`cli-chat-dot${state.busy ? ' busy' : state.waiting ? ' waiting' : state.dead ? ' dead' : ''}`} />
        <span className="cli-chat-status">{status}</span>
        {state.sessionId && <span className="cli-chat-session">{state.sessionId.slice(0, 8)}</span>}
        <span className="cli-chat-spacer" />
        {state.dead ? (
          <button className="cli-chat-btn" onClick={restart}>
            <RotateCcw size={13} /> {t('clichat.restart')}
          </button>
        ) : (
          <button className="cli-chat-btn" onClick={toggleTerminal}>
            {state.terminal ? <MessageSquare size={13} /> : <SquareTerminal size={13} />}{' '}
            {state.terminal ? t('clichat.showChat') : t('clichat.showTerminal')}
          </button>
        )}
      </div>

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
              <TurnView key={turn.key} turn={turn} />
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
            {state.blocked && (
              <div className="cli-chat-blocked">
                <span>{t(`clichat.blocked.${state.blocked}`)}</span>
                <button className="cli-chat-btn" onClick={toggleTerminal}>
                  <SquareTerminal size={13} /> {t('clichat.showTerminal')}
                </button>
              </div>
            )}
            {model.permissions.map((p) => (
              <div key={p.id} className="chat-card cli-chat-perm">
                <div className="chat-card-head">{t('clichat.perm.title', { tool: p.tool })}</div>
                <pre className="cli-chat-perm-input">{toolSummary(p.tool, p.input) || JSON.stringify(p.input, null, 2)}</pre>
                <div className="cli-chat-perm-actions">
                  <button className="cli-chat-btn primary" onClick={() => window.api.cliChat.answer(key, p.id, 'allow')}>
                    {t('clichat.perm.allow')}
                  </button>
                  <button className="cli-chat-btn" onClick={() => window.api.cliChat.answer(key, p.id, 'deny')}>
                    {t('clichat.perm.deny')}
                  </button>
                  <button
                    className="cli-chat-btn"
                    onClick={() => {
                      window.api.cliChat.answer(key, p.id, 'terminal')
                      if (!state.terminal) window.api.cliChat.terminal(key, true)
                    }}
                  >
                    {t('clichat.perm.terminal')}
                  </button>
                </div>
              </div>
            ))}
            {error && <div className="cli-chat-note error">{error}</div>}
          </div>

          <div className="chat-composer">
            <textarea
              ref={inputRef}
              className="chat-input"
              value={input}
              rows={1}
              disabled={state.dead}
              placeholder={t('clichat.placeholder')}
              onChange={(e) => {
                setInput(e.target.value)
                const el = e.target
                el.style.height = 'auto'
                el.style.height = `${Math.min(el.scrollHeight, 168)}px`
              }}
              onCompositionStart={() => (composing.current = true)}
              onCompositionEnd={() => (composing.current = false)}
              onKeyDown={(e) => {
                // Enter sends; never mid-IME (Korean) and never with Shift.
                if (e.key === 'Enter' && !e.shiftKey && !composing.current && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  submit()
                }
              }}
            />
            <div className="chat-actions">
              <div className="chat-actions-spacer" />
              {state.busy ? (
                <button className="chat-send stop" onClick={() => window.api.cliChat.interrupt(key)} title={t('clichat.interrupt')}>
                  <Square size={11} fill="currentColor" />
                </button>
              ) : (
                <button className="chat-send" onClick={submit} title={t('clichat.send')} disabled={state.dead}>
                  <ArrowUp size={15} strokeWidth={2.5} />
                </button>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
