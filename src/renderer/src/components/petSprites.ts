import type { Form, Mood, Stage } from '../state/pet'

// ---------------------------------------------------------------------------
// The pixel art. Every creature is a 16×16 grid of characters, one per dot, so
// the sprites are readable and editable as text and the renderer only has to
// emit one <rect> per lit dot (shape-rendering: crispEdges — no anti-aliasing,
// no smoothing, real dots at any zoom).
//
// Faces are NOT baked into the bodies: four moods × eight bodies would be 32
// grids to keep in sync. Each body instead declares where its face goes, and the
// mood's 4×4 face is stamped on top (see pixelsOf).
//
// Palette characters:
//   .  empty        o  outline        b  body         s  shade (limbs)
//   h  highlight    w  shell/white    e  eye          m  mouth      a  accent
//   p  prop (droppings, the medicine cross, the game's arrows)
// ---------------------------------------------------------------------------

export const SPRITE_SIZE = 16
export const PALETTE = '.obshwemap'

export interface Sprite {
  rows: string[]
  /** Top-left dot where the 4×4 mood face is stamped; null for a faceless egg. */
  face: { x: number; y: number } | null
}

const egg: Sprite = {
  face: null,
  rows: [
    '................',
    '................',
    '................',
    '......oooo......',
    '.....obbbbo.....',
    '....obbbbbbo....',
    '....obbbbbbo....',
    '....obbbbbbo....',
    '....obbobbbo....',
    '....obbbobbo....',
    '....obbobbbo....',
    '....obbbbbbo....',
    '....obbbbbbo....',
    '.....obbbbo.....',
    '......oooo......',
    '................'
  ]
}

const hatchling: Sprite = {
  face: { x: 6, y: 9 },
  rows: [
    '................',
    '................',
    '................',
    '................',
    '......w..w......',
    '.....wwwwww.....',
    '......oooo......',
    '.....obbbbo.....',
    '....obbbbbbo....',
    '....obbbbbbo....',
    '....obbbbbbo....',
    '....obbbbbbo....',
    '.....obbbbo.....',
    '......oooo......',
    '................',
    '................'
  ]
}

const child: Sprite = {
  face: { x: 6, y: 8 },
  rows: [
    '................',
    '................',
    '................',
    '....o......o....',
    '...obo....obo...',
    '.....oooooo.....',
    '....obbbbbbo....',
    '...obbbbbbbbo...',
    '...obbbbbbbbo...',
    '...obbbbbbbbo...',
    '...obbbbbbbbo...',
    '...obbbbbbbbo...',
    '....obbbbbbo....',
    '.....oooooo.....',
    '................',
    '................'
  ]
}

const teen: Sprite = {
  face: { x: 6, y: 7 },
  rows: [
    '................',
    '................',
    '....o......o....',
    '...obo....obo...',
    '.....oooooo.....',
    '....obbbbbbo....',
    '...obbbbbbbbo...',
    '...obbbbbbbbo...',
    '..sobbbbbbbbos..',
    '..sobbbbbbbbos..',
    '...obbbbbbbbo...',
    '...obbbbbbbbo...',
    '...obbbbbbbbo...',
    '....obbbbbbo....',
    '.....oooooo.....',
    '................'
  ]
}

// Well fed, almost never left hungry: a halo and a few sparks.
const radiant: Sprite = {
  face: { x: 6, y: 6 },
  rows: [
    '.....aaaaaa.....',
    '..a.............',
    '....o......o....',
    '...obo....obo...',
    '.....oooooo.....',
    '....obbbbbbo....',
    '...obbbbbbbbo..a',
    '...obbbbbbbbo...',
    '..sobbbbbbbbos..',
    '..sobbbbbbbbos..',
    '...obbbbbbbbo...',
    '...obbbbbbbbo...',
    '...obbbbbbbbo...',
    '....obbbbbbo....',
    '.....oooooo.....',
    '..............a.'
  ]
}

// The ordinary grown-up: broader and steady on its feet.
const sturdy: Sprite = {
  face: { x: 6, y: 7 },
  rows: [
    '................',
    '................',
    '...o........o...',
    '..obo......obo..',
    '....oooooooo....',
    '...obbbbbbbbo...',
    '..obbbbbbbbbbo..',
    '..obbbbbbbbbbo..',
    '.sobbbbbbbbbbos.',
    '.sobbbbbbbbbbos.',
    '..obbbbbbbbbbo..',
    '..obbbbbbbbbbo..',
    '..obbbbbbbbbbo..',
    '...obbbbbbbbo...',
    '....oooooooo....',
    '................'
  ]
}

