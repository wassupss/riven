import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Check, Loader2, RotateCw, Sparkles, Square, X } from 'lucide-react'
import { useT } from '../i18n'
import { Button, Select } from './ui/Controls'
import { PET_AI_MODELS, saveModel, savedModel, startPetAi, usageTokens, type PetAiAnswer, type PetAiModel, type PetAiRun } from '../lib/petAi'

// ---------------------------------------------------------------------------
// The AI request box the pixel editor and the decoration layout share: a
// request, the model, a run with its seconds and a stop button, and then a
// preview the caller draws with [적용] [다시] [취소]. The call itself and the
// checking of its answer are the caller's (`ask`), so this stays the same
// for a picture and for a layout. `compact` is the one-line form the species
// maker puts under its palette: the request, the model in a small menu, a button.
// ---------------------------------------------------------------------------

/** What the caller makes of an answer: a result to preview, or why it was refused. */
export type AskOutcome<R> = { ok: true; result: R } | { ok: false; reason: string; vars?: Record<string, string | number> }

/** Codex is offered only where it is installed; asked once per window. */
let enginesOnce: Promise<{ claude: boolean; codex: boolean }> | null = null
const engines = (): Promise<{ claude: boolean; codex: boolean }> =>
  (enginesOnce ??= window.api.petAi.engines().catch(() => ({ claude: true, codex: false })))

const MODEL_LABEL: Record<PetAiModel, string> = { sonnet: 'Sonnet', haiku: 'Haiku', opus: 'Opus', codex: 'Codex' }

export default function PetAiAsk<R>({
  title,
  placeholder,
  build,
  check,
  preview,
  onApply,
  disabled,
  compact
}: {
  title: string
  placeholder: string
  /** The call for a request: system prompt, prompt and pictures (base64 PNGs). */
  build: (request: string) => { system: string; prompt: string; images: string[] }
  /** The answer's text checked against what is there now. */
  check: (text: string) => AskOutcome<R>
  /** The result beside what is there now. */
  preview: (result: R) => ReactNode
  onApply: (result: R) => void
  disabled?: boolean
  /** One line: request, model menu, button (the title is the field's label). */
  compact?: boolean
}): JSX.Element {
  const t = useT()
  const [request, setRequest] = useState('')
  const [model, setModel] = useState<PetAiModel>(savedModel)
  const [codex, setCodex] = useState(false)
  const [running, setRunning] = useState(false)
  const [secs, setSecs] = useState(0)
  const [result, setResult] = useState<R | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [spent, setSpent] = useState(0)
  const run = useRef<PetAiRun | null>(null)

  useEffect(() => {
    let live = true
    void engines().then((e) => live && setCodex(e.codex))
    return () => {
      live = false
      // Leaving mid-call stops it: nobody is left to see the answer.
      run.current?.cancel()
    }
  }, [])
  // The seconds, once a second, only while a call runs.
  useEffect(() => {
    if (!running) return
    const from = Date.now()
    setSecs(0)
    const id = setInterval(() => setSecs(Math.floor((Date.now() - from) / 1000)), 1000)
    return () => clearInterval(id)
  }, [running])

  const say = (a: PetAiAnswer): string =>
    a.error === 'notInstalled'
      ? t(model === 'codex' ? 'pet.ai.noCodex' : 'pet.ai.noClaude')
      : a.error === 'timeout'
        ? t('pet.ai.timeout')
        : t('pet.ai.failed', { detail: a.detail?.trim() || '-' })

  const go = async (): Promise<void> => {
    const q = request.trim()
    if (!q || running) return
    setError(null)
    setResult(null)
    saveModel(model)
    const r = startPetAi({ model, ...build(q) })
    run.current = r
    setRunning(true)
    const a = await r.done
    if (run.current !== r) return
    run.current = null
    setRunning(false)
    setSpent(usageTokens(a.usage))
    if (!a.ok) {
      if (a.error !== 'cancelled') setError(say(a))
      return
    }
    const out = check(a.text ?? '')
    if (!out.ok) return setError(t('pet.ai.refused', { why: t(out.reason, out.vars) }))
    setResult(out.result)
  }
  const stop = (): void => {
    run.current?.cancel()
  }

  const models = PET_AI_MODELS.filter((m) => m !== 'codex' || codex)
  const modelMenu = (
    <Select
      className={compact ? 'pai-model' : undefined}
      aria-label={t('pet.ai.model')}
      title={t('pet.ai.model')}
      value={model}
      disabled={running}
      onChange={(e) => setModel(e.target.value as PetAiModel)}
    >
      {models.map((m) => (
        <option key={m} value={m}>
          {MODEL_LABEL[m]}
        </option>
      ))}
    </Select>
  )
  const after = (
    <>
      {error && (
        <p className="pai-error" role="alert">
          {error}
        </p>
      )}
      {result !== null && (
        <div className="pai-preview">
          {preview(result)}
          {spent > 0 && <p className="pai-note">{t('pet.ai.tokens', { n: spent.toLocaleString() })}</p>}
          <div className="pai-row">
            <Button
              variant="primary"
              onClick={() => {
                onApply(result)
                setResult(null)
              }}
            >
              <Check size={14} /> {t('pet.ai.apply')}
            </Button>
            <Button onClick={() => void go()}>
              <RotateCw size={14} /> {t('pet.ai.again')}
            </Button>
            <Button variant="ghost" onClick={() => setResult(null)}>
              <X size={14} /> {t('pet.ai.discard')}
            </Button>
          </div>
        </div>
      )}
    </>
  )

  if (compact)
    return (
      <div className="pai compact">
        <div className="pai-line">
          <Sparkles size={14} className="pai-icon" aria-hidden="true" />
          <input
            className="ui-input pai-one"
            value={request}
            placeholder={placeholder}
            aria-label={title}
            title={title}
            disabled={running}
            maxLength={400}
            onChange={(e) => setRequest(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                e.preventDefault()
                void go()
              }
            }}
          />
          {modelMenu}
          {running ? (
            <Button onClick={stop} aria-label={t('pet.ai.stop')} title={`${t('pet.ai.running', { s: secs })} ${t('pet.ai.stop')}`}>
              <Loader2 size={14} className="pai-spin" /> {secs}s <Square size={11} />
            </Button>
          ) : (
            <Button disabled={disabled || !request.trim()} onClick={() => void go()}>
              {t('pet.ai.ask')}
            </Button>
          )}
        </div>
        {after}
      </div>
    )

  return (
    <div className="pai">
      <div className="pai-head">
        <Sparkles size={14} />
        <b>{title}</b>
        <span className="pm-gap" />
        {modelMenu}
      </div>
      <textarea
        className="pai-input"
        rows={2}
        value={request}
        placeholder={placeholder}
        aria-label={title}
        disabled={running}
        maxLength={400}
        onChange={(e) => setRequest(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault()
            void go()
          }
        }}
      />
      {running ? (
        <div className="pai-row">
          <Loader2 size={14} className="pai-spin" />
          <span className="pai-note">{t('pet.ai.running', { s: secs })}</span>
          <span className="pm-gap" />
          <Button onClick={stop}>
            <Square size={12} /> {t('pet.ai.stop')}
          </Button>
        </div>
      ) : (
        !result && (
          <div className="pai-row">
            <span className="pm-gap" />
            <Button variant="primary" disabled={disabled || !request.trim()} onClick={() => void go()}>
              <Sparkles size={14} /> {t('pet.ai.go')}
            </Button>
          </div>
        )
      )}
      {after}
    </div>
  )
}
