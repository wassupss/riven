import { describe, it, expect } from 'vitest'
import {
  DEFAULT_FPS,
  buildFramesPrompt,
  cellsOfRows,
  checkFrameSet,
  finishPhotoFrames,
  packMotion,
  parseFramesAnswer,
  rebaseRows,
  rowsOfCells,
  sanitizeSpeciesMotion
} from './petFrames'
import { finishPhoto } from './petPhoto'
import { checkMotion, defaultMotion } from './petMotion'
import { gridRows } from './petAiPixels'
import { PHOTO_CHARS, type PhotoArt } from '../state/petSpecies'

const N = 32
/** A 32x32 picture: a 10x10 block of colour 0 with a column of colour 1 (`shift` moves it). */
function rows(shift = 0, a = '0', b = '1'): string[] {
  return Array.from({ length: N }, (_, y) =>
    Array.from({ length: N }, (_, x) => (y >= 10 && y < 20 && x >= 10 && x < 20 ? (x === 12 + shift ? b : a) : '.')).join('')
  )
}
const photo: PhotoArt = { palette: ['#111111', '#eeeeee', '#ff0000'], rows: rows() }

describe('frame sets', () => {
  it('takes 2 to 4 frames of the picture size and palette', () => {
    const r = checkFrameSet({ fps: 6, frames: [rows(0), rows(1), rows(2)] }, photo)
    expect(r).toEqual({ ok: true, value: { fps: 6, frames: [rows(0), rows(1), rows(2)] } })
    expect(checkFrameSet({ frames: [rows(), rows()] }, photo)).toMatchObject({ ok: true, value: { fps: DEFAULT_FPS } })
  })
  it.each([
    ['one frame', { frames: [rows()] }, 'pet.mo.err.count'],
    ['five frames', { frames: [rows(), rows(), rows(), rows(), rows()] }, 'pet.mo.err.count'],
    ['fps 0', { fps: 0, frames: [rows(), rows()] }, 'pet.mo.err.range'],
    ['fps 13', { fps: 13, frames: [rows(), rows()] }, 'pet.mo.err.range'],
    ['a short row', { frames: [rows(), [...rows().slice(0, 31), '.'.repeat(31)]] }, 'pet.fr.err.rows'],
    ['a wrong size', { frames: [rows(), rows().slice(0, 16)] }, 'pet.fr.err.rows'],
    ['a colour not in the palette', { frames: [rows(), rows(0, '0', '7')] }, 'pet.fr.err.char'],
    ['an empty frame', { frames: [rows(), Array(N).fill('.'.repeat(N))] }, 'pet.fr.err.dots'],
    ['an unknown key', { frames: [rows(), rows()], speed: 2 }, 'pet.mo.err.key']
  ])('refuses %s', (_, raw, reason) => {
    const r = checkFrameSet(raw, photo)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe(reason)
  })
})

describe('a species motion as saved', () => {
  const happy = (checkMotion({ keyframes: [{ at: 0 }, { at: 0.5, y: -3 }], duration_ms: 600 }) as { ok: true; value: ReturnType<typeof defaultMotion> }).value
  it('reads specs and frames, dropping what does not check', () => {
    const m = sanitizeSpeciesMotion(
      {
        v: 1,
        specs: { happy, idle: { keyframes: [], duration_ms: 1 } },
        frames: { idle: { fps: 3, frames: [rows(0), rows(1)] }, eat: { frames: [rows()] }, nope: { frames: [rows(), rows()] } }
      },
      photo
    )
    expect(m).toEqual({ v: 1, specs: { happy }, frames: { idle: { fps: 3, frames: [rows(0), rows(1)] } } })
  })
  it('a species with no picture keeps only its specs; an unknown version is not read', () => {
    expect(sanitizeSpeciesMotion({ v: 1, specs: { happy }, frames: { idle: { frames: [rows(), rows()] } } }, undefined)).toEqual({ v: 1, specs: { happy } })
    expect(sanitizeSpeciesMotion({ v: 2, specs: { happy } }, photo)).toBeUndefined()
    expect(sanitizeSpeciesMotion({ v: 1 }, photo)).toBeUndefined()
  })
  it('packs away empty parts', () => {
    expect(packMotion({ v: 1, specs: {}, frames: {} })).toBeUndefined()
    expect(packMotion({ v: 1, specs: { happy } })).toEqual({ v: 1, specs: { happy } })
  })
})

