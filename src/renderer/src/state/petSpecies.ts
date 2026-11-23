import { create } from 'zustand'
import { sanitizeSpeciesMotion, type SpeciesMotion } from '../lib/petFrames'

// ---------------------------------------------------------------------------
// Species the user made from a photo (see lib/petPhoto.ts for the image half
// and components/petCustomArt.ts for the bodies). A custom species is a NEW
// animal, not a reskin: its own silhouette, its own colours, its own battle
// family and stats.
//
// What is kept is the DESIGN: the animal's dots on a 12x12 grid (the room a
// 16x16 body has inside its outline), the five colours the photo was reduced
// to, and where its face goes. Everything else is derived from that, the same
// way for every machine, so a design is all that has to travel: in the shared
// store file, in a pet's save as a snapshot, and in a battle code.
//
// The file is userData/store/pet-species.json, which the Electron and Tauri
// builds both read and write (main/store.ts, src-tauri commands/store.rs).
// ---------------------------------------------------------------------------

/** The art grid of a design: the inside of a 16x16 body, one dot of air and one of outline all round. */
export const ART = 12
/** Where the art sits on the 16x16 grid of the body. */
export const ART_AT = 2
/** How many species one keeper can make. */
export const MAX_CUSTOM = 24
/** A design with fewer dots than this is a speck, not an animal. */
export const MIN_CELLS = 30
export const NAME_MAX = 24

/**
 * A dot's role in the photo's palette. Light to dark is not the order: body is
 * the main colour, shade its darker part, highlight its lighter part, accent a
 * marking in another colour, white the near-white bits (a bib, a blaze).
 */
export type Role = 'b' | 's' | 'h' | 'a' | 'w'
export const ROLES: Role[] = ['b', 's', 'h', 'a', 'w']
export const ROLE_CHARS = '.bshaw'

export interface CustomColors {
  body: string
  shade: string
  highlight: string
  accent: string
  white: string
}
export const COLOR_KEYS: Array<keyof CustomColors> = ['body', 'shade', 'highlight', 'accent', 'white']
export const ROLE_COLOR: Record<Role, keyof CustomColors> = {
  b: 'body',
  s: 'shade',
  h: 'highlight',
  a: 'accent',
  w: 'white'
}

export interface CustomDesign {
  name: string
  colors: CustomColors
  /** ART rows of ART characters from ROLE_CHARS. */
  art: string[]
  /** Top-left of the 6x4 face window, on the art grid. */
  face: { x: number; y: number }
  /** Keep the photo as it is: no eyes or mouth are stamped on it. */
  noFace: boolean
  /**
   * The faithful picture ("사진 충실 모드"), on species made since it came in:
   * the photo itself at 32x32 (or 48x48, 64x64) in up to 16 colours, drawn
   * in the pet's 32 css pixels with no face of its own. The 12x12 design above is still made and
   * kept beside it: the battle family and the stats' lean read it, and
   * an older riven that knows nothing of `photo` draws that instead.
   */
  photo?: PhotoArt
}

/** The faithful picture's default grid: the 32 dots a pet is drawn at. */
export const PHOTO = 32
/**
 * The grids a picture can be made at. The pet is always drawn 32 css pixels
 * square, so 48 is 2/3 of a css pixel a dot and 64 half of one (a device
 * pixel each on a Retina screen): more detail in the same room.
 */
export const PHOTO_SIZES = [32, 48, 64] as const
export type PhotoSize = (typeof PHOTO_SIZES)[number]
export const PHOTO_MAX_COLORS = 16
/** A dot of the picture: '.' is air, otherwise the index of its colour in `palette`. */
export const PHOTO_CHARS = '0123456789abcdef'
/** A 32x32 picture with fewer dots than this is a speck (a bigger grid scales it by area). */
export const MIN_PHOTO_CELLS = 60

export interface PhotoArt {
  /** Up to 16 '#rrggbb' colours. */
  palette: string[]
  /** `size` rows of `size` characters: '.' or a PHOTO_CHARS index into `palette`. */
  rows: string[]
  /**
   * The grid, 48 or 64. Left out at 32, which is what every picture made
   * before the choice came in is, so their data reads and writes unchanged.
   */
  size?: PhotoSize
}

/** A picture's grid (32 when it does not say). */
export const photoSizeOf = (p: PhotoArt): PhotoSize => p.size ?? PHOTO

/** The fewest dots a picture of `size` may have: MIN_PHOTO_CELLS, by area. */
export const minPhotoCells = (size: number): number => Math.round((MIN_PHOTO_CELLS * size * size) / (PHOTO * PHOTO))

