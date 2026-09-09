import { useEffect, useRef, useState } from 'react'
import { useAskUser } from '../state/askUser'
import { useT } from '../i18n'

// The `ask_user` MCP tool's UI: an arrow-selectable option list (native chat's
// choice card). Enter/click picks, Esc dismisses. Only the current request shows.
export default function AskUserModal(): JSX.Element | null {
  // Only questions with no owning chat pane use this modal; a pane-bound question
  // renders inline in that conversation (see AskInline).
  const current = useAskUser((s) => s.pending.find((r) => !r.chatKey) ?? null)
  const answerFn = useAskUser((s) => s.answer)
  const cancelFn = useAskUser((s) => s.cancel)
  const dismissFn = useAskUser((s) => s.dismiss)
  const t = useT()
  const [sel, setSel] = useState(0)
  const ref = useRef<HTMLDivElement>(null)

  // Reset the highlighted row whenever a new question appears, and focus so the
  // arrow keys work immediately.
  useEffect(() => {
    setSel(0)
    ref.current?.focus()
  }, [current?.id])

  if (!current) return null
  const { question, options } = current

  // The agent gave up first; keep the question visible but stop offering
  // answers that can no longer reach anyone.
  if (current.expired)
    return (
      <div className="askuser-backdrop" onClick={() => dismissFn(current.id)}>
        <div className="askuser-card" onClick={(e) => e.stopPropagation()}>
          <div className="askuser-q">{question}</div>
          <div className="ask-inline-row">
            <span className="ask-inline-note">{t('ask.expired')}</span>
            <button className="ask-inline-cancel" onClick={() => dismissFn(current.id)}>
              {t('common.close')}
            </button>
          </div>
        </div>
      </div>
    )

  return (
    <div className="askuser-backdrop" onClick={() => cancelFn(current.id)}>
      <div
        ref={ref}
        className="askuser-card"
        tabIndex={0}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault()
            setSel((i) => (i + 1) % options.length)
          } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            setSel((i) => (i - 1 + options.length) % options.length)
          } else if (e.key === 'Enter') {
            e.preventDefault()
            answerFn(current.id, options[sel])
          } else if (e.key === 'Escape') {
            e.preventDefault()
            cancelFn(current.id)
          }
        }}
      >
        <div className="askuser-q">{question}</div>
        <div className="askuser-options">
          {options.map((opt, i) => (
            <button
              key={i}
              className={`askuser-option${i === sel ? ' sel' : ''}`}
              onMouseEnter={() => setSel(i)}
              onClick={() => answerFn(current.id, opt)}
            >
              {opt}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
