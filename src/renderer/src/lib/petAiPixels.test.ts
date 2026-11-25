import { describe, expect, it } from 'vitest'
import { extractJson, normalizeHex, scaleFor, usageTokens } from './petAi'
import { buildPixelPrompt, gridRows, parsePixelAnswer, rgbaOfDoc } from './petAiPixels'
import { BLOB, HAIKU_PIXEL_ANSWER } from './petAi.fixtures'
import type { PixelDoc } from './pixelEdit'

const blob = (): PixelDoc => ({ w: BLOB.n, h: BLOB.n, cells: Uint8Array.from(BLOB.cells), palette: [...BLOB.palette] })

/** A tiny picture for hand-written answers: n x n, slot 1 on the diagonal. */
const tiny = (n = 4): PixelDoc => {
  const cells = new Uint8Array(n * n)
  for (let i = 0; i < n; i++) cells[i * n + i] = 1
  return { w: n, h: n, cells, palette: ['#112233'] }
}
const answer = (grid: unknown, palette: unknown): string => JSON.stringify({ grid, palette })

describe('the answer as JSON', () => {
  it('reads a bare object, a fenced one, or one inside a sentence', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 })
    expect(extractJson('Here:\n```json\n{"a":2}\n```')).toEqual({ a: 2 })
    expect(extractJson('Sure! {"a":3} Hope that helps.')).toEqual({ a: 3 })
    expect(extractJson('no json here')).toBeNull()
    expect(extractJson('[1,2]')).toBeNull()
  })
  it('normalises colours', () => {
    expect(normalizeHex('#AABBCC')).toBe('#aabbcc')
    expect(normalizeHex('abc')).toBe('#aabbcc')
    expect(normalizeHex(' #0f0 ')).toBe('#00ff00')
    expect(normalizeHex('red')).toBeNull()
    expect(normalizeHex('#12345')).toBeNull()
    expect(normalizeHex(7)).toBeNull()
  })
  it('scales a picture to about 512 across and adds the tokens up', () => {
    expect(scaleFor(32)).toBe(16)
    expect(scaleFor(48)).toBe(10)
    expect(scaleFor(64)).toBe(8)
    expect(usageTokens({ input: 2, output: 10, cacheRead: 100, cacheWrite: 1000 })).toBe(1112)
    expect(usageTokens(undefined)).toBe(0)
  })
})

describe('the prompt', () => {
  it('has the grid row by row, the palette, the size, the cap and the request', () => {
    const d = blob()
    const p = buildPixelPrompt(d, '  머리에 빨간 모자  ', { scale: 16, photo: false })
    expect(p.startsWith('Request: 머리에 빨간 모자\n')).toBe(true)
    expect(p).toContain('32x32 dots')
    expect(p).toContain('0 #222034\n1 #f0a040\n2 #000000')
    expect(p).toContain('At most 16 colours')
    expect(p).toContain('each dot drawn as a 16x16 square')
    expect(p).not.toContain('the photo')
    const rows = gridRows(d)
    expect(rows).toHaveLength(32)
    expect(rows.every((r) => r.length === 32)).toBe(true)
    expect(p).toContain(`Current grid:\n${rows.join('\n')}\n`)
    expect(buildPixelPrompt(d, 'x', { scale: 16, photo: true })).toContain('2. the photo the picture was made from')
  })
  it("writes air as '.' and a colour as its slot", () => {
    expect(gridRows(tiny())).toEqual(['0...', '.0..', '..0.', '...0'])
  })
})

