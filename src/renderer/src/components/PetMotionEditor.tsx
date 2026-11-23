import '../styles/pet-maker.css'
import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react'
import { Play, Plus, RotateCcw, Trash2, Undo2 } from 'lucide-react'
import { useT } from '../i18n'
import { Button, NumberInput, Select, Switch } from './ui/Controls'
import { Creature } from './PetDevice'
import PetAiAsk from './PetAiAsk'
import type { Species } from '../state/pet'
import {
  EASINGS,
  LIMITS,
  MOTION_SYSTEM,
  SITUATIONS,
  buildMotionPrompt,
  checkMotion,
  defaultMotion,
  parseMotionAnswer,
  withMotion,
  type Easing,
  type MotionKey,
  type MotionSet,
  type MotionSpec,
  type Situation
} from '../lib/petMotion'
import type { FrameMap } from '../lib/petFrames'
import { emptyHistory, pushHistory, undo as undoOf, type History } from '../lib/pixelEdit'

// ---------------------------------------------------------------------------
// 움직임: how a pet moves in each situation (lib/petMotion.ts). The species
// maker shows it for a homemade species (with its frame strip as children),
// Settings > 리븐펫 for one pet (its own specs over its species'). The pet is
// previewed by the same Creature as anywhere else, running the spec through
// the same generated @keyframes; "AI에게 부탁하기" asks for specs, which are
// checked whole before they can be applied.
// ---------------------------------------------------------------------------

/** A value with undo: a change is a step, a run of changes with the same key one step. */
export function useUndoable<T>(initial: T): {
  value: T
  set: (next: T, key?: string | null) => void
  /** Change it without an undo step (what is drawn inside a frame has the pixel editor's undo). */
  replace: (next: T | ((v: T) => T)) => void
  undo: () => void
  canUndo: boolean
  reset: (v: T) => void
} {
  const [state, setState] = useState<{ value: T; history: History<T> }>({ value: initial, history: emptyHistory() })
  const set = useCallback(
    (next: T, key: string | null = null) =>
      setState((s) => (Object.is(s.value, next) ? s : { value: next, history: pushHistory(s.history, s.value, key) })),
    []
  )
  const replace = useCallback(
    (next: T | ((v: T) => T)) =>
      setState((s) => ({ ...s, value: typeof next === 'function' ? (next as (v: T) => T)(s.value) : next })),
    []
  )
  const undo = useCallback(
    () =>
      setState((s) => {
        const r = undoOf(s.history, s.value)
        return r ? { value: r.state, history: { ...r.history, future: [] } } : s
      }),
    []
  )
  const reset = useCallback((v: T) => setState({ value: v, history: emptyHistory() }), [])
  return { value: state.value, set, replace, undo, canUndo: state.history.past.length > 0, reset }
}

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v))

