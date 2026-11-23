import { PHOTO_CHARS, PHOTO_MAX_COLORS, minPhotoCells, photoSizeOf, type PhotoArt, type PhotoSize, PHOTO } from '../state/petSpecies'
import { extractJson } from './petAi'
import { parsePixelObject } from './petAiPixels'
import { isSituation, sanitizeMotionSet, type MotionCheck, type MotionSet, type Situation } from './petMotion'
import type { PixelDoc } from './pixelEdit'

// ---------------------------------------------------------------------------
// A homemade species' frame animation (blink, tail wag, walk): for a
// situation, 2 to 4 pictures shown in turn at a chosen fps, on top of its
// motion. Every frame is the species' picture grid (same size, same palette:
// a frame's characters index the picture's palette), so it is drawn by the
// same code with the same colour variables. Pure: checked and tidied here,
// drawn by Creature as a reel slid by CSS steps() (pet.css .pet-fr).
//
// Kept with the species in its file (`motion`, versioned), never in a battle
// code or a pet's design snapshot (designOf leaves it out).
// ---------------------------------------------------------------------------

export const FRAME_LIMITS = { count: { min: 2, max: 4 }, fps: { min: 1, max: 12 } } as const
export const DEFAULT_FPS = 4

export interface FrameSet {
  fps: number
  /** 2..4 pictures, each `size` rows of `size` characters ('.' or a palette index). */
  frames: string[][]
}
export type FrameMap = Partial<Record<Situation, FrameSet>>

/** What a homemade species keeps about how it moves. */
export interface SpeciesMotion {
  v: 1
  specs?: MotionSet
  frames?: FrameMap
}
export const MOTION_V = 1

const fail = <T>(reason: string, vars?: Record<string, string | number>): MotionCheck<T> => ({ ok: false, reason, ...(vars ? { vars } : {}) })

/** One frame's rows against the picture: its size, its palette, enough dots. */
export function checkFrame(raw: unknown, photo: PhotoArt, label: string): MotionCheck<string[]> {
  const n = photoSizeOf(photo)
  if (!Array.isArray(raw) || raw.length !== n) return fail('pet.fr.err.rows', { k: label, n })
  const ok = '.' + PHOTO_CHARS.slice(0, photo.palette.length)
  let dots = 0
  const rows: string[] = []
  for (const row of raw) {
    if (typeof row !== 'string' || row.length !== n) return fail('pet.fr.err.rows', { k: label, n })
    for (const ch of row) {
      if (!ok.includes(ch)) return fail('pet.fr.err.char', { k: label, ch })
      if (ch !== '.') dots++
    }
    rows.push(row)
  }
  const min = minPhotoCells(n)
  if (dots < min) return fail('pet.fr.err.dots', { k: label, n: dots, min })
  return { ok: true, value: rows }
}

/** A frame set, strictly. */
export function checkFrameSet(raw: unknown, photo: PhotoArt, label = ''): MotionCheck<FrameSet> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('pet.fr.err.set', { k: label || '-' })
  const o = raw as Record<string, unknown>
  for (const k of Object.keys(o)) if (k !== 'fps' && k !== 'frames') return fail('pet.mo.err.key', { k })
  const fps = o.fps ?? DEFAULT_FPS
  if (typeof fps !== 'number' || !Number.isInteger(fps) || fps < FRAME_LIMITS.fps.min || fps > FRAME_LIMITS.fps.max)
    return fail('pet.mo.err.range', { k: 'fps', v: String(fps), min: FRAME_LIMITS.fps.min, max: FRAME_LIMITS.fps.max })
  if (!Array.isArray(o.frames)) return fail('pet.fr.err.set', { k: label || '-' })
  const c = o.frames.length
  if (c < FRAME_LIMITS.count.min || c > FRAME_LIMITS.count.max)
    return fail('pet.mo.err.count', { k: 'frames', v: c, min: FRAME_LIMITS.count.min, max: FRAME_LIMITS.count.max })
  const frames: string[][] = []
  for (let i = 0; i < c; i++) {
    const r = checkFrame(o.frames[i], photo, String(i + 1))
    if (!r.ok) return r
    frames.push(r.value)
  }
  return { ok: true, value: { fps, frames } }
}

/** A species' motion as saved, read leniently against its picture: bad parts are dropped. */
export function sanitizeSpeciesMotion(raw: unknown, photo: PhotoArt | undefined): SpeciesMotion | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const o = raw as Record<string, unknown>
  // A newer riven's format: not understood, so not drawn (the file keeps it until this one saves).
  if (o.v !== MOTION_V) return undefined
  const specs = sanitizeMotionSet(o.specs)
  let frames: FrameMap | undefined
  if (photo && o.frames && typeof o.frames === 'object' && !Array.isArray(o.frames)) {
    for (const [k, v] of Object.entries(o.frames as Record<string, unknown>)) {
      if (!isSituation(k)) continue
      const r = checkFrameSet(v, photo)
      if (r.ok) (frames ??= {})[k] = r.value
    }
  }
  if (!specs && !frames) return undefined
  return { v: MOTION_V, ...(specs ? { specs } : {}), ...(frames ? { frames } : {}) }
}

