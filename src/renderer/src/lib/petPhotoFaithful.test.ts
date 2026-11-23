import { describe, it, expect, beforeAll } from 'vitest'
import {
  PHOTO_FIT,
  photoFit,
  backgroundMask,
  cropSquare,
  defaultCrop,
  faithfulDesignFromPhoto,
  finishPhoto,
  foregroundOf,
  labOf,
  photoArtOf,
  quantizeLab,
  type Rgba
} from './petPhoto'
import { canvas, catPhoto, diskPhoto, paint, penguinPhoto } from './petPhoto.fixtures'
import {
  PHOTO,
  PHOTO_CHARS,
  PHOTO_SIZES,
  designOf,
  minPhotoCells,
  photoAt32,
  photoLine,
  photoSizeOf,
  hexToRgb,
  noteDesign,
  packDesign,
  readSpeciesFile,
  sameDesign,
  sanitizeDesign,
  sanitizePhoto,
  unpackDesign,
  type CustomDesign,
  type CustomSpeciesId,
  type PhotoArt
} from '../state/petSpecies'
import { PHOTO_DOT, customBody, photoGrid } from '../components/petCustomArt'
import { PALETTE, SPRITE_SIZE, outfitPixels, photoDrawing, pixelsOf, runPaths, runsOf } from '../components/petSprites'
import { PRIZES } from '../state/pet'

// "사진 충실 모드": a photo species drawn as its own 32x32 picture.

const cutout = (img: Rgba, tol = 18): { sq: Rgba; fg: Uint8Array } => {
  const sq = cropSquare(img, defaultCrop(img.width, img.height))
  return { sq, fg: foregroundOf(backgroundMask(sq, tol)) }
}
const lit = (rows: string[]): number => rows.join('').replace(/\./g, '').length
const dist = (a: number[], b: number[]): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])

/** Eight-connected parts of a grid of characters. */
function parts(rows: string[]): number {
  const seen = new Set<string>()
  let n = 0
  rows.forEach((row, y) =>
    [...row].forEach((ch, x) => {
      if (ch === '.' || seen.has(`${x},${y}`)) return
      n++
      const stack = [[x, y]]
      seen.add(`${x},${y}`)
      while (stack.length) {
        const [cx, cy] = stack.pop()!
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const nx = cx + dx
            const ny = cy + dy
            if (rows[ny]?.[nx] === undefined || rows[ny][nx] === '.' || seen.has(`${nx},${ny}`)) continue
            seen.add(`${nx},${ny}`)
            stack.push([nx, ny])
          }
      }
    })
  )
  return n
}

/** A two-colour animal on white: a red head over a blue body, with a black eye. */
function twoTone(): Rgba {
  const img = canvas(160, 160, () => [250, 250, 250])
  paint(img, (x, y) => (x - 80) ** 2 + (y - 60) ** 2 < 30 ** 2, () => [210, 40, 40])
  paint(img, (x, y) => x >= 40 && x < 120 && y >= 85 && y < 140, () => [40, 70, 200])
  paint(img, (x, y) => (x - 92) ** 2 + (y - 55) ** 2 < 6 ** 2, () => [10, 10, 10])
  return img
}

describe('quantizeLab', () => {
  const labsOfList = (cols: number[][]): Float32Array => {
    const out = new Float32Array(cols.length * 3)
    cols.forEach((c, i) => out.set(labOf(c[0], c[1], c[2]), i * 3))
    return out
  }

  it('keeps distinct colours apart and never makes more than it was asked for', () => {
    const cols = [
      ...Array(50).fill([200, 30, 30]),
      ...Array(50).fill([30, 30, 200]),
      ...Array(3).fill([250, 250, 250]),
      ...Array(40).fill([40, 160, 40])
    ]
    const { centers, assign } = quantizeLab(labsOfList(cols), 16)
    // Four colours, however many were allowed: a box of one colour is never split.
    expect(centers.length).toBe(4)
    // A small but different colour (the three white dots) gets its own.
    expect(new Set(assign.slice(100, 103)).size).toBe(1)
    expect(assign[100]).not.toBe(assign[0])
    const two = quantizeLab(labsOfList(cols), 2)
    expect(two.centers.length).toBeLessThanOrEqual(2)
  })

  it('is deterministic', () => {
    const cols = Array.from({ length: 300 }, (_, i) => [(i * 37) % 256, (i * 91) % 256, (i * 13) % 256])
    const a = quantizeLab(labsOfList(cols), 12)
    const b = quantizeLab(labsOfList(cols), 12)
    expect(a.centers).toEqual(b.centers)
    expect([...a.assign]).toEqual([...b.assign])
    expect(a.centers.length).toBeLessThanOrEqual(12)
  })

  it('handles nothing', () => {
    expect(quantizeLab(new Float32Array(0), 8).centers).toEqual([])
  })
})