export default function PetMotionEditor({
  species,
  level = 1,
  photo,
  base,
  value,
  onChange,
  canUndo,
  onUndo,
  situation,
  onSituation,
  frames,
  children
}: {
  /** Who is previewed (a species id, or the maker's draft id). */
  species: Species
  level?: number
  /** A faithful picture (its default happy motion is a skip). */
  photo: boolean
  /** What a situation falls back to before the default (a pet's species' specs). */
  base?: MotionSet
  /** The specs being edited (only the situations changed). */
  value: MotionSet | undefined
  /** A change; `key` folds a run of the same edit into one undo step. */
  onChange: (next: MotionSet | undefined, key?: string | null) => void
  canUndo: boolean
  onUndo: () => void
  situation: Situation
  onSituation: (s: Situation) => void
  /** Frames per situation, for the preview. */
  frames?: FrameMap
  /** The frame strip (the maker's), under the fields. */
  children?: ReactNode
}): JSX.Element {
  const t = useT()
  const [replay, setReplay] = useState(0)
  const [err, setErr] = useState<string | null>(null)
  const own = value?.[situation]
  const fallback = base?.[situation] ?? defaultMotion(situation, photo)
  const spec = own ?? fallback
  // The preview always runs the generated keyframes, the default's too.
  const shown = useMemo(() => {
    const all: MotionSet = {}
    for (const s of SITUATIONS) all[s] = value?.[s] ?? base?.[s] ?? defaultMotion(s, photo)
    return all
  }, [value, base, photo])

  // A field changed: the spec checked whole, kept only when it passes.
  const editRef = useRef(spec)
  editRef.current = spec
  const put = (next: Record<string, unknown>, key: string): void => {
    const r = checkMotion(next)
    if (!r.ok) return setErr(t('pet.mo.bad', { why: t(r.reason, r.vars) }))
    setErr(null)
    onChange(withMotion(value, situation, r.value), `${situation}:${key}`)
  }
  const field = (k: 'duration_ms' | 'delay_ms', v: number): void => put({ ...editRef.current, [k]: v }, k)
  const setKey = (i: number, k: keyof MotionKey, v: number): void => {
    const keyframes = editRef.current.keyframes.map((f, j) => (j === i ? { ...f, [k]: v } : f))
    put({ ...editRef.current, keyframes }, `kf${i}${k}`)
  }
  const addKey = (): void => {
    const ks = editRef.current.keyframes
    if (ks.length >= LIMITS.keyframes.max) return
    const last = ks[ks.length - 1]
    // Halfway between the last and the end (or before the last when it is at the end).
    const at = last.at < 1 ? Math.round(((last.at + 1) / 2) * 100) / 100 : Math.round(((ks[ks.length - 2]?.at ?? 0) + last.at) * 50) / 100
    put({ ...editRef.current, keyframes: [...ks, { ...last, at }] }, 'add')
  }
  const dropKey = (i: number): void => {
    const ks = editRef.current.keyframes
    if (ks.length <= LIMITS.keyframes.min) return
    put({ ...editRef.current, keyframes: ks.filter((_, j) => j !== i) }, 'drop')
  }

  const num = (k: keyof MotionKey, i: number, f: MotionKey): JSX.Element => {
    const lim = k === 'at' ? { min: 0, max: 100 } : LIMITS[k]
    const v = k === 'at' ? Math.round(f.at * 100) : f[k]
    return (
      <NumberInput
        aria-label={`${t(`pet.mo.kf.${k}`)} ${i + 1}`}
        className="pmo-num"
        min={lim.min}
        max={lim.max}
        step={k === 'opacity' ? 0.05 : 1}
        value={v}
        onChange={(e) => {
          const n = Number(e.target.value)
          if (!Number.isFinite(n) || e.target.value === '') return
          const c = clamp(n, lim.min, lim.max)
          setKey(i, k, k === 'at' ? c / 100 : c)
        }}
      />
    )
  }

  return (
    <div className="pmo">
      <div className="pmo-sits" role="tablist" aria-label={t('pet.mo.situations')}>
        {SITUATIONS.map((s) => (
          <button
            key={s}
            type="button"
            role="tab"
            aria-selected={s === situation}
            className={`pet-chip${s === situation ? ' on' : ''}`}
            onClick={() => {
              setErr(null)
              onSituation(s)
            }}
          >
            {t(`pet.mo.sit.${s}`)}
            {(value?.[s] || frames?.[s]) && <span className="pmo-mark" aria-label={t('pet.mo.custom')} />}
          </button>
        ))}
      </div>

      <div className="pmo-stage">
        <div className="pmo-pet">
          <Creature species={species} mood="ok" chewing={false} level={level} situation={situation} motions={shown} frames={frames} replay={replay} />
        </div>
        <div className="pmo-stage-side">
          <span className="pmk-note">{own ? t('pet.mo.custom') : base?.[situation] ? t('pet.mo.fromSpecies') : t('pet.mo.default')}</span>
          <div className="pmk-row">
            <Button onClick={() => setReplay((n) => n + 1)} title={t('pet.mo.play')}>
              <Play size={14} /> {t('pet.mo.play')}
            </Button>
            <Button variant="ghost" disabled={!canUndo} onClick={onUndo} title={t('pet.px.undo')} aria-label={t('pet.px.undo')}>
              <Undo2 size={14} />
            </Button>
          </div>
          {own && (
            <Button variant="ghost" onClick={() => onChange(withMotion(value, situation, null))}>
              <RotateCcw size={14} /> {t('pet.mo.reset')}
            </Button>
          )}
        </div>
      </div>

      <div className="pmo-fields">
        <label className="pmo-field">
          <span>{t('pet.mo.duration')}</span>
          <NumberInput
            className="pmo-num"
            min={LIMITS.duration_ms.min}
            max={LIMITS.duration_ms.max}
            step={50}
            value={spec.duration_ms}
            onChange={(e) => e.target.value !== '' && field('duration_ms', clamp(Number(e.target.value), LIMITS.duration_ms.min, LIMITS.duration_ms.max))}
          />
        </label>
        <label className="pmo-field">
          <span>{t('pet.mo.easing')}</span>
          <Select value={spec.easing} onChange={(e) => put({ ...spec, easing: e.target.value as Easing }, 'easing')}>
            {EASINGS.map((x) => (
              <option key={x} value={x}>
                {t(`pet.mo.ease.${x}`)}
              </option>
            ))}
          </Select>
        </label>
        <div className="pmo-field">
          <span>{t('pet.mo.repeat')}</span>
          <span className="pmk-row">
            <Switch
              checked={spec.iterations === 'infinite'}
              onChange={(v) => put({ ...spec, iterations: v ? 'infinite' : 1 }, 'iter')}
            />
            <span className="pmk-note">{t('pet.mo.loop')}</span>
            {spec.iterations !== 'infinite' && (
              <NumberInput
                className="pmo-num"
                aria-label={t('pet.mo.times')}
                min={LIMITS.iterations.min}
                max={LIMITS.iterations.max}
                value={spec.iterations}
                onChange={(e) =>
                  e.target.value !== '' &&
                  put({ ...spec, iterations: Math.round(clamp(Number(e.target.value), LIMITS.iterations.min, LIMITS.iterations.max)) }, 'iter')
                }
              />
            )}
          </span>
        </div>
        <label className="pmo-field">
          <span>{t('pet.mo.delay')}</span>
          <NumberInput
            className="pmo-num"
            min={LIMITS.delay_ms.min}
            max={LIMITS.delay_ms.max}
            step={50}
            value={spec.delay_ms}
            onChange={(e) => e.target.value !== '' && field('delay_ms', clamp(Number(e.target.value), LIMITS.delay_ms.min, LIMITS.delay_ms.max))}
          />
        </label>
      </div>

      <div className="pmo-keys" role="table" aria-label={t('pet.mo.keys')}>
        <div className="pmo-key head" role="row">
          {(['at', 'x', 'y', 'rot', 'opacity'] as Array<keyof MotionKey>).map((k) => (
            <span key={k} role="columnheader" title={t(`pet.mo.kf.${k}Hint`)}>
              {t(`pet.mo.kf.${k}`)}
            </span>
          ))}
          <span />
        </div>
        {spec.keyframes.map((f, i) => (
          <div key={i} className="pmo-key" role="row">
            {num('at', i, f)}
            {num('x', i, f)}
            {num('y', i, f)}
            {num('rot', i, f)}
            {num('opacity', i, f)}
            <button
              type="button"
              className="pmx-btn"
              disabled={spec.keyframes.length <= LIMITS.keyframes.min}
              aria-label={t('pet.mo.dropKey')}
              title={t('pet.mo.dropKey')}
              onClick={() => dropKey(i)}
            >
              <Trash2 size={13} />
            </button>
          </div>
        ))}
        <div className="pmk-row">
          <Button disabled={spec.keyframes.length >= LIMITS.keyframes.max} onClick={addKey}>
            <Plus size={14} /> {t('pet.mo.addKey')}
          </Button>
        </div>
        {err && <p className="pm-error">{err}</p>}
      </div>

      {children}

      <PetAiAsk<MotionSet>
        title={t('pet.ai.title')}
        placeholder={t('pet.mo.aiHint')}
        build={(q) => ({ system: MOTION_SYSTEM, prompt: buildMotionPrompt(q, shown, situation), images: [] })}
        check={(text) => {
          const r = parseMotionAnswer(text)
          return r.ok ? { ok: true, result: r.value } : r
        }}
        preview={(next) => (
          <div className="pmo-ai">
            {(Object.keys(next) as Situation[]).map((s) => (
              <figure key={s}>
                <div className="pm-pet">
                  <Creature species={species} mood="ok" chewing={false} level={level} situation={s} motions={{ ...shown, ...next }} frames={frames} />
                </div>
                <figcaption>{t(`pet.mo.sit.${s}`)}</figcaption>
              </figure>
            ))}
          </div>
        )}
        onApply={(next) => {
          let m = value
          for (const [s, sp] of Object.entries(next) as Array<[Situation, MotionSpec]>) m = withMotion(m, s, sp)
          onChange(m)
          const first = Object.keys(next)[0] as Situation | undefined
          if (first && !next[situation]) onSituation(first)
          setReplay((n) => n + 1)
        }}
      />
    </div>
  )
}
