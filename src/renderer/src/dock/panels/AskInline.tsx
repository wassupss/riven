import { useEffect, useRef, useState } from 'react'
import { useAskUser } from '../../state/askUser'
import { useT } from '../../i18n'

// The `ask_user` prompt, rendered INSIDE the conversation that asked it. Besides
// the agent's options you can type your own answer or dismiss the question, so a
// choice list never traps you into an answer that doesn't fit.
export default function AskInline({ chatKey }: { chatKey: string }): JSX.Element | null {
  const t = useT()
  const req = useAskUser((s) => s.pending.find((r) => r.chatKey === chatKey))
  const answer = useAskUser((s) => s.answer)
  const cancel = useAskUser((s) => s.cancel)
  const [text, setText] = useState('')
  const [sel, setSel] = useState(0)
  const boxRef = useRef<HTMLDivElement>(null)
  const optsRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    setText('')
    setSel(0)
    boxRef.current?.scrollIntoView({ block: 'nearest' })
    // Take focus so the arrow keys work immediately — the question is the thing
    // blocking the agent, so it owns the keyboard until answered.
    optsRef.current?.focus()
  }, [req?.id])

  if (!req) return null
  const submitText = (): void => {
    const v = text.trim()
    if (v) answer(req.id, v)
  }

  return (
    <div className="ask-inline" ref={boxRef}>
      <div className="ask-inline-q">{req.question}</div>
      {/* Vertical list: ↑/↓ moves, Enter picks, Esc dismisses. */}
      <div
        className="ask-inline-opts"
        ref={optsRef}
        tabIndex={0}
        role="listbox"
        aria-activedescendant={`ask-opt-${sel}`}
        onKeyDown={(e) => {
          const n = req.options.length
          if (e.key === 'ArrowDown') {
            e.preventDefault()
            // Past the last option the selection lands on the free-text field, so
            // the whole prompt is one continuous keyboard list.
            if (sel >= n - 1) {
              inputRef.current?.focus()
              setSel(n)
            } else setSel(sel + 1)
          } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            setSel((i) => (i - 1 + n) % n)
          } else if (e.key === 'Enter') {
            e.preventDefault()
            answer(req.id, req.options[sel])
          } else if (e.key === 'Escape') {
            e.preventDefault()
            cancel(req.id)
          }
        }}
      >
        {req.options.map((o, i) => (
          <button
            key={i}
            id={`ask-opt-${i}`}
            role="option"
            aria-selected={i === sel}
            className={`ask-inline-opt${i === sel ? ' on' : ''}`}
            onMouseEnter={() => setSel(i)}
            onClick={() => answer(req.id, o)}
          >
            {o}
          </button>
        ))}
      </div>
      <div className="ask-inline-row">
        <input
          ref={inputRef}
          className={`ask-inline-input${sel === req.options.length ? ' on' : ''}`}
          value={text}
          placeholder={t('ask.otherPlaceholder')}
          onFocus={() => setSel(req.options.length)}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowUp' && !text) {
              // Empty field → step back into the option list.
              e.preventDefault()
              optsRef.current?.focus()
              setSel(req.options.length - 1)
            } else if (e.key === 'Enter') {
              e.preventDefault()
              submitText()
            } else if (e.key === 'Escape') cancel(req.id)
          }}
        />
        <button className="ask-inline-send" disabled={!text.trim()} onClick={submitText}>
          {t('ask.send')}
        </button>
        <button className="ask-inline-cancel" onClick={() => cancel(req.id)}>
          {t('ask.cancel')}
        </button>
      </div>
    </div>
  )
}
