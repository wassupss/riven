import { useEffect, useRef, useState } from 'react'
import { useAskUser } from '../state/askUser'

// The `ask_user` MCP tool's UI: an arrow-selectable option list (native chat's
// choice card). Enter/click picks, Esc dismisses. Only the current request shows.
export default function AskUserModal(): JSX.Element | null {
  // Only questions with no owning chat pane use this modal; a pane-bound question
  // renders inline in that conversation (see AskInline).
  const current = useAskUser((s) => s.pending.find((r) => !r.chatKey) ?? null)
  const answerFn = useAskUser((s) => s.answer)
  const cancelFn = useAskUser((s) => s.cancel)
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
