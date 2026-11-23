import { describe, it, expect } from 'vitest'
import {
  applyCommand,
  briefOf,
  deductOwed,
  feedOwn,
  normalize,
  normalizeNest,
  restart,
  splitFood,
  turnFood,
  withAssistant,
  CACHE_READ_WEIGHT
} from './pet'
import { defaultAssistant } from '../lib/petAssistant'
import { XP_TOKENS } from './petLevel'

const NOW = Date.UTC(2026, 10, 23, 12)

describe('the assistant on a pet save', () => {
  it('is absent from an old save and survives a round trip', () => {
    const old = normalize({ version: 4, bornAt: NOW - 1000, species: 'cat', name: 'a' }, NOW)
    expect(old.assistant).toBeUndefined()
    const cfg = { ...defaultAssistant(), role: 'reviewer', model: 'haiku' }
    const back = normalize(JSON.parse(JSON.stringify({ ...old, assistant: cfg })), NOW)
    expect(back.assistant).toEqual(cfg)
  })

  it('is sanitized when the nest is read', () => {
    const n = normalizeNest(
      { version: 4, active: 0, pets: [{ bornAt: NOW - 5, species: 'dog', assistant: { on: true, permission: 'bypassPermissions', model: 42 } }] },
      NOW
    )
    expect(n.pets[0].assistant).toEqual({ ...defaultAssistant(), on: true })
  })

  it('is set and cleared by a command, and reaches the brief', () => {
    const n = normalizeNest(null, NOW)
    const ref = { index: 0, bornAt: n.pets[0].bornAt }
    const on = applyCommand(n, { op: 'assistant', ...ref, assistant: { ...defaultAssistant(), role: 'r' } }, NOW)
    expect(on.result).toBe('ok')
    expect(on.nest.pets[0].assistant?.role).toBe('r')
    expect(briefOf(on.nest).pets[0].assistant?.role).toBe('r')
    // The same settings again change nothing (the same nest back).
    const same = applyCommand(on.nest, { op: 'assistant', ...ref, assistant: { ...defaultAssistant(), role: 'r' } }, NOW)
    expect(same.nest).toBe(on.nest)
    const off = applyCommand(on.nest, { op: 'assistant', ...ref, assistant: null }, NOW)
    expect(off.nest.pets[0].assistant).toBeUndefined()
    expect('assistant' in briefOf(off.nest).pets[0]).toBe(false)
    // A command about a pet that moved is refused.
    expect(applyCommand(n, { op: 'assistant', index: 0, bornAt: 1, assistant: null }, NOW).result).toBe('stale')
  })

  it('is kept when the pet starts over', () => {
    const n = normalizeNest(null, NOW)
    const withA = { ...n, pets: [withAssistant(n.pets[0], defaultAssistant())] }
    const again = restart(withA, NOW + 10)
    expect(again.pets[0].assistant).toEqual(defaultAssistant())
    expect(again.pets[0].bornAt).not.toBe(n.pets[0].bornAt)
  })
})

describe('an assistant pet eats from its own work', () => {
  it('turns usage records into food per flavour', () => {
    expect(
      turnFood([
        { model: 'claude-haiku-4-5', input: 100, output: 50, cacheWrite: 10, cacheRead: 1000 },
        { model: 'claude-haiku-4-5', input: 1, output: 1, cacheWrite: 0, cacheRead: 0 },
        { model: 'claude-opus-5', input: 0, output: 0, cacheWrite: 0, cacheRead: 0 }
      ])
    ).toEqual({ haiku: Math.floor(160 + 1000 * CACHE_READ_WEIGHT + 2) })
  })

  it('feeds that pet alone, out on screen or not', () => {
    const base = normalizeNest(null, NOW)
    const a = base.pets[0]
    const b = { ...a, bornAt: a.bornAt + 1 }
    const n = { pets: [a, b], active: 0 }
    const r = feedOwn(n, b.bornAt, { haiku: XP_TOKENS * 2 }, NOW)
    expect(r.pets[0]).toBe(a)
    expect(r.pets[1].xp).toBe(2)
    expect(r.pets[1].diet.haiku).toBe(2)
    expect(r.leveled.length).toBeGreaterThanOrEqual(0)
    // Someone not in the nest, or nothing to eat: nothing changes.
    expect(feedOwn(n, 12345, { haiku: 10 }, NOW).pets).toBe(n.pets)
    expect(feedOwn(n, b.bornAt, { haiku: 0 }, NOW).pets).toBe(n.pets)
  })

  it('is not fed twice: the shared sample leaves out what it already ate', () => {
    const deltas = { 'f2:acc::haiku': 1000, 'f2:acc::opus': 500, 'f2:other::haiku': 300 }
    const r = deductOwed(deltas, { haiku: 1200 })
    expect(r.deltas).toEqual({ 'f2:acc::opus': 500, 'f2:other::haiku': 100 })
    expect(r.owed).toEqual({})
    // Owed more than the sample has: the rest waits for the next one.
    const r2 = deductOwed({ 'f2:acc::haiku': 100 }, { haiku: 250, opus: 7 })
    expect(r2.deltas).toEqual({})
    expect(r2.owed).toEqual({ haiku: 150, opus: 7 })
    // Nothing owed: the sample is shared as it was.
    expect(deductOwed(deltas, {}).deltas).toEqual(deltas)
  })

  it('keeps every token counted once across the two paths', () => {
    // The assistant's turn: 900 haiku tokens to it. The account's usage then
    // grows by 1500 haiku tokens: its 900 and 600 of other work.
    const own = 900
    const { deltas } = deductOwed({ 'f2:acc::haiku': 1500 }, { haiku: own })
    const shares = splitFood(deltas, 2)
    const shared = shares.reduce((n, s) => n + (s['f2:acc::haiku'] ?? 0), 0)
    expect(own + shared).toBe(1500)
  })
})
