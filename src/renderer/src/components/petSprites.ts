import { slotOf } from '../state/pet'
import type { Accessory, AccessorySlot, BuiltinSpecies, Mood, Species } from '../state/pet'
import { decorationsOf } from '../state/petLevel'
import { customOf, isCustomId, type CustomDesign } from '../state/petSpecies'
import { customBody, photoGrid } from './petCustomArt'
import { bboxOf, fromRel, type Box as LayoutBox, type DecorLayout } from '../state/petLayout'

// ---------------------------------------------------------------------------
// The pixel art. Every animal is authored as a 16x16 grid of characters, one
// per dot, so the sprites are readable and editable as text. pixelsOf doubles
// it to 32x32 and refines it there (rounded curves, a 1-dot outline, light and
// shadow, an 8x8 face), and the renderer emits one <rect> per run of same-colour
// dots (shape-rendering: crispEdges, so real dots at any zoom).
//
// A pet is always its animal, grown: there are no younger sizes and no eggs.
// Faces are NOT baked into the bodies: each body declares where its face goes,
// and the mood's face is stamped on top (see pixelsOf).
//
// Palette characters:
//   .  empty        o  outline        b  body         s  shade (limbs)
//   h  highlight    w  white          e  eye          m  mouth      a  accent
//   p  prop (what the watched pane is doing)
//   g  the glow a level 50 pet has round it (see outfitPixels)
//   A..P  the colours of a species' faithful picture (see photoParts)
// ---------------------------------------------------------------------------

/** The authored grids: 16x16, one character per dot, easy to read as text. */
export const GRID = 16
/**
 * What is drawn: each authored dot becomes 2x2, then is refined at that size
 * (rounded corners, a 1-dot outline, shading, detailed faces; see pixelsOf).
 */
export const SPRITE_SIZE = GRID * 2
/** `l` rim light and `d` shadow only exist at the drawn size, made by shading. */
export const PALETTE = '.obshwemapldg'

export interface Sprite {
  rows: string[]
  /** Top-left dot where the 4x4 face is stamped. */
  face: { x: number; y: number } | null
  /**
   * Top-left of the 6x4 window the big face goes in. Defaults to one dot left
   * of `face`, which is where it lands centred on most bodies.
   */
  bigFace?: { x: number; y: number }
  /**
   * A species made from a photo can keep the photo's own look: the face
   * window still anchors what it wears, but no eyes or mouth are stamped.
   */
  hideFace?: boolean
}

// ---------------------------------------------------------------------------
// The animals: one grown silhouette each.
//
// Every grid is 16x16 and every face is a 4x4 window of plain body, which is what
// petSprites.test.ts checks: a miscounted row is invisible in review.
// ---------------------------------------------------------------------------

// Pointed ears, a tail carried straight up.
const cat: Sprite = {
  face: { x: 6, y: 5 },
  rows: [
    '................',
    '...o........o...',
    '..obo......obo..',
    '..obbo....obbo..',
    '...oobbbbbbboo..',
    '..obbbbbbbbbbo..',
    'o.obbbbbbbbbbo.o',
    '.oobbbbbbbbbboo.',
    'o.obbbbbbbbbbo.o',
    '..obbbbbbbbbbo..',
    '..obbbbbbbbbbo..',
    '...obbbbbbbbo...',
    '..sobbbbbbbbos..',
    '...obbbbbbbbo...',
    '....oooooooo....',
    '................'
  ]
}

// Two long ears straight up, a round tail.
const rabbit: Sprite = {
  face: { x: 6, y: 6 },
  rows: [
    '....o....o......',
    '....obo..obo....',
    '....obo..obo....',
    '....obo..obo....',
    '...oobbbbbboo...',
    '..obbbbbbbbbbo..',
    '..obbbbbbbbbbo..',
    '..obbbbbbbbbbo..',
    '..obbbbbbbbbbo..',
    '..obbbbbbbbbbo..',
    '..obbbbbbbbbboo.',
    '...obbbbbbbbo...',
    '..sobbbbbbbbos..',
    '...obbbbbbbbo...',
    '....oooooooo....',
    '................'
  ]
}

// A beak, a tail of feathers, two thin legs. It faces left.
const bird: Sprite = {
  face: { x: 6, y: 3 },
  rows: [
    '................',
    '.....oooooo.....',
    '....obbbbbbo....',
    '...obbbbbbbbo...',
    '.hhobbbbbbbbo...',
    'hhhobbbbbbbbo...',
    '...obbbbbbbbbo..',
    '...obbbbbbbbbboo',
    '..obbbbbbbbbbboo',
    '..obbbbbbbbbbo..',
    '...obbbbbbbbo...',
    '....oooooooo....',
    '.....o...o......',
    '....ooo.ooo.....',
    '................',
    '................'
  ]
}

// No legs at all: a tail fin at the back, fins above and below.
const fish: Sprite = {
  face: { x: 3, y: 6 },
  bigFace: { x: 3, y: 6 },
  rows: [
    '................',
    '................',
    '.........o......',
    '........obo.....',
    '.....ooooboo....',
    '...obbbbbbbbo...',
    '..obbbbbbbbbboo.',
    '.obbbbbbbbbbbboo',
    '.obbbbbbbbbbbboo',
    '..obbbbbbbbbboo.',
    '...obbbbbbbbo...',
    '....oooobooo....',
    '........obo.....',
    '.........o......',
    '................',
    '................'
  ]
}

// A small head over a wide shelled body, with four legs poking out.
const turtle: Sprite = {
  face: { x: 3, y: 2 },
  bigFace: { x: 2, y: 2 },
  rows: [
    '................',
    '..oooooo........',
    '.obbbbbbo.......',
    'obbbbbbbbo......',
    'obbbbbbbbo......',
    'obbbbbbbbooooo..',
    '.obbbbbbbbbbbbo.',
    '..oobbbbbbbbbbbo',
    '..obbbbbbbbbbbbo',
    '..obbbbbbbbbbbbo',
    '...oobbbbbbbboo.',
    '....oooooooooo..',
    '....o.oo..oo.o..',
    '....o.oo..oo.o..',
    '................',
    '................'
  ]
}

// Antennae up top, legs down both sides.
const bug: Sprite = {
  face: { x: 6, y: 5 },
  rows: [
    '...o........o...',
    '....o......o....',
    '.....o....o.....',
    '......oooo......',
    '....oobbbboo....',
    '..sobbbbbbbbos..',
    '..sobbbbbbbbos..',
    '...obbbbbbbbo...',
    '..sobbbbbbbbos..',
    '..sobbbbbbbbos..',
    '...obbbbbbbbo...',
    '..sobbbbbbbbos..',
    '....oobbbboo....',
    '......oooo......',
    '................',
    '................'
  ]
}

// Floppy ears down the sides of the head, and four legs.
const dog: Sprite = {
  face: { x: 5, y: 5 },
  rows: [
    '................',
    '..oo......oo....',
    '.obbo....obbo...',
    '.obbbooooobbbo..',
    '.obbbbbbbbbbbo..',
    '.obbbbbbbbbbbo..',
    '.obbbbbbbbbbbo..',
    '.obbbbbbbbbbbo..',
    '.obbbbbbbbbbbo..',
    '..obbbbbbbbbo...',
    '..obbbbbbbbbo.o.',
    '..obbbbbbbbboo..',
    '..obbbbbbbbbo...',
    '..ooooooooooo...',
    '..o.oo...oo.o...',
    '..o.oo...oo.o...'
  ]
}

