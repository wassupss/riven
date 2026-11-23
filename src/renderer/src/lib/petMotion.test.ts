import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  DOT_CQ,
  SITUATIONS,
  buildMotionPrompt,
  checkMotion,
  checkMotionSet,
  defaultMotion,
  motionAnimation,
  motionBlocks,
  motionCss,
  motionFor,
  motionName,
  parseMotionAnswer,
  sadMotion,
  sanitizeMotionSet,
  situationOf,
  withMotion,
  type MotionSpec
} from './petMotion'
import { heldCount, holdMotion, releaseMotion } from './petMotionStyle'

const spec = (o: Record<string, unknown> = {}): Record<string, unknown> => ({
  keyframes: [
    { at: 0, y: 0 },
    { at: 0.5, y: -3, rot: 5 }
  ],
  duration_ms: 1000,
  easing: 'ease',
  iterations: 2,
  ...o
})

describe('checkMotion', () => {
  it('fills the rest pose, rounds and sorts', () => {
    const r = checkMotion({ keyframes: [{ at: 0.704, x: 1.4 }, { at: 0 }], duration_ms: 1234.4 })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value).toEqual({
      keyframes: [
        { at: 0, x: 0, y: 0, rot: 0, opacity: 1 },
        { at: 0.7, x: 1, y: 0, rot: 0, opacity: 1 }
      ],
      duration_ms: 1234,
      easing: 'steps',
      iterations: 'infinite',
      delay_ms: 0
    })
  })

  it.each([
    ['unknown spec key', { scale: 2 }, 'pet.mo.err.key'],
    ['duration too short', { duration_ms: 100 }, 'pet.mo.err.range'],
    ['duration too long', { duration_ms: 9000 }, 'pet.mo.err.range'],
    ['delay too long', { delay_ms: 4000 }, 'pet.mo.err.range'],
    ['unknown easing', { easing: 'bounce' }, 'pet.mo.err.easing'],
    ['iterations zero', { iterations: 0 }, 'pet.mo.err.range'],
    ['iterations fractional', { iterations: 1.5 }, 'pet.mo.err.type'],
    ['iterations text', { iterations: 'forever' }, 'pet.mo.err.type'],
    ['duration as text', { duration_ms: '1000' }, 'pet.mo.err.type'],
    ['no keyframes', { keyframes: [] }, 'pet.mo.err.count'],
    ['too many keyframes', { keyframes: Array.from({ length: 13 }, (_, i) => ({ at: i / 13 })) }, 'pet.mo.err.count'],
    ['keyframe key', { keyframes: [{ at: 0, scale: 2 }] }, 'pet.mo.err.key'],
    ['x out of range', { keyframes: [{ at: 0, x: 5 }] }, 'pet.mo.err.range'],
    ['y too high', { keyframes: [{ at: 0, y: -7 }] }, 'pet.mo.err.range'],
    ['y too low', { keyframes: [{ at: 0, y: 5 }] }, 'pet.mo.err.range'],
    ['rot out of range', { keyframes: [{ at: 0, rot: 20 }] }, 'pet.mo.err.range'],
    ['opacity too low', { keyframes: [{ at: 0, opacity: 0.1 }] }, 'pet.mo.err.range'],
    ['at past 1', { keyframes: [{ at: 1.2 }] }, 'pet.mo.err.range'],
    ['no at', { keyframes: [{ y: 1 }] }, 'pet.mo.err.type'],
    ['two at the same moment', { keyframes: [{ at: 0.5 }, { at: 0.501 }] }, 'pet.mo.err.sameAt']
  ])('refuses %s', (_, over, reason) => {
    const r = checkMotion(spec(over))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe(reason)
  })

  it('accepts the edges of every range', () => {
    const r = checkMotion({
      keyframes: [
        { at: 0, x: -4, y: -6, rot: -15, opacity: 0.3 },
        { at: 1, x: 4, y: 4, rot: 15, opacity: 1 }
      ],
      duration_ms: 200,
      delay_ms: 3000,
      iterations: 20,
      easing: 'ease-in-out'
    })
    expect(r.ok).toBe(true)
  })
})

