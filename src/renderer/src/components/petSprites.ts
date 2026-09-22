import type { Form, Mood, Species, Stage } from '../state/pet'

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
  /** Top-left dot where the strain's 6×2 crown is stamped; absent for an egg. */
  crown?: Crown
}

// The shell is plain on purpose: what is printed on it is the strain's coat (see
// COATS), so the draw you got is visible before it has hatched. It used to carry
// a zigzag of its own, which every egg everywhere had.
// The shell is plain: what is printed on it is the strain's coat (see COAT_RULES),
// so the animal you drew is visible before it has hatched.
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
    '....obbbbbbo....',
    '....obbbbbbo....',
    '....obbbbbbo....',
    '....obbbbbbo....',
    '....obbbbbbo....',
    '.....obbbbo.....',
    '......oooo......',
    '................'
  ]
}

// ---------------------------------------------------------------------------
// The animals. One silhouette per strain, at three sizes: `baby` (just hatched,
// sitting in the broken shell), `young` (the child; the teen is this plus limbs)
// and `grown`. The adult FORM is not another body — it is a change made to the
// grown one (see fatten / halo / tatter), so care and strain compose instead of
// multiplying into twenty-four hand-drawn grids.
//
// Every grid is 16×16 and every face is a 4×4 window of plain body, which is what
// petSprites.test.ts checks: a miscounted row is invisible in review.
// ---------------------------------------------------------------------------

interface Bodies {
  baby: Sprite
  young: Sprite
  grown: Sprite
}

