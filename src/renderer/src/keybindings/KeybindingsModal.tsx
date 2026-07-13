import { useEffect, useReducer, useState } from 'react'
import { keymap, chordFromEvent, chordLabel, type KeyAction } from './keys'
import { useUI } from '../state/ui'

export default function KeybindingsModal(): JSX.Element | null {
  const open = useUI((s) => s.keybindingsOpen)
  const setOpen = useUI((s) => s.setKeybindingsOpen)
  const [, force] = useReducer((x) => x + 1, 0)
  const [recording, setRecording] = useState<string | null>(null)

  useEffect(() => keymap.subscribe(force), [])

  // Capture a chord while recording.
  useEffect(() => {
    if (!recording) return
    const onKey = (e: KeyboardEvent): void => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') {
        setRecording(null)
        return
      }
      const chord = chordFromEvent(e)
      if (!chord) return // modifier-only, keep waiting
      keymap.setBinding(recording, chord)
      setRecording(null)
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  }, [recording])

  if (!open) return null

  const byCategory = new Map<string, KeyAction[]>()
  for (const a of keymap.list()) {
    if (!byCategory.has(a.category)) byCategory.set(a.category, [])
    byCategory.get(a.category)!.push(a)
  }

  return (
    <div className="modal-overlay" onClick={() => setOpen(false)}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span>단축키 설정</span>
          <button className="btn-small" onClick={() => setOpen(false)}>
            닫기
          </button>
        </div>
        <div className="modal-hint">
          바인딩을 클릭하고 원하는 키를 누르세요. Esc로 취소. 커스텀 값은 자동 저장됩니다.
        </div>
        <div className="modal-body">
          {[...byCategory.entries()].map(([cat, actions]) => (
            <div key={cat} className="kb-cat">
              <div className="section-label">{cat}</div>
              {actions.map((a) => {
                const chord = keymap.binding(a.id)
                const conflict = chord ? keymap.conflict(a.id, chord) : null
                return (
                  <div key={a.id} className="kb-row">
                    <span className="kb-label">{a.label}</span>
                    <span className="kb-controls">
                      {conflict && <span className="kb-conflict" title={`충돌: ${conflict.label}`}>⚠</span>}
                      <button
                        className={`kb-chord${recording === a.id ? ' recording' : ''}`}
                        onClick={() => setRecording(a.id)}
                      >
                        {recording === a.id ? '키 입력…' : chordLabel(chord)}
                      </button>
                      <button className="kb-reset" title="기본값" onClick={() => keymap.resetBinding(a.id)}>
                        ↺
                      </button>
                    </span>
                  </div>
                )
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
