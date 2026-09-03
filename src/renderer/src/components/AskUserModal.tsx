import { useEffect, useRef, useState } from 'react'
import { useAskUser } from '../state/askUser'

// The `ask_user` MCP tool's UI: an arrow-selectable option list (native chat's
// choice card). Enter/click picks, Esc dismisses. Only the current request shows.
export default function AskUserModal(): JSX.Element | null {
  const current = useAskUser((s) => s.current)
  const answer = useAskUser((s) => s.answer)
  const cancel = useAskUser((s) => s.cancel)
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
    <div className="askuser-backdrop" onClick={cancel}>
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
            answer(options[sel])
          } else if (e.key === 'Escape') {
            e.preventDefault()
            cancel()
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
              onClick={() => answer(opt)}
            >
              {opt}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
