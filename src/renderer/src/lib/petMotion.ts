import { extractJson } from './petAi'

// ---------------------------------------------------------------------------
// How the pet moves, per situation, as data (the "움직임" editor, its AI box,
// the species file and the pet save). A motion is a small spec: keyframes of
// a translate (in dots of the 32-dot plate), a rotation and an opacity, with a
// duration, an easing from a fixed list, a repeat count and a delay. It is
// turned into ONE @keyframes rule per spec (motionCss), made once per change
// of the spec and run by CSS on the pet's .pet-sprite box: no per-frame JS.
//
// Never a scale: scaling a box that holds an svg kept WebKit's GPU process at
// ~130MB (see pet.css, commit 361b0b4). Ranges are clamped so the pet stays
// inside its box (.pet-lcd clips what leaves it). Opacity is allowed but only
// written into the keyframes when a spec actually fades.
//
// With no spec of its own a situation keeps the motion pet.css gives it
// (defaultMotion describes those exactly; a test reads pet.css to prove it).
// ---------------------------------------------------------------------------

/** What the pet is doing, in the order the editor lists them. */
export const SITUATIONS = ['idle', 'happy', 'working', 'waiting', 'resting', 'levelup', 'eat'] as const
export type Situation = (typeof SITUATIONS)[number]
export const isSituation = (v: unknown): v is Situation => typeof v === 'string' && (SITUATIONS as readonly string[]).includes(v)

export const EASINGS = ['steps', 'linear', 'ease', 'ease-in', 'ease-out', 'ease-in-out'] as const
export type Easing = (typeof EASINGS)[number]

export interface MotionKey {
  /** When, 0..1 of the duration (kept to whole percent). */
  at: number
  /** Dots of the 32-dot plate, + right. */
  x: number
  /** Dots, + down (a hop is negative). */
  y: number
  /** Degrees, + clockwise, about the box's centre. */
  rot: number
  opacity: number
}

export interface MotionSpec {
  keyframes: MotionKey[]
  duration_ms: number
  easing: Easing
  /** A count, or 'infinite'. */
  iterations: number | 'infinite'
  delay_ms: number
}

export type MotionSet = Partial<Record<Situation, MotionSpec>>

/** The ranges every spec is held to (the AI's answers are refused outside them). */
export const LIMITS = {
  keyframes: { min: 1, max: 12 },
  at: { min: 0, max: 1 },
  x: { min: -4, max: 4 },
  y: { min: -6, max: 4 },
  rot: { min: -15, max: 15 },
  opacity: { min: 0.3, max: 1 },
  duration_ms: { min: 200, max: 8000 },
  delay_ms: { min: 0, max: 3000 },
  iterations: { min: 1, max: 20 }
} as const

/** One dot of the 32-dot plate in the sprite box's units (.pet-lcd is a size container). */
export const DOT_CQ = 3.125

const SPEC_KEYS = ['keyframes', 'duration_ms', 'easing', 'iterations', 'delay_ms']
const KEY_KEYS = ['at', 'x', 'y', 'rot', 'opacity']

export type MotionCheck<T> = { ok: true; value: T } | { ok: false; reason: string; vars?: Record<string, string | number> }
const fail = <T>(reason: string, vars?: Record<string, string | number>): MotionCheck<T> => ({ ok: false, reason, ...(vars ? { vars } : {}) })

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const round = (v: number, step: number): number => Math.round(v / step) * step
const tidy = (v: number): number => {
  const r = +v.toFixed(4)
  return Object.is(r, -0) ? 0 : r
}

function inRange<T>(k: keyof typeof LIMITS, v: unknown, where: string): MotionCheck<T> | null {
  if (!isNum(v)) return fail('pet.mo.err.type', { k: where })
  const { min, max } = LIMITS[k]
  if (v < min || v > max) return fail('pet.mo.err.range', { k: where, v, min, max })
  return null
}

/**
 * One spec, checked strictly: an unknown key, a value of the wrong type or
 * out of range refuses it with the reason. Missing x, y, rot, opacity are the
 * rest pose (0, 0, 0, 1); missing delay is 0; missing easing is 'steps'.
 * Values are rounded to what is drawn: whole percent, whole dots and degrees,
 * opacity in 0.05. Keyframes are sorted by `at`; two at the same moment refuse.
 */