/**
 * How many dots thick a picture's outline is drawn, and so how much air it
 * keeps round itself: about a css pixel, never less than a dot.
 */
export const photoLine = (size: number): number => Math.max(1, Math.floor(size / PHOTO))

export type CustomSpeciesId = `u-${string}`
const ID_RE = /^u-[a-z0-9]{4,20}$/

export interface CustomSpecies extends CustomDesign {
  id: CustomSpeciesId
  createdAt: number
  updatedAt: number
  /**
   * How it moves (the maker's "움직임"): motion specs per situation and, for
   * a picture, extra frames. Kept with the species only: designOf leaves it
   * out, so neither a battle code nor a pet's snapshot carries it.
   */
  motion?: SpeciesMotion
}

export const isCustomId = (s: unknown): s is CustomSpeciesId => typeof s === 'string' && ID_RE.test(s)

export function newCustomId(now: number, rand: number = Math.random()): CustomSpeciesId {
  const r = Math.floor(rand * 36 ** 4)
    .toString(36)
    .padStart(4, '0')
  return `u-${now.toString(36)}${r}`
}

const HEX_RE = /^#[0-9a-f]{6}$/

/** A faithful picture read defensively. Null when unusable (the design then falls back to its 12x12). */
export function sanitizePhoto(raw: unknown): PhotoArt | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (!Array.isArray(o.palette) || !o.palette.length || o.palette.length > PHOTO_MAX_COLORS) return null
  const palette: string[] = []
  for (const c of o.palette) {
    const v = typeof c === 'string' ? c.toLowerCase() : ''
    if (!HEX_RE.test(v)) return null
    palette.push(v)
  }
  // Only the grids a picture can be made at; none given is the 32 of old.
  const size = o.size === undefined ? PHOTO : o.size
  if (!(PHOTO_SIZES as readonly unknown[]).includes(size)) return null
  const n = size as PhotoSize
  if (!Array.isArray(o.rows) || o.rows.length !== n) return null
  const ok = '.' + PHOTO_CHARS.slice(0, palette.length)
  const rows: string[] = []
  for (const row of o.rows) {
    if (typeof row !== 'string' || row.length !== n) return null
    for (const ch of row) if (!ok.includes(ch)) return null
    rows.push(row)
  }
  if (cellsOf(rows) < minPhotoCells(n)) return null
  return n === PHOTO ? { palette, rows } : { palette, rows, size: n }
}

/** A design read defensively: a hand-edited file or a forged code must never draw garbage. Null when unusable. */
export function sanitizeDesign(raw: unknown): CustomDesign | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const name = typeof o.name === 'string' ? o.name.trim().slice(0, NAME_MAX) : ''
  if (!name) return null
  const c = o.colors as Record<string, unknown> | undefined
  if (!c || typeof c !== 'object') return null
  const colors = {} as CustomColors
  for (const k of COLOR_KEYS) {
    const v = typeof c[k] === 'string' ? (c[k] as string).toLowerCase() : ''
    if (!HEX_RE.test(v)) return null
    colors[k] = v
  }
  if (!Array.isArray(o.art) || o.art.length !== ART) return null
  const art: string[] = []
  for (const row of o.art) {
    if (typeof row !== 'string' || row.length !== ART) return null
    for (const ch of row) if (!ROLE_CHARS.includes(ch)) return null
    art.push(row)
  }
  if (cellsOf(art) < MIN_CELLS) return null
  const f = o.face as Record<string, unknown> | undefined
  const int = (v: unknown, hi: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(hi, Math.round(v))) : 0
  const face = { x: int(f?.x, ART - 6), y: int(f?.y, ART - 4) }
  // A broken picture is dropped, not the species: it still has its 12x12.
  const photo = o.photo === undefined ? null : sanitizePhoto(o.photo)
  return { name, colors, art, face, noFace: photo ? true : o.noFace === true, ...(photo ? { photo } : {}) }
}

export function sanitizeSpecies(raw: unknown): CustomSpecies | null {
  const d = sanitizeDesign(raw)
  if (!d) return null
  const o = raw as Record<string, unknown>
  if (!isCustomId(o.id)) return null
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0)
  const motion = o.motion === undefined ? undefined : sanitizeSpeciesMotion(o.motion, d.photo)
  return { ...d, id: o.id, createdAt: num(o.createdAt), updatedAt: num(o.updatedAt), ...(motion ? { motion } : {}) }
}