// Small, round ears, and cheeks wider than it is tall.
const hamster: Sprite = {
  face: { x: 6, y: 6 },
  rows: [
    '................',
    '...oo....oo.....',
    '..obbo..obbo....',
    '..obbboobbbo....',
    '...oobbbbbboo...',
    '..obbbbbbbbbbo..',
    '.obbbbbbbbbbbbo.',
    '.obbbbbbbbbbbbo.',
    '.obbbbbbbbbbbbo.',
    '.obbbbbbbbbbbbo.',
    '..obbbbbbbbbbo..',
    '..obbbbbbbbbbo..',
    '...oobbbbbboo...',
    '.....oooooo.....',
    '....o.o..o.o....',
    '................'
  ]
}

// Upright, with a pale front, two flippers and two feet.
const penguin: Sprite = {
  face: { x: 5, y: 2 },
  rows: [
    '................',
    '....oooooo......',
    '...obbbbbbo.....',
    '..aobbbbbbo.....',
    '...obbbbbbo.....',
    '...obbbbbbbo....',
    '..oobbbbbbbboo..',
    '.obbbbbbbbbbbbo.',
    '.obbbbbbbbbbbbo.',
    '.obbbbbbbbbbbbo.',
    '..obbbbbbbbbbo..',
    '..obbbbbbbbbbo..',
    '..obbbbbbbbbbo..',
    '...oooooooooo...',
    '..ooo......ooo..',
    '................'
  ]
}

// Squat and wide, with eyes up top and legs splayed out at the bottom.
const frog: Sprite = {
  face: { x: 6, y: 6 },
  rows: [
    '................',
    '...oo......oo...',
    '..obbo....obbo..',
    '..obbboooobbbo..',
    '.oobbbbbbbbbboo.',
    '.obbbbbbbbbbbbo.',
    '.obbbbbbbbbbbbo.',
    '.obbbbbbbbbbbbo.',
    '.obbbbbbbbbbbbo.',
    '.oobbbbbbbbbboo.',
    '..oooooooooooo..',
    '.oo..........oo.',
    'obbo........obbo',
    'obbo........obbo',
    '.oo..........oo.',
    '................'
  ]
}

// Wide and flat, two claws held up, legs down both sides.
const crab: Sprite = {
  face: { x: 6, y: 5 },
  rows: [
    '................',
    '.oo..........oo.',
    'obbo........obbo',
    'obbo........obbo',
    '.oboooooooooobo.',
    '.obbbbbbbbbbbbo.',
    '.obbbbbbbbbbbbo.',
    '.obbbbbbbbbbbbo.',
    '.obbbbbbbbbbbbo.',
    '.oobbbbbbbbbboo.',
    '..oooooooooooo..',
    '.o.o.o....o.o.o.',
    '.o.o.o....o.o.o.',
    '................',
    '................',
    '................'
  ]
}

// Horns, a wing out one side, and a tail behind.
const dragon: Sprite = {
  face: { x: 5, y: 5 },
  rows: [
    '..o........o....',
    '..obo....obo....',
    '...oobbbbboo....',
    '..obbbbbbbbbo...',
    '..obbbbbbbbbo...',
    '..obbbbbbbbbo.oo',
    '..obbbbbbbbboobo',
    '..obbbbbbbbbbbbo',
    '..obbbbbbbbboobo',
    '..obbbbbbbbbo.oo',
    '...obbbbbbbo....',
    '..sobbbbbbbos...',
    '...ooooooooo....',
    '..........o.....',
    '.........oo.....',
    '........oo......'
  ]
}

// Big ears, and a brush of a tail curled up one side.
const fox: Sprite = {
  face: { x: 6, y: 5 },
  rows: [
    '...o.......o....',
    '..obo.....obo...',
    '..obbo...obbo...',
    '..obbbbbbbbbo...',
    '..obbbbbbbbbo...',
    '..obbbbbbbbbo...',
    '..obbbbbbbbbo.o.',
    '..obbbbbbbbboobo',
    '..obbbbbbbbboobo',
    '..obbbbbbbbbobbo',
    '..obbbbbbbbbbbbo',
    '...obbbbbbbbbbo.',
    '..sobbbbbbbbos..',
    '...obbbbbbbbo...',
    '....oooooooo....',
    '................'
  ]
}

// Ear tufts, folded wings, talons.
const owl: Sprite = {
  face: { x: 6, y: 6 },
  rows: [
    '................',
    '...o........o...',
    '...oo......oo...',
    '..oobbbbbbbboo..',
    '..obbbbbbbbbbo..',
    '..obbbbbbbbbbo..',
    '..obbbbbbbbbbo..',
    '.sobbbbbbbbbbos.',
    '.sobbbbbbbbbbos.',
    '.sobbbbbbbbbbos.',
    '..obbbbbbbbbbo..',
    '..obbbbbbbbbbo..',
    '...obbbbbbbbo...',
    '....oooooooo....',
    '.....oo..oo.....',
    '................'
  ]
}

// Round ears, a solid build, and two stubby legs.
const bear: Sprite = {
  face: { x: 6, y: 5 },
  rows: [
    '................',
    '..oo........oo..',
    '.obbo......obbo.',
    '..oobbbbbbbboo..',
    '..obbbbbbbbbbo..',
    '..obbbbbbbbbbo..',
    '..obbbbbbbbbbo..',
    '..obbbbbbbbbbo..',
    '..obbbbbbbbbbo..',
    '.sobbbbbbbbbbos.',
    '.sobbbbbbbbbbos.',
    '..obbbbbbbbbbo..',
    '..obbbbbbbbbbo..',
    '..obbbo..obbbo..',
    '..ooooo..ooooo..',
    '................'
  ]
}

// A dome of a head and a skirt of curling arms.
const octopus: Sprite = {
  face: { x: 6, y: 5 },
  rows: [
    '................',
    '.....oooooo.....',
    '....obbbbbbo....',
    '...obbbbbbbbo...',
    '..obbbbbbbbbbo..',
    '..obbbbbbbbbbo..',
    '..obbbbbbbbbbo..',
    '..obbbbbbbbbbo..',
    '..obbbbbbbbbbo..',
    '.obbbbbbbbbbbbo.',
    '.obo.obbbbo.obo.',
    'obo..obbbbo..obo',
    'oo..obo..obo..oo',
    '....oo....oo....',
    '................',
    '................'
  ]
}

// A wide head fringed with pink gills, and a little paddle of a tail.
const axolotl: Sprite = {
  face: { x: 6, y: 5 },
  rows: [
    '................',
    '................',
    'a..oooooooooo..a',
    '.aobbbbbbbbbboa.',
    'a.obbbbbbbbbbo.a',
    '.aobbbbbbbbbboa.',
    'a.obbbbbbbbbbo.a',
    '..obbbbbbbbbbo..',
    '..obbbbbbbbbbo..',
    '...obbbbbbbbo...',
    '..sobbbbbbbbos..',
    '...obbbbbbbbooo.',
    '....oooooooobbo.',
    '............oo..',
    '................',
    '................'
  ]
}