describe('photoArtOf', () => {
  it.each([
    ['cat', catPhoto],
    ['penguin', penguinPhoto],
    ['disk', () => diskPhoto()],
    ['two-tone', twoTone]
  ])('%s: a valid 32x32 picture in one piece, standing on the bottom, a dot of air for its outline', (_, make) => {
    const { sq, fg } = cutout(make())
    const p = photoArtOf(sq, fg)!
    expect(p).not.toBeNull()
    expect(p.rows).toHaveLength(PHOTO)
    for (const row of p.rows) expect(row).toHaveLength(PHOTO)
    expect(p.palette.length).toBeGreaterThan(0)
    expect(p.palette.length).toBeLessThanOrEqual(16)
    expect(sanitizePhoto(p)).toEqual(p)
    expect(parts(p.rows)).toBe(1)
    // Row 0, row 31 and the side columns stay clear for the outline.
    expect(p.rows[0]).toBe('.'.repeat(PHOTO))
    expect(p.rows[PHOTO - 1]).toBe('.'.repeat(PHOTO))
    for (const row of p.rows) expect(row[0] + row[PHOTO - 1]).toBe('..')
    // Standing on the bottom of its room.
    expect(p.rows[PHOTO_FIT]).not.toBe('.'.repeat(PHOTO))
    // Its colours are numbered most used first.
    const count = p.palette.map((_, i) => p.rows.join('').split(PHOTO_CHARS[i]).length - 1)
    expect([...count].sort((a, b) => b - a)).toEqual(count)
    expect(count.every((n) => n > 0)).toBe(true)
  })

  it('looks like the photo: its colours where they were, the eye kept', () => {
    const { sq, fg } = cutout(twoTone())
    const p = photoArtOf(sq, fg)!
    const at = (x: number, y: number): number[] => hexToRgb(p.palette[PHOTO_CHARS.indexOf(p.rows[y][x])])
    // Find the head and the body by colour: the top lit row is red, the bottom one blue.
    // (Inside the head, not on its edge, where a dot is part background.)
    const top = p.rows.findIndex((r) => r !== '.'.repeat(PHOTO)) + 4
    const span = [p.rows[top].search(/[^.]/), p.rows[top].length - 1 - [...p.rows[top]].reverse().join('').search(/[^.]/)]
    expect(dist(at(Math.floor((span[0] + span[1]) / 2) - 3, top), [210, 40, 40])).toBeLessThan(40)
    const bottom = PHOTO_FIT
    expect(dist(at(16, bottom), [40, 70, 200])).toBeLessThan(40)
    // The black eye is still a dot of its own (near black), which the 12x12 never kept.
    const dark = p.palette.map(hexToRgb).filter((c) => dist(c, [10, 10, 10]) < 60)
    expect(dark.length).toBeGreaterThan(0)
  })

  it('makes no more colours than asked for', () => {
    const { sq, fg } = cutout(catPhoto())
    expect(photoArtOf(sq, fg, 8)!.palette.length).toBeLessThanOrEqual(8)
    expect(photoArtOf(sq, fg, 12)!.palette.length).toBeLessThanOrEqual(12)
  })

  it('is the same picture every time', () => {
    const { sq, fg } = cutout(catPhoto())
    expect(photoArtOf(sq, fg)).toEqual(photoArtOf(sq, fg))
  })

  it('is null when nothing (or a speck) is left', () => {
    const { sq } = cutout(catPhoto())
    expect(photoArtOf(sq, new Uint8Array(sq.width * sq.height))).toBeNull()
    const speck = new Uint8Array(sq.width * sq.height)
    for (let i = 0; i < 9; i++) speck[64 * sq.width + 60 + i] = 1
    expect(photoArtOf(sq, speck)).toBeNull()
  })

  it('finishPhoto drops unused colours and renumbers by use', () => {
    const grid = Array.from({ length: PHOTO }, (_, y) =>
      Array.from({ length: PHOTO }, (_, x) => (y < 2 ? '.' : x < 4 ? '2' : x < 30 ? '0' : '.'))
    )
    const p = finishPhoto(grid, ['#ff0000', '#00ff00', '#0000ff'])!
    expect(p.palette).toEqual(['#ff0000', '#0000ff'])
    expect(p.rows[5].slice(0, 6)).toBe('111100')
  })
})