describe('checkMotionSet and the AI answer', () => {
  it('takes several situations', () => {
    const r = checkMotionSet({ happy: spec(), resting: spec({ easing: 'ease-in-out', iterations: 'infinite' }) })
    expect(r.ok && Object.keys(r.value)).toEqual(['happy', 'resting'])
  })
  it('refuses the whole answer for one unknown situation or one bad value', () => {
    expect(checkMotionSet({ happy: spec(), dancing: spec() })).toMatchObject({ ok: false, reason: 'pet.mo.err.situation', vars: { k: 'dancing' } })
    const bad = checkMotionSet({ happy: spec(), idle: spec({ duration_ms: 50 }) })
    expect(bad).toMatchObject({ ok: false, reason: 'pet.mo.err.range' })
    if (!bad.ok) expect(bad.vars?.k).toBe('idle.duration_ms')
    expect(checkMotionSet({})).toMatchObject({ ok: false, reason: 'pet.mo.err.empty' })
  })
  it('reads an answer inside a fence, and refuses prose', () => {
    const text = 'Here:\n```json\n' + JSON.stringify({ happy: spec() }) + '\n```'
    expect(parseMotionAnswer(text).ok).toBe(true)
    expect(parseMotionAnswer('jump twice')).toMatchObject({ ok: false, reason: 'pet.mo.err.json' })
  })
  it('a saved set is read leniently', () => {
    expect(sanitizeMotionSet({ happy: spec(), idle: spec({ duration_ms: 1 }), nope: spec() })).toEqual({
      happy: (checkMotion(spec()) as { value: MotionSpec }).value
    })
    expect(sanitizeMotionSet({ idle: 'x' })).toBeUndefined()
    expect(sanitizeMotionSet(null)).toBeUndefined()
  })
  it('the prompt names the focus and every limit', () => {
    const p = buildMotionPrompt('잘 때 천천히 위아래', { idle: defaultMotion('idle', false) }, 'resting')
    expect(p).toContain('it is about "resting"')
    expect(p).toContain('-6..4')
    expect(p).toContain('"steps"')
  })
})

describe('CSS keyframes', () => {
  it('steps holds each keyframe as pet.css writes it', () => {
    const blocks = motionBlocks(defaultMotion('idle', false))
    expect(blocks.map((b) => b.at)).toEqual([
      [0, 50],
      [51, 100]
    ])
    expect(motionCss(defaultMotion('idle', false), 'x')).toBe(
      '@keyframes x { 0%, 50% { transform: translate(0, 0); } 51%, 100% { transform: translate(0, -6.25cqmin); } }'
    )
  })
  it('a late first keyframe starts from rest; a smooth one holds its last to 100%', () => {
    const s = (checkMotion({ keyframes: [{ at: 0.2, y: -1 }, { at: 0.6, y: 1 }], duration_ms: 800, easing: 'ease' }) as { value: MotionSpec }).value
    expect(motionBlocks(s).map((b) => b.at)).toEqual([[0], [20], [60], [100]])
    const st = { ...s, easing: 'steps' as const }
    expect(motionBlocks(st).map((b) => b.at)).toEqual([[0, 19], [20, 59], [60, 100]])
  })
  it('writes rotate and opacity only when the spec uses them', () => {
    expect(motionCss(defaultMotion('idle', false))).not.toMatch(/rotate|opacity/)
    const s = (checkMotion({ keyframes: [{ at: 0 }, { at: 0.5, rot: -5, opacity: 0.5 }], duration_ms: 500 }) as { value: MotionSpec }).value
    const css = motionCss(s, 'y')
    expect(css).toContain('rotate(-5deg)')
    expect(css).toContain('rotate(0deg)')
    expect(css).toContain('opacity: 0.5;')
    expect(css).not.toMatch(/scale/)
  })
  it('names are stable per spec and the animation line follows it', () => {
    const a = defaultMotion('happy', true)
    expect(motionName(a)).toBe(motionName(JSON.parse(JSON.stringify(a))))
    expect(motionName(a)).not.toBe(motionName(defaultMotion('happy', false)))
    expect(motionAnimation(a, 'n')).toBe('n 1200ms steps(1, end) 0ms infinite')
    const once = (checkMotion(spec()) as { value: MotionSpec }).value
    expect(motionAnimation(once, 'n')).toBe('n 1000ms ease 0ms 2')
  })
})

// ---- the defaults are exactly what pet.css does ----

const css = readFileSync(join(__dirname, '../styles/pet.css'), 'utf8')

/** @keyframes `name` of pet.css as percent -> [x, y] in dots. */
function cssFrames(name: string): Map<number, [number, number]> {
  const at = css.indexOf(`@keyframes ${name} {`)
  expect(at).toBeGreaterThan(-1)
  let depth = 0
  let end = at
  for (let i = css.indexOf('{', at); i < css.length; i++) {
    if (css[i] === '{') depth++
    else if (css[i] === '}' && --depth === 0) {
      end = i
      break
    }
  }
  const body = css.slice(css.indexOf('{', at) + 1, end)
  return framesOf(body)
}
function framesOf(body: string): Map<number, [number, number]> {
  const out = new Map<number, [number, number]>()
  const re = /([\d%,\s]+)\{([^}]*)\}/g
  let m: RegExpExecArray | null
  while ((m = re.exec(body))) {
    const tr = /transform:\s*([^;]+);/.exec(m[2])?.[1] ?? ''
    const v = (s: string): number => (s.trim() === '0' ? 0 : parseFloat(s) / DOT_CQ)
    let xy: [number, number] = [0, 0]
    const t2 = /translate\(([^,]+),([^)]+)\)/.exec(tr)
    const ty = /translateY\(([^)]+)\)/.exec(tr)
    const tx = /translateX\(([^)]+)\)/.exec(tr)
    if (t2) xy = [v(t2[1]), v(t2[2])]
    else if (ty) xy = [0, v(ty[1])]
    else if (tx) xy = [v(tx[1]), 0]
    for (const p of m[1].split(',')) if (p.trim()) out.set(parseInt(p), xy)
  }
  return out
}
const ours = (s: MotionSpec): Map<number, [number, number]> => framesOf(motionCss(s, 'n').replace(/^@keyframes n \{/, '').replace(/\}$/, ''))
/** A css duration of a rule's animation (`sel { animation[-duration]: <name>? <dur>s`). */
function durationOf(selector: string): number {
  const at = css.indexOf(`\n${selector} {`)
  expect(at).toBeGreaterThan(-1)
  const rule = css.slice(at, css.indexOf('}', at))
  const m = /animation(?:-duration)?:\s*(?:[a-z-]+\s+)?([\d.]+)s/.exec(rule)
  return Math.round(parseFloat(m![1]) * 1000)
}