// A drop of jelly: a peak on top, settling wider as it grows.
const slime: Sprite = {
  face: { x: 6, y: 7 },
  rows: [
    '................',
    '.......oo.......',
    '......obbo......',
    '.....obbbbo.....',
    '....obbbbbbo....',
    '...obbbbbbbbo...',
    '..obbbbbbbbbbo..',
    '..obbbbbbbbbbo..',
    '.obbbbbbbbbbbbo.',
    '.obbbbbbbbbbbbo.',
    '.obbbbbbbbbbbbo.',
    '.obbbbbbbbbbbbo.',
    '..oooooooooooo..',
    '................',
    '................',
    '................'
  ]
}

export const BODIES: Record<BuiltinSpecies, Sprite> = {
  cat,
  rabbit,
  bird,
  fish,
  turtle,
  bug,
  dog,
  hamster,
  penguin,
  frog,
  crab,
  dragon,
  fox,
  owl,
  bear,
  octopus,
  axolotl,
  slime
}

// Faces are drawn at the drawn size, over a body's 4x4 face window (so 8x8).
// Eyes two dots wide and three tall with a white glint, a blush under each, a
// mouth with real corners. A smile puts its corners ABOVE its middle, a frown
// the other way round, and sad eyes sit lower and flatter.
export const FACES: Record<Mood, string[]> = {
  happy: ['we....we', 'ee....ee', 'ee....ee', '........', 'h.m..m.h', '...mm...', '........', '........'],
  ok: ['we....we', 'ee....ee', 'ee....ee', '........', 'h......h', '...mm...', '........', '........'],
  sad: ['........', '........', 'ee....ee', 'ee....ee', '........', '...mm...', '..m..m..', '........']
}

// The big face, over a 6x4 window (so 12x8), wherever it fits: a small face
// on a big body reads as plain, so the eyes are big ovals with a glint.
export const BIG_FACES: Record<Mood, string[]> = {
  happy: ['.ee......ee.', 'ewee....ewee', 'eeee....eeee', 'eeee....eeee', '.ee......ee.', 'hh..m..m..hh', '.....mm.....', '............'],
  ok: ['.ee......ee.', 'ewee....ewee', 'eeee....eeee', 'eeee....eeee', '.ee......ee.', 'hh........hh', '.....mm.....', '............'],
  sad: ['............', '............', 'eeee....eeee', 'ewee....ewee', '.ee......ee.', '.w..........', '.w...mm.....', '....m..m....']
}

// Props for what the watched pane is doing: a book (reading), a pen (writing), a
// prompt (running), a lens (searching), a globe (fetching).
export const MIMES: Record<string, string[]> = {
  read: ['pppp', 'p..p', 'p..p', 'pppp'],
  write: ['...p', '..pp', '.pp.', 'pp..'],
  run: ['pppp', 'p.pp', 'pp.p', 'pppp'],
  search: ['.pp.', 'p..p', '.pp.', '...p'],
  web: ['.pp.', 'pppp', 'pppp', '.pp.']
}

// ---------------------------------------------------------------------------
// Species marks. Each animal wears a coat stamped onto its body, the same
// trick the faces use, and its colour comes from CSS (.pet-sp-* in pet.css),
// mixed with the theme's accent so it reads as itself in any theme.
//
// A coat is a RULE, not a picture: measured against the body's own bounding
// box, so it fits the silhouette without a hand-drawn mask to keep in step.
// 'h' is the highlight (a lighter shade of the body), 'a' the accent.
// ---------------------------------------------------------------------------

interface Box {
  x0: number
  x1: number
  y0: number
  y1: number
}

export const COAT_RULES: Record<
  BuiltinSpecies,
  (x: number, y: number, b: Box) => string | null
> = {
  // Tabby bars down both flanks. Stripes right across, every other column, were
  // a barcode on a grown cat: the body was more stripe than cat.
  cat: (x, y, b) => ((x - b.x0 < 2 || b.x1 - x < 2) && (y - b.y0) % 2 === 0 ? 'h' : null),
  // Pale underside, inset from the flanks, or it reads as a nappy rather than
  // as a belly.
  rabbit: (x, y, b) => (y >= b.y1 - 2 && x > b.x0 + 1 && x < b.x1 - 1 ? 'h' : null),
  // Speckled plumage. In the highlight colour, not the accent: amber confetti on
  // a coloured bird fights the bird.
  bird: (x, y) => ((x * 3 + y * 7) % 8 === 0 ? 'h' : null),
  // Scales, on the diagonal.
  fish: (x, y) => ((x + y) % 3 === 0 ? 'h' : null),
  // The scutes of a shell: one diagonal family. Both of them was a lattice, and
  // at this size a lattice is just noise.
  turtle: (x, y) => ((x + y) % 4 === 0 ? 'a' : null),
  // Two-dot dabs on a four-dot grid, anchored to the body so the pattern does
  // not slide as it grows.
  bug: (x, y, b) => ((x - b.x0) % 4 < 2 && (y - b.y0) % 4 < 2 ? 'h' : null),
  // Patches, the way a mongrel is marked.
  dog: (x, y) => ((x * 5 + y * 3) % 9 === 0 ? 'h' : null),
  // A pale chest and belly.
  hamster: (x, y, b) => (y >= b.y1 - 3 && x > b.x0 + 1 && x < b.x1 - 1 ? 'h' : null),
  // The white front, which is the whole of a penguin's marking.
  penguin: (x, y, b) => (y >= b.y0 + 5 && x > b.x0 + 2 && x < b.x1 - 2 ? 'h' : null),
  // Mottled damp skin.
  frog: (x, y) => ((x * 3 + y * 5) % 7 === 0 ? 'h' : null),
  // A hard shell, marked across it.
  crab: (x, y) => ((x + y) % 5 === 0 ? 'h' : null),
  // Scales down the back, in the accent: a dragon is allowed to be flashy.
  dragon: (x, y) => ((x + y) % 3 === 0 ? 'a' : null),
  // A pale bib down the middle of the chest.
  fox: (x, y, b) => (y >= b.y1 - 3 && Math.abs(x - (b.x0 + b.x1) / 2) < 2 ? 'h' : null),
  // Rows of little feather chevrons.
  owl: (x, y, b) => ((y - b.y0) % 3 === 0 && (x + y) % 2 === 0 ? 'h' : null),
  // A lighter tummy, set well in from the sides.
  bear: (x, y, b) => (y >= b.y1 - 4 && x > b.x0 + 3 && x < b.x1 - 3 ? 'h' : null),
  // Suckers, in the accent.
  octopus: (x, y) => ((x * 2 + y * 3) % 5 === 0 ? 'a' : null),
  // Freckles.
  axolotl: (x, y) => ((x * 7 + y * 3) % 10 === 0 ? 'h' : null),
  // Bubbles caught in the jelly.
  slime: (x, y) => ((x * 5 + y * 7) % 11 === 0 ? 'h' : null)
}

type Grid = string[][]
const at = (g: Grid, x: number, y: number): string => g[y]?.[x] ?? '.'

/** Coat marks: the built-in highlight and accent, and a photo's own markings. */
const MARK_CHARS = 'hakcnvu'

/** The body of an animal, built in or made from a photo (see petCustomArt.ts). */
export function bodyOf(species: Species): Sprite {
  if (isCustomId(species)) {
    const d = customOf(species)
    return d ? customBody(d) : BODIES.cat
  }
  return BODIES[species] ?? BODIES.cat
}

/** Where the big face would go on a body, if its 6×4 window is all body. */
export function bigFaceOf(sprite: Sprite): { x: number; y: number } | null {
  if (!sprite.face) return null
  const at0 = sprite.bigFace ?? { x: sprite.face.x - 1, y: sprite.face.y }
  for (let dy = 0; dy < 4; dy++)
    for (let dx = 0; dx < 6; dx++) if (sprite.rows[at0.y + dy]?.[at0.x + dx] !== 'b') return null
  return at0
}