export function checkMotion(raw: unknown, label = ''): MotionCheck<MotionSpec> {
  const p = label ? `${label}.` : ''
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('pet.mo.err.spec', { k: label || '-' })
  const o = raw as Record<string, unknown>
  for (const k of Object.keys(o)) if (!SPEC_KEYS.includes(k)) return fail('pet.mo.err.key', { k: p + k })
  if (!Array.isArray(o.keyframes)) return fail('pet.mo.err.type', { k: `${p}keyframes` })
  const n = o.keyframes.length
  if (n < LIMITS.keyframes.min || n > LIMITS.keyframes.max)
    return fail('pet.mo.err.count', { k: `${p}keyframes`, v: n, min: LIMITS.keyframes.min, max: LIMITS.keyframes.max })
  const keys: MotionKey[] = []
  for (let i = 0; i < n; i++) {
    const kf = o.keyframes[i] as unknown
    const w = `${p}keyframes[${i}]`
    if (!kf || typeof kf !== 'object' || Array.isArray(kf)) return fail('pet.mo.err.type', { k: w })
    const f = kf as Record<string, unknown>
    for (const k of Object.keys(f)) if (!KEY_KEYS.includes(k)) return fail('pet.mo.err.key', { k: `${w}.${k}` })
    const v = { at: f.at, x: f.x ?? 0, y: f.y ?? 0, rot: f.rot ?? 0, opacity: f.opacity ?? 1 }
    for (const k of KEY_KEYS as Array<keyof typeof v>) {
      const bad = inRange<MotionSpec>(k, v[k], `${w}.${k}`)
      if (bad) return bad
    }
    keys.push({
      at: tidy(round(v.at as number, 0.01)),
      x: tidy(Math.round(v.x as number)),
      y: tidy(Math.round(v.y as number)),
      rot: tidy(Math.round(v.rot as number)),
      opacity: tidy(round(v.opacity as number, 0.05))
    })
  }
  keys.sort((a, b) => a.at - b.at)
  for (let i = 1; i < keys.length; i++) if (keys[i].at === keys[i - 1].at) return fail('pet.mo.err.sameAt', { k: `${p}keyframes`, v: keys[i].at })
  const dur = inRange<MotionSpec>('duration_ms', o.duration_ms, `${p}duration_ms`)
  if (dur) return dur
  const delay = o.delay_ms ?? 0
  const del = inRange<MotionSpec>('delay_ms', delay, `${p}delay_ms`)
  if (del) return del
  const easing = o.easing ?? 'steps'
  if (typeof easing !== 'string' || !(EASINGS as readonly string[]).includes(easing))
    return fail('pet.mo.err.easing', { k: `${p}easing`, v: String(easing) })
  let iterations: number | 'infinite'
  if (o.iterations === 'infinite' || o.iterations === undefined) iterations = 'infinite'
  else {
    const it = inRange<MotionSpec>('iterations', o.iterations, `${p}iterations`)
    if (it) return it
    if (!Number.isInteger(o.iterations)) return fail('pet.mo.err.type', { k: `${p}iterations` })
    iterations = o.iterations as number
  }
  return {
    ok: true,
    value: {
      keyframes: keys,
      duration_ms: Math.round(o.duration_ms as number),
      easing: easing as Easing,
      iterations,
      delay_ms: Math.round(delay as number)
    }
  }
}

/** A set of specs ({situation: spec}), checked strictly: one bad entry refuses all. */
export function checkMotionSet(raw: unknown): MotionCheck<MotionSet> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('pet.mo.err.json')
  const out: MotionSet = {}
  const entries = Object.entries(raw as Record<string, unknown>)
  if (!entries.length) return fail('pet.mo.err.empty')
  for (const [k, v] of entries) {
    if (!isSituation(k)) return fail('pet.mo.err.situation', { k })
    const r = checkMotion(v, k)
    if (!r.ok) return r
    out[k] = r.value
  }
  return { ok: true, value: out }
}

/** A saved set read leniently: what checks is kept, the rest dropped (a hand-edited file never breaks a pet). */
export function sanitizeMotionSet(raw: unknown): MotionSet | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const out: MotionSet = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!isSituation(k)) continue
    const r = checkMotion(v)
    if (r.ok) out[k] = r.value
  }
  return Object.keys(out).length ? out : undefined
}

// ---- the motions pet.css has always had ----

