import { useEffect, useRef, useState } from 'react'
import { SquareTerminal } from 'lucide-react'
import Markdown from '../../../components/Markdown'
import { useT } from '../../../i18n'
import { scrollWithin } from '../../../lib/scrollWithin'
import {
  questionAnswers,
  questionsOf,
  toolSummary,
  type CliMenu,
  type CliPermission
} from '../../../lib/cliChat'

// What the CLI asks the person, drawn by riven instead of the TUI:
// - a permission request (PermissionRequest hook, answered through it);
// - an AskUserQuestion (the same hook; the answers go back as its input);
// - a numbered menu on the screen (plan approval, the folder trust dialog, a
//   permission dialog left to the CLI), answered with arrow keys + Enter.
// Every card can hand the question to the terminal view instead.

export function PermissionCard({
  chatKey,
  p,
  onTerminal
}: {
  chatKey: string
  p: CliPermission
  onTerminal: () => void
}): JSX.Element {
  const t = useT()
  return (
    <div className="chat-card cli-chat-perm">
      <div className="chat-card-head">{t('clichat.perm.title', { tool: p.tool })}</div>
      <pre className="cli-chat-perm-input">{toolSummary(p.tool, p.input) || JSON.stringify(p.input, null, 2)}</pre>
      <div className="cli-chat-perm-actions">
        <button className="cli-chat-btn primary" onClick={() => window.api.cliChat.answer(chatKey, p.id, 'allow')}>
          {t('clichat.perm.allow')}
        </button>
        <button className="cli-chat-btn" onClick={() => window.api.cliChat.answer(chatKey, p.id, 'deny')}>
          {t('clichat.perm.deny')}
        </button>
        <button
          className="cli-chat-btn"
          onClick={() => {
            window.api.cliChat.answer(chatKey, p.id, 'terminal')
            onTerminal()
          }}
        >
          {t('clichat.perm.terminal')}
        </button>
      </div>
    </div>
  )
}

export function QuestionCard({
  chatKey,
  q,
  onTerminal
}: {
  chatKey: string
  q: CliPermission
  onTerminal: () => void
}): JSX.Element {
  const t = useT()
  const qs = questionsOf(q.input)
  const [picked, setPicked] = useState<Record<number, string[]>>({})
  const [other, setOther] = useState<Record<number, string>>({})
  // One question at a time, as the terminal asks them; the last one sends the card.
  const [step, setStep] = useState(0)
  const boxRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    setStep(0)
    scrollWithin(boxRef.current)
  }, [q.id])
  const answers = questionAnswers(qs, picked, other)
  const cur = qs[step]
  const last = step >= qs.length - 1
  const typed = (other[step] ?? '').trim()
  const stepDone = !!(picked[step]?.length || typed)
  const send = (a: Record<string, string | string[]> | null): void => {
    if (a) window.api.cliChat.question(chatKey, q.id, a)
  }
  const next = (): void => {
    if (last) send(answers)
    else setStep(step + 1)
  }
  const pick = (label: string): void => {
    const multi = cur.multiSelect
    const have = picked[step] ?? []
    const list = multi ? (have.includes(label) ? have.filter((l) => l !== label) : [...have, label]) : [label]
    const nextPicked = { ...picked, [step]: list }
    setPicked(nextPicked)
    if (multi) return
    // A single choice takes its step: on to the next question, or the card's answer on the last.
    const nextOther = { ...other, [step]: '' }
    setOther(nextOther)
    if (last) send(questionAnswers(qs, nextPicked, nextOther))
    else setStep(step + 1)
  }
  if (!cur) return <></>
  return (
    <div className="ask-inline cli-chat-question" ref={boxRef}>
      {qs.length > 1 && <div className="cli-chat-q-step">{t('ask.step', { n: step + 1, m: qs.length })}</div>}
      <div className="cli-chat-q">
        <div className="ask-inline-q">
          {cur.header && <span className="cli-chat-q-header">{cur.header}</span>}
          {cur.question}
        </div>
        <div className="ask-inline-opts">
          {cur.options.map((o) => {
            const on = (picked[step] ?? []).includes(o.label)
            return (
              <button
                key={o.label}
                className={`ask-inline-opt${on ? ' on' : ''}`}
                title={o.description}
                onClick={() => pick(o.label)}
              >
                {cur.multiSelect && <span className="cli-chat-check">{on ? '☑' : '☐'}</span>}
                {o.label}
                {o.description && <span className="cli-chat-opt-desc">{o.description}</span>}
              </button>
            )
          })}
        </div>
        <div className="ask-inline-row">
          <input
            className="ask-inline-input"
            value={other[step] ?? ''}
            placeholder={t('ask.otherPlaceholder')}
            onChange={(e) => {
              setOther({ ...other, [step]: e.target.value })
              if (!cur.multiSelect) setPicked({ ...picked, [step]: [] })
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing && typed) {
                e.preventDefault()
                next()
              }
            }}
          />
        </div>
      </div>
      <div className="ask-inline-row">
        {step > 0 && (
          <button className="ask-inline-cancel" onClick={() => setStep(step - 1)}>
            {t('ask.prev')}
          </button>
        )}
        {(cur.multiSelect || typed) && (
          <button className="ask-inline-send" disabled={last ? !answers : !stepDone} onClick={next}>
            {last ? t('ask.send') : t('ask.next')}
          </button>
        )}
        <button
          className="ask-inline-cancel"
          onClick={() => {
            window.api.cliChat.question(chatKey, q.id, null)
            onTerminal()
          }}
        >
          <SquareTerminal size={12} /> {t('clichat.perm.terminal')}
        </button>
      </div>
    </div>
  )
}

