import { useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react'
import { ArrowUp, History, Plus, Square, SquareTerminal, X } from 'lucide-react'
import { useT } from '../i18n'
import { buildTurns, initialModel, reduce, type AgentProgress, type CliEvent } from '../lib/cliChat'
import { TurnView } from '../dock/panels/clichat/TurnView'
import { LivePreview } from '../dock/panels/CliChatPanel'
import { BlockedNotice, MenuCard, PermissionCard, QuestionCard } from '../dock/panels/clichat/Cards'
import TerminalPane from './TerminalPane'
import {
  assistantPet,
  closePetChat,
  listPetChats,
  newPetChat,
  openPetChat,
  resumePetChat,
  sendFromChat,
  usePetChat,
  viewPetChat,
  type PetChatItem
} from '../state/petAssistants'
import { onAssistantChatRequest, type AssistPet } from '../lib/petAssistBus'
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

/** When a past conversation was last talked in, short. */
function whenOf(at: number): string {
  if (!at) return ''
  return new Date(at).toLocaleString(undefined, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

/** The card's width: its room on the pet's left, in riven's window and in the pet's own. */
export const ASSIST_CARD_W = 540
/** Its height when the pet is a desktop window (the window grows to fit it). */
export const ASSIST_CARD_H = 560
const CARD_GAP = 12

/**
 * A pet's conversation, beside the pet wherever the pet is: over riven's window when
 * the pet lives inside the app, and in the pet's own window (which grows to make room)
 * when it is a desktop window. One card, one behaviour, both ways.
 */
export function AssistantCard({ anchor }: { anchor: 'attached' | 'detached' }): JSX.Element | null {
  const open = usePetChat((s) => s.open)
  const [box, setBox] = useState({ left: 0, top: 0, height: 0 })

  // The shortcut, or the pet's menu: whichever window hosts the pet answers.
  useEffect(
    () =>
      onAssistantChatRequest((bornAt) => {
        if (usePetChat.getState().open === Math.floor(bornAt)) closePetChat()
        else openPetChat(bornAt)
      }),
    []
  )

  // Where it sits. Inside riven: the pet is at the card's bottom-right corner, a gap apart,
  // and the card follows the pet when the pet's box changes (its size, or the window).
  // A desktop pet: the whole pet window (the window itself is what moves with the pet).
  useLayoutEffect(() => {
    if (open === null) return
    if (anchor === 'detached') {
      setBox({ left: 0, top: 0, height: window.innerHeight })
      return
    }
    const place = (): void => {
      const pet = document.querySelector('.pet-device') as HTMLElement | null
      const stage = document.querySelector('.pet-device .pet-stage') as HTMLElement | null
      const r = (stage ?? pet)?.getBoundingClientRect()
      const bottom = r ? r.bottom : window.innerHeight - 42
      const height = Math.min(680, bottom - 8)
      const top = Math.max(8, bottom - height)
      const left = Math.max(8, (r?.left ?? window.innerWidth - 144) - CARD_GAP - ASSIST_CARD_W)
      setBox({ left, top, height: bottom - top })
    }
    place()
    window.addEventListener('resize', place)
    const pet = document.querySelector('.pet-device') as HTMLElement | null
    const ro = pet && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(place) : null
    if (pet) ro?.observe(pet)
    return () => {
      window.removeEventListener('resize', place)
      ro?.disconnect()
    }
  }, [open, anchor])

  // A desktop pet's window makes room for the card while it is open.
  useEffect(() => {
    if (anchor !== 'detached') return
    const on = open !== null
    document.documentElement.classList.toggle('assist-open', on)
    void window.api.pet.room(on, ASSIST_CARD_W + CARD_GAP, ASSIST_CARD_H).catch(() => {})
  }, [open, anchor])

  if (open === null) return null
  return (
    <div className={`assistant-card ${anchor}`} style={{ left: box.left, top: box.top, height: box.height }}>
      <Dialog key={open} bornAt={open} />
    </div>
  )
}

function Dialog({ bornAt }: { bornAt: number }): JSX.Element {
  const t = useT()
  const [model, dispatch] = useReducer(reduce, undefined, initialModel)
  const [key, setKey] = useState<string | null>(null)
  const [pet, setPet] = useState<AssistPet | null>(null)
  const [gone, setGone] = useState(false)
  const [input, setInput] = useState('')
  const [refused, setRefused] = useState(false)
  const composing = useRef(false)
  const [histOpen, setHistOpen] = useState(false)
  const [chats, setChats] = useState<PetChatItem[]>([])
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const { state } = model
  // A request to open this conversation again (the shortcut): the caret goes to its field.
  const seq = usePetChat((s) => s.seq)
  useEffect(() => {
    if (seq) inputRef.current?.focus()
  }, [seq])

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
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !composing.current) closePetChat()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // The conversations this pet has: read when the history opens, and as a turn ends.
  useEffect(() => {
    if (histOpen) void listPetChats(bornAt).then(setChats)
  }, [histOpen, bornAt, state.busy])

  const turns = useMemo(() => buildTurns(model.items), [model.items])
  const shown = turns.length > TURNS_SHOWN ? turns.slice(-TURNS_SHOWN) : turns
  // The reply in flight: streamed text drawn out toward the transcript's copy of it, at the
  // end of the last turn (the same spot), the way the CLI chat pane does it.
  const hiddenText = useMemo(() => new Set(model.previewHides), [model.previewHides])
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
  const livePreview = model.preview ? (
    <LivePreview
      text={model.preview}
      final={!state.busy}
      landed={model.previewHides.length > 0}
      onGrow={() => {
        const el = scrollRef.current
        if (el) el.scrollTop = el.scrollHeight
      }}
      onSettled={() => dispatch({ key: chatKey, kind: 'settle' } as unknown as CliEvent)}
    />
  ) : null
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
            <button
              type="button"
              className={`pet-chat-icon${histOpen ? ' on' : ''}`}
              title={t('pet.assist.history')}
              aria-label={t('pet.assist.history')}
              aria-expanded={histOpen}
              onClick={() => setHistOpen((v) => !v)}
            >
              <History size={14} />
            </button>
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
            {(
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
        {histOpen && (
          <div className="pet-chat-history" role="menu">
            <button
              type="button"
              className="pet-chat-hist-new"
              onClick={() => {
                setHistOpen(false)
                newPetChat(bornAt)
              }}
            >
              <Plus size={13} />
              <span>{t('pet.assist.newChat')}</span>
            </button>
            {chats.length === 0 && <div className="pet-chat-hist-empty">{t('pet.assist.historyEmpty')}</div>}
            {chats.map((c) => (
              <button
                key={c.sessionId}
                type="button"
                role="menuitem"
                className={`pet-chat-hist-item${c.current ? ' current' : ''}`}
                onClick={() => {
                  setHistOpen(false)
                  if (!c.current) resumePetChat(bornAt, c.sessionId)
                }}
              >
                <span className="pet-chat-hist-title">{c.title || t('pet.assist.untitled')}</span>
                <span className="pet-chat-hist-when">{c.current ? t('pet.assist.current') : whenOf(c.at)}</span>
              </button>
            ))}
          </div>
        )}
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
                {shown.map((turn, i) => (
                  <TurnView
                    key={turn.key}
                    chatKey={chatKey}
                    turn={turn}
                    agents={NO_AGENTS}
                    hidden={hiddenText}
                    tail={i === shown.length - 1 && model.preview ? livePreview : undefined}
                  />
                ))}
                {!shown.length && model.preview && <div className="chat-turn assistant cli-chat-assistant">{livePreview}</div>}
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
  return <div className="assistant-card-body">{body}</div>
}
