import { tidy } from '../components/petCustomArt'
import {
  ART,
  rgbToHex,
  type CustomColors,
  type CustomDesign,
  type Role
} from '../state/petSpecies'

// ---------------------------------------------------------------------------
// A photo, turned into a pet's dots. All of it runs here, on the pixels, with
// no model and no network: a square crop, the background flood-filled away
// from the edges, the subject squeezed into the 12x12 the art has, its colours
// reduced to the five roles a pet's palette has.
//
// Everything is pure over plain RGBA buffers (what a canvas's getImageData
// gives), so it is tested on synthetic images without a browser.
// ---------------------------------------------------------------------------

export interface Rgba {
  width: number
  height: number
  data: Uint8ClampedArray | Uint8Array
}

/** The working size: big enough to cut a subject out cleanly, small enough to do it live. */
export const WORK = 128

/** A square crop of `img`, resampled to `out`x`out` by averaging (alpha-weighted). */
export function cropSquare(img: Rgba, crop: { x: number; y: number; size: number }, out = WORK): Rgba {
  const data = new Uint8ClampedArray(out * out * 4)
  const step = crop.size / out
  for (let j = 0; j < out; j++)
    for (let i = 0; i < out; i++) {
      const x0 = crop.x + i * step
      const y0 = crop.y + j * step
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      let n = 0
      // A few samples per output pixel is enough for a 128 square.
      const k = Math.max(1, Math.min(4, Math.ceil(step)))
      for (let sy = 0; sy < k; sy++)
        for (let sx = 0; sx < k; sx++) {
          const x = Math.floor(x0 + ((sx + 0.5) * step) / k)
          const y = Math.floor(y0 + ((sy + 0.5) * step) / k)
          n++
          if (x < 0 || y < 0 || x >= img.width || y >= img.height) continue
          const p = (y * img.width + x) * 4
          const al = img.data[p + 3]
          r += img.data[p] * al
          g += img.data[p + 1] * al
          b += img.data[p + 2] * al
          a += al
        }
      const o = (j * out + i) * 4
      if (a > 0) {
        data[o] = r / a
        data[o + 1] = g / a
        data[o + 2] = b / a
      }
      data[o + 3] = a / n
    }
  return { width: out, height: out, data }
}

/** The largest centred square of an image, the crop it starts with. */
export function defaultCrop(w: number, h: number): { x: number; y: number; size: number } {
  const size = Math.min(w, h)
  return { x: Math.floor((w - size) / 2), y: Math.floor((h - size) / 2), size }
}

// ---- colour ----

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

const dist = (p: ArrayLike<number>, q: ArrayLike<number>): number =>
  Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2])

function labsOf(img: Rgba): Float32Array {
  const n = img.width * img.height
  const out = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) {
    const [L, A, B] = labOf(img.data[i * 4], img.data[i * 4 + 1], img.data[i * 4 + 2])
    out[i * 3] = L
    out[i * 3 + 1] = A
    out[i * 3 + 2] = B
  }
  return out
}

interface Cluster {
  lab: [number, number, number]
  rgb: [number, number, number]
  count: number
}

/**
 * k-means over the given pixels, started from evenly spaced lightness
 * quantiles so the same photo always gives the same clusters. Empty clusters
 * are dropped.
 */
export function kmeans(img: Rgba, labs: Float32Array, pixels: number[], k: number, rounds = 12): Cluster[] {
  if (!pixels.length) return []
  // At most a few thousand samples: the clusters of a 128 square do not need more.
  const stride = Math.max(1, Math.floor(pixels.length / 4000))
  const sample = pixels.filter((_, i) => i % stride === 0)
  const byL = [...sample].sort((p, q) => labs[p * 3] - labs[q * 3])
  let centers: Array<[number, number, number]> = []
  for (let c = 0; c < k; c++) {
    const p = byL[Math.min(byL.length - 1, Math.floor(((c + 0.5) / k) * byL.length))]
    centers.push([labs[p * 3], labs[p * 3 + 1], labs[p * 3 + 2]])
  }
  const assign = new Int32Array(sample.length)
  for (let round = 0; round < rounds; round++) {
    const sum = centers.map(() => [0, 0, 0, 0])
    sample.forEach((p, i) => {
      let best = 0
      let bestD = Infinity
      const lab = labs.subarray(p * 3, p * 3 + 3)
      centers.forEach((c, ci) => {
        const d = dist(lab, c)
        if (d < bestD) {
          bestD = d
          best = ci
        }
      })
      assign[i] = best
      sum[best][0] += lab[0]
      sum[best][1] += lab[1]
      sum[best][2] += lab[2]
      sum[best][3]++
    })
    centers = centers.map((c, ci) =>
      sum[ci][3] ? [sum[ci][0] / sum[ci][3], sum[ci][1] / sum[ci][3], sum[ci][2] / sum[ci][3]] : c
    )
  }
  // Final membership over every pixel, with the real sRGB mean of each.
  const acc = centers.map(() => [0, 0, 0, 0])
  for (const p of pixels) {
    const lab = labs.subarray(p * 3, p * 3 + 3)
    let best = 0
    let bestD = Infinity
    centers.forEach((c, ci) => {
      const d = dist(lab, c)
      if (d < bestD) {
        bestD = d
        best = ci
      }
    })
    acc[best][0] += img.data[p * 4]
    acc[best][1] += img.data[p * 4 + 1]
    acc[best][2] += img.data[p * 4 + 2]
    acc[best][3]++
  }
  const out: Cluster[] = []
  centers.forEach((c, ci) => {
    if (!acc[ci][3]) return
    const rgb: [number, number, number] = [acc[ci][0] / acc[ci][3], acc[ci][1] / acc[ci][3], acc[ci][2] / acc[ci][3]]
    out.push({ lab: labOf(...rgb), rgb, count: acc[ci][3] })
  })
  return out
}

