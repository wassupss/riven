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

  useEffect(() => {
    setText('')
    setSel(0)
    boxRef.current?.scrollIntoView({ block: 'nearest' })
  }, [req?.id])

  if (!req) return null
  const submitText = (): void => {
    const v = text.trim()
    if (v) answer(req.id, v)
  }

  return (
    <div className="ask-inline" ref={boxRef}>
      <div className="ask-inline-q">{req.question}</div>
      <div className="ask-inline-opts">
        {req.options.map((o, i) => (
          <button
            key={i}
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
          className="ask-inline-input"
          value={text}
          placeholder={t('ask.otherPlaceholder')}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
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