export function MenuCard({
  chatKey,
  menu,
  plan,
  onTerminal
}: {
  chatKey: string
  menu: CliMenu
  plan: string | null
  onTerminal: () => void
}): JSX.Element {
  const t = useT()
  // The text option ("Tell Claude what to change"): typed here, then the
  // keys go to the TUI in one go.
  const [typing, setTyping] = useState<number | null>(null)
  const [text, setText] = useState('')
  const boxRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    setTyping(null)
    setText('')
    scrollWithin(boxRef.current)
  }, [menu.title])
  return (
    <div className="ask-inline cli-chat-menu" ref={boxRef}>
      {plan && (
        <div className="cli-chat-plan">
          <Markdown text={plan} />
        </div>
      )}
      <div className="ask-inline-q">{menu.title || t('clichat.menu.title')}</div>
      <div className="ask-inline-opts">
        {menu.options.map((o, i) => (
          <button
            key={i}
            className={`ask-inline-opt${i === menu.selected ? ' on' : ''}`}
            onClick={() => (o.input ? setTyping(i) : window.api.cliChat.menu(chatKey, i))}
          >
            {i + 1}. {o.label}
          </button>
        ))}
      </div>
      {typing != null && (
        <div className="ask-inline-row">
          <input
            className="ask-inline-input on"
            autoFocus
            value={text}
            placeholder={menu.options[typing]?.label}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing && text.trim()) {
                e.preventDefault()
                window.api.cliChat.menu(chatKey, typing, text)
              }
            }}
          />
          <button
            className="ask-inline-send"
            disabled={!text.trim()}
            onClick={() => window.api.cliChat.menu(chatKey, typing, text)}
          >
            {t('ask.send')}
          </button>
        </div>
      )}
      <div className="ask-inline-row">
        <button className="ask-inline-cancel" onClick={() => window.api.cliChat.keys(chatKey, '\x1b')}>
          {t('clichat.menu.cancel')}
        </button>
        <button className="ask-inline-cancel" onClick={onTerminal}>
          <SquareTerminal size={12} /> {t('clichat.showTerminal')}
        </button>
      </div>
    </div>
  )
}

/** A dialog the chat view cannot draw: say so and offer the terminal view. */
export function BlockedNotice({ blocked, onTerminal }: { blocked: string; onTerminal: () => void }): JSX.Element {
  const t = useT()
  return (
    <div className="cli-chat-blocked">
      <span>{t(`clichat.blocked.${blocked}`)}</span>
      <button className="cli-chat-btn" onClick={onTerminal}>
        <SquareTerminal size={13} /> {t('clichat.showTerminal')}
      </button>
    </div>
  )
}
