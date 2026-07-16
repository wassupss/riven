import { useEffect, useReducer, useState } from 'react'
import { keymap, chordFromEvent, chordLabel, type KeyAction } from './keys'
import { useSettings } from '../state/settings'
import { useT } from '../i18n'
import { TriangleAlert, RotateCcw } from 'lucide-react'
import {
  EDITOR_PRESETS,
  EDITOR_COMMANDS,
  editorBinding,
  editorBindingIsOverridden,
  editorConflict,
  setEditorBinding,
  resetEditorBinding,
  applyEditorKeymap,
  subscribeEditorKeymap
} from '../state/editorKeymaps'

type Recording = { kind: 'app' | 'editor'; id: string } | null

// Keybinding editor, embedded as the "단축키" tab of the unified Settings modal.
export default function KeybindingsSettings(): JSX.Element {
  const t = useT()
  const editorPreset = useSettings((s) => s.settings.editorKeymap)
  const setSetting = useSettings((s) => s.set)
  const [, force] = useReducer((x) => x + 1, 0)
  const [recording, setRecording] = useState<Recording>(null)
  const [tab, setTab] = useState<'editor' | 'terminal' | 'riven'>('editor')

  useEffect(() => keymap.subscribe(force), [])
  useEffect(() => subscribeEditorKeymap(force), [])

  useEffect(() => {
    if (!recording) return
    // Suppress the global keymap so pressing an already-bound chord records it
    // without also running that action.
    keymap.setRecording(true)
    const onKey = (e: KeyboardEvent): void => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') {
        setRecording(null)
        return
      }
      const chord = chordFromEvent(e)
      if (!chord) return
      if (recording.kind === 'app') keymap.setBinding(recording.id, chord)
      else setEditorBinding(recording.id, chord)
      setRecording(null)
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => {
      keymap.setRecording(false)
      window.removeEventListener('keydown', onKey, { capture: true })
    }
  }, [recording])

  const byCategory = new Map<string, KeyAction[]>()
  for (const a of keymap.list()) {
    if (!byCategory.has(a.category)) byCategory.set(a.category, [])
    byCategory.get(a.category)!.push(a)
  }
  const appGroups = [...byCategory.entries()]

  const actionLabel = (a: KeyAction): string => {
    if (a.id.startsWith('workspace.switch.'))
      return t('action.workspace.switch', a.label, { n: a.id.split('.').pop() ?? '' })
    if (a.id.startsWith('terminal.select.'))
      return t('action.terminal.select', a.label, { n: a.id.split('.').pop() ?? '' })
    return t(`action.${a.id}`, a.label)
  }

  return (
    <div className="kb-settings">
      <div className="kb-tabs">
        <button className={`kb-tab${tab === 'editor' ? ' active' : ''}`} onClick={() => setTab('editor')}>
          {t('kb.tab.editor')}
        </button>
        <button className={`kb-tab${tab === 'terminal' ? ' active' : ''}`} onClick={() => setTab('terminal')}>
          {t('kb.tab.terminal')}
        </button>
        <button className={`kb-tab${tab === 'riven' ? ' active' : ''}`} onClick={() => setTab('riven')}>
          {t('kb.tab.riven')}
        </button>
      </div>
      <div className="kb-hint">{t('kb.hint')}</div>

      {tab === 'editor' && (
        <div className="kb-cat">
          <div className="keymap-presets">
            {EDITOR_PRESETS.map((p) => (
              <button
                key={p.id}
                className={`keymap-chip${editorPreset === p.id ? ' active' : ''}`}
                onClick={() => {
                  setSetting({ editorKeymap: p.id })
                  applyEditorKeymap(p.id)
                }}
              >
                {p.label}
              </button>
            ))}
          </div>
          {EDITOR_COMMANDS.map((c) => {
            const chord = editorBinding(c.id)
            const conflict = chord ? editorConflict(c.id, chord) : null
            const rec = recording?.kind === 'editor' && recording.id === c.id
            return (
              <div key={c.id} className="kb-row">
                <span className="kb-label">{t(`editorcmd.${c.id}`, c.label)}</span>
                <span className="kb-controls">
                  {conflict && (
                    <span className="kb-conflict" title={t('kb.conflict', { label: t(`editorcmd.${conflict.id}`, conflict.label) })}>
                      <TriangleAlert size={13} />
                    </span>
                  )}
                  <button
                    className={`kb-chord${rec ? ' recording' : ''}${editorBindingIsOverridden(c.id) ? ' custom' : ''}`}
                    onClick={() => setRecording({ kind: 'editor', id: c.id })}
                  >
                    {rec ? t('kb.recording') : chordLabel(chord)}
                  </button>
                  <button className="kb-reset" title={t('kb.resetPreset')} onClick={() => resetEditorBinding(c.id)}>
                    <RotateCcw size={13} />
                  </button>
                </span>
              </div>
            )
          })}
          <div className="kb-hint">{t('kb.presetHint')}</div>
        </div>
      )}

      {appGroups
        .filter(([cat]) => (tab === 'terminal' ? cat === '터미널' : tab === 'riven' ? cat === '리븐 기본' : false))
        .map(([cat, actions]) => (
          <div key={cat} className="kb-cat">
            {actions.map((a) => {
              const chord = keymap.binding(a.id)
              const conflict = chord ? keymap.conflict(a.id, chord) : null
              const rec = recording?.kind === 'app' && recording.id === a.id
              return (
                <div key={a.id} className="kb-row">
                  <span className="kb-label">{actionLabel(a)}</span>
                  <span className="kb-controls">
                    {conflict && (
                      <span className="kb-conflict" title={t('kb.conflict', { label: actionLabel(conflict) })}>
                        <TriangleAlert size={13} />
                      </span>
                    )}
                    <button
                      className={`kb-chord${rec ? ' recording' : ''}`}
                      onClick={() => setRecording({ kind: 'app', id: a.id })}
                    >
                      {rec ? t('kb.recording') : chordLabel(chord)}
                    </button>
                    <button className="kb-reset" title={t('kb.resetDefault')} onClick={() => keymap.resetBinding(a.id)}>
                      <RotateCcw size={13} />
                    </button>
                  </span>
                </div>
              )
            })}
          </div>
        ))}
    </div>
  )
}