describe('a faithful design', () => {
  const { sq, fg } = cutout(catPhoto())
  const d = faithfulDesignFromPhoto(sq, fg, 'Cheddar')!

  it('carries the picture and, beside it, a full 12x12 design', () => {
    expect(d.photo).toBeTruthy()
    expect(d.noFace).toBe(true)
    expect(d.art).toHaveLength(12)
    expect(sanitizeDesign(d)).toEqual(d)
  })

  it('survives the file, a snapshot and a battle code', () => {
    const json = JSON.parse(JSON.stringify(designOf(d)))
    expect(sameDesign(sanitizeDesign(json)!, d)).toBe(true)
    const back = unpackDesign(JSON.parse(JSON.stringify(packDesign(d))))!
    expect(back.photo).toEqual(d.photo)
    expect(sameDesign(back, d)).toBe(true)
  })

  it('reads as its 12x12 to a riven from before pictures', () => {
    // An old reader takes the first six fields of the code and ignores `photo` in the file.
    const old = unpackDesign(packDesign(d).slice(0, 6))!
    expect(old.photo).toBeUndefined()
    expect(old.art).toEqual(d.art)
    const { photo: _photo, ...file } = d
    expect(sanitizeDesign(file)?.photo).toBeUndefined()
  })

  it('sits in pet-species.json beside the old 12x12 species, both read back', () => {
    const { photo: _p, ...old } = { ...d, noFace: false }
    const file = JSON.parse(
      JSON.stringify({
        version: 1,
        species: [
          { ...old, id: 'u-old0001', createdAt: 1, updatedAt: 1 },
          { ...d, id: 'u-new0001', createdAt: 2, updatedAt: 2 }
        ]
      })
    )
    const [a, b] = readSpeciesFile(file)
    expect(a.photo).toBeUndefined()
    expect(a.noFace).toBe(false)
    expect(b.photo).toEqual(d.photo)
  })

  it('a change of the picture is a change of the design', () => {
    const rows = [...d.photo!.rows]
    const y = rows.findIndex((r) => r.includes('0'))
    rows[y] = rows[y].replace('0', '1')
    expect(sameDesign(d, { ...d, photo: { ...d.photo!, rows } })).toBe(false)
  })
})

