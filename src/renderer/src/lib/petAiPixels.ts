import { PHOTO_CHARS } from '../state/petSpecies'
import { extractJson, normalizeHex } from './petAi'
import { MAX_COLORS, type PixelDoc } from './pixelEdit'

// ---------------------------------------------------------------------------
// "AI에게 맡기기" in the pixel editor, the pure half: the picture as text for
// the model, and its answer checked and turned back into a picture. The
// contract is one JSON object, {grid: string[], palette: {char: hex}}; any
// answer that breaks it is refused with the reason, and the picture is left
// as it was.
// ---------------------------------------------------------------------------

export const PIXEL_SYSTEM = [
  'You edit small pixel-art pictures of a desktop pet.',
  'You get the picture as a text grid with its palette, and pictures of it.',
  'Reply with exactly one JSON object and nothing else: no prose, no code fences.',
  'The object is {"grid": [rows], "palette": {"<char>": "#rrggbb"}}.'
].join(' ')

/** The picture's rows, one character per dot: '.' for none, else its palette slot (0-9, a-f). */
export function gridRows(doc: PixelDoc): string[] {
  const rows: string[] = []
  for (let y = 0; y < doc.n; y++) {
    let row = ''
    for (let x = 0; x < doc.n; x++) {
      const v = doc.cells[y * doc.n + x]
      row += v ? PHOTO_CHARS[v - 1] : '.'
    }
    rows.push(row)
  }
  return rows
}

/** The user's request and the picture, as the model reads it. */
export function buildPixelPrompt(doc: PixelDoc, request: string, opts: { scale: number; photo: boolean }): string {
  const n = doc.n
  const palette = doc.palette.map((hex, i) => `${PHOTO_CHARS[i]} ${hex}`).join('\n')
  const images = [`1. the current picture, each dot drawn as a ${opts.scale}x${opts.scale} square`]
  if (opts.photo) images.push('2. the photo the picture was made from (for reference only)')
  return [
    `Request: ${request.trim()}`,
    '',
    `The picture is ${n}x${n} dots: ${n} rows of ${n} characters, one character per dot.`,
    `'.' is transparent (no dot). Any other character is a key of the palette.`,
    '',
    'Palette (character, colour):',
    palette || '(empty)',
    '',
    'Images attached:',
    ...images,
    '',
    'Rules:',
    `- Keep the size: exactly ${n} rows, each exactly ${n} characters.`,
    `- At most ${MAX_COLORS} colours. Colours are "#rrggbb".`,
    "- Palette keys are single characters (use 0-9 and a-f); '.' is never a key.",
    '- Every character in the grid is \'.\' or a key of your palette.',
    '- Keep the existing colours and their keys where you can; add new colours as new keys.',
    '- Change only what the request asks for; keep every other dot exactly as it is.',
    '- It is a pixel-art pet: keep a clean dark outline round any new part.',
    '',
    'Current grid:',
    ...gridRows(doc),
    '',
    `Answer with only: {"grid": ["<row 1>", ..., "<row ${n}>"], "palette": {"0": "#rrggbb", ...}}`
  ].join('\n')
}

export type PixelAnswer =
  | { ok: true; doc: PixelDoc; changed: number }
  | { ok: false; reason: string; vars?: Record<string, string | number> }

const fail = (reason: string, vars?: Record<string, string | number>): PixelAnswer => ({ ok: false, reason, ...(vars ? { vars } : {}) })

/**
 * The model's answer as a picture of the same size, or why it is refused
 * (an i18n key under pet.ai.err and its values). Colours that match the
 * current palette keep their slots, in order; new ones follow; colours no
 * dot uses are dropped.
 */
export function parsePixelAnswer(text: string, current: PixelDoc): PixelAnswer {
  const j = extractJson(text)
  if (!j) return fail('pet.ai.err.json')
  return parsePixelObject(j, current)
}

/** parsePixelAnswer on an answer already parsed (one frame of several, say). */
export function parsePixelObject(raw: unknown, current: PixelDoc): PixelAnswer {
  const n = current.n
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('pet.ai.err.json')
  const j = raw as { grid?: unknown; palette?: unknown }
  // The palette: {char: hex}, or a list (slots 0-9, a-f).
  const keys = new Map<string, string>()
  const rawPal = j.palette
  if (Array.isArray(rawPal)) rawPal.forEach((h, i) => i < PHOTO_CHARS.length && keys.set(PHOTO_CHARS[i], h as string))
  else if (rawPal && typeof rawPal === 'object') for (const [k, h] of Object.entries(rawPal)) keys.set(k, h as string)
  else return fail('pet.ai.err.palette')
  const colour = new Map<string, string>()
  for (const [k, h] of keys) {
    if ([...k].length !== 1 || k === '.' || /\s/.test(k)) return fail('pet.ai.err.key', { ch: k })
    const hex = normalizeHex(h)
    if (!hex) return fail('pet.ai.err.hex', { ch: k })
    colour.set(k, hex)
  }
  // The grid: a list of rows (or one string of lines).
  let rows: unknown = j.grid
  if (typeof rows === 'string') rows = rows.split(/\r?\n/).filter((r) => r.length)
  if (!Array.isArray(rows) || !rows.every((r) => typeof r === 'string')) return fail('pet.ai.err.grid')
  const lines = rows as string[]
  if (lines.length !== n) return fail('pet.ai.err.rows', { n, got: lines.length })
  const chars = lines.map((r) => [...r])
  for (let y = 0; y < n; y++) if (chars[y].length !== n) return fail('pet.ai.err.cols', { row: y + 1, n, got: chars[y].length })
  // Which colours the dots use.
  const used = new Set<string>()
  for (let y = 0; y < n; y++)
    for (const ch of chars[y]) {
      if (ch === '.') continue
      const hex = colour.get(ch)
      if (!hex) return fail('pet.ai.err.char', { ch, row: y + 1 })
      used.add(hex)
    }
  if (!used.size) return fail('pet.ai.err.empty')
  if (used.size > MAX_COLORS) return fail('pet.ai.err.colors', { n: used.size, max: MAX_COLORS })
  const palette = [...current.palette.filter((h) => used.has(h)), ...[...used].filter((h) => !current.palette.includes(h))]
  const slot = new Map(palette.map((h, i) => [h, i + 1]))
  const cells = new Uint8Array(n * n)
  let changed = 0
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const ch = chars[y][x]
      const v = ch === '.' ? 0 : slot.get(colour.get(ch)!)!
      cells[y * n + x] = v
      const was = current.cells[y * n + x]
      const wasHex = was ? current.palette[was - 1] : null
      const isHex = v ? palette[v - 1] : null
      if (wasHex !== isHex) changed++
    }
  return { ok: true, doc: { n, cells, palette }, changed }
}

/** The picture as RGBA, for its PNG. */
export function rgbaOfDoc(doc: PixelDoc, rgb: (hex: string) => [number, number, number]): Uint8ClampedArray {
  const out = new Uint8ClampedArray(doc.n * doc.n * 4)
  const cols = doc.palette.map(rgb)
  for (let i = 0; i < doc.n * doc.n; i++) {
    const v = doc.cells[i]
    if (!v) continue
    const c = cols[v - 1]
    if (!c) continue
    out[i * 4] = c[0]
    out[i * 4 + 1] = c[1]
    out[i * 4 + 2] = c[2]
    out[i * 4 + 3] = 255
  }
  return out
}