const key = (at: number, x = 0, y = 0): MotionKey => ({ at, x, y, rot: 0, opacity: 1 })
const loop = (keyframes: MotionKey[], duration_ms: number): MotionSpec => ({
  keyframes,
  duration_ms,
  easing: 'steps',
  iterations: 'infinite',
  delay_ms: 0
})
/** pet-hop: two dots up for the second half. */
const hop = (ms: number): MotionSpec => loop([key(0), key(0.51, 0, -2)], ms)

/**
 * What a situation does with no spec of its own: exactly what pet.css does
 * (`photo`: a faithful picture, whose happiness is a skip rather than a hop).
 * Working, waiting and resting have never moved differently from idle.
 */
export function defaultMotion(s: Situation, photo: boolean): MotionSpec {
  switch (s) {
    case 'happy':
      // pet-pm-skip, or .pet-m-happy's faster hop.
      return photo ? loop([key(0, 0, -2), key(0.16), key(0.31, 0, -3), key(0.46)], 1200) : hop(900)
    case 'levelup':
      return hop(250) // .pet-lcd.cheer
    case 'eat':
      return loop([key(0), key(0.51, 0, 2)], 300) // pet-chew
    default:
      return hop(1600) // pet-hop
  }
}

/** The battle loser's sulk, pet.css pet-pm-sway / the slow hop (not editable; tests compare it). */
export function sadMotion(photo: boolean): MotionSpec {
  return photo ? loop([key(0, 0, 1), key(0.41, -1, 1), key(0.61, 0, 1), key(0.81, 1, 1)], 3600) : hop(2800)
}

/** The spec a pet runs for a situation: its own, else the species', else the default. */
export function motionFor(s: Situation, own: MotionSet | undefined, species: MotionSet | undefined, photo: boolean): MotionSpec {
  return own?.[s] ?? species?.[s] ?? defaultMotion(s, photo)
}

/**
 * The situation from what the pet is going through, most pressing first, in
 * the order pet.css lets them win: a level up over a meal over the rest.
 */
export function situationOf(f: {
  cheer?: boolean
  chewing?: boolean
  patted?: boolean
  resting?: boolean
  waiting?: boolean
  working?: boolean
}): Situation {
  if (f.cheer) return 'levelup'
  if (f.chewing) return 'eat'
  if (f.patted) return 'happy'
  if (f.resting) return 'resting'
  if (f.waiting) return 'waiting'
  if (f.working) return 'working'
  return 'idle'
}

// ---- CSS ----

const pct = (at: number): number => Math.round(at * 100)
const cq = (dots: number): string => (dots === 0 ? '0' : `${tidy(dots * DOT_CQ)}cqmin`)

/** A keyframe's declarations; rotate and opacity only when the spec uses them anywhere. */
function decls(k: MotionKey, rot: boolean, fade: boolean): string {
  let tr = `translate(${cq(k.x)}, ${cq(k.y)})`
  if (rot) tr += ` rotate(${tidy(k.rot)}deg)`
  return `transform: ${tr};${fade ? ` opacity: ${tidy(k.opacity)};` : ''}`
}

/** The keyframes' body: `<selector> { <decls> }` blocks, in order. */
export function motionBlocks(spec: MotionSpec): Array<{ at: number[]; decl: string }> {
  const rot = spec.keyframes.some((k) => k.rot !== 0)
  const fade = spec.keyframes.some((k) => k.opacity !== 1)
  const keys = spec.keyframes
  const rest = key(0)
  const out: Array<{ at: number[]; decl: string }> = []
  if (pct(keys[0].at) > 0) out.push({ at: [0], decl: decls(rest, rot, fade) })
  if (spec.easing === 'steps') {
    // Held until the next keyframe, as pet.css writes them: "0%, 50%" then "51%, 100%".
    keys.forEach((k, i) => {
      const from = pct(k.at)
      const next = i + 1 < keys.length ? pct(keys[i + 1].at) - 1 : 100
      out.push({ at: next > from ? [from, next] : [from], decl: decls(k, rot, fade) })
    })
    // A rest pose before the first keyframe is held too.
    if (out.length > keys.length) {
      const first = pct(keys[0].at) - 1
      if (first > 0) out[0].at = [0, first]
    }
  } else {
    for (const k of keys) out.push({ at: [pct(k.at)], decl: decls(k, rot, fade) })
    const last = keys[keys.length - 1]
    if (pct(last.at) < 100) out.push({ at: [100], decl: decls(last, rot, fade) })
  }
  return out
}