describe('sanitizePhoto', () => {
  const ok: PhotoArt = {
    palette: ['#112233', '#445566'],
    rows: Array.from({ length: PHOTO }, (_, y) => (y > 4 && y < 28 ? '..' + '01'.repeat(14) + '..' : '.'.repeat(PHOTO)))
  }
  const base: CustomDesign = sanitizeDesign({
    name: 'x',
    colors: { body: '#c08040', shade: '#603010', highlight: '#e0b080', accent: '#4080c0', white: '#f4f0ea' },
    art: Array.from({ length: 12 }, () => 'bbbbbbbbbbbb'),
    face: { x: 3, y: 3 },
    noFace: false
  })!

  it('accepts a good one, lower-casing colours', () => {
    expect(sanitizePhoto({ ...ok, palette: ['#AABBCC', '#445566'] })?.palette[0]).toBe('#aabbcc')
    expect(sanitizePhoto(ok)).toEqual(ok)
  })

  it.each([
    ['no palette', { ...ok, palette: [] }],
    ['17 colours', { ...ok, palette: Array(17).fill('#000000') }],
    ['a bad colour', { ...ok, palette: ['#12345', '#445566'] }],
    ['31 rows', { ...ok, rows: ok.rows.slice(1) }],
    ['a short row', { ...ok, rows: [...ok.rows.slice(0, 10), '...', ...ok.rows.slice(11)] }],
    ['an index past the palette', { ...ok, rows: ok.rows.map((r) => r.replace(/1/g, '2')) }],
    ['a letter', { ...ok, rows: ok.rows.map((r) => r.replace(/1/g, 'x')) }],
    ['a speck', { ...ok, rows: ok.rows.map((r, y) => (y === 10 ? '..0' + '.'.repeat(29) : '.'.repeat(PHOTO))) }],
    ['not an object', 'abc']
  ])('rejects %s, and the design keeps its 12x12', (_, photo) => {
    expect(sanitizePhoto(photo)).toBeNull()
    const d = sanitizeDesign({ ...base, photo })!
    expect(d).not.toBeNull()
    expect(d.photo).toBeUndefined()
    // Without its picture it is an ordinary design again, face and all.
    expect(d.noFace).toBe(false)
  })

  it('an old design comes back exactly as it was', () => {
    expect(sanitizeDesign(base)).toEqual(base)
    expect('photo' in sanitizeDesign(base)!).toBe(false)
  })

  it('a picture never shows a face', () => {
    expect(sanitizeDesign({ ...base, photo: ok })!.noFace).toBe(true)
  })
})

describe('a faithful design, drawn', () => {
  const designs: Record<string, CustomDesign> = {
    cat: faithfulDesignFromPhoto(...Object.values(cutout(catPhoto())) as [Rgba, Uint8Array], 'cat')!,
    penguin: faithfulDesignFromPhoto(...Object.values(cutout(penguinPhoto())) as [Rgba, Uint8Array], 'penguin')!,
    twoTone: faithfulDesignFromPhoto(...Object.values(cutout(twoTone())) as [Rgba, Uint8Array], 'tt')!
  }
  const id = (k: string): CustomSpeciesId => `u-faith${k.toLowerCase()}` as CustomSpeciesId
  beforeAll(() => Object.entries(designs).forEach(([k, d]) => noteDesign(id(k), d)))
  const allowed = PALETTE + PHOTO_DOT

  it.each(Object.keys(designs))('%s: drawn inside the grid in every mood, with no face', (k) => {
    for (const mood of ['happy', 'ok', 'sad'] as const) {
      const dots = pixelsOf(mood, id(k))
      expect(dots.length).toBeGreaterThan(20)
      for (const d of dots) {
        expect(d.x >= 0 && d.y >= 0 && d.x < SPRITE_SIZE && d.y < SPRITE_SIZE).toBe(true)
        expect(allowed.includes(d.ch)).toBe(true)
        // No eyes, no mouth: the picture is its face.
        expect(d.ch === 'e' || d.ch === 'm').toBe(false)
      }
    }
  })

  it.each(Object.keys(designs))('%s: the pet is the picture itself, dot for dot', (k) => {
    const d = designs[k]
    const dots = pixelsOf('ok', id(k))
    const at = new Map(dots.map((p) => [`${p.x},${p.y}`, p.ch]))
    d.photo!.rows.forEach((row, y) =>
      [...row].forEach((ch, x) => {
        if (ch !== '.') expect(at.get(`${x},${y}`)).toBe(PHOTO_DOT[PHOTO_CHARS.indexOf(ch)])
      })
    )
    // And outlined, in one piece.
    expect(dots.some((p) => p.ch === 'o')).toBe(true)
    expect(parts(photoGrid(d).map((r) => r.replace(/o/g, '.')))).toBe(1)
  })

  it('caches the picture: drawing a frame does no work', () => {
    const d = designs.cat
    expect(photoGrid(d)).toBe(photoGrid(d))
    expect(customBody(d)).toBe(customBody(d))
  })

  it.each(Object.keys(designs))('%s: can wear every prize, and shows its decorations', (k) => {
    for (const prize of PRIZES) {
      const { back, front } = outfitPixels(id(k), [prize.id])
      for (const d of [...back, ...front]) expect(d.x >= 0 && d.x < SPRITE_SIZE && d.y >= 0 && d.y < SPRITE_SIZE).toBe(true)
    }
    const hat = PRIZES.find((p) => p.slot === 'head')!
    expect(outfitPixels(id(k), [hat.id]).front.length).toBeGreaterThan(0)
    const decor = outfitPixels(id(k), [], 50)
    expect(decor.back.length + decor.front.length).toBeGreaterThan(0)
  })
})