export interface Dot {
  x: number
  y: number
  ch: string
}

/**
 * Scale2x (EPX): every dot becomes four, and a corner of the four takes its
 * neighbours' colour where two of them agree. Staircases turn into curves and
 * a lone corner is rounded off, without inventing anything the art didn't say.
 */
function scale2x(g: Grid): Grid {
  const out: Grid = Array.from({ length: g.length * 2 }, () => Array(g.length * 2).fill('.'))
  g.forEach((row, y) =>
    row.forEach((e, x) => {
      const b = at(g, x, y - 1)
      const d = at(g, x - 1, y)
      const f = at(g, x + 1, y)
      const h = at(g, x, y + 1)
      const bend = b !== h && d !== f
      out[2 * y][2 * x] = bend && d === b ? d : e
      out[2 * y][2 * x + 1] = bend && b === f ? f : e
      out[2 * y + 1][2 * x] = bend && d === h ? d : e
      out[2 * y + 1][2 * x + 1] = bend && h === f ? f : e
    })
  )
  return out
}

const N4: Array<[number, number]> = [[0, -1], [-1, 0], [1, 0], [0, 1]]
const N8: Array<[number, number]> = [...N4, [-1, -1], [1, -1], [-1, 1], [1, 1]]

/**
 * The outline, one dot thick. Doubled, it was as heavy as an eye. An outline
 * dot that doesn't touch the outside gives way to whatever is inside it. Lines
 * drawn INSIDE the body (a fin, a shell's rim) are kept as they are.
 */
function thinOutline(g: Grid, src: Grid): void {
  const before = g.map((r) => [...r])
  const inner = (x: number, y: number): boolean => {
    // The authored dot this one came from had no air around it: a line drawn
    // on purpose inside the body.
    const sx = x >> 1
    const sy = y >> 1
    return N8.every(([dx, dy]) => at(src, sx + dx, sy + dy) !== '.')
  }
  before.forEach((row, y) =>
    row.forEach((ch, x) => {
      if (ch !== 'o' || inner(x, y)) return
      if (N4.some(([dx, dy]) => at(before, x + dx, y + dy) === '.')) return
      const count: Record<string, number> = {}
      for (const [dx, dy] of N8) {
        const n = at(before, x + dx, y + dy)
        if (n !== 'o' && n !== '.') count[n] = (count[n] ?? 0) + 1
      }
      const fill = Object.keys(count).sort((p, q) => count[q] - count[p])[0]
      g[y][x] = fill ?? 'b'
    })
  )
}

/** Coats whose marks are stripes, drawn one dot thick at the drawn size. */
const STRIPED: ReadonlySet<Species> = new Set<Species>(['cat'])

/**
 * A coat, doubled, was a scatter of fat blocks. Its marks are pulled one dot
 * back from the outline (a mark run into the edge reads as a hole in it), and
 * stripes are drawn one dot thick. Never so far that an animal shows nothing.
 */
function refineCoat(g: Grid, coat: boolean[][], species: Species): void {
  const marked = (x: number, y: number): boolean => {
    const ch = g[y][x]
    if (!MARK_CHARS.includes(ch)) return false
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) if (coat[(y >> 1) + dy]?.[(x >> 1) + dx]) return true
    return false
  }
  const off: Array<[number, number]> = []
  const kept: Array<[number, number]> = []
  g.forEach((row, y) =>
    row.forEach((_, x) => {
      if (!marked(x, y)) return
      const rim = N4.some(([dx, dy]) => {
        const n = at(g, x + dx, y + dy)
        return n === 'o' || n === '.'
      })
      if (rim || (STRIPED.has(species) && y % 2 === 1)) off.push([x, y])
      else kept.push([x, y])
    })
  )
  if (kept.length === 0) return
  for (const [x, y] of off) g[y][x] = 'b'
}

/**
 * Light from the top left: a rim of light under the top of the outline and
 * down the left of the upper half, a band of shadow along the bottom and down
 * the right of the lower half. Only on plain body, never over a coat.
 */
function shade(g: Grid): void {
  const before = g.map((r) => [...r])
  let y0 = g.length
  let y1 = -1
  before.forEach((row, y) => {
    if (row.includes('b')) {
      y0 = Math.min(y0, y)
      y1 = Math.max(y1, y)
    }
  })
  const cy = (y0 + y1) / 2
  const edge = (x: number, y: number): boolean => {
    const n = at(before, x, y)
    return n === 'o' || n === '.'
  }
  before.forEach((row, y) =>
    row.forEach((ch, x) => {
      if (ch !== 'b') return
      if (edge(x, y - 1) || (edge(x - 1, y) && y < cy)) g[y][x] = 'l'
      else if (edge(x, y + 1) || edge(x, y + 2) || (edge(x + 1, y) && y > cy)) g[y][x] = 'd'
    })
  )
}

/** The face a pet wears, where it goes on the drawn grid: the big one wherever it fits. */
function faceOf(sprite: Sprite, mood: Mood): { x: number; y: number; w: number; rows: string[] } | null {
  const big = bigFaceOf(sprite)
  if (big) return { x: big.x * 2, y: big.y * 2, w: 12, rows: BIG_FACES[mood] ?? BIG_FACES.ok }
  if (!sprite.face) return null
  return { x: sprite.face.x * 2, y: sprite.face.y * 2, w: 8, rows: FACES[mood] ?? FACES.ok }
}

/** Where a pet's face is on the drawn (32) grid, for what must not cover it. */
export function faceBoxOf(species: Species): LayoutBox | null {
  const f = faceOf(bodyOf(species), 'ok')
  return f ? { x: f.x, y: f.y, w: f.w, h: f.rows.length } : null
}