describe('checking the answer', () => {
  it('takes a good one, keeping old colours in their slots and adding new ones after', () => {
    const r = parsePixelAnswer(answer(['1..0', '.0..', '..0.', '...0'], { 0: '#112233', 1: '#FF0000', 2: '#00ff00' }), tiny())
    expect(r.ok).toBe(true)
    if (!r.ok) return
    // The unused green is dropped; red is new, after the old colour.
    expect(r.doc.palette).toEqual(['#112233', '#ff0000'])
    expect(gridRows(r.doc)).toEqual(['1..0', '.0..', '..0.', '...0'])
    expect(r.changed).toBe(2)
  })
  it('accepts a palette given as a list and a grid given as one string', () => {
    const r = parsePixelAnswer(JSON.stringify({ grid: '0...\n.0..\n..0.\n...0', palette: ['#112233'] }), tiny())
    expect(r.ok && r.changed).toBe(0)
  })
  it('refuses the wrong size, with the row and the counts', () => {
    expect(parsePixelAnswer(answer(['0...', '.0..', '..0.'], { 0: '#112233' }), tiny())).toEqual({ ok: false, reason: 'pet.ai.err.rows', vars: { n: 4, got: 3 } })
    expect(parsePixelAnswer(answer(['0...', '.0...', '..0.', '...0'], { 0: '#112233' }), tiny())).toEqual({ ok: false, reason: 'pet.ai.err.cols', vars: { row: 2, n: 4, got: 5 } })
  })
  it('refuses a dot whose character is not in the palette', () => {
    expect(parsePixelAnswer(answer(['0...', '.0..', '..x.', '...0'], { 0: '#112233' }), tiny())).toEqual({ ok: false, reason: 'pet.ai.err.char', vars: { ch: 'x', row: 3 } })
  })
  it('refuses a bad colour, a bad key, no palette, no grid, nothing drawn and no JSON', () => {
    const g = ['0...', '.0..', '..0.', '...0']
    expect(parsePixelAnswer(answer(g, { 0: 'red' }), tiny()).ok).toBe(false)
    expect(parsePixelAnswer(answer(g, { 0: 'red' }), tiny())).toMatchObject({ reason: 'pet.ai.err.hex' })
    expect(parsePixelAnswer(answer(g, { '00': '#112233' }), tiny())).toMatchObject({ reason: 'pet.ai.err.key' })
    expect(parsePixelAnswer(answer(g, { '.': '#112233' }), tiny())).toMatchObject({ reason: 'pet.ai.err.key' })
    expect(parsePixelAnswer(JSON.stringify({ grid: g }), tiny())).toMatchObject({ reason: 'pet.ai.err.palette' })
    expect(parsePixelAnswer(JSON.stringify({ palette: {} }), tiny())).toMatchObject({ reason: 'pet.ai.err.grid' })
    expect(parsePixelAnswer(answer(['....', '....', '....', '....'], { 0: '#112233' }), tiny())).toMatchObject({ reason: 'pet.ai.err.empty' })
    expect(parsePixelAnswer('I added a hat!', tiny())).toMatchObject({ reason: 'pet.ai.err.json' })
  })
  it('refuses more than 16 colours in use, but not unused extras', () => {
    const n = 17
    const cells = new Uint8Array(n * n)
    const doc: PixelDoc = { w: n, h: n, cells, palette: ['#000000'] }
    const keys = 'ABCDEFGHIJKLMNOPQ'
    const pal = Object.fromEntries([...keys].map((k, i) => [k, `#0000${(i + 16).toString(16)}`]))
    const grid = Array.from({ length: n }, (_, y) => keys[y] + '.'.repeat(n - 1))
    expect(parsePixelAnswer(answer(grid, pal), doc)).toEqual({ ok: false, reason: 'pet.ai.err.colors', vars: { n: 17, max: 16 } })
    const grid16 = grid.map((r, y) => (y === 16 ? '.'.repeat(n) : r))
    expect(parsePixelAnswer(answer(grid16, pal), doc).ok).toBe(true)
  })
  it("refuses the real Haiku answer: its 10th row is 33 dots", () => {
    expect(parsePixelAnswer(HAIKU_PIXEL_ANSWER, blob())).toEqual({ ok: false, reason: 'pet.ai.err.cols', vars: { row: 10, n: 32, got: 33 } })
  })
  it('takes that answer once the stray dot is gone, with the red as a new colour', () => {
    const j = JSON.parse(HAIKU_PIXEL_ANSWER) as { grid: string[]; palette: Record<string, string> }
    j.grid[9] = j.grid[9].replace(' ', '')
    const r = parsePixelAnswer(JSON.stringify(j), blob())
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.doc.palette).toEqual(['#222034', '#f0a040', '#000000', '#d62828'])
  })
})

describe('the picture for the model', () => {
  it('is RGBA with air left clear', () => {
    const px = rgbaOfDoc(tiny(2), () => [1, 2, 3])
    expect([...px]).toEqual([1, 2, 3, 255, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 255])
  })
})