// ---- background ----

/**
 * Background, as 1s: everything reachable from the edges of the picture
 * through colours within `tolerance` (Lab distance) of the colours the edges
 * are mostly made of. Transparent pixels are background whatever their colour.
 */
export function backgroundMask(img: Rgba, tolerance: number): Uint8Array {
  const { width: w, height: h } = img
  const labs = labsOf(img)
  const border: number[] = []
  for (let x = 0; x < w; x++) border.push(x, (h - 1) * w + x)
  for (let y = 1; y < h - 1; y++) border.push(y * w, y * w + w - 1)
  const opaque = border.filter((p) => img.data[p * 4 + 3] >= 128)
  // The edge's own colours, and only the ones that are a real share of it: a
  // subject touching the frame must not make its own colour "background".
  const edge = kmeans(img, labs, opaque, 3).filter((c) => c.count >= opaque.length * 0.2)
  const like = (p: number): boolean => {
    if (img.data[p * 4 + 3] < 128) return true
    const lab = labs.subarray(p * 3, p * 3 + 3)
    return edge.some((c) => dist(lab, c.lab) <= tolerance)
  }
  const bg = new Uint8Array(w * h)
  const stack: number[] = []
  for (const p of border)
    if (!bg[p] && like(p)) {
      bg[p] = 1
      stack.push(p)
    }
  while (stack.length) {
    const p = stack.pop()!
    const x = p % w
    const y = (p - x) / w
    const near = [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1]
    for (const q of near) {
      if (q < 0 || bg[q] || !like(q)) continue
      bg[q] = 1
      stack.push(q)
    }
  }
  return bg
}

/** The hand fixes: 0 nothing, 1 keep (always subject), 2 erase (always background). */
export type BrushMode = 'keep' | 'erase'

export function paintBrush(brush: Uint8Array, w: number, cx: number, cy: number, r: number, mode: BrushMode): void {
  const v = mode === 'keep' ? 1 : 2
  const h = brush.length / w
  for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(h - 1, Math.ceil(cy + r)); y++)
    for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(w - 1, Math.ceil(cx + r)); x++)
      if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) brush[y * w + x] = v
}

/** The subject, as 1s: not background, or kept by hand, and never erased by hand. */
export function foregroundOf(bg: Uint8Array, brush?: Uint8Array): Uint8Array {
  const fg = new Uint8Array(bg.length)
  for (let i = 0; i < bg.length; i++) {
    const b = brush?.[i] ?? 0
    fg[i] = b === 2 ? 0 : b === 1 ? 1 : bg[i] ? 0 : 1
  }
  return fg
}

/** Only the largest four-connected piece of a mask (stray dots of a busy background go). */
function largestPart(mask: Uint8Array, w: number): Uint8Array {
  const h = mask.length / w
  const label = new Int32Array(mask.length)
  let best = 0
  let bestN = 0
  let next = 0
  for (let s = 0; s < mask.length; s++) {
    if (!mask[s] || label[s]) continue
    next++
    let n = 0
    const stack = [s]
    label[s] = next
    while (stack.length) {
      const p = stack.pop()!
      n++
      const x = p % w
      const y = (p - x) / w
      for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1]) {
        if (q < 0 || !mask[q] || label[q]) continue
        label[q] = next
        stack.push(q)
      }
    }
    if (n > bestN) {
      bestN = n
      best = next
    }
  }
  const out = new Uint8Array(mask.length)
  for (let i = 0; i < mask.length; i++) out[i] = label[i] === best && best > 0 ? 1 : 0
  return out
}