/** The lit dots of a pet: its body, wearing its coat, with its mood on top. */
export function pixelsOf(mood: Mood, species: Species = 'cat'): Dot[] {
  // A faithful picture is drawn as it is (see photoParts).
  if (isCustomId(species)) {
    const d = customOf(species)
    if (d?.photo) return photoParts(d).coarse
  }
  const sprite = bodyOf(species)
  const grid = sprite.rows.map((r) => r.split(''))

  // The window the face is stamped into, on the authored grid.
  const big = bigFaceOf(sprite)
  const window = big ? { ...big, w: 6 } : sprite.face ? { ...sprite.face, w: 4 } : null

  // The coat. Only where there is body to mark (never over an outline, never
  // outside the silhouette) and never within a dot of the face: a marking
  // beside an eye reads as a bruise, not as a pattern. A species made from a
  // photo wears its own markings, so it has no rule.
  const custom = isCustomId(species) ? customOf(species) : null
  const rule = isCustomId(species) ? null : COAT_RULES[species]
  const coat = grid.map((row) => row.map(() => false))
  if (rule) {
    let x0 = GRID
    let x1 = -1
    let y0 = GRID
    let y1 = -1
    grid.forEach((row, y) =>
      row.forEach((ch, x) => {
        if (ch !== 'b') return
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
      })
    )
    // A dot of clearance around the face, so a marking never crowds an eye, but
    // only where there is room for it.
    const margin = x1 - x0 >= 9 ? 1 : 0
    const clear = (x: number, y: number): boolean =>
      !window ||
      x < window.x - margin ||
      x > window.x + window.w - 1 + margin ||
      y < window.y - margin ||
      y > window.y + 3 + margin
    if (x1 >= 0) {
      const box = { x0, x1, y0, y1 }
      let marked = 0
      grid.forEach((row, y) =>
        row.forEach((ch, x) => {
          if (ch !== 'b' || !clear(x, y)) return
          const mark = rule(x, y, box)
          if (!mark) return
          grid[y][x] = mark
          coat[y][x] = true
          marked++
        })
      )
      // An animal's coat has to show: where the face and its margin cover the
      // whole torso, mark the flanks instead.
      if (marked === 0)
        grid.forEach((row, y) =>
          row.forEach((ch, x) => {
            if (ch !== 'b' || !clear(x, y)) return
            if ((x === x0 || x === x1) && y % 2 === 0) {
              grid[y][x] = 'h'
              coat[y][x] = true
            }
          })
        )
    }
  }

  // Up to the drawn size, and refined there.
  const fine = scale2x(grid)
  thinOutline(fine, grid)
  refineCoat(fine, coat, species)
  // Doubling rounds a coat's corners, and a corner beside the face can round
  // into it. The face stays clear.
  const face = sprite.hideFace ? null : faceOf(sprite, mood)
  if (face && !custom)
    for (let y = face.y; y < face.y + 8; y++)
      for (let x = face.x; x < face.x + face.w; x++)
        if (fine[y]?.[x] === 'h' || fine[y]?.[x] === 'a') fine[y][x] = 'b'
  shade(fine)

  if (face) {
    face.rows.forEach((row, dy) =>
      row.split('').forEach((ch, dx) => {
        if (ch === '.') return // transparent: the body shows through
        const y = face.y + dy
        const x = face.x + dx
        if (fine[y]?.[x] !== undefined) fine[y][x] = ch
      })
    )
  }
  const dots: Dot[] = []
  fine.forEach((row, y) =>
    row.forEach((ch, x) => {
      if (ch !== '.') dots.push({ x, y, ch })
    })
  )
  return dots
}

/** A faithful picture as drawn: see photoDrawing. */
export interface PhotoDrawing {
  /** The picture's grid (32, 48 or 64): `picture` is on it. */
  size: number
  /** The picture with its outline, one dot per grid dot. */
  picture: Dot[]
}

/**
 * The picture (petCustomArt photoGrid, cached) with no face, on its own grid,
 * and brought down to the 32 grid (`coarse`), which is what the rest of the
 * pet code reads (where a hat fits, where a decoration has room).
 */
function photoParts(d: CustomDesign): PhotoDrawing & { coarse: Dot[] } {
  const cached = photoCache.get(d)
  if (cached) return cached
  const fine: Grid = photoGrid(d).map((r) => [...r])
  const n = fine.length
  const coarseGrid = n === SPRITE_SIZE ? fine : toSprite(fine)
  const dotsOf = (g: Grid): Dot[] => {
    const dots: Dot[] = []
    g.forEach((row, y) =>
      row.forEach((ch, x) => {
        if (ch !== '.') dots.push({ x, y, ch })
      })
    )
    return dots
  }
  const parts = { size: n, picture: dotsOf(fine), coarse: dotsOf(coarseGrid) }
  photoCache.set(d, parts)
  return parts
}
const photoCache = new WeakMap<CustomDesign, PhotoDrawing & { coarse: Dot[] }>()

/**
 * A faithful picture as the pet draws it (see Creature): the picture on its
 * own grid. Null for anything else.
 */
export function photoDrawing(species: Species): PhotoDrawing | null {
  if (!isCustomId(species)) return null
  const d = customOf(species)
  if (!d?.photo) return null
  const { size, picture } = photoParts(d)
  return { size, picture }
}

/**
 * A picture's animation frames (lib/petFrames.ts) drawn like the picture:
 * each frame on the picture's grid with its outline, same colour characters.
 * Cached per frame list (a species' saved frames are one object until they
 * change), so a reel is worked out once per design, never per frame shown.
 */
export function frameDrawings(d: CustomDesign, frames: string[][]): PhotoDrawing[] {
  const hit = frameCache.get(frames)
  if (hit && hit.d === d) return hit.out
  const out = frames.map((rows) => {
    const p = d.photo ? { ...d.photo, rows } : undefined
    const g = photoGrid({ ...d, ...(p ? { photo: p } : {}) })
    const picture: Dot[] = []
    g.forEach((row, y) => [...row].forEach((ch, x) => ch !== '.' && picture.push({ x, y, ch })))
    return { size: g.length, picture }
  })
  frameCache.set(frames, { d, out })
  return out
}
const frameCache = new WeakMap<string[][], { d: CustomDesign; out: PhotoDrawing[] }>()

/**
 * A picture on a bigger grid (48, 64) brought onto the 32 one, for what reads
 * the pet's dots rather than drawing them: a dot is lit where any of the
 * picture is under it (so marks and keepsakes never land on the picture), in
 * the character that covers most of it.
 */
function toSprite(fine: Grid): Grid {
  const k = fine.length / SPRITE_SIZE
  const out: Grid = Array.from({ length: SPRITE_SIZE }, () => Array(SPRITE_SIZE).fill('.'))
  for (let j = 0; j < SPRITE_SIZE; j++)
    for (let i = 0; i < SPRITE_SIZE; i++) {
      const x0 = i * k
      const x1 = x0 + k
      const y0 = j * k
      const y1 = y0 + k
      const area = new Map<string, number>()
      for (let y = Math.floor(y0); y < Math.ceil(y1); y++)
        for (let x = Math.floor(x0); x < Math.ceil(x1); x++) {
          const ch = fine[y]?.[x]
          if (!ch || ch === '.') continue
          const a = (Math.min(x + 1, x1) - Math.max(x, x0)) * (Math.min(y + 1, y1) - Math.max(y, y0))
          if (a > 0) area.set(ch, (area.get(ch) ?? 0) + a)
        }
      let best = '.'
      let most = 0
      for (const [ch, a] of area)
        if (a > most) {
          most = a
          best = ch
        }
      out[j][i] = best
    }
  return out
}

/** A row of same-coloured dots, drawn as one rect. */
export interface Run extends Dot {
  w: number
}

/**
 * Runs as one svg path per colour: `M x y h w v 1 h -w z` for each, in whole
 * units of the grid they are on, so nothing lands between two dots.
 */
export function runPaths(runs: Run[]): Array<{ ch: string; d: string }> {
  const by = new Map<string, string>()
  for (const r of runs) by.set(r.ch, `${by.get(r.ch) ?? ''}M${r.x} ${r.y}h${r.w}v1h${-r.w}z`)
  return [...by].map(([ch, d]) => ({ ch, d }))
}

/** Dots merged into horizontal runs: a third as many rects to draw. */
export function runsOf(dots: Dot[]): Run[] {
  const runs: Run[] = []
  const sorted = [...dots].sort((p, q) => p.y - q.y || p.x - q.x)
  for (const d of sorted) {
    const last = runs[runs.length - 1]
    if (last && last.y === d.y && last.ch === d.ch && last.x + last.w === d.x) last.w++
    else runs.push({ ...d, w: 1 })
  }
  return runs
}

/**
 * Keepsakes, drawn as their own layer (see Creature) at the drawn size. A hat
 * sits on its head; the neckwear is made to fit (see neckBand) and only its
 * charm is drawn here; the rest find a free spot of air around it.
 */