describe('one palette for the picture and its frames', () => {
  it('finishPhotoFrames is finishPhoto when there are no frames', () => {
    const p = { palette: ['#000000', '#111111', '#eeeeee'], rows: rows(0, '1', '2') }
    const a = finishPhoto(p.rows.map((r) => [...r]), p.palette)
    expect(finishPhotoFrames(p.rows, p.palette, undefined)).toEqual({ photo: a, frames: undefined })
  })
  it('counts and rewrites the frames with the picture', () => {
    // Colour 2 (red) is only in a frame: it is kept, and the frame still reads red.
    const frame = rows(1, '0', '2')
    const r = finishPhotoFrames(photo.rows, photo.palette, { idle: { fps: 4, frames: [photo.rows, frame] } })!
    expect(r.photo.palette).toContain('#ff0000')
    const red = PHOTO_CHARS[r.photo.palette.indexOf('#ff0000')]
    expect(r.frames!.idle!.frames[1][10][13]).toBe(red)
    const white = PHOTO_CHARS[r.photo.palette.indexOf('#eeeeee')]
    expect(r.photo.rows[10][12]).toBe(white)
  })
  it('rebaseRows moves grids to a new palette by colour, appending what it lacks', () => {
    const r = rebaseRows([rows()], ['#111111', '#eeeeee'], ['#eeeeee'])
    expect(r.palette).toEqual(['#eeeeee', '#111111'])
    expect(r.grids[0][10][12]).toBe('0')
    expect(r.grids[0][10][11]).toBe('1')
  })
  it('cells and rows round-trip', () => {
    expect(rowsOfCells(N, N, cellsOfRows(rows(3)))).toEqual(rows(3))
  })
})

describe('frames from the AI', () => {
  const doc = { w: N, h: N, cells: cellsOfRows(photo.rows), palette: photo.palette }
  it('the prompt carries the grid and the contract', () => {
    const p = buildFramesPrompt(doc, gridRows(doc), '꼬리 흔드는 프레임 3장', 16)
    expect(p).toContain('꼬리 흔드는 프레임 3장')
    expect(p).toContain(`exactly ${N} rows`)
    expect(p).toContain('"frames"')
  })
  it('takes rows on a shared palette, new colours appended', () => {
    const r = parseFramesAnswer(
      JSON.stringify({ fps: 5, palette: { '0': '#111111', '1': '#eeeeee', '2': '#00ff00' }, frames: [rows(0), rows(1, '0', '2'), rows(2)] }),
      doc
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.fps).toBe(5)
    expect(r.palette).toEqual(['#111111', '#eeeeee', '#ff0000', '#00ff00'])
    expect(r.frames.length).toBe(3)
    expect(rowsOfCells(N, N, r.frames[1])[10][13]).toBe('3')
    expect(rowsOfCells(N, N, r.frames[0])).toEqual(rows(0))
  })
  it('takes frames as {grid, palette} like a picture edit', () => {
    const f = (s: number): unknown => ({ grid: rows(s), palette: { '0': '#111111', '1': '#eeeeee' } })
    expect(parseFramesAnswer(JSON.stringify({ frames: [f(0), f(1)] }), doc)).toMatchObject({ ok: true, fps: DEFAULT_FPS })
  })
  it('refuses the whole answer for one bad frame, saying which', () => {
    const r = parseFramesAnswer(JSON.stringify({ palette: { '0': '#111111', '1': '#eeeeee' }, frames: [rows(0), rows(0).slice(1)] }), doc)
    expect(r).toMatchObject({ ok: false, reason: 'pet.ai.err.rows', frame: 2 })
    expect(parseFramesAnswer(JSON.stringify({ palette: {}, frames: [rows()] }), doc)).toMatchObject({ ok: false, reason: 'pet.mo.err.count' })
    expect(parseFramesAnswer(JSON.stringify({ frames: [rows(), rows()], fps: 30 }), doc)).toMatchObject({ ok: false, reason: 'pet.mo.err.range' })
    expect(parseFramesAnswer('no', doc)).toMatchObject({ ok: false, reason: 'pet.ai.err.json' })
  })
})