// ---- roles ----

const chroma = (lab: ArrayLike<number>): number => Math.hypot(lab[1], lab[2])

/**
 * Which role each cluster plays. The biggest is the body. The rest are tried
 * in every arrangement over shade (darker, same hue), highlight (lighter,
 * same hue), white (light and colourless) and accent (a different colour), and
 * the cheapest arrangement wins. A cluster barely different from the body is
 * just more body.
 */
export function assignRoles(clusters: Cluster[]): { roles: Role[]; colors: CustomColors } {
  if (!clusters.length) {
    return { roles: [], colors: deriveColors([200, 140, 90], {}) }
  }
  const bodyIx = clusters.reduce((bi, c, i) => (c.count > clusters[bi].count ? i : bi), 0)
  const body = clusters[bodyIx]
  const roles: Role[] = clusters.map(() => 'b')
  const others = clusters.map((_, i) => i).filter((i) => i !== bodyIx && dist(clusters[i].lab, body.lab) >= 8)
  const Lb = body.lab[0]
  const hueGap = (c: Cluster): number => Math.hypot(c.lab[1] - body.lab[1], c.lab[2] - body.lab[2])
  const cost = (c: Cluster, r: Role): number => {
    const L = c.lab[0]
    switch (r) {
      case 's':
        return hueGap(c) * 0.6 + Math.max(0, L - (Lb - 8)) * 2.5
      case 'h':
        return hueGap(c) * 0.6 + Math.max(0, Lb + 8 - L) * 2.5
      case 'w':
        return Math.max(0, 82 - L) * 2 + chroma(c.lab) * 1.2
      case 'a':
        return Math.max(0, 45 - dist(c.lab, body.lab)) * 1.5 + 12
      default:
        return 0
    }
  }
  const pool: Role[] = ['s', 'h', 'a', 'w']
  let best: Role[] = []
  let bestCost = Infinity
  const walk = (i: number, used: Role[], total: number): void => {
    if (total >= bestCost) return
    if (i === others.length) {
      bestCost = total
      best = [...used]
      return
    }
    for (const r of pool) {
      if (used.includes(r)) continue
      walk(i + 1, [...used, r], total + cost(clusters[others[i]], r))
    }
  }
  walk(0, [], 0)
  others.forEach((ci, k) => (roles[ci] = best[k] ?? 'b'))
  const got: Partial<Record<Role, [number, number, number]>> = {}
  // Two clusters can share a role only as body; the others are one each.
  clusters.forEach((c, i) => {
    if (roles[i] !== 'b') got[roles[i]] = c.rgb
  })
  return { roles, colors: deriveColors(body.rgb, got) }
}

/** The five colours, the ones the photo did not have made up from its body colour. */
function deriveColors(body: number[], got: Partial<Record<Role, number[]>>): CustomColors {
  const mix = (a: number[], b: number[], t: number): number[] => a.map((v, i) => v + (b[i] - v) * t)
  const accent = (): number[] => {
    // A warm gold against a cool body, a teal against a warm one.
    const [r, , b] = body
    return r >= b ? [70, 170, 190] : [235, 180, 60]
  }
  return {
    body: rgbToHex(body),
    shade: rgbToHex(got.s ?? mix(body, [0, 0, 0], 0.3)),
    highlight: rgbToHex(got.h ?? mix(body, [255, 255, 255], 0.35)),
    accent: rgbToHex(got.a ?? accent()),
    white: rgbToHex(got.w ?? mix(body, [255, 255, 255], 0.85))
  }
}

// ---- dots ----

export interface PhotoDots {
  art: string[]
  colors: CustomColors
}

/**
 * The subject in the art's 12x12: fitted to its own bounding box (square, so
 * it keeps its proportions, standing on the bottom row), a dot where enough of
 * the cell is subject, each dot the role most of its pixels have. Then one
 * piece with no holes.
 */
