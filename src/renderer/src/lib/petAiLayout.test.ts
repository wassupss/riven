import { describe, expect, it } from 'vitest'
import { buildLayoutPrompt, layoutGrid, parseLayoutAnswer, rgbaOfDots, type LayoutItem } from './petAiLayout'
import { HAIKU_LAYOUT_ANSWER, LAYOUT_CALL } from './petAi.fixtures'
import { fromRel } from '../state/petLayout'

const items = LAYOUT_CALL.items as LayoutItem[]
const bbox = LAYOUT_CALL.bbox
const ask = (list: unknown[]): string => JSON.stringify({ items: list })

describe('the layout prompt', () => {
  it('has the pet grid, the face, every piece with its size and place, and the request', () => {
    const grid = layoutGrid(
      [
        { x: 1, y: 1 },
        { x: 2, y: 1 },
        { x: 2, y: 2 }
      ],
      { x: 2, y: 1, w: 1, h: 1 },
      4
    )
    expect(grid).toEqual(['....', '.#F.', '..#.', '....'])
    const p = buildLayoutPrompt({ grid, items: items.slice(0, 2), request: '왕관은 머리 위', scale: 16 })
    expect(p.startsWith('Request: 왕관은 머리 위\n')).toBe(true)
    expect(p).toContain('....\n.#F.\n..#.\n....')
    expect(p).toContain('"id":"acc:crown","name":"crown","w":9,"h":6,"x":11,"y":3,"z":"front"')
    expect(p).toContain('0 <= x <= 4 - w')
    expect(p).toContain('each dot drawn as a 16x16 square')
    expect(buildLayoutPrompt({ grid, items: [], request: ' ', scale: 16 })).toContain('do not overlap')
  })
})

describe('checking a layout answer', () => {
  it("takes the real Haiku answer: the badge moved, the extra 'seen' field ignored", () => {
    const r = parseLayoutAnswer(HAIKU_LAYOUT_ANSWER, items, bbox, undefined)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.moved).toBe(1)
    const badge = items.find((i) => i.id === 'decor:badge')!
    // Stored relative, it comes back to the corner the model chose.
    expect(fromRel(r.layout!['decor:badge'] as { x: number; y: number }, badge, bbox)).toEqual({ x: 14, y: 24 })
  })
  it('keeps what was already laid out and adds to it', () => {
    const r = parseLayoutAnswer(ask([{ id: 'acc:star', x: 0, y: 0, z: 'back' }]), items, bbox, { 'decor:halo': { hidden: true } })
    expect(r.ok && r.layout).toMatchObject({ 'decor:halo': { hidden: true }, 'acc:star': { z: 'back' } })
  })
  it('lets a piece left where it is through, and changes only what changed', () => {
    const crown = items[0]
    const r = parseLayoutAnswer(ask([{ id: crown.id, x: crown.x, y: crown.y, z: crown.z }]), items, bbox, undefined)
    expect(r).toEqual({ ok: true, layout: undefined, moved: 0 })
  })
  it('hides and shows when asked', () => {
    const r = parseLayoutAnswer(ask([{ id: 'acc:star', x: 27, y: 0, hidden: true }]), items, bbox, undefined)
    expect(r.ok && r.layout).toEqual({ 'acc:star': { hidden: true } })
  })
  it('refuses an unknown piece, a piece off the grid, missing numbers, no list or no JSON', () => {
    expect(parseLayoutAnswer(ask([{ id: 'acc:rocket', x: 1, y: 1 }]), items, bbox, undefined)).toEqual({ ok: false, reason: 'pet.ai.err.unknown', vars: { id: 'acc:rocket' } })
    // The crown is 9 wide: x 24 would put its right edge at 33.
    expect(parseLayoutAnswer(ask([{ id: 'acc:crown', x: 24, y: 0 }]), items, bbox, undefined)).toEqual({ ok: false, reason: 'pet.ai.err.bounds', vars: { id: 'acc:crown', x: 24, y: 0 } })
    expect(parseLayoutAnswer(ask([{ id: 'acc:crown', x: -1, y: 0 }]), items, bbox, undefined)).toMatchObject({ reason: 'pet.ai.err.bounds' })
    expect(parseLayoutAnswer(ask([{ id: 'acc:crown', x: '3', y: 0 }]), items, bbox, undefined)).toMatchObject({ reason: 'pet.ai.err.xy' })
    expect(parseLayoutAnswer('{"positions": []}', items, bbox, undefined)).toMatchObject({ reason: 'pet.ai.err.items' })
    expect(parseLayoutAnswer('looks good to me', items, bbox, undefined)).toMatchObject({ reason: 'pet.ai.err.json' })
  })
})

describe('the picture for the model', () => {
  it('draws the layers in order, later ones on top, in the colours given', () => {
    const px = rgbaOfDots(
      [[{ x: 0, y: 0, ch: 'b' }], [{ x: 0, y: 0, ch: 'A' }, { x: 1, y: 0, ch: 'zz' }]],
      (ch) => (ch === 'A' ? '#010203' : undefined),
      (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)],
      2
    )
    expect([...px.slice(0, 8)]).toEqual([1, 2, 3, 255, 0x88, 0x88, 0x88, 255])
  })
})