describe('defaults reproduce pet.css', () => {
  it('pet-hop, pet-chew, pet-pm-skip, pet-pm-sway, frame for frame', () => {
    expect(ours(defaultMotion('idle', false))).toEqual(cssFrames('pet-hop'))
    expect(ours(defaultMotion('levelup', true))).toEqual(cssFrames('pet-hop'))
    expect(ours(defaultMotion('eat', false))).toEqual(cssFrames('pet-chew'))
    expect(ours(defaultMotion('happy', true))).toEqual(cssFrames('pet-pm-skip'))
    expect(ours(sadMotion(true))).toEqual(cssFrames('pet-pm-sway'))
    expect(ours(defaultMotion('happy', false))).toEqual(cssFrames('pet-hop'))
  })
  it('and their timings', () => {
    expect(defaultMotion('idle', false).duration_ms).toBe(durationOf('.pet-sprite'))
    expect(defaultMotion('happy', false).duration_ms).toBe(durationOf('.pet-m-happy .pet-sprite'))
    expect(sadMotion(false).duration_ms).toBe(durationOf('.pet-m-sad .pet-sprite'))
    expect(defaultMotion('eat', true).duration_ms).toBe(durationOf('.pet-sprite.chew'))
    expect(defaultMotion('levelup', false).duration_ms).toBe(durationOf('.pet-lcd.cheer .pet-sprite'))
    expect(defaultMotion('happy', true).duration_ms).toBe(durationOf('.pet-pm.pet-m-happy .pet-sprite:not(.chew)'))
    expect(sadMotion(true).duration_ms).toBe(durationOf('.pet-pm.pet-m-sad .pet-sprite:not(.chew)'))
    for (const s of SITUATIONS) {
      const d = defaultMotion(s, false)
      expect(d.easing).toBe('steps')
      expect(d.iterations).toBe('infinite')
      expect(d.delay_ms).toBe(0)
      // Every default passes its own check unchanged.
      expect(checkMotion(d)).toEqual({ ok: true, value: d })
    }
  })
  it('working, waiting and resting have always moved like idle', () => {
    for (const s of ['working', 'waiting', 'resting'] as const) expect(defaultMotion(s, true)).toEqual(defaultMotion('idle', true))
  })
})

describe('which motion runs', () => {
  it('a level up over a meal over a pat over a break over waiting over work', () => {
    expect(situationOf({ cheer: true, chewing: true, patted: true })).toBe('levelup')
    expect(situationOf({ chewing: true, patted: true })).toBe('eat')
    expect(situationOf({ patted: true, resting: true })).toBe('happy')
    expect(situationOf({ resting: true, waiting: true })).toBe('resting')
    expect(situationOf({ waiting: true, working: true })).toBe('waiting')
    expect(situationOf({ working: true })).toBe('working')
    expect(situationOf({})).toBe('idle')
  })
  it("a pet's own spec over its species' over the default", () => {
    const a = (checkMotion(spec()) as { value: MotionSpec }).value
    const b = { ...a, duration_ms: 2000 }
    expect(motionFor('happy', { happy: a }, { happy: b }, false)).toBe(a)
    expect(motionFor('happy', undefined, { happy: b }, false)).toBe(b)
    expect(motionFor('happy', undefined, undefined, false)).toEqual(defaultMotion('happy', false))
  })
  it('withMotion sets and clears', () => {
    const a = defaultMotion('idle', false)
    const m = withMotion(undefined, 'idle', a)
    expect(m).toEqual({ idle: a })
    expect(withMotion(m, 'idle', null)).toBeUndefined()
  })
})

describe('the keyframes in a document', () => {
  it('one <style> per spec, shared, removed with its last user', () => {
    const added: Array<{ removed: boolean }> = []
    const doc = {
      createElement: () => {
        const el = { dataset: {} as Record<string, string>, textContent: '', removed: false, remove: () => (el.removed = true) }
        return el
      },
      head: { appendChild: (el: { removed: boolean }) => added.push(el) }
    } as unknown as Document
    holdMotion(doc, 'a', '@keyframes a {}')
    holdMotion(doc, 'a', '@keyframes a {}')
    holdMotion(doc, 'b', '@keyframes b {}')
    expect(added.length).toBe(2)
    expect(heldCount(doc)).toBe(2)
    releaseMotion(doc, 'a')
    expect(added[0].removed).toBe(false)
    releaseMotion(doc, 'a')
    expect(added[0].removed).toBe(true)
    expect(heldCount(doc)).toBe(1)
  })
})