/** Only the design, for a snapshot or a battle code. */
export function designOf(s: CustomDesign): CustomDesign {
  return {
    name: s.name,
    colors: { ...s.colors },
    art: [...s.art],
    face: { ...s.face },
    noFace: s.noFace,
    ...(s.photo
      ? {
          photo: {
            palette: [...s.photo.palette],
            rows: [...s.photo.rows],
            ...(s.photo.size && s.photo.size !== PHOTO ? { size: s.photo.size } : {})
          }
        }
      : {})
  }
}

export const cellsOf = (art: string[]): number => art.join('').replace(/\./g, '').length

export const sameDesign = (a: CustomDesign, b: CustomDesign): boolean =>
  JSON.stringify(designOf(a)) === JSON.stringify(designOf(b))

// ---- the battle code's copy ----

/**
 * A design as a short array, for a battle code: [name, colours, rows joined
 * by '/', fx, fy, noFace], and for a faithful picture a seventh, [its colours
 * as one hex string, its rows as one string]. A riven from before pictures
 * reads the first six and draws the 12x12.
 *
 * The picture in a code is always 32x32, whatever it was made at: a 64x64
 * one would make the code four times longer (4096 dots against 1024), and a
 * code is something people paste into chat. The other side sees the same
 * picture at the pet's own 32 dots, which every riven that reads pictures
 * draws; the keeper's own file keeps the full size.
 */
export function packDesign(d: CustomDesign): unknown[] {
  const base = [d.name, COLOR_KEYS.map((k) => d.colors[k].slice(1)).join(''), d.art.join('/'), d.face.x, d.face.y, d.noFace ? 1 : 0]
  const pic = d.photo ? photoAt32(d.photo) : null
  return pic ? [...base, [pic.palette.map((c) => c.slice(1)).join(''), pic.rows.join('')]] : base
}

/**
 * A picture brought down to 32x32 (the battle code's copy): each new dot
 * covers its share of the old ones and is lit where at least half of that is
 * lit, in the palette colour nearest (in Lab) to the area-weighted mean
 * there. The palette is kept as it is. A 32 picture is returned as it is;
 * null when too little is left to be a picture.
 */
export function photoAt32(p: PhotoArt): PhotoArt | null {
  const n = photoSizeOf(p)
  if (n === PHOTO) return p
  const k = n / PHOTO
  const rgbs = p.palette.map(hexToRgb)
  const labs = rgbs.map((c) => labOf(c[0], c[1], c[2]))
  const rows: string[] = []
  for (let j = 0; j < PHOTO; j++) {
    let row = ''
    for (let i = 0; i < PHOTO; i++) {
      const fx0 = i * k
      const fx1 = fx0 + k
      const fy0 = j * k
      const fy1 = fy0 + k
      let area = 0
      let r = 0
      let g = 0
      let b = 0
      for (let y = Math.floor(fy0); y < Math.ceil(fy1); y++)
        for (let x = Math.floor(fx0); x < Math.ceil(fx1); x++) {
          const ch = p.rows[y]?.[x]
          if (!ch || ch === '.') continue
          const a = (Math.min(x + 1, fx1) - Math.max(x, fx0)) * (Math.min(y + 1, fy1) - Math.max(y, fy0))
          if (a <= 0) continue
          const c = rgbs[PHOTO_CHARS.indexOf(ch)]
          area += a
          r += c[0] * a
          g += c[1] * a
          b += c[2] * a
        }
      if (area < k * k * 0.5) {
        row += '.'
        continue
      }
      const lab = labOf(r / area, g / area, b / area)
      let best = 0
      let bestD = Infinity
      labs.forEach((l, ci) => {
        const d = (l[0] - lab[0]) ** 2 + (l[1] - lab[1]) ** 2 + (l[2] - lab[2]) ** 2
        if (d < bestD) {
          bestD = d
          best = ci
        }
      })
      row += PHOTO_CHARS[best]
    }
    rows.push(row)
  }
  return sanitizePhoto({ palette: p.palette, rows })
}

function unpackPhoto(raw: unknown): PhotoArt | undefined {
  if (!Array.isArray(raw) || raw.length < 2) return undefined
  const [hex, dots] = raw
  if (typeof hex !== 'string' || hex.length % 6 !== 0 || typeof dots !== 'string' || dots.length !== PHOTO * PHOTO)
    return undefined
  const palette = Array.from({ length: hex.length / 6 }, (_, i) => `#${hex.slice(i * 6, i * 6 + 6)}`)
  const rows = Array.from({ length: PHOTO }, (_, y) => dots.slice(y * PHOTO, (y + 1) * PHOTO))
  return sanitizePhoto({ palette, rows }) ?? undefined
}