// Pointed ears, a tail carried straight up.
const cat: Bodies = {
  baby: {
    face: { x: 6, y: 5 },
    rows: [
      '................',
      '................',
      '................',
      '.....o....o.....',
      '....oobbbboo....',
      '....obbbbbbo....',
      '....obbbbbbo....',
      '....obbbbbbo....',
      '....obbbbbbo....',
      '.....obbbbo.....',
      '......oooo......',
      '.....w.ww.w.....',
      '....wwwwwwww....',
      '................',
      '................',
      '................'
    ]
  },
  young: {
    face: { x: 6, y: 6 },
    rows: [
      '................',
      '................',
      '....o......o....',
      '...obo....obo...',
      '....oobbbboo....',
      '...obbbbbbbbo...',
      '.o.obbbbbbbbo.o.',
      '..oobbbbbbbboo..',
      '.o.obbbbbbbbo.o.',
      '...obbbbbbbbo...',
      '...obbbbbbbbo...',
      '....obbbbbbo....',
      '.....oooooo.....',
      '................',
      '................',
      '................'
    ]
  },
  grown: {
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
}

// Two long ears straight up, a round tail.
const rabbit: Bodies = {
  baby: {
    face: { x: 6, y: 6 },
    rows: [
      '................',
      '................',
      '......o..o......',
      '.....obo.obo....',
      '......oooo......',
      '.....obbbbo.....',
      '....obbbbbbo....',
      '....obbbbbbo....',
      '....obbbbbbo....',
      '.....obbbbo.....',
      '......oooo......',
      '.....w.ww.w.....',
      '....wwwwwwww....',
      '................',
      '................',
      '................'
    ]
  },
  young: {
    face: { x: 6, y: 6 },
    rows: [
      '................',
      '....o...o.......',
      '....obo.obo.....',
      '....obo.obo.....',
      '....oobbbboo....',
      '...obbbbbbbbo...',
      '...obbbbbbbbo...',
      '...obbbbbbbbo...',
      '...obbbbbbbbo...',
      '...obbbbbbbbo...',
      '...obbbbbbbboo..',
      '....obbbbbbo....',
      '.....oooooo.....',
      '................',
      '................',
      '................'
    ]
  },
  grown: {
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
}

// A beak, a tail of feathers, two thin legs. It faces left.
const bird: Bodies = {
  baby: {
    face: { x: 6, y: 4 },
    rows: [
      '................',
      '................',
      '................',
      '......oooo......',
      '....hobbbbo.....',
      '...hhobbbbo.....',
      '.....obbbbo.....',
      '....obbbbbbo....',
      '....obbbbbbo....',
      '.....oooooo.....',
      '.....w.ww.w.....',
      '....wwwwwwww....',
      '................',
      '................',
      '................',
      '................'
    ]
  },
  young: {
    face: { x: 6, y: 3 },
    rows: [
      '................',
      '................',
      '......oooo......',
      '.....obbbbo.....',
      '...hobbbbbbo....',
      '..hhobbbbbbo....',
      '...obbbbbbbbo...',
      '...obbbbbbbbooo.',
      '...obbbbbbbbo...',
      '....obbbbbbo....',
      '.....oooooo.....',
      '.....o...o......',
      '....ooo.ooo.....',
      '................',
      '................',
      '................'
    ]
  },
  grown: {
    face: { x: 6, y: 2 },
    rows: [
      '................',
      '......oooo......',
      '.....obbbbo.....',
      '...hobbbbbbo....',
      '..hhobbbbbbo....',
      '....obbbbbbbo...',
      '...obbbbbbbbbo..',
      '...obbbbbbbbbboo',
      '..obbbbbbbbbbboo',
      '..obbbbbbbbbbo..',
      '..obbbbbbbbbo...',
      '...obbbbbbbo....',
      '....oooooooo....',
      '.....o...o......',
      '....ooo.ooo.....',
      '................'
    ]
  }
}

// No legs at all: a tail fin at the back, fins above and below.
const fish: Bodies = {
  baby: {
    face: { x: 4, y: 5 },
    rows: [
      '................',
      '................',
      '................',
      '................',
      '.....oooooo.....',
      '...obbbbbbbbo...',
      '..obbbbbbbbbboo.',
      '..obbbbbbbbbbooo',
      '...obbbbbbbboo..',
      '.....oooooo.....',
      '.....w.ww.w.....',
      '....wwwwwwww....',
      '................',
      '................',
      '................',
      '................'
    ]
  },
  young: {
    face: { x: 4, y: 6 },
    rows: [
      '................',
      '................',
      '................',
      '........o.......',
      '.....oooboo.....',
      '...obbbbbbbbo...',
      '..obbbbbbbbbboo.',
      '..obbbbbbbbbbooo',
      '..obbbbbbbbbboo.',
      '...obbbbbbbbo...',
      '.....ooobooo....',
      '........o.......',
      '................',
      '................',
      '................',
      '................'
    ]
  },
  grown: {
    face: { x: 3, y: 6 },
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
}

// A small head over a wide shelled body, with four legs poking out.
const turtle: Bodies = {
  baby: {
    face: { x: 6, y: 4 },
    rows: [
      '................',
      '................',
      '................',
      '......oooo......',
      '.....obbbbo.....',
      '.....obbbbo.....',
      '.....obbbbo.....',
      '.....obbbbo.....',
      '....oooooooo....',
      '...oobbbbbboo...',
      '...oobbbbbboo...',
      '....oooooooo....',
      '.....w.ww.w.....',
      '....wwwwwwww....',
      '................',
      '................'
    ]
  },
  young: {
    face: { x: 3, y: 3 },
    rows: [
      '................',
      '................',
      '..oooo..........',
      '.obbbbo.........',
      '.obbbbo.........',
      '.obbbboooooo....',
      '.oobbbbbbbbbo...',
      '..obbbbbbbbbo...',
      '..obbbbbbbbbo...',
      '..oobbbbbbbboo..',
      '...oooooooooo...',
      '....o.o..o.o....',
      '....o.o..o.o....',
      '................',
      '................',
      '................'
    ]
  },
  grown: {
    face: { x: 3, y: 2 },
    rows: [
      '................',
      '..oooo..........',
      '.obbbbo.........',
      '.obbbbo.........',
      '.obbbbo.........',
      '.obbbbooooooo...',
      '.oobbbbbbbbbbo..',
      'oobbbbbbbbbbbbo.',
      'obbbbbbbbbbbbbbo',
      'obbbbbbbbbbbbbbo',
      '.obbbbbbbbbbbbo.',
      '..oobbbbbbbboo..',
      '...oooooooooo...',
      '...o.oo..oo.o...',
      '...o.oo..oo.o...',
      '................'
    ]
  }
}

// Antennae up top, legs down both sides.
const bug: Bodies = {
  baby: {
    face: { x: 6, y: 4 },
    rows: [
      '................',
      '................',
      '.....o....o.....',
      '......oooo......',
      '.....obbbbo.....',
      '....obbbbbbo....',
      '..s.obbbbbbo.s..',
      '....obbbbbbo....',
      '.....obbbbo.....',
      '......oooo......',
      '.....w.ww.w.....',
      '....wwwwwwww....',
      '................',
      '................',
      '................',
      '................'
    ]
  },
  young: {
    face: { x: 6, y: 5 },
    rows: [
      '................',
      '....o......o....',
      '.....o....o.....',
      '......oooo......',
      '.....obbbbo.....',
      '..sobbbbbbbbos..',
      '...obbbbbbbbo...',
      '..sobbbbbbbbos..',
      '...obbbbbbbbo...',
      '..sobbbbbbbbos..',
      '....oobbbboo....',
      '......oooo......',
      '................',
      '................',
      '................',
      '................'
    ]
  },
  grown: {
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
}

// Floppy ears down the sides of the head, and four legs.
const dog: Bodies = {
  baby: {
    face: { x: 6, y: 5 },
    rows: [
      '................',
      '................',
      '................',
      '....oo....oo....',
      '...obboooobbo...',
      '...obbbbbbbbo...',
      '...obbbbbbbbo...',
      '...obbbbbbbbo...',
      '...obbbbbbbbo...',
      '....oooooooo....',
      '.....w.ww.w.....',
      '....wwwwwwww....',
      '................',
      '................',
      '................',
      '................'
    ]
  },
  young: {
    face: { x: 6, y: 5 },
    rows: [
      '................',
      '................',
      '...oo......oo...',
      '..obbo....obbo..',
      '..obbbooooobbbo.',
      '..obbbbbbbbbbbo.',
      '..obbbbbbbbbbbo.',
      '..obbbbbbbbbbbo.',
      '...obbbbbbbbbo..',
      '...obbbbbbbbbo..',
      '...obbbbbbbbbo..',
      '...ooooooooooo..',
      '...o.oo..oo.o...',
      '...o.oo..oo.o...',
      '................',
      '................'
    ]
  },
  grown: {
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
}

// Small, round ears, and cheeks wider than it is tall.
const hamster: Bodies = {
  baby: {
    face: { x: 6, y: 5 },
    rows: [
      '................',
      '................',
      '................',
      '....oo....oo....',
      '...obbo..obbo...',
      '....oobbbboo....',
      '...obbbbbbbbo...',
      '...obbbbbbbbo...',
      '....oobbbboo....',
      '......oooo......',
      '.....w.ww.w.....',
      '....wwwwwwww....',
      '................',
      '................',
      '................',
      '................'
    ]
  },
  young: {
    face: { x: 6, y: 6 },
    rows: [
      '................',
      '................',
      '...oo....oo.....',
      '..obbo..obbo....',
      '..obbboobbbo....',
      '...oobbbbbboo...',
      '..obbbbbbbbbbo..',
      '..obbbbbbbbbbo..',
      '..obbbbbbbbbbo..',
      '..obbbbbbbbbbo..',
      '...oobbbbbboo...',
      '.....oooooo.....',
      '....o.o..o.o....',
      '................',
      '................',
      '................'
    ]
  },
  grown: {
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
}

// Upright, with a pale front, two flippers and two feet.
const penguin: Bodies = {
  baby: {
    face: { x: 5, y: 4 },
    rows: [
      '................',
      '................',
      '................',
      '....oooooo......',
      '...obbbbbbo.....',
      '..aobbbbbbo.....',
      '...obbbbbbo.....',
      '...obbbbbbo.....',
      '....oooooo......',
      '.....w.ww.w.....',
      '....wwwwwwww....',
      '................',
      '................',
      '................',
      '................',
      '................'
    ]
  },
  young: {
    face: { x: 5, y: 3 },
    rows: [
      '................',
      '................',
      '....oooooo......',
      '...obbbbbbo.....',
      '..aobbbbbbo.....',
      '...obbbbbbo.....',
      '..oobbbbbboo....',
      '.obbbbbbbbbbo...',
      '.obbbbbbbbbbo...',
      '..obbbbbbbbo....',
      '..obbbbbbbbo....',
      '...oooooooo.....',
      '..ooo....ooo....',
      '................',
      '................',
      '................'
    ]
  },
  grown: {
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
}

// Squat and wide, with eyes up top and legs splayed out at the bottom.
const frog: Bodies = {
  baby: {
    face: { x: 6, y: 5 },
    rows: [
      '................',
      '................',
      '................',
      '....oo....oo....',
      '...obboooobbo...',
      '...obbbbbbbbo...',
      '...obbbbbbbbo...',
      '....oooooooo....',
      '...oo......oo...',
      '..obo......obo..',
      '.....w.ww.w.....',
      '....wwwwwwww....',
      '................',
      '................',
      '................',
      '................'
    ]
  },
  young: {
    face: { x: 6, y: 5 },
    rows: [
      '................',
      '................',
      '...oo......oo...',
      '..obbo....obbo..',
      '..obbboooobbbo..',
      '..obbbbbbbbbbo..',
      '..obbbbbbbbbbo..',
      '..obbbbbbbbbbo..',
      '..oobbbbbbbboo..',
      '...oooooooooo...',
      '..oo........oo..',
      '.obbo......obbo.',
      '.oo..........oo.',
      '................',
      '................',
      '................'
    ]
  },
  grown: {
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
}

// Wide and flat, two claws held up, legs down both sides.
const crab: Bodies = {
  baby: {
    face: { x: 6, y: 5 },
    rows: [
      '................',
      '................',
      '...oo......oo...',
      '...obo....obo...',
      '....oooooooo....',
      '...obbbbbbbbo...',
      '...obbbbbbbbo...',
      '...obbbbbbbbo...',
      '....oooooooo....',
      '...o.o....o.o...',
      '.....w.ww.w.....',
      '....wwwwwwww....',
      '................',
      '................',
      '................',
      '................'
    ]
  },
  young: {
    face: { x: 6, y: 5 },
    rows: [
      '................',
      '..oo........oo..',
      '.obbo......obbo.',
      '.obbo......obbo.',
      '..oboooooooobo..',
      '..obbbbbbbbbbo..',
      '..obbbbbbbbbbo..',
      '..obbbbbbbbbbo..',
      '..obbbbbbbbbbo..',
      '..oobbbbbbbboo..',
      '...oooooooooo...',
      '..o.o.o..o.o.o..',
      '..o.o.o..o.o.o..',
      '................',
      '................',
      '................'
    ]
  },
  grown: {
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
}

// Horns, a wing out one side, and a tail behind.
const dragon: Bodies = {
  baby: {
    face: { x: 6, y: 5 },
    rows: [
      '................',
      '................',
      '.....o....o.....',
      '.....obooobo....',
      '....obbbbbbbo...',
      '....obbbbbbbo...',
      '....obbbbbbbo...',
      '....obbbbbbbo...',
      '.....oooooooo...',
      '..........o.....',
      '.....w.ww.w.....',
      '....wwwwwwww....',
      '................',
      '................',
      '................',
      '................'
    ]
  },
  young: {
    face: { x: 5, y: 5 },
    rows: [
      '................',
      '...o......o.....',
      '...obo..obo.....',
      '....oobbboo.....',
      '..obbbbbbbbo....',
      '..obbbbbbbbo.oo.',
      '..obbbbbbbbooboo',
      '..obbbbbbbbbbbbo',
      '..obbbbbbbbooboo',
      '...obbbbbbo..oo.',
      '...oooooooo.....',
      '.........o......',
      '........oo......',
      '.......oo.......',
      '................',
      '................'
    ]
  },
  grown: {
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
}

export const BODIES: Record<Species, Bodies> = {
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
  dragon
}

/** Every grid in the art, flat, for the shape checks in the tests. */
export const SPRITES: Record<string, Sprite> = {
  egg,
  ...Object.fromEntries(
    Object.entries(BODIES).flatMap(([sp, b]) =>
      (Object.keys(b) as Array<keyof Bodies>).map((size) => [`${sp}.${size}`, b[size]])
    )
  )
}

// 4 wide so it sits dead centre on a body, 4 tall: eyes, a gap, a mouth. A smile
// puts its corners ABOVE its middle; a frown does the opposite, and sad eyes
// droop a row — the same two dots, one row lower.
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

// Props for what the watched pane is doing: a book (reading), a pen (writing), a
// prompt (running), a lens (searching), a globe (fetching).
export const MIMES: Record<string, string[]> = {
  read: ['pppp', 'p..p', 'p..p', 'pppp'],
  write: ['...p', '..pp', '.pp.', 'pp..'],
  run: ['pppp', 'p.pp', 'pp.p', 'pppp'],
  search: ['.pp.', 'p..p', '.pp.', '...p'],
  web: ['.pp.', 'pppp', 'pppp', '.pp.']
}
export const ARROW_LEFT = ['..p.', '.pp.', 'pppp', '.pp.', '..p.']
export const ARROW_RIGHT = ['.p..', '.pp.', 'pppp', '.pp.', '.p..']

// ---------------------------------------------------------------------------
// Species — what a pet hatched as (see state/pet.ts).
//
// Six strains without six sets of bodies: the strain is stamped ONTO whatever
// body the pet is wearing, the same trick the faces use. Three marks:
//
//   coat   a 16×16 mask laid over the body. A dot only lands where the body
//          already is, so one pattern fits every stage and every adult form
//          without a single extra grid to keep in sync.
//   crown  a 6×2 patch above the head — horns, an antenna, a tuft. This is the
//          silhouette difference, so two strains are told apart in one glance
//          even in the 'bare' size where there is nothing else on screen.
//   colour CSS, not dots (see .pet-sp-* in pet.css): the body hue is mixed with
//          the theme's accent so a strain reads as itself in any theme.
//
// The egg wears its strain's coat too, which is the whole point — the draw is
// visible the moment it appears instead of hours later at adulthood.
// ---------------------------------------------------------------------------

/** Where a body wants its strain's crown: top-left of a 6×2 patch. */
export interface Crown {
  x: number
  y: number
}

// A coat is a RULE, not a picture. Six hand-drawn 16×16 masks had to line up
// with seven different bodies (four of them adult forms of different widths) and
// they did not: stripes cut through eyes, a ridge landed on a chin, spots read as
// dirt. A rule measured against the body's own bounding box fits every one of
// them — and the egg, which is the whole point of having strains at all.
//
// 'h' is the highlight (a lighter shade of the body), 'a' the accent.
interface Box {
  x0: number
  x1: number
  y0: number
  y1: number
}

export const COAT_RULES: Record<
  Species,
  (x: number, y: number, b: Box) => string | null
> = {
  // Tabby stripes. Every OTHER column, not every third: the face and its margin
  // take the middle six dots, so a sparser stripe left nothing but edge piping.
  cat: (x, y, b) => ((x - b.x0) % 2 === 0 ? 'h' : null),
  // Pale underside — inset from the flanks, or it reads as a nappy rather than
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
  dragon: (x, y) => ((x + y) % 3 === 0 ? 'a' : null)
}

// ---- the adult forms, as changes made to the grown body ----
//
// A form used to be its own grid, which cannot work once a strain owns the
// silhouette: four forms × six animals is twenty-four bodies to draw and keep in
// step. Each form is a transformation instead, so it composes with any animal.

type Grid = string[][]
const at = (g: Grid, x: number, y: number): string => g[y]?.[x] ?? '.'

/** Gorged: one dot fatter all round, whatever animal it is. */
function fatten(g: Grid): void {
  const before = g.map((r) => [...r])
  const solid = (x: number, y: number): boolean => at(before, x, y) !== '.'
  for (let y = 0; y < g.length; y++)
    for (let x = 0; x < g[y].length; x++) {
      const here = at(before, x, y)
      // Empty next to the shape becomes the new outline …
      if (here === '.') {
        if (solid(x - 1, y) || solid(x + 1, y) || solid(x, y - 1) || solid(x, y + 1)) g[y][x] = 'o'
        continue
      }
      // … and the old outline is swallowed by the body behind it.
      if (here === 'o') {
        const b = (dx: number, dy: number): boolean => at(before, x + dx, y + dy) === 'b'
        if (b(-1, 0) || b(1, 0) || b(0, -1) || b(0, 1)) g[y][x] = 'b'
      }
    }
}

/**
 * Radiant: a dotted aura following the silhouette. An arc over the head was the
 * first attempt and it only works on animals whose head is their topmost part —
 * on a fish (a fin tip) it came out as a single dot. This traces whatever shape
 * the animal has, every other cell, so it reads as a sparkle rather than a ring.
 */
function halo(g: Grid): void {
  const before = g.map((r) => [...r])
  const solid = (x: number, y: number): boolean => at(before, x, y) !== '.'
  for (let y = 0; y < g.length; y++)
    for (let x = 0; x < g[y].length; x++) {
      if (before[y][x] !== '.' || (x + y) % 2 !== 0) continue
      if (solid(x - 1, y) || solid(x + 1, y) || solid(x, y - 1) || solid(x, y + 1)) g[y][x] = 'a'
    }
}

/** Raised on neglect: the hem has come apart. */
function tatter(g: Grid): void {
  const bottom = g.reduce((last, row, y) => (row.some((c) => c !== '.') ? y : last), -1)
  if (bottom < 0) return
  for (const y of [bottom, bottom - 1]) {
    if (y < 0) continue
    for (let x = 0; x < g[y].length; x++) if (g[y][x] !== '.' && x % 2 === 0) g[y][x] = '.'
  }
}

/** Teen: the young body with limbs put out to the sides. */
function withLimbs(rows: string[]): string[] {
  // An animal that already stands on something (bug, turtle) keeps what it has.
  if (rows.some((r) => r.includes('s'))) return rows
  const g = rows.map((r) => [...r])
  const ys = g.flatMap((row, y) => (row.some((c) => c === 'b') ? [y] : []))
  const mid = ys[Math.floor(ys.length / 2)]
  for (const y of [mid, mid + 1]) {
    const row = g[y]
    if (!row) continue
    const first = row.findIndex((c) => c !== '.')
    const last = row.length - 1 - [...row].reverse().findIndex((c) => c !== '.')
    if (first > 0) row[first - 1] = 's'
    if (last < row.length - 1) row[last + 1] = 's'
  }
  return g.map((r) => r.join(''))
}

/** Which body a pet wears: its animal, at the size its stage calls for. */
export function bodyOf(species: Species, stage: Stage): Sprite {
  if (stage === 'egg') return egg
  const b = BODIES[species] ?? BODIES.cat
  if (stage === 'hatchling') return b.baby
  if (stage === 'child') return b.young
  if (stage === 'teen') return { ...b.young, rows: withLimbs(b.young.rows) }
  return b.grown
}

export interface Dot {
  x: number
  y: number
  ch: string
}

/** The lit dots of a pet: its body, wearing its strain, with its mood on top. */
export function pixelsOf(stage: Stage, form: Form, mood: Mood, species: Species = 'cat'): Dot[] {
  const sprite = bodyOf(species, stage)
  const grid = sprite.rows.map((r) => r.split(''))

  // What its upbringing made of it, applied to whichever animal it is.
  if (stage === 'adult') {
    if (form === 'titan') fatten(grid)
    else if (form === 'radiant') halo(grid)
    else if (form === 'wraith') tatter(grid)
  }

  // The coat, first. Only where there is body to mark — never over an outline,
  // never outside the silhouette — and never within a dot of the face: a marking
  // beside an eye reads as a bruise, not as a pattern.
  // A wraith wears no markings: what it was raised on faded them out. (It also
  // keeps the dot count below a sturdy one, which the tests check.)
  const rule = form === 'wraith' && stage === 'adult' ? null : COAT_RULES[species]
  if (rule) {
    let x0 = SPRITE_SIZE
    let x1 = -1
    let y0 = SPRITE_SIZE
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
    const f = sprite.face
    // A dot of clearance around the face, so a marking never crowds an eye — but
    // only where there is room for it. A just-hatched body is barely wider than
    // its own face, and the margin left nowhere at all for its strain to show.
    const margin = x1 - x0 >= 9 ? 1 : 0
    const clear = (x: number, y: number): boolean =>
      !f ||
      x < f.x - margin ||
      x > f.x + 3 + margin ||
      y < f.y - margin ||
      y > f.y + 3 + margin
    if (x1 >= 0) {
      const box = { x0, x1, y0, y1 }
      let marked = 0
      grid.forEach((row, y) =>
        row.forEach((ch, x) => {
          if (ch !== 'b' || !clear(x, y)) return
          const mark = rule(x, y, box)
          if (!mark) return
          grid[y][x] = mark
          marked++
        })
      )
      // A strain has to be visible at EVERY size. On the smallest bodies the face
      // and its margin can cover the whole torso, leaving a belly or a sparse
      // speckle with nowhere to land — so fall back to marking the flanks.
      if (marked === 0)
        grid.forEach((row, y) =>
          row.forEach((ch, x) => {
            if (ch !== 'b' || !clear(x, y)) return
            if ((x === x0 || x === x1) && y % 2 === 0) grid[y][x] = 'h'
          })
        )
    }
  }
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