/** The CSS timing function for an easing (steps holds each keyframe, whole-dot jumps like pet.css). */
export const timingOf = (e: Easing): string => (e === 'steps' ? 'steps(1, end)' : e)

/** A stable, short name for a spec: the same spec is always the same rule. */
export function motionName(spec: MotionSpec): string {
  const s = JSON.stringify(spec)
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return `pet-mo-${(h >>> 0).toString(36)}`
}

/** The whole @keyframes rule. */
export function motionCss(spec: MotionSpec, name = motionName(spec)): string {
  const body = motionBlocks(spec)
    .map((b) => `${b.at.map((a) => `${a}%`).join(', ')} { ${b.decl} }`)
    .join(' ')
  return `@keyframes ${name} { ${body} }`
}

/** The `animation` shorthand that runs it. */
export function motionAnimation(spec: MotionSpec, name = motionName(spec)): string {
  return `${name} ${spec.duration_ms}ms ${timingOf(spec.easing)} ${spec.delay_ms}ms ${spec.iterations}`
}

/** Whether two specs move the same (for "기본" badges and no-op edits). */
export const sameMotion = (a: MotionSpec | undefined, b: MotionSpec | undefined): boolean =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

/** A set with one situation set or cleared; undefined when nothing is left. */
export function withMotion(set: MotionSet | undefined, s: Situation, spec: MotionSpec | null): MotionSet | undefined {
  const next: MotionSet = { ...(set ?? {}) }
  if (spec) next[s] = spec
  else delete next[s]
  return Object.keys(next).length ? next : undefined
}

// ---- the AI box ----

export const MOTION_SYSTEM = [
  'You design short motions for a small pixel-art desktop pet (32x32 dots).',
  'Reply with exactly one JSON object and nothing else: no prose, no code fences.'
].join(' ')

const SITUATION_TEXT: Record<Situation, string> = {
  idle: 'idle: nothing special is happening',
  happy: 'happy: it was just patted (lasts about 4 s)',
  working: 'working: an AI agent is busy',
  waiting: 'waiting: an agent waits for the user',
  resting: 'resting: the user is on a break (sleepy, calm)',
  levelup: 'levelup: it just levelled up (lasts about 2.6 s)',
  eat: 'eat: it is chewing food (lasts about 1.6 s)'
}

/** The request and what moves now, as the model reads it. */
export function buildMotionPrompt(request: string, current: Partial<Record<Situation, MotionSpec>>, focus: Situation): string {
  const L = LIMITS
  return [
    `Request: ${request.trim()}`,
    '',
    'Situations (use these names as keys):',
    ...SITUATIONS.map((s) => `- ${SITUATION_TEXT[s]}`),
    `If the request does not name a situation, it is about "${focus}".`,
    '',
    'Current motions:',
    JSON.stringify(current),
    '',
    'Answer with only the situations the request changes:',
    '{"<situation>": {"keyframes": [{"at": 0, "x": 0, "y": 0, "rot": 0, "opacity": 1}, ...], "duration_ms": 1200, "easing": "steps", "iterations": "infinite", "delay_ms": 0}}',
    '',
    'Rules:',
    `- at: 0..1, when in the cycle; each keyframe a different at. ${L.keyframes.min}..${L.keyframes.max} keyframes.`,
    `- x: ${L.x.min}..${L.x.max} dots (+ is right). y: ${L.y.min}..${L.y.max} dots (negative is UP, a jump).`,
    `- rot: ${L.rot.min}..${L.rot.max} degrees. opacity: ${L.opacity.min}..1. No scaling.`,
    `- duration_ms: ${L.duration_ms.min}..${L.duration_ms.max}. delay_ms: ${L.delay_ms.min}..${L.delay_ms.max}.`,
    `- iterations: 1..${L.iterations.max} or "infinite".`,
    `- easing: one of ${EASINGS.map((e) => `"${e}"`).join(', ')}. "steps" holds each keyframe and jumps (pixel-art style); the others glide.`,
    '- No other keys. Whole dots and degrees.'
  ].join('\n')
}

/** The model's answer as specs, or why it is refused (an i18n key and its values). */
export function parseMotionAnswer(text: string): MotionCheck<MotionSet> {
  const j = extractJson(text)
  if (!j) return fail('pet.mo.err.json')
  return checkMotionSet(j)
}