export const ACCESSORY_ART: Record<Accessory, string[]> = {
  sprout: ['hh...hh', 'hhh.hhh', '.hhshh.', '...s...'],
  bow: ['mm.....mm', 'mhmm.mmhm', 'mhhmmmhhm', 'mhmm.mmhm', 'mm.....mm'],
  crown: ['w...w...w', 'a..aaa..a', 'aa.aaa.aa', 'aaaaaaaaa', 'aamaaamaa', 'aaaaaaaaa'],
  scarf: ['mm', 'hm', 'mm', 'hm'],
  bell: ['.aaa.', 'aaaaa', 'awaaa', 'aaaaa', '..o..'],
  medal: ['.m.m.', '.aaa.', 'aawaa', 'aaaaa', '.aaa.'],
  heart: ['mm.mm', 'hmmmm', 'mmmmm', '.mmm.', '..m..'],
  star: ['..a..', '.awa.', 'aaaaa', '.aaa.', '.a.a.'],
  moon: ['.aaa', 'aa..', 'aa..', 'aa..', '.aaa'],
  flowers: ['.w.', 'waw', '.w.', '.s.'],
  mushrooms: ['.mmm.', 'mwmmm', 'mmmwm', '..w..'],
  sparkle: ['.a.', 'awa', '.a.'],
  glitter: ['.a.', 'awa', '.a.'],
  legend: ['..a..', '..a..', 'aawaa', '..a..', '..a..'],
  // Prizes (see PRIZES in state/pet.ts).
  bandana: ['..mmmmm..', '.mhmhmhm.', 'mmmmmmmmm'],
  laurel: ['aa.....aa', 'a.a...a.a', '.aaa.aaa.', '..a.w.a..'],
  pumpkin: ['...o...', '.aaoaa.', 'aaaaaaa', 'aeaaaea', 'aaaeaaa', '.aaaaa.'],
  santa: ['......w', '....mmw', '..mmmm.', '.mmmmm.', 'wwwwwww'],
  gem: ['.w.', 'whw', '.h.'],
  sword: ['....w', '...w.', 'a.w..', '.a...', 'o.a..'],
  trophy: ['a.aaa.a', 'aawaaaa', '.aaaaa.', '..aaa..', '...a...', '..aaa..'],
  coin: ['.aaa.', 'aawaa', 'awaaa', 'aaaaa', '.aaa.'],
  blossom: ['.h....', 'hah.h.', '.h.hah', '....h.']
}

/** Smaller ones, for a pet that leaves no room for the full-size piece. */
const ACCESSORY_MINI: Partial<Record<Accessory, string[]>> = {
  heart: ['m.m', 'mmm', '.m.'],
  star: ['.a.', 'awa', 'a.a'],
  moon: ['.aa', 'aa.', '.aa'],
  flowers: ['waw', '.s.'],
  mushrooms: ['mmm', 'mwm', '.w.'],
  sword: ['..w', 'aw.', 'oa.'],
  trophy: ['aaa', '.a.', 'aaa'],
  coin: ['aa', 'wa'],
  blossom: ['.h.', 'hah', '.h.']
}

/** How many twinkles each shine scatters round it, and how many are big ones. */
const AURA: Partial<Record<Accessory, { small: number; big: number }>> = {
  sparkle: { small: 2, big: 0 },
  glitter: { small: 4, big: 0 },
  legend: { small: 4, big: 2 }
}

/** Where twinkles go first, spread round the pet before they fill in. */
const AURA_SPOTS: Array<[number, number]> = [
  [2, 2],
  [27, 27],
  [27, 2],
  [2, 27],
  [1, 14],
  [28, 14],
  [14, 1],
  [14, 28]
]

const keyOf = (x: number, y: number): number => y * SPRITE_SIZE + x

/** Stamp `art` with its top-left at (x0, y0), keeping what lands in the grid and above `below`. */
function stamp(art: string[], x0: number, y0: number, below = SPRITE_SIZE): Dot[] {
  const dots: Dot[] = []
  art.forEach((row, dy) =>
    row.split('').forEach((ch, dx) => {
      const x = x0 + dx
      const y = y0 + dy
      if (ch !== '.' && x >= 0 && x < SPRITE_SIZE && y >= 0 && y < below) dots.push({ x, y, ch })
    })
  )
  return dots
}

/**
 * The free spot nearest `anchor`, between rows `minY` and `maxY`, where `art`
 * fits with `margin` dots of air all round it; null when there is none.
 */
function nearestFit(
  art: string[],
  anchor: [number, number],
  taken: Set<number>,
  minY = 0,
  margin = 1,
  maxY = SPRITE_SIZE
): { x: number; y: number } | null {
  const w = art[0].length
  const h = art.length
  let best: { x: number; y: number } | null = null
  let bestD = Infinity
  for (let y = Math.max(0, minY); y + h <= Math.min(SPRITE_SIZE, maxY); y++)
    for (let x = 0; x + w <= SPRITE_SIZE; x++) {
      const d = (x - anchor[0]) ** 2 + (y - anchor[1]) ** 2
      if (d >= bestD) continue
      let free = true
      for (let yy = y - margin; free && yy < y + h + margin; yy++)
        for (let xx = x - margin; xx < x + w + margin; xx++)
          if (taken.has(keyOf(xx, yy))) {
            free = false
            break
          }
      if (free) {
        best = { x, y }
        bestD = d
      }
    }
  return best
}

/**
 * Something worn round the neck: a band wrapped round the body just under the
 * face, cut to its outline, with a charm (or a scarf's tail) on it. `band` is
 * how many rows it is and `dot` what colour each of its dots is.
 */
function neckBand(
  face: { x: number; y: number; w: number; rows: string[] },
  body: Set<number>,
  band: number,
  dot: (x: number, dy: number) => string,
  charm: string[],
  charmX: number
): Dot[] {
  const from = face.y + face.rows.length
  // The first row under the face that is mostly body, where a collar would rest.
  let y = -1
  for (let yy = from; yy < Math.min(SPRITE_SIZE - 1, from + 5) && y < 0; yy++) {
    let n = 0
    for (let x = face.x; x < face.x + face.w; x++) if (body.has(keyOf(x, yy))) n++
    if (n * 2 >= face.w) y = yy
  }
  if (y < 0) return []
  const dots: Dot[] = []
  for (let dy = 0; dy < band; dy++)
    for (let x = 0; x < SPRITE_SIZE; x++)
      if (body.has(keyOf(x, y + dy)) && Math.abs(x - (face.x + face.w / 2)) <= face.w)
        dots.push({ x, y: y + dy, ch: dot(x, dy) })
  if (!dots.length) return []
  return [...dots, ...stamp(charm, charmX, y + band)]
}

/** A neck keepsake: a scarf hangs a tail off one side, a bell or medal hangs in the middle. */
function neckwear(id: Accessory, face: { x: number; y: number; w: number; rows: string[] }, body: Set<number>): Dot[] {
  const art = ACCESSORY_ART[id]
  const band = id === 'scarf' ? 2 : 1
  const x0 = id === 'scarf' ? face.x + face.w - 3 : face.x + Math.floor((face.w - art[0].length) / 2)
  return neckBand(
    face,
    body,
    band,
    (x, dy) => (id === 'medal' ? 'h' : id === 'scarf' && (x + dy) % 3 === 0 ? 'h' : 'm'),
    art,
    x0
  )
}