export function unpackDesign(raw: unknown): CustomDesign | null {
  if (!Array.isArray(raw) || raw.length < 6) return null
  const [name, hex, rows, fx, fy, nf, pic] = raw
  if (typeof hex !== 'string' || hex.length !== 30 || typeof rows !== 'string') return null
  const colors = {} as Record<string, string>
  COLOR_KEYS.forEach((k, i) => (colors[k] = `#${hex.slice(i * 6, i * 6 + 6)}`))
  const photo = unpackPhoto(pic)
  return sanitizeDesign({ name, colors, art: rows.split('/'), face: { x: fx, y: fy }, noFace: nf === 1, ...(photo ? { photo } : {}) })
}

// ---- colour arithmetic, shared with the photo pipeline ----

export function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/** CIE Lab of an sRGB colour, for distances that match what an eye sees. */
export function labOf(r: number, g: number, b: number): [number, number, number] {
  const lin = (v: number): number => {
    const c = v / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  const R = lin(r)
  const G = lin(g)
  const B = lin(b)
  const f = (t: number): number => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116)
  const X = f((R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047)
  const Y = f(R * 0.2126 + G * 0.7152 + B * 0.0722)
  const Z = f((R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883)
  return [116 * Y - 16, 500 * (X - Y), 200 * (Y - Z)]
}

export function rgbToHex([r, g, b]: [number, number, number] | number[]): string {
  const c = (v: number): string => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')
  return `#${c(r)}${c(g)}${c(b)}`
}

/** Hue 0..360, saturation and lightness 0..1. */
export function hslOf(hex: string): { h: number; s: number; l: number } {
  const [r, g, b] = hexToRgb(hex).map((v) => v / 255)
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max === min) return { h: 0, s: 0, l }
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  const h =
    max === r ? ((g - b) / d + (g < b ? 6 : 0)) * 60 : max === g ? ((b - r) / d + 2) * 60 : ((r - g) / d + 4) * 60
  return { h, s, l }
}

// ---- what kind of fighter it is ----

/** The battle families (see petBattle.ts): kept here so a design can say which it belongs to. */
export type Family = 'wild' | 'sea' | 'spark'

/**
 * The family a photo's animal fights for, from its main colour: blues and
 * cyans are the sea, warm and vivid colours are spark, and greens, browns,
 * greys and the rest of a fur coat's colours are wild. Read off the design, so
 * a friend who only has the battle code gets the same answer.
 */
export function familyOfDesign(d: CustomDesign): Family {
  const { h, s, l } = hslOf(d.colors.body)
  if (s < 0.2 || l < 0.12 || l > 0.92) return 'wild'
  if (h >= 165 && h < 260) return 'sea'
  if (h >= 70 && h < 165) return 'wild'
  // Browns: an orange too dark to be a flame is a coat.
  if (h >= 15 && h < 50 && l < 0.42) return 'wild'
  return 'spark'
}

/**
 * Its build, -1 (lanky) to 1 (round): how much of its bounding box it fills.
 * A round one fights a little sturdier and slower, a lanky one quicker and
 * harder. Zero-sum by design, so a custom animal is never simply stronger
 * than the built-in ones (which have no tilt at all).
 */
export function buildOfDesign(d: CustomDesign): number {
  let x0 = ART
  let x1 = -1
  let y0 = ART
  let y1 = -1
  let n = 0
  d.art.forEach((row, y) =>
    [...row].forEach((ch, x) => {
      if (ch === '.') return
      n++
      x0 = Math.min(x0, x)
      x1 = Math.max(x1, x)
      y0 = Math.min(y0, y)
      y1 = Math.max(y1, y)
    })
  )
  if (!n) return 0
  const fill = n / ((x1 - x0 + 1) * (y1 - y0 + 1))
  return Math.max(-1, Math.min(1, (fill - 0.68) / 0.2))
}

// ---- the registry ----
//
// Rendering, battles and talk all ask "what is u-xyz?" from pure code, so the
// answer is a module-level lookup: the keeper's own species (from the file),
// then designs known only for now (a pet's own snapshot of a species since
// deleted, a friend's animal from a battle code, the maker's draft).

interface SpeciesState {
  own: CustomSpecies[]
  /** Not saved: snapshots, friends' animals, the draft being made. */
  transient: Record<string, CustomDesign>
  loaded: boolean
  /** Bumped on every change, for memos keyed on a species id. */
  rev: number
  load: () => Promise<void>
  /** Add or replace one, and save the file. */
  put: (s: CustomSpecies) => void
  remove: (id: CustomSpeciesId) => void
}

const FILE = 'pet-species'
/**
 * The species file's format. 1: the designs; 2 adds a species' `motion`
 * (optional, so a version 1 file reads unchanged, and an older riven reading
 * a version 2 file just draws the designs).
 */
export const SPECIES_FILE_VERSION = 2
const CHANNEL = 'riven-pet-species'

let channel: BroadcastChannel | null = null
function chan(): BroadcastChannel | null {
  if (channel) return channel
  try {
    channel = new BroadcastChannel(CHANNEL)
  } catch {
    channel = null
  }
  return channel
}

type StoreApi = {
  loadAll(): Promise<Record<string, unknown>>
  save(name: string, data: unknown): Promise<void>
}
const storeApi = (): StoreApi | null =>
  (globalThis as unknown as { window?: { api?: { store?: StoreApi } } }).window?.api?.store ?? null

/** The file's contents, read defensively. */
export function readSpeciesFile(raw: unknown): CustomSpecies[] {
  const list = raw && typeof raw === 'object' ? (raw as { species?: unknown }).species : null
  if (!Array.isArray(list)) return []
  const seen = new Set<string>()
  const out: CustomSpecies[] = []
  for (const r of list) {
    const s = sanitizeSpecies(r)
    if (!s || seen.has(s.id)) continue
    seen.add(s.id)
    out.push(s)
  }
  return out.slice(0, MAX_CUSTOM)
}

function persist(own: CustomSpecies[]): void {
  const api = storeApi()
  if (!api) return
  void api
    .save(FILE, own.length ? { version: SPECIES_FILE_VERSION, species: own } : null)
    .catch((e) => console.error('[petSpecies] saving failed', e))
  // The other window (the floating pet, or the app) reads the file again.
  try {
    chan()?.postMessage('changed')
  } catch {
    /* only this window knows, until the other one next loads */
  }
}

export const useCustomSpecies = create<SpeciesState>((set, get) => {
  const reload = async (): Promise<void> => {
    const api = storeApi()
    if (!api) return set({ loaded: true })
    const files = await api.loadAll().catch(() => ({}) as Record<string, unknown>)
    const own = readSpeciesFile(files[FILE])
    const before = get().own
    if (get().loaded && JSON.stringify(before) === JSON.stringify(own)) return
    set({ own, loaded: true, rev: get().rev + 1 })
  }
  return {
    own: [],
    transient: {},
    loaded: false,
    rev: 0,
    load: async () => {
      if (!get().loaded) {
        const c = chan()
        if (c) c.onmessage = () => void reload()
      }
      await reload()
    },
    // Never before the file was read: saving a list that was never loaded
    // would replace the keeper's species with just this one.
    put: (s) => {
      if (!get().loaded) return
      const own = get().own.some((o) => o.id === s.id)
        ? get().own.map((o) => (o.id === s.id ? s : o))
        : [...get().own, s].slice(0, MAX_CUSTOM)
      set({ own, rev: get().rev + 1 })
      persist(own)
    },
    remove: (id) => {
      if (!get().loaded) return
      const own = get().own.filter((o) => o.id !== id)
      if (own.length === get().own.length) return
      set({ own, rev: get().rev + 1 })
      persist(own)
    }
  }
})

/** Make a design known without saving it (a snapshot, a friend's, the draft). */
export function noteDesign(id: string, d: CustomDesign): void {
  const st = useCustomSpecies.getState()
  const cur = st.transient[id]
  if (cur && (cur === d || sameDesign(cur, d))) return
  useCustomSpecies.setState({ transient: { ...st.transient, [id]: d }, rev: st.rev + 1 })
}

export function forgetDesign(id: string): void {
  const st = useCustomSpecies.getState()
  if (!(id in st.transient)) return
  const transient = { ...st.transient }
  delete transient[id]
  useCustomSpecies.setState({ transient, rev: st.rev + 1 })
}

/** How one of the keeper's own species moves (none for a snapshot or a friend's). */
export function motionOfSpecies(id: string): SpeciesMotion | undefined {
  if (!isCustomId(id)) return undefined
  return useCustomSpecies.getState().own.find((s) => s.id === id)?.motion
}

/** What a custom species looks like: the keeper's own first, then anything known for now. */
export function customOf(id: string): CustomDesign | null {
  if (!isCustomId(id)) return null
  const st = useCustomSpecies.getState()
  return st.own.find((s) => s.id === id) ?? st.transient[id] ?? null
}
