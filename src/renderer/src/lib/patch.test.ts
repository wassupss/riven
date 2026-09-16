import { describe, it, expect } from 'vitest'
import { parsePatch, threadAnchor, lineAnchor } from './patch'

// A real `pulls/{n}/files` patch: hunk header, context, deletion, addition.
const PATCH = [
  '@@ -10,6 +10,7 @@ function a() {',
  ' const x = 1',
  '-  return x',
  '+  const y = 2',
  '+  return x + y',
  ' }',
  ' '
].join('\n')

describe('parsePatch', () => {
  it('numbers every line on the side it exists', () => {
    const [hunk] = parsePatch(PATCH)
    expect(hunk.lines.map((l) => [l.kind, l.oldLine, l.newLine])).toEqual([
      ['hunk', null, null],
      ['context', 10, 10],
      ['del', 11, null],
      ['add', null, 11],
      ['add', null, 12],
      ['context', 12, 13],
      ['context', 13, 14]
    ])
  })

  it('keeps the text without the +/- marker', () => {
    const [hunk] = parsePatch(PATCH)
    expect(hunk.lines[3].text).toBe('  const y = 2')
  })

  it('reads several hunks and restarts the counters at each header', () => {
    const two = ['@@ -1,2 +1,2 @@', ' a', '-b', '+c', '@@ -40,1 +40,2 @@', ' z', '+w'].join('\n')
    const hunks = parsePatch(two)
    expect(hunks).toHaveLength(2)
    expect(hunks[1].lines[1]).toMatchObject({ kind: 'context', oldLine: 40, newLine: 40 })
    expect(hunks[1].lines[2]).toMatchObject({ kind: 'add', newLine: 41 })
  })

  // A one-line hunk omits the count: "@@ -5 +5 @@".
  it('handles a hunk header with no line counts', () => {
    const [hunk] = parsePatch(['@@ -5 +5 @@', '-old', '+new'].join('\n'))
    expect(hunk.lines[1]).toMatchObject({ kind: 'del', oldLine: 5 })
    expect(hunk.lines[2]).toMatchObject({ kind: 'add', newLine: 5 })
  })

  // "\ No newline at end of file" belongs to neither file: counting it shifts
  // every later line number, which silently misplaces comments.
  it('does not advance the counters for the no-newline marker', () => {
    const [hunk] = parsePatch(['@@ -1,2 +1,2 @@', '-a', '\\ No newline at end of file', '+a', ' b'].join('\n'))
    const last = hunk.lines[hunk.lines.length - 1]
    expect(last).toMatchObject({ kind: 'context', oldLine: 2, newLine: 2 })
  })

  it('returns nothing for a file GitHub sent no patch for (binary, or too large)', () => {
    expect(parsePatch(null)).toEqual([])
    expect(parsePatch('')).toEqual([])
  })
})

describe('anchors', () => {
  it('addresses an added line on the right and a deleted line on the left', () => {
    const [hunk] = parsePatch(PATCH)
    const add = hunk.lines.find((l) => l.kind === 'add')!
    const del = hunk.lines.find((l) => l.kind === 'del')!
    expect(lineAnchor('a.ts', add)).toBe('a.ts::RIGHT::11')
    expect(lineAnchor('a.ts', del)).toBe('a.ts::LEFT::11')
  })

  it('addresses a context line by its new number, as GitHub does', () => {
    const [hunk] = parsePatch(PATCH)
    expect(lineAnchor('a.ts', hunk.lines[1])).toBe('a.ts::RIGHT::10')
  })

  it('matches a thread to the line it sits on', () => {
    const [hunk] = parsePatch(PATCH)
    const add = hunk.lines.find((l) => l.kind === 'add')!
    const thread = { path: 'a.ts', line: 11, originalLine: 9, diffSide: 'RIGHT' as const }
    expect(threadAnchor(thread)).toBe(lineAnchor('a.ts', add))
  })

  // GitHub nulls `line` once the diff moves under a thread; without the
  // fallback every outdated thread would disappear from the file it is about.
  it('falls back to the original line for an outdated thread', () => {
    expect(threadAnchor({ path: 'a.ts', line: null, originalLine: 42, diffSide: 'RIGHT' })).toBe(
      'a.ts::RIGHT::42'
    )
  })

  it('has nowhere to put a thread with no line at all', () => {
    expect(threadAnchor({ path: 'a.ts', line: null, originalLine: null, diffSide: 'RIGHT' })).toBe(
      'a.ts::none'
    )
  })
})
