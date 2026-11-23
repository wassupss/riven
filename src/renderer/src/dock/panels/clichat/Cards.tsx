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
  const boxRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    scrollWithin(boxRef.current)
  }, [q.id])
  const answers = questionAnswers(qs, picked, other)
  const send = (a: Record<string, string | string[]> | null): void => {
    if (a) window.api.cliChat.question(chatKey, q.id, a)
  }
  const pick = (i: number, label: string): void => {
    const multi = qs[i].multiSelect
    const cur = picked[i] ?? []
    const next = multi ? (cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label]) : [label]
    const nextPicked = { ...picked, [i]: next }
    setPicked(nextPicked)
    if (!multi) setOther({ ...other, [i]: '' })
    // One single-choice question: a click is the answer.
    if (qs.length === 1 && !multi) send(questionAnswers(qs, nextPicked, {}))
  }
  return (
    <div className="ask-inline cli-chat-question" ref={boxRef}>
      {qs.map((question, i) => (
        <div key={i} className="cli-chat-q">
          <div className="ask-inline-q">
            {question.header && <span className="cli-chat-q-header">{question.header}</span>}
            {question.question}
          </div>
          <div className="ask-inline-opts">
            {question.options.map((o) => {
              const on = (picked[i] ?? []).includes(o.label)
              return (
                <button
                  key={o.label}
                  className={`ask-inline-opt${on ? ' on' : ''}`}
                  title={o.description}
                  onClick={() => pick(i, o.label)}
                >
                  {question.multiSelect && <span className="cli-chat-check">{on ? '☑' : '☐'}</span>}
                  {o.label}
                  {o.description && <span className="cli-chat-opt-desc">{o.description}</span>}
                </button>
              )
            })}
          </div>
          <div className="ask-inline-row">
            <input
              className="ask-inline-input"
              value={other[i] ?? ''}
              placeholder={t('ask.otherPlaceholder')}
              onChange={(e) => {
                setOther({ ...other, [i]: e.target.value })
                if (!question.multiSelect) setPicked({ ...picked, [i]: [] })
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  send(answers)
                }
              }}
            />
          </div>
        </div>
      ))}
      <div className="ask-inline-row">
        {(qs.length > 1 || qs.some((x) => x.multiSelect) || Object.values(other).some((v) => v.trim())) && (
          <button className="ask-inline-send" disabled={!answers} onClick={() => send(answers)}>
            {t('ask.send')}
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