/** Nothing in it: the species moves as pet.css says. */
export const emptyMotion = (m: SpeciesMotion | undefined): boolean => !m || (!m.specs && !m.frames)

/** A copy, for a draft. */
export const cloneMotion = (m: SpeciesMotion | undefined): SpeciesMotion =>
  m ? (JSON.parse(JSON.stringify(m)) as SpeciesMotion) : { v: MOTION_V }

/** A motion tidied for saving: empty parts dropped. Undefined when nothing is left. */
export function packMotion(m: SpeciesMotion): SpeciesMotion | undefined {
  const specs = m.specs && Object.keys(m.specs).length ? m.specs : undefined
  const frames = m.frames && Object.keys(m.frames).length ? m.frames : undefined
  if (!specs && !frames) return undefined
  return { v: MOTION_V, ...(specs ? { specs } : {}), ...(frames ? { frames } : {}) }
}

// ---- one palette for the picture and its frames ----

/**
 * Rows written against `from` rewritten against `to`, matched by colour; a
 * colour `to` lacks is appended to it (returned). The picture and every frame
 * share one palette, so a change to it in one (the AI's answer reorders it)
 * is carried to the others this way.
 */
export function rebaseRows(grids: string[][], from: string[], to: string[]): { grids: string[][]; palette: string[] } {
  const palette = [...to]
  const map = new Map<string, string>()
  from.forEach((hex, i) => {
    let j = palette.indexOf(hex)
    if (j < 0) {
      palette.push(hex)
      j = palette.length - 1
    }
    map.set(PHOTO_CHARS[i], PHOTO_CHARS[j] ?? '.')
  })
  const grids2 = grids.map((rows) => rows.map((row) => [...row].map((ch) => (ch === '.' ? '.' : (map.get(ch) ?? '.'))).join('')))
  return { grids: grids2, palette }
}

/**
 * finishPhoto (lib/petPhoto.ts) for a picture with frames: unused colours
 * dropped and the rest ordered by use, counted over the picture AND its
 * frames, with every grid rewritten the same way. With no frames it is
 * exactly finishPhoto. Null when the picture is too small to keep.
 */
export function finishPhotoFrames(
  rows: string[],
  palette: string[],
  frames: FrameMap | undefined
): { photo: PhotoArt; frames: FrameMap | undefined } | null {
  const sets = Object.entries(frames ?? {}) as Array<[Situation, FrameSet]>
  const all = [rows, ...sets.flatMap(([, f]) => f.frames)]
  const used = palette.map(() => 0)
  for (const g of all) for (const row of g) for (const ch of row) if (ch !== '.') used[PHOTO_CHARS.indexOf(ch)]++
  const order = palette
    .map((_, i) => i)
    .filter((i) => used[i] > 0)
    .sort((p, q) => used[q] - used[p] || p - q)
  const remap: Record<string, string> = {}
  order.forEach((old, i) => (remap[PHOTO_CHARS[old]] = PHOTO_CHARS[i]))
  const re = (g: string[]): string[] => g.map((row) => [...row].map((ch) => (ch === '.' ? '.' : remap[ch])).join(''))
  const pic = re(rows)
  let cells = 0
  for (const row of pic) for (const ch of row) if (ch !== '.') cells++
  const size = pic.length
  if (cells < minPhotoCells(size)) return null
  const photo: PhotoArt = { palette: order.map((i) => palette[i]), rows: pic, ...(size === PHOTO ? {} : { size: size as PhotoSize }) }
  let out: FrameMap | undefined
  for (const [s, f] of sets) (out ??= {})[s] = { fps: f.fps, frames: f.frames.map(re) }
  return { photo, frames: out }
}

// ---- the AI box: several frames at once ----

export const FRAMES_SYSTEM = [
  'You draw animation frames for a small pixel-art desktop pet.',
  'You get its picture as a text grid with its palette, and a picture of it.',
  'Reply with exactly one JSON object and nothing else: no prose, no code fences.'
].join(' ')

