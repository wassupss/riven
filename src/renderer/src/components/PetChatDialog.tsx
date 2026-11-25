import { useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { ArrowUp, Square, SquareTerminal, X } from 'lucide-react'
import { useT } from '../i18n'
import { buildTurns, initialModel, reduce, type AgentProgress, type CliEvent } from '../lib/cliChat'
import { TurnView } from '../dock/panels/clichat/TurnView'
import { BlockedNotice, MenuCard, PermissionCard, QuestionCard } from '../dock/panels/clichat/Cards'
import TerminalPane from './TerminalPane'
import { assistantPet, closePetChat, sendFromChat, usePetChat, viewPetChat } from '../state/petAssistants'
import type { AssistPet } from '../lib/petAssistBus'
import '../styles/cli-chat.css'
import '../styles/pet.css'

// ---------------------------------------------------------------------------
// A pet assistant's whole conversation (펫 비서), in riven's window: the pet's
// balloon only has room for a line. It draws the session with the CLI chat
// pane's own parts (TurnView, the permission / question / menu cards, the
// terminal view of the same pty), over a session that state/petAssistants
// runs; it is no dock pane, so it is not saved in a layout and closing it
// stops nothing.
//
// Opening it shows the saved conversation without starting a process (a
// parked session); a message starts it, the same way talking to the pet does.
// ---------------------------------------------------------------------------

const NO_AGENTS: Record<string, AgentProgress> = {}
// Only the recent turns are drawn; a pet conversation is read, not mined.
const TURNS_SHOWN = 40

export default function PetChatDialog(): JSX.Element | null {
  const open = usePetChat((s) => s.open)
  if (open === null) return null
  return <Dialog key={open} bornAt={open} />
}

function Dialog({ bornAt, panel = false }: { bornAt: number; panel?: boolean }): JSX.Element {
  const t = useT()
  const [model, dispatch] = useReducer(reduce, undefined, initialModel)
  const [key, setKey] = useState<string | null>(null)
  const [pet, setPet] = useState<AssistPet | null>(null)
  const [gone, setGone] = useState(false)
  const [input, setInput] = useState('')
  const [refused, setRefused] = useState(false)
  const composing = useRef(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const { state } = model
  // A request to open this conversation again (the shortcut): the caret goes to its field.
  const seq = usePetChat((s) => s.seq)
  useEffect(() => {
    if (panel && seq) inputRef.current?.focus()
  }, [seq, panel])

  // Events first, then the session: nothing it says on attaching is missed.
  useEffect(() => {
    let alive = true
    const want = `petchat-${Math.floor(bornAt)}`
    const off = window.api.cliChat.onEvent((e) => {
      if (e.key === want) dispatch(e as unknown as CliEvent)
    })
    void assistantPet(bornAt).then((p) => {
      if (!alive) return
      setPet(p)
      if (!p) return setGone(true)
      void viewPetChat(bornAt).then((k) => alive && setKey(k ?? want))
    })
    return () => {
      alive = false
      off()
    }
  }, [bornAt])

  useEffect(() => {
    if (panel) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !composing.current) closePetChat()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const turns = useMemo(() => buildTurns(model.items), [model.items])
  const shown = turns.length > TURNS_SHOWN ? turns.slice(-TURNS_SHOWN) : turns
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [turns, model.preview, model.permissions, model.questions, state.busy, state.menu])

  const send = (): void => {
    const text = input.trim()
    if (!text) return
    // A slash command can write the keeper's global settings (/model,
    // /config): a pet assistant never types one.
    if (text.startsWith('/')) return setRefused(true)
    setRefused(false)
    setInput('')
    void sendFromChat(bornAt, text)
  }
  const chatKey = key ?? `petchat-${Math.floor(bornAt)}`
  const toTerminal = (): void => {
    if (!state.terminal) window.api.cliChat.terminal(chatKey, true)
  }

  const body = (
    <>
        <div className="modal-header pet-chat-head">
          <span className="pet-chat-title">
            <span className={`cli-chat-dot${state.busy ? ' busy' : state.waiting || state.menu ? ' waiting' : ''}`} />
            <span className="pet-chat-name">{pet ? t('pet.assist.chatTitle', { name: pet.title }) : ''}</span>
          </span>
          <span className="pet-chat-tools">
            {key && !state.dead && !state.parked && (
              <button
                type="button"
                className={`pet-chat-icon${state.terminal ? ' on' : ''}`}
                title={t('pet.assist.terminal')}
                aria-label={t('pet.assist.terminal')}
                aria-pressed={!!state.terminal}
                onClick={() => window.api.cliChat.terminal(chatKey, !state.terminal)}
              >
                <SquareTerminal size={14} />
              </button>
            )}
            {!panel && (
            <button
              type="button"
              className="pet-chat-icon"
              title={t('common.close')}
              aria-label={t('common.close')}
              onClick={closePetChat}
            >
              <X size={14} />
            </button>
            )}
          </span>
        </div>
        <div className="chat-panel cli-chat pet-chat-body">
          {state.terminal && key && !state.dead ? (
            <div className="cli-chat-term">
              <TerminalPane sessionKey={chatKey} cwd="" />
            </div>
          ) : (
            <>
              <div className="chat-scroll" ref={scrollRef}>
                {gone && <div className="cli-chat-empty">{t('pet.assist.off')}</div>}
                {!gone && turns.length === 0 && !model.preview && (
                  <div className="cli-chat-empty">{t('pet.assist.chatEmpty')}</div>
                )}
                {shown.map((turn) => (
                  <TurnView key={turn.key} chatKey={chatKey} turn={turn} agents={NO_AGENTS} />
                ))}
                {state.busy && model.preview && (
                  <div className="chat-turn assistant cli-chat-assistant">
                    <div className="chat-assistant-text cli-chat-preview">{model.preview}</div>
                  </div>
                )}
                {state.busy && !model.preview && <div className="cli-chat-note">{t('pet.assist.working')}</div>}
                {state.menu ? (
                  <MenuCard chatKey={chatKey} menu={state.menu} plan={state.plan ?? null} onTerminal={toTerminal} />
                ) : (
                  state.blocked && <BlockedNotice blocked={state.blocked} onTerminal={toTerminal} />
                )}
                {model.questions.map((q) => (
                  <QuestionCard key={q.id} chatKey={chatKey} q={q} onTerminal={toTerminal} />
                ))}
                {model.permissions.map((p) => (
                  <PermissionCard key={p.id} chatKey={chatKey} p={p} onTerminal={toTerminal} />
                ))}
                {state.parked && turns.length > 0 && <div className="cli-chat-note parked">{t('pet.assist.parkedNote')}</div>}
              </div>
              {!gone && (
                <div className="chat-composer">
                  {refused && <div className="cli-chat-note error">{t('pet.assist.noCommands')}</div>}
                  <textarea
                    ref={inputRef}
                    className="chat-input"
                    value={input}
                    rows={1}
                    autoFocus
                    placeholder={t('pet.assist.placeholder', { name: pet?.title ?? '' })}
                    onChange={(e) => {
                      setInput(e.target.value)
                      const el = e.target
                      el.style.height = 'auto'
                      el.style.height = `${Math.min(el.scrollHeight, 168)}px`
                    }}
                    onCompositionStart={() => (composing.current = true)}
                    onCompositionEnd={() => (composing.current = false)}
                    onKeyDown={(e) => {
                      if (e.key !== 'Enter' || e.shiftKey) return
                      // Enter mid-composition only commits the syllable (Korean IME).
                      if (composing.current || e.nativeEvent.isComposing) return
                      e.preventDefault()
                      send()
                    }}
                  />
                  <div className="chat-actions">
                    <div className="chat-actions-spacer" />
                    {state.busy ? (
                      <button
                        className="chat-send stop"
                        onClick={() => window.api.cliChat.interrupt(chatKey)}
                        title={t('clichat.interrupt')}
                      >
                        <Square size={11} fill="currentColor" />
                      </button>
                    ) : (
                      <button className="chat-send" onClick={send} title={t('clichat.send')} disabled={!input.trim()}>
                        <ArrowUp size={15} strokeWidth={2.5} />
                      </button>
                    )}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
    </>
  )
  if (panel) return <div className="assistant-panel">{body}</div>
  return (
    <div className="modal-overlay" onClick={closePetChat}>
      <div className="modal pet-chat-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={pet?.title}>
        {body}
      </div>
    </div>
  )
}

/** A pet assistant's conversation as a dock panel (the same body as the dialog). */
export function AssistantChat({ bornAt }: { bornAt: number }): JSX.Element {
  return <Dialog key={bornAt} bornAt={bornAt} panel />
}