// ---- the resolution choice: 32, 48 or 64 dots across the same 32 css pixels ----

describe('a faithful picture at 32, 48 and 64', () => {
  const made = Object.fromEntries(
    PHOTO_SIZES.map((n) => {
      const { sq, fg } = cutout(catPhoto())
      return [n, faithfulDesignFromPhoto(sq, fg, `cat${n}`, 16, n)!]
    })
  ) as Record<(typeof PHOTO_SIZES)[number], CustomDesign>

  it.each(PHOTO_SIZES)('%i: a valid picture of that size, in one piece, with room for its outline', (n) => {
    const p = made[n].photo!
    expect(photoSizeOf(p)).toBe(n)
    // 32 says nothing of its size, as every picture from before the choice.
    expect('size' in p).toBe(n !== PHOTO)
    expect(p.rows).toHaveLength(n)
    for (const row of p.rows) expect(row).toHaveLength(n)
    expect(sanitizePhoto(p)).toEqual(p)
    expect(parts(p.rows)).toBe(1)
    const air = photoLine(n)
    for (let k = 0; k < air; k++) {
      expect(p.rows[k]).toBe('.'.repeat(n))
      expect(p.rows[n - 1 - k]).toBe('.'.repeat(n))
      for (const row of p.rows) expect(row[k] + row[n - 1 - k]).toBe('..')
    }
    // Standing on the bottom of its room.
    expect(p.rows[air + photoFit(n) - 1]).not.toBe('.'.repeat(n))
  })

  it('more dots, more detail: a bigger grid lights more dots', () => {
    const lit32 = lit(made[32].photo!.rows)
    const lit48 = lit(made[48].photo!.rows)
    const lit64 = lit(made[64].photo!.rows)
    expect(lit48).toBeGreaterThan(lit32 * 1.8)
    expect(lit64).toBeGreaterThan(lit48 * 1.5)
  })

  it.each(PHOTO_SIZES)('%i: survives the file and a snapshot exactly', (n) => {
    const d = made[n]
    const json = JSON.parse(JSON.stringify(designOf(d)))
    const back = sanitizeDesign(json)!
    expect(back.photo).toEqual(d.photo)
    expect(sameDesign(back, d)).toBe(true)
    const [again] = readSpeciesFile(
      JSON.parse(JSON.stringify({ version: 1, species: [{ ...d, id: 'u-res00001', createdAt: 1, updatedAt: 1 }] }))
    )
    expect(again.photo).toEqual(d.photo)
  })

  it.each(PHOTO_SIZES)('%i: a battle code carries it at 32x32, so codes stay short', (n) => {
    const d = made[n]
    const packed = packDesign(d)
    const [hex, dots] = packed[6] as [string, string]
    expect(dots).toHaveLength(PHOTO * PHOTO)
    expect(hex).toHaveLength(d.photo!.palette.length * 6)
    const back = unpackDesign(JSON.parse(JSON.stringify(packed)))!
    expect(back.photo).toBeTruthy()
    expect(photoSizeOf(back.photo!)).toBe(PHOTO)
    expect('size' in back.photo!).toBe(false)
    expect(back.photo!.palette).toEqual(d.photo!.palette)
    expect(back.photo).toEqual(photoAt32(d.photo!))
    if (n === PHOTO) expect(back.photo).toEqual(d.photo)
    // The rest of the design is untouched.
    expect(back.art).toEqual(d.art)
    expect(back.colors).toEqual(d.colors)
    // A 64 code is no longer than a 32 one would be.
    expect(JSON.stringify(packed).length).toBeLessThanOrEqual(JSON.stringify(packDesign(made[32])).length + 200)
  })

  it('photoAt32 is area-weighted: a 64 drawn in 2x2 blocks comes down to exactly its 32', () => {
    const p32 = made[32].photo!
    const rows64 = p32.rows.flatMap((r) => {
      const wide = [...r].map((c) => c + c).join('')
      return [wide, wide]
    })
    const p64 = sanitizePhoto({ ...p32, rows: rows64, size: 64 })!
    expect(p64).not.toBeNull()
    // Dot for dot the same colours (two palette entries can be the same colour,
    // so the colours are compared, not the indices).
    const hexes = (p: PhotoArt): string[] => p.rows.map((r) => [...r].map((c) => (c === '.' ? '.' : p.palette[PHOTO_CHARS.indexOf(c)])).join(','))
    const down = photoAt32(p64)!
    expect(down.palette).toEqual(p32.palette)
    expect(hexes(down)).toEqual(hexes(p32))
    // And a 32 is returned as it is.
    expect(photoAt32(p32)).toBe(p32)
  })

  it('photoAt32 picks the palette colour nearest the mean, and drops dots under half lit', () => {
    // A 64 grid: one red dot in each 2x2 block of a red region (a quarter lit) and
    // full blocks elsewhere, half red and half dark red.
    const rows = Array.from({ length: 64 }, (_, y) =>
      Array.from({ length: 64 }, (_, x) => {
        if (y < 16 || y >= 48 || x < 8 || x >= 56) return '.'
        if (y < 24) return x % 2 === 0 && y % 2 === 0 ? '0' : '.'
        return x % 2 === 0 ? '0' : '1'
      }).join('')
    )
    const p = sanitizePhoto({ palette: ['#ff0000', '#800000', '#c00000'], rows, size: 64 })!
    expect(p).not.toBeNull()
    const small = photoAt32(p)!
    // The quarter-lit rows are gone.
    expect(small.rows[8]).toBe('.'.repeat(32))
    // Half #ff0000 and half #800000 is nearest #c00000.
    expect(small.rows[20][10]).toBe('2')
  })

  describe('sanitizePhoto with a size', () => {
    const square = (n: number, size?: unknown): unknown => ({
      palette: ['#112233', '#445566'],
      rows: Array.from({ length: n }, (_, y) =>
        y > 4 && y < n - 4 ? '..' + '01'.repeat((n - 4) / 2) + '..' : '.'.repeat(n)
      ),
      ...(size === undefined ? {} : { size })
    })

    it.each(PHOTO_SIZES)('accepts %i with rows to match', (n) => {
      const p = sanitizePhoto(square(n, n))!
      expect(p).not.toBeNull()
      expect(photoSizeOf(p)).toBe(n)
    })

    it('an old 32 picture (no size) comes back exactly as it was; a 32 that says so is the same picture', () => {
      const old = square(32) as PhotoArt
      expect(sanitizePhoto(old)).toEqual(old)
      expect('size' in sanitizePhoto(old)!).toBe(false)
      expect(sanitizePhoto(square(32, 32))).toEqual(old)
    })

    it.each([
      ['a size it cannot be made at', square(40, 40)],
      ['16', square(16, 16)],
      ['a size as text', square(48, '48')],
      ['48 with 32 rows', square(32, 48)],
      ['no size with 64 rows', square(64)],
      ['64 with 48 rows', square(48, 64)],
      ['64 with a short row', { ...(square(64, 64) as PhotoArt), rows: [...(square(64, 64) as PhotoArt).rows.slice(0, 63), '.'.repeat(48)] }],
      ['64 with 17 colours', { ...(square(64, 64) as PhotoArt), palette: Array(17).fill('#000000') }],
      ['a speck at 64', { palette: ['#000000'], rows: Array.from({ length: 64 }, (_, y) => (y === 9 ? '0'.repeat(minPhotoCells(64) - 1).padEnd(64, '.') : '.'.repeat(64))), size: 64 }]
    ])('rejects %s', (_, raw) => {
      expect(sanitizePhoto(raw)).toBeNull()
    })
  })

  describe('drawn', () => {
    const id = (n: number): CustomSpeciesId => `u-res${n}` as CustomSpeciesId
    beforeAll(() => PHOTO_SIZES.forEach((n) => noteDesign(id(n), made[n])))
    it.each(PHOTO_SIZES)('%i: the picture on its grid, and what the rest reads on the 32 one', (n) => {
      const drawn = photoDrawing(id(n))!
      expect(drawn.size).toBe(n)
      expect(drawn.picture.length).toBeGreaterThan(20)
      for (const d of drawn.picture) {
        expect(d.x >= 0 && d.y >= 0 && d.x < n && d.y < n).toBe(true)
        expect((PHOTO_DOT + 'o').includes(d.ch)).toBe(true)
      }
      // What the rest of the pet reads is on the 32 grid, faceless.
      for (const d of pixelsOf('happy', id(n))) {
        expect(d.x >= 0 && d.y >= 0 && d.x < SPRITE_SIZE && d.y < SPRITE_SIZE).toBe(true)
        expect((PALETTE + PHOTO_DOT).includes(d.ch)).toBe(true)
        expect(d.ch === 'e' || d.ch === 'm').toBe(false)
      }
      expect(photoGrid(made[n])).toHaveLength(n)
    })

    it.each(PHOTO_SIZES)('%i: the pet is the picture itself, dot for dot, outlined', (n) => {
      const p = made[n].photo!
      const drawn = photoDrawing(id(n))!
      const at = new Map(drawn.picture.map((d) => [`${d.x},${d.y}`, d.ch]))
      p.rows.forEach((row, y) =>
        [...row].forEach((ch, x) => {
          if (ch !== '.') expect(at.get(`${x},${y}`)).toBe(PHOTO_DOT[PHOTO_CHARS.indexOf(ch)])
        })
      )
      expect(drawn.picture.filter((d) => d.ch === 'o').length).toBeGreaterThan(n)
    })

    it.each(PHOTO_SIZES)('%i: drawn as whole-dot paths, no fractional coordinates', (n) => {
      const paths = runPaths(runsOf(photoDrawing(id(n))!.picture))
      expect(paths.length).toBeLessThanOrEqual(18)
      for (const { d } of paths) {
        expect(d).not.toMatch(/\./)
        for (const v of d.match(/-?\d+/g)!.map(Number)) expect(Math.abs(v)).toBeLessThanOrEqual(n)
      }
    })

    it.each(PHOTO_SIZES)('%i: cached, wears every prize, and its decorations never cover the picture', (n) => {
      const d = made[n]
      expect(photoGrid(d)).toBe(photoGrid(d))
      expect(customBody(d)).toBe(customBody(d))
      for (const prize of PRIZES) {
        const { back, front } = outfitPixels(id(n), [prize.id])
        for (const p of [...back, ...front]) expect(p.x >= 0 && p.x < SPRITE_SIZE && p.y >= 0 && p.y < SPRITE_SIZE).toBe(true)
      }
      const hat = PRIZES.find((p) => p.slot === 'head')!
      expect(outfitPixels(id(n), [hat.id]).front.length).toBeGreaterThan(0)
      const k = n / SPRITE_SIZE
      const under = new Set(photoDrawing(id(n))!.picture.map((p) => `${Math.floor(p.x / k)},${Math.floor(p.y / k)}`))
      const at = (level: number): ReturnType<typeof outfitPixels> => outfitPixels(id(n), [], level)
      for (const level of [10, 20, 30, 40, 50]) {
        const { back, front } = at(level)
        expect(back.length + front.length, `Lv${level}`).toBeGreaterThan(0)
      }
      // The ribbon is tied round it (on the picture, as a scarf is); the badge,
      // the halo, the sparkles and the glow only ever take the air around it.
      const halo = at(40).front.filter((m) => !at(30).front.some((o) => o.x === m.x && o.y === m.y))
      for (const m of [...at(10).front, ...halo, ...at(50).back])
        expect(under.has(`${m.x},${m.y}`), `at ${m.x},${m.y}`).toBe(false)
    })
  })
})