export function buildFramesPrompt(doc: PixelDoc, rows: string[], request: string, scale: number): string {
  const n = doc.n
  const palette = doc.palette.map((hex, i) => `${PHOTO_CHARS[i]} ${hex}`).join('\n')
  const { min, max } = FRAME_LIMITS.count
  return [
    `Request: ${request.trim()}`,
    '',
    `Draw ${min} to ${max} frames of an animation loop of this pet (the request may say how many).`,
    `The picture is ${n}x${n} dots: ${n} rows of ${n} characters. '.' is transparent; any other character is a palette key.`,
    `The attached image is the picture, each dot a ${scale}x${scale} square.`,
    '',
    'Palette (character, colour):',
    palette,
    '',
    'Rules:',
    `- Every frame is exactly ${n} rows of exactly ${n} characters.`,
    '- Use the same palette keys and colours; add a colour only if you must (at most 16 in all).',
    '- Keep the pet in the same place and size; change only what moves (eyes, tail, legs, ears).',
    '- Frames follow each other smoothly and the last leads back to the first.',
    '- Keep the clean dark outline.',
    '',
    'Current grid:',
    ...rows,
    '',
    'Answer with only: {"fps": 4, "palette": {"0": "#rrggbb", ...}, "frames": [["<row 1>", ...], ["<row 1>", ...]]}'
  ].join('\n')
}

export type FramesAnswer =
  | { ok: true; palette: string[]; frames: Uint8Array[]; fps: number }
  /** `frame`: which frame (from 1) was refused, when one was. */
  | { ok: false; reason: string; vars?: Record<string, string | number>; frame?: number }

/**
 * The model's frames, each checked like a picture edit (parsePixelObject),
 * then put on ONE palette: the current one, with any new colours after it.
 * Refused whole when any frame is, or when the colours outgrow 16.
 */
export function parseFramesAnswer(text: string, base: PixelDoc): FramesAnswer {
  const j = extractJson(text) as Record<string, unknown> | null
  if (!j) return { ok: false, reason: 'pet.ai.err.json' }
  for (const k of Object.keys(j)) if (!['fps', 'palette', 'frames'].includes(k)) return { ok: false, reason: 'pet.mo.err.key', vars: { k } }
  const fps = j.fps ?? DEFAULT_FPS
  if (typeof fps !== 'number' || !Number.isInteger(fps) || fps < FRAME_LIMITS.fps.min || fps > FRAME_LIMITS.fps.max)
    return { ok: false, reason: 'pet.mo.err.range', vars: { k: 'fps', v: String(fps), min: FRAME_LIMITS.fps.min, max: FRAME_LIMITS.fps.max } }
  if (!Array.isArray(j.frames)) return { ok: false, reason: 'pet.fr.err.set', vars: { k: 'frames' } }
  const c = j.frames.length
  if (c < FRAME_LIMITS.count.min || c > FRAME_LIMITS.count.max)
    return { ok: false, reason: 'pet.mo.err.count', vars: { k: 'frames', v: c, min: FRAME_LIMITS.count.min, max: FRAME_LIMITS.count.max } }
  const palette = [...base.palette]
  const out: Uint8Array[] = []
  for (let i = 0; i < c; i++) {
    const f = j.frames[i] as unknown
    // A frame is its rows (the shared palette), or {grid, palette} like a picture edit.
    const obj = Array.isArray(f) || typeof f === 'string' ? { grid: f, palette: j.palette } : f
    const r = parsePixelObject(obj, base)
    if (!r.ok) return { ok: false, reason: r.reason, ...(r.vars ? { vars: r.vars } : {}), frame: i + 1 }
    const cells = new Uint8Array(r.doc.cells.length)
    for (let p = 0; p < cells.length; p++) {
      const v = r.doc.cells[p]
      if (!v) continue
      const hex = r.doc.palette[v - 1]
      let slot = palette.indexOf(hex)
      if (slot < 0) {
        palette.push(hex)
        slot = palette.length - 1
      }
      cells[p] = slot + 1
    }
    if (palette.length > PHOTO_MAX_COLORS) return { ok: false, reason: 'pet.ai.err.colors', vars: { n: palette.length, max: PHOTO_MAX_COLORS } }
    out.push(cells)
  }
  return { ok: true, palette, frames: out, fps }
}

/** Cells (0 air, k+1 colour k) as a frame's rows. */
export function rowsOfCells(n: number, cells: Uint8Array): string[] {
  const rows: string[] = []
  for (let y = 0; y < n; y++) {
    let row = ''
    for (let x = 0; x < n; x++) {
      const v = cells[y * n + x]
      row += v ? PHOTO_CHARS[v - 1] : '.'
    }
    rows.push(row)
  }
  return rows
}

/** A frame's rows as cells. */
export function cellsOfRows(rows: string[]): Uint8Array {
  const n = rows.length
  const cells = new Uint8Array(n * n)
  rows.forEach((row, y) => {
    for (let x = 0; x < n; x++) {
      const ch = row[x]
      if (ch && ch !== '.') cells[y * n + x] = PHOTO_CHARS.indexOf(ch) + 1
    }
  })
  return cells
}