// ---- decorations ----
// What levels bring (DECORATIONS in state/petLevel.ts), drawn with the
// keepsakes: a badge at 10, a ribbon at 20, sparkles at 30, a halo at 40 and
// a glow from 50. Static dots like the keepsakes; the sparkles twinkle on the
// same layer the shines already use, so nothing new runs per frame.
export const DECOR_ART = {
  /** A rosette pinned beside it. */
  badge: ['.aaa.', 'aawaa', '.aaa.', '.m.m.'],
  /** The badge where there is no room for it. */
  badgeMini: ['.a.', 'awa', 'm.m'],
  /** The ribbon's knot, under its chin. */
  ribbonKnot: ['m.m', '.h.', 'm.m'],
  /** The ribbon as a bow by its head, when something else is round its neck. */
  ribbonBow: ['mm.mm', '.mhm.', 'mm.mm'],
  /** A ring floating over its head. */
  halo: ['.aaaaa.', 'a.....a', '.aaaaa.'],
  /** One twinkle. */
  sparkle: ['.a.', 'awa', '.a.']
}
/** How many twinkles the sparkle decoration scatters round it. */
export const DECOR_SPARKLES = 3

/** Where a hat sits: centred over the face, its bottom row sunk into the outline of the head. */
function headwear(
  art: string[],
  face: { x: number; y: number; w: number },
  body: Dot[]
): Dot[] {
  const w = art[0].length
  const x0 = Math.max(0, Math.min(SPRITE_SIZE - w, face.x + Math.floor((face.w - w) / 2)))
  // The top of the head under the keepsake, ignoring what floats around it.
  let top = SPRITE_SIZE
  for (const d of body) if (d.x >= x0 && d.x < x0 + w && d.y < top) top = d.y
  // Over a head that touches the top of the grid it sinks into the head
  // instead, and where even that leaves no room above the eyes, the bottom of
  // it is cut off rather than drawn over them.
  const y0 = Math.max(0, Math.min(top - art.length + 2, face.y - art.length))
  return stamp(art, x0, y0, face.y)
}

/** One decoration as placed: see outfitPieces. */
export interface OutfitPiece {
  /** Its key in a DecorLayout (state/petLayout.ts). */
  key: string
  /** A keepsake (Accessory) or a level decoration (Decoration). */
  kind: 'acc' | 'decor'
  item: string
  /** Which one of several (the pair at its feet, the twinkles of a shine). */
  index: number | null
  /** Drawn behind the pet or in front of it. */
  layer: 'back' | 'front'
  /** Where it is (none when it is hidden or there was no room for it). */
  dots: Dot[]
  box: LayoutBox | null
  /** Its size where the keeper puts it (the full-size piece), in dots. */
  size: { w: number; h: number }
  hidden: boolean
  /** Can be dragged somewhere else (the glow follows the pet's outline). */
  movable: boolean
  /** Placed where the keeper put it, not automatically. */
  moved: boolean
}

interface PieceSpec {
  key: string
  kind: 'acc' | 'decor'
  item: string
  index: number | null
  layer: 'back' | 'front'
  /** Placed automatically, round what is already there; null when there is no room. */
  auto: () => Dot[] | null
  /** Its dots at the origin, for placing it where the keeper put it; null when it cannot be. */
  shape: () => Dot[] | null
}

const shift = (dots: Dot[], dx: number, dy: number): Dot[] => dots.map((d) => ({ x: d.x + dx, y: d.y + dy, ch: d.ch }))
/** Dots moved so their box starts at 0,0. */
const atOrigin = (dots: Dot[]): Dot[] | null => {
  if (!dots.length) return null
  const b = bboxOf(dots)
  return shift(dots, -b.x, -b.y)
}

/**
 * Everything a pet wears and has earned, piece by piece, already placed. The
 * automatic placement fits each piece in turn around the pet and what it
 * already has on, so nothing covers its face or another piece, and a piece
 * with nowhere to go is left off: what it wears first, then the decorations
 * of its level. A `layout` (state/petLayout.ts) overrides that per piece:
 * hidden, in front or behind, or moved, and the moved ones are placed first
 * so every automatic one (one earned later included) goes round them.
 * Computed once per change (the pet memoises it), never per frame.
 */