export function dotsOf(img: Rgba, fg: Uint8Array, colors = 5): PhotoDots | null {
  const w = img.width
  const h = img.height
  const mask = largestPart(fg, w)
  const pixels: number[] = []
  let x0 = w
  let x1 = -1
  let y0 = h
  let y1 = -1
  for (let p = 0; p < mask.length; p++) {
    if (!mask[p]) continue
    pixels.push(p)
    const x = p % w
    const y = (p - x) / w
    x0 = Math.min(x0, x)
    x1 = Math.max(x1, x)
    y0 = Math.min(y0, y)
    y1 = Math.max(y1, y)
  }
  if (pixels.length < 16) return null
  const labs = labsOf(img)
  const clusters = kmeans(img, labs, pixels, colors)
  const { roles, colors: palette } = assignRoles(clusters)
  const roleOf = (p: number): Role => {
    const lab = labs.subarray(p * 3, p * 3 + 3)
    let best = 0
    let bestD = Infinity
    clusters.forEach((c, i) => {
      const d = dist(lab, c.lab)
      if (d < bestD) {
        bestD = d
        best = i
      }
    })
    return roles[best] ?? 'b'
  }
  const side = Math.max(x1 - x0 + 1, y1 - y0 + 1)
  const cell = side / ART
  // Centred across, standing on the bottom.
  const ox = x0 - (side - (x1 - x0 + 1)) / 2
  const oy = y1 + 1 - side
  const grid: string[][] = Array.from({ length: ART }, () => Array(ART).fill('.'))
  for (let j = 0; j < ART; j++)
    for (let i = 0; i < ART; i++) {
      const votes: Record<string, number> = {}
      let n = 0
      let total = 0
      for (let y = Math.floor(oy + j * cell); y < Math.ceil(oy + (j + 1) * cell); y++)
        for (let x = Math.floor(ox + i * cell); x < Math.ceil(ox + (i + 1) * cell); x++) {
          total++
          if (x < 0 || y < 0 || x >= w || y >= h || !mask[y * w + x]) continue
          n++
          const r = roleOf(y * w + x)
          votes[r] = (votes[r] ?? 0) + 1
        }
      if (!total || n / total < 0.42) continue
      grid[j][i] = Object.keys(votes).sort((p, q) => votes[q] - votes[p] || (p === 'b' ? -1 : q === 'b' ? 1 : 0))[0]
    }
  tidy(grid)
  return { art: grid.map((r) => r.join('')), colors: palette }
}

/** Lightness 0..100 of a role's colour. */
const lightOf = (hex: string): number => {
  const n = parseInt(hex.slice(1), 16)
  return labOf((n >> 16) & 255, (n >> 8) & 255, n & 255)[0]
}

/** Every top-left where the 6x4 face window is all dots of the art. */
export function faceSpots(art: string[]): Array<{ x: number; y: number }> {
  const out: Array<{ x: number; y: number }> = []
  for (let y = 0; y + 4 <= ART; y++)
    for (let x = 0; x + 6 <= ART; x++) {
      const rows = art.slice(y, y + 4).map((r) => r.slice(x, x + 6))
      if (!rows.some((r) => r.includes('.'))) out.push({ x, y })
    }
  return out
}

/**
 * Where the face should go: the brightest, flattest place for a 6x4 window up
 * in the middle of the animal (where a face is). Where it fits nowhere, the
 * spot nearest there; the bodies make room for it (see petCustomArt).
 */
export function suggestFace(art: string[], colors: CustomColors): { x: number; y: number } {
  let x0 = ART
  let x1 = -1
  let y0 = ART
  let y1 = -1
  art.forEach((row, y) =>
    [...row].forEach((ch, x) => {
      if (ch === '.') return
      x0 = Math.min(x0, x)
      x1 = Math.max(x1, x)
      y0 = Math.min(y0, y)
      y1 = Math.max(y1, y)
    })
  )
  if (x1 < 0) return { x: 3, y: 3 }
  const tx = (x0 + x1 + 1) / 2
  const ty = y0 + (y1 - y0 + 1) * 0.38
  const role: Record<string, keyof CustomColors> = { b: 'body', s: 'shade', h: 'highlight', a: 'accent', w: 'white' }
  let best: { x: number; y: number } | null = null
  let bestScore = -Infinity
  for (const at of faceSpots(art)) {
    const count: Record<string, number> = {}
    let light = 0
    for (let dy = 0; dy < 4; dy++)
      for (let dx = 0; dx < 6; dx++) {
        const ch = art[at.y + dy][at.x + dx]
        count[ch] = (count[ch] ?? 0) + 1
        light += lightOf(colors[role[ch]])
      }
    const flat = Math.max(...Object.values(count)) / 24
    const far = Math.hypot(at.x + 3 - tx, at.y + 2 - ty)
    const score = flat * 3 + (light / 24 / 100) * 1.5 - far * 0.45
    if (score > bestScore) {
      bestScore = score
      best = at
    }
  }
  return (
    best ?? {
      x: Math.max(0, Math.min(ART - 6, Math.round(tx - 3))),
      y: Math.max(0, Math.min(ART - 4, Math.round(ty - 2)))
    }
  )
}

/** The whole way from a cut-out photo to a design, the face suggested. */
export function designFromPhoto(img: Rgba, fg: Uint8Array, name: string): CustomDesign | null {
  const dots = dotsOf(img, fg)
  if (!dots) return null
  return { name, ...dots, face: suggestFace(dots.art, dots.colors), noFace: false }
}