// Gorged: fills the screen, with cheeks to match.
const titan: Sprite = {
  face: { x: 6, y: 5 },
  rows: [
    '................',
    '..o..........o..',
    '.obo........obo.',
    '...oooooooooo...',
    '..obbbbbbbbbbo..',
    '.obbbbbbbbbbbbo.',
    '.obbbbbbbbbbbbo.',
    'sobbbbbbbbbbbbos',
    'sobbbbbbbbbbbbos',
    '.obbhbbbbbbhbbo.',
    '.obbbbbbbbbbbbo.',
    '.obbbbbbbbbbbbo.',
    '..obbbbbbbbbbo..',
    '...oooooooooo...',
    '................',
    '................'
  ]
}

// Raised on neglect: gaunt, with a hem that has come apart.
const wraith: Sprite = {
  face: { x: 6, y: 6 },
  rows: [
    '................',
    '................',
    '.....o....o.....',
    '....oso..oso....',
    '......oooo......',
    '.....obbbbo.....',
    '....obbbbbbo....',
    '....obbbbbbo....',
    '....obbbbbbo....',
    '....obbbbbbo....',
    '....obbbbbbo....',
    '....obbbbbbo....',
    '....obbbbbbo....',
    '....obbbbbbo....',
    '....o.oo.oo.....',
    '.....o..o.o.....'
  ]
}

export const SPRITES: Record<string, Sprite> = {
  egg,
  hatchling,
  child,
  teen,
  radiant,
  sturdy,
  titan,
  wraith
}

// 4 wide so it sits dead centre on a 16-dot body, 4 tall: eyes, a gap, a mouth.
// A smile puts its corners ABOVE its middle; a frown does the opposite, and sad
// eyes droop a row — the same two dots, one row lower.
export const FACES: Record<Mood, string[]> = {
  happy: ['e..e', '....', 'm..m', '.mm.'],
  ok: ['e..e', '....', '.mm.', '....'],
  hungry: ['e..e', '....', '.mm.', '.mm.'],
  sad: ['....', 'e..e', '.mm.', 'm..m'],
  // Ill: eyes shut, mouth askew. The colour shift and the cross beside it carry
  // the rest of the message.
  sick: ['....', 'e..e', 'mm..', '..mm'],
  // Asleep: the eyes become closed lids — the same two dots, in the mouth's
  // colour rather than the eye's — and the mouth relaxes. The Z does the rest.
  asleep: ['....', 'm..m', '....', '.mm.']
}

// Small props drawn beside the creature rather than baked into its body, so they
// can appear over any of them.
export const POOP = ['..p..', '.ppp.', 'ppppp']
export const ZZZ = ['ppp', '.pp', 'pp.', 'ppp']
export const CROSS = ['.p.', 'ppp', '.p.']
export const ARROW_LEFT = ['..p.', '.pp.', 'pppp', '.pp.', '..p.']
export const ARROW_RIGHT = ['.p..', '.pp.', 'pppp', '.pp.', '.p..']

/** Which body a pet wears: its stage, except a grown-up wears its form.
 *  formOf never leaves a grown-up on 'base', but if it ever did, the plain
 *  grown-up body is the honest fallback — not a child's. */
export function spriteKey(stage: Stage, form: Form): string {
  if (form !== 'base') return form
  return stage === 'adult' ? 'sturdy' : stage
}

export interface Dot {
  x: number
  y: number
  ch: string
}

/** The lit dots of a pet, body with its mood's face stamped on top. */
export function pixelsOf(stage: Stage, form: Form, mood: Mood): Dot[] {
  const sprite = SPRITES[spriteKey(stage, form)] ?? SPRITES.child
  const grid = sprite.rows.map((r) => r.split(''))
  if (sprite.face) {
    const face = FACES[mood] ?? FACES.ok
    face.forEach((row, dy) =>
      row.split('').forEach((ch, dx) => {
        if (ch === '.') return // transparent: the body shows through
        const y = sprite.face!.y + dy
        const x = sprite.face!.x + dx
        if (grid[y]?.[x] !== undefined) grid[y][x] = ch
      })
    )
  }
  const dots: Dot[] = []
  grid.forEach((row, y) =>
    row.forEach((ch, x) => {
      if (ch !== '.') dots.push({ x, y, ch })
    })
  )
  return dots
}