export function outfitPieces(
  species: Species,
  worn: Accessory[],
  level = 0,
  layout?: DecorLayout
): { pieces: OutfitPiece[]; bbox: LayoutBox } {
  const decor = decorationsOf(level)
  const all = pixelsOf('ok', species)
  const bbox = bboxOf(all)
  if (!worn.length && !decor.length) return { pieces: [], bbox }
  const face = faceOf(bodyOf(species), 'ok')
  if (!face) return { pieces: [], bbox }
  const flesh = all.filter((d) => d.ch !== 'a' && d.ch !== 'w')
  const body = new Set(flesh.map((d) => keyOf(d.x, d.y)))
  const pet = new Set(all.map((d) => keyOf(d.x, d.y)))
  const taken = new Set(pet)
  const take = (dots: Dot[]): Dot[] => {
    for (const d of dots) taken.add(keyOf(d.x, d.y))
    return dots
  }
  // The free spot for the first of `arts` that fits, best with a dot of air
  // round it (a twinkle behind it may brush the pet), then snug against it.
  const fitOf = (arts: Array<string[] | undefined>, anchor: (art: string[]) => [number, number], rows: [number, number] = [0, SPRITE_SIZE], back = false): Dot[] | null => {
    for (const art of arts) {
      if (!art) continue
      for (const margin of back ? [0] : [1, 0]) {
        const at = nearestFit(art, anchor(art), taken, rows[0], margin, rows[1])
        if (at) return stamp(art, at.x, at.y)
      }
    }
    return null
  }
  const artShape = (art: string[]): Dot[] | null => atOrigin(stamp(art, 0, 0))
  const specs: PieceSpec[] = []
  const slotted = (slot: AccessorySlot): Accessory | undefined => worn.find((a) => slotOf(a) === slot)

  // Fitted from the head out, so the pieces on the body get the best spots.
  const hat = slotted('head')
  if (hat) {
    const dots = (): Dot[] => headwear(ACCESSORY_ART[hat], face, flesh)
    specs.push({ key: `acc:${hat}`, kind: 'acc', item: hat, index: null, layer: 'front', auto: () => dots(), shape: () => atOrigin(dots()) })
  }
  const neck = slotted('neck')
  if (neck) {
    const dots = (): Dot[] => neckwear(neck, face, body)
    specs.push({ key: `acc:${neck}`, kind: 'acc', item: neck, index: null, layer: 'front', auto: () => dots(), shape: () => atOrigin(dots()) })
  }
  const friend = slotted('float')
  if (friend)
    // Up by its head, never down at its feet; full size where it fits, else a smaller one.
    specs.push({
      key: `acc:${friend}`,
      kind: 'acc',
      item: friend,
      index: null,
      layer: 'front',
      auto: () => fitOf([ACCESSORY_ART[friend], ACCESSORY_MINI[friend]], (art) => [SPRITE_SIZE - art[0].length - 1, 1], [0, face.y + face.rows.length]),
      shape: () => artShape(ACCESSORY_ART[friend])
    })
  const ground = slotted('ground')
  if (ground) {
    // One at each side of its feet, kept to the bottom few rows.
    const rows: [number, number] = [SPRITE_SIZE - 10, SPRITE_SIZE]
    const sides: Array<(art: string[]) => [number, number]> = [
      (art) => [0, SPRITE_SIZE - art.length],
      (art) => [SPRITE_SIZE - art[0].length, SPRITE_SIZE - art.length]
    ]
    sides.forEach((anchor, i) =>
      specs.push({
        key: `acc:${ground}:${i}`,
        kind: 'acc',
        item: ground,
        index: i,
        layer: 'front',
        auto: () => fitOf([ACCESSORY_ART[ground], ACCESSORY_MINI[ground]], anchor, rows),
        shape: () => artShape(ACCESSORY_ART[ground])
      })
    )
  }
  const shine = slotted('aura')
  const aura = shine ? AURA[shine] : undefined
  let spot = 0
  if (shine && aura) {
    // A big twinkle with no room for it is a small one instead.
    for (let i = 0; i < aura.big + aura.small; i++) {
      const at = AURA_SPOTS[spot++ % AURA_SPOTS.length]
      const big = i < aura.big
      specs.push({
        key: `acc:${shine}:${i}`,
        kind: 'acc',
        item: shine,
        index: i,
        layer: 'back',
        auto: () => fitOf(big ? [ACCESSORY_ART.legend, ACCESSORY_ART.sparkle] : [ACCESSORY_ART.sparkle], () => at, undefined, true),
        shape: () => artShape(big ? ACCESSORY_ART.legend : ACCESSORY_ART.sparkle)
      })
    }
  }

  // ---- what its level brings ----
  const has = new Set(decor)
  if (has.has('halo')) {
    // Over the middle of its head (over a hat, if it has one on).
    const cx = face.x + Math.floor(face.w / 2)
    specs.push({
      key: 'decor:halo',
      kind: 'decor',
      item: 'halo',
      index: null,
      layer: 'front',
      auto: () => fitOf([DECOR_ART.halo], () => [cx - 3, 0], [0, face.y]),
      shape: () => artShape(DECOR_ART.halo)
    })
  }
  if (has.has('ribbon')) {
    // Round its neck; with a keepsake already there, a bow by its head.
    const knot = DECOR_ART.ribbonKnot
    const band = (): Dot[] =>
      neck ? [] : neckBand(face, body, 1, (x) => (x % 4 === 0 ? 'h' : 'm'), knot, face.x + Math.floor((face.w - knot[0].length) / 2))
    specs.push({
      key: 'decor:ribbon',
      kind: 'decor',
      item: 'ribbon',
      index: null,
      layer: 'front',
      auto: () => {
        const b = band()
        if (b.length) return b
        return fitOf([DECOR_ART.ribbonBow], () => [Math.max(0, face.x - 6), Math.max(0, face.y - 4)], [0, face.y + face.rows.length])
      },
      shape: () => atOrigin(band()) ?? artShape(DECOR_ART.ribbonBow)
    })
  }
  if (has.has('badge')) {
    // Pinned in the air low by its side, where nothing else usually is; on a
    // pet that fills its lower half, wherever there is air, smaller if it must.
    const low: [number, number] = [Math.floor(SPRITE_SIZE / 2), SPRITE_SIZE]
    specs.push({
      key: 'decor:badge',
      kind: 'decor',
      item: 'badge',
      index: null,
      layer: 'front',
      auto: () =>
        fitOf([DECOR_ART.badge], () => [SPRITE_SIZE - 5, SPRITE_SIZE - 8], low) ??
        fitOf([DECOR_ART.badge], () => [0, SPRITE_SIZE - 8], low) ??
        fitOf([DECOR_ART.badge], () => [SPRITE_SIZE - 5, SPRITE_SIZE - 8]) ??
        fitOf([DECOR_ART.badgeMini], () => [SPRITE_SIZE - 3, SPRITE_SIZE - 6]),
      shape: () => artShape(DECOR_ART.badge)
    })
  }
  if (has.has('sparkle'))
    for (let i = 0; i < DECOR_SPARKLES; i++) {
      const at = AURA_SPOTS[(spot + i) % AURA_SPOTS.length]
      specs.push({
        key: `decor:sparkle:${i}`,
        kind: 'decor',
        item: 'sparkle',
        index: i,
        layer: 'back',
        auto: () => fitOf([DECOR_ART.sparkle], () => at, undefined, true),
        shape: () => artShape(DECOR_ART.sparkle)
      })
    }

  // The keeper's moves first, so the automatic ones go round them.
  const placed = new Map<string, { dots: Dot[]; moved: boolean }>()
  for (const s of specs) {
    const o = layout?.[s.key]
    if (!o || o.hidden || o.x === undefined || o.y === undefined) continue
    const shape = s.shape()
    if (!shape) continue
    const size = bboxOf(shape)
    const at = fromRel({ x: o.x, y: o.y }, size, bbox, SPRITE_SIZE)
    placed.set(s.key, { dots: take(shift(shape, at.x, at.y)), moved: true })
  }
  for (const s of specs) {
    if (placed.has(s.key) || layout?.[s.key]?.hidden) continue
    const dots = s.auto()
    if (dots?.length) placed.set(s.key, { dots: take(dots), moved: false })
  }
  const pieces: OutfitPiece[] = specs.map((s) => {
    const o = layout?.[s.key]
    const p = placed.get(s.key)
    const dots = p?.dots ?? []
    const box = dots.length ? bboxOf(dots) : null
    const shape = s.shape()
    const full = shape ? bboxOf(shape) : box
    return {
      key: s.key,
      kind: s.kind,
      item: s.item,
      index: s.index,
      layer: o?.z ?? s.layer,
      dots,
      box,
      size: full ? { w: full.w, h: full.h } : { w: 1, h: 1 },
      hidden: !!o?.hidden,
      movable: true,
      moved: !!p?.moved
    }
  })
  if (has.has('glow')) {
    // A soft ring one dot out from its silhouette, wherever there is air.
    const hidden = !!layout?.['decor:glow']?.hidden
    const glow: Dot[] = []
    if (!hidden)
      for (const k of pet) {
        const x = k % SPRITE_SIZE
        const y = (k - x) / SPRITE_SIZE
        for (const [dx, dy] of N4) {
          const nx = x + dx
          const ny = y + dy
          if (nx < 0 || ny < 0 || nx >= SPRITE_SIZE || ny >= SPRITE_SIZE) continue
          const nk = keyOf(nx, ny)
          if (taken.has(nk)) continue
          taken.add(nk)
          glow.push({ x: nx, y: ny, ch: 'g' })
        }
      }
    pieces.push({ key: 'decor:glow', kind: 'decor', item: 'glow', index: null, layer: 'back', dots: glow, box: glow.length ? bboxOf(glow) : null, size: { w: 1, h: 1 }, hidden, movable: false, moved: false })
  }
  return { pieces, bbox }
}

/**
 * Everything a pet wears and has earned, already placed (see outfitPieces):
 * `back` (its shine and glow, drawn behind and left to twinkle) and `front`
 * (the rest).
 */
export function outfitPixels(species: Species, worn: Accessory[], level = 0, layout?: DecorLayout): { back: Dot[]; front: Dot[] } {
  const back: Dot[] = []
  const front: Dot[] = []
  for (const p of outfitPieces(species, worn, level, layout).pieces) (p.layer === 'back' ? back : front).push(...p.dots)
  return { back, front }
}


/** One keepsake on its own, as `outfitPixels` would place it. */
export function accessoryPixels(species: Species, accessory: Accessory | null): Dot[] {
  if (!accessory) return []
  const { back, front } = outfitPixels(species, [accessory])
  return [...back, ...front]
}
