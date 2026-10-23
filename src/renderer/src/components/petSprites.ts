import { slotOf } from '../state/pet'
import type { Accessory, AccessorySlot, Form, Mood, Species, Stage } from '../state/pet'

// ---------------------------------------------------------------------------
// The pixel art. Every creature is authored as a 16×16 grid of characters, one
// per dot, so the sprites are readable and editable as text. pixelsOf doubles
// it to 32×32 and refines it there (rounded curves, a 1-dot outline, light and
// shadow, an 8×8 face), and the renderer emits one <rect> per run of same-colour
// dots (shape-rendering: crispEdges, so real dots at any zoom).
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

/** The authored grids: 16×16, one character per dot, easy to read as text. */
export const GRID = 16
/**
 * What is drawn: each authored dot becomes 2×2, then is refined at that size
 * (rounded corners, a 1-dot outline, shading, detailed faces; see pixelsOf).
 * At 16 the outline was as thick as an eye and every curve was a staircase.
 */
export const SPRITE_SIZE = GRID * 2
/** `l` rim light and `d` shadow only exist at the drawn size, made by shading. */
export const PALETTE = '.obshwemapld'

export interface Sprite {
  rows: string[]
  /** Top-left dot where the 4×4 mood face is stamped; null for a faceless egg. */
  face: { x: number; y: number } | null
  /** Top-left dot where the strain's 6×2 crown is stamped; absent for an egg. */
  crown?: Crown
  /**
   * Top-left of the 6×4 window the grown-up's big face goes in. Defaults to one
   * dot left of `face`, which is where it lands centred on most bodies.
   */
  bigFace?: { x: number; y: number }
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

// Big ears, and a brush of a tail curled up one side.
const fox: Bodies = {
  baby: {
    face: { x: 6, y: 5 },
    rows: [
      '................',
      '................',
      '.....o....o.....',
      '....obo..obo....',
      '....oobbbboo....',
      '....obbbbbbo....',
      '....obbbbbbo....',
      '....obbbbbbo.o..',
      '....obbbbbboobo.',
      '.....obbbbbbbo..',
      '......ooooooo...',
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
      '...o......o.....',
      '..obo....obo....',
      '..oobbbbbboo....',
      '..obbbbbbbbo....',
      '..obbbbbbbbo..o.',
      '..obbbbbbbbo.obo',
      '..obbbbbbbbo.obo',
      '..obbbbbbbboobbo',
      '...obbbbbbbbbbo.',
      '....oooooooooo..',
      '................',
      '................',
      '................',
      '................'
    ]
  },
  grown: {
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
}

// Ear tufts, folded wings, talons.
const owl: Bodies = {
  baby: {
    face: { x: 6, y: 6 },
    rows: [
      '................',
      '................',
      '.....o....o.....',
      '.....oo..oo.....',
      '....oobbbboo....',
      '....obbbbbbo....',
      '....obbbbbbo....',
      '....obbbbbbo....',
      '....obbbbbbo....',
      '....obbbbbbo....',
      '.....oooooo.....',
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
      '....oo....oo....',
      '...oobbbbbboo...',
      '...obbbbbbbbo...',
      '...obbbbbbbbo...',
      '..sobbbbbbbbos..',
      '..sobbbbbbbbos..',
      '...obbbbbbbbo...',
      '...obbbbbbbbo...',
      '....obbbbbbo....',
      '.....oo..oo.....',
      '................',
      '................',
      '................'
    ]
  },
  grown: {
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
}

// Round ears, a solid build, and two stubby legs.
const bear: Bodies = {
  baby: {
    face: { x: 6, y: 5 },
    rows: [
      '................',
      '................',
      '....oo....oo....',
      '...obbo..obbo...',
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
      '...oo......oo...',
      '..obbo....obbo..',
      '...oobbbbbboo...',
      '...obbbbbbbbo...',
      '...obbbbbbbbo...',
      '...obbbbbbbbo...',
      '...obbbbbbbbo...',
      '...obbbbbbbbo...',
      '...obbbbbbbbo...',
      '...obbo..obbo...',
      '...oooo..oooo...',
      '................',
      '................',
      '................'
    ]
  },
  grown: {
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
}

// A dome of a head and a skirt of curling arms.
const octopus: Bodies = {
  baby: {
    face: { x: 6, y: 5 },
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
      '....obobbobo....',
      '....o.o..o.o....',
      '.....w.ww.w.....',
      '....wwwwwwww....',
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
      '.....oooooo.....',
      '....obbbbbbo....',
      '...obbbbbbbbo...',
      '...obbbbbbbbo...',
      '...obbbbbbbbo...',
      '...obbbbbbbbo...',
      '...obbbbbbbbo...',
      '..obbbbbbbbbbo..',
      '..obo.obbo.obo..',
      '.obo..obbo..obo.',
      '.oo....oo....oo.',
      '................',
      '................',
      '................'
    ]
  },
  grown: {
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
}

// A wide head fringed with pink gills, and a little paddle of a tail.
const axolotl: Bodies = {
  baby: {
    face: { x: 6, y: 5 },
    rows: [
      '................',
      '................',
      '................',
      '................',
      '....oooooooo....',
      '...aobbbbbboa...',
      '..a.obbbbbbo.a..',
      '...aobbbbbboa...',
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
    face: { x: 6, y: 5 },
    rows: [
      '................',
      '................',
      '................',
      '.a..oooooooo..a.',
      '..aobbbbbbbboa..',
      '.a.obbbbbbbbo.a.',
      '..aobbbbbbbboa..',
      '...obbbbbbbbo...',
      '...obbbbbbbbo...',
      '....obbbbbbo....',
      '....obbbbbbooo..',
      '.....oooooobbo..',
      '...........oo...',
      '................',
      '................',
      '................'
    ]
  },
  grown: {
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
}

// A drop of jelly: a peak on top, settling wider as it grows.
const slime: Bodies = {
  baby: {
    face: { x: 6, y: 6 },
    rows: [
      '................',
      '................',
      '................',
      '.......oo.......',
      '......obbo......',
      '.....obbbbo.....',
      '....obbbbbbo....',
      '....obbbbbbo....',
      '....obbbbbbo....',
      '....obbbbbbo....',
      '.....oooooo.....',
      '.....w.ww.w.....',
      '....wwwwwwww....',
      '................',
      '................',
      '................'
    ]
  },
  young: {
    face: { x: 6, y: 7 },
    rows: [
      '................',
      '................',
      '.......oo.......',
      '......obbo......',
      '.....obbbbo.....',
      '....obbbbbbo....',
      '...obbbbbbbbo...',
      '...obbbbbbbbo...',
      '..obbbbbbbbbbo..',
      '..obbbbbbbbbbo..',
      '..obbbbbbbbbbo..',
      '...oooooooooo...',
      '................',
      '................',
      '................',
      '................'
    ]
  },
  grown: {
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
  dragon,
  fox,
  owl,
  bear,
  octopus,
  axolotl,
  slime
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

// Faces are drawn at the drawn size, over a body's 4×4 face window (so 8×8).
// Eyes two dots wide and three tall with a white glint, a blush under each, a
// mouth with real corners. A smile puts its corners ABOVE its middle, a frown
// the other way round, and sad eyes sit lower and flatter.
export const FACES: Record<Mood, string[]> = {
  happy: ['we....we', 'ee....ee', 'ee....ee', '........', 'h.m..m.h', '...mm...', '........', '........'],
  ok: ['we....we', 'ee....ee', 'ee....ee', '........', 'h......h', '...mm...', '........', '........'],
  hungry: ['we....we', 'ee....ee', 'ee....ee', '........', 'h..mm..h', '..mhhm..', '...mm...', '........'],
  sad: ['........', '........', 'ee....ee', 'ee....ee', '........', '...mm...', '..m..m..', '........'],
  // Ill: eyes squeezed shut, > <, and a wobbly mouth. The colour shift and the
  // cross beside it carry the rest of the message.
  sick: ['e......e', '.e....e.', 'e......e', '........', '........', '..m..m..', '...mm.m.', '........'],
  // Asleep: lids closed in a gentle curve, the mouth relaxed. The Z does the rest.
  asleep: ['........', '........', 'e.e..e.e', '.e....e.', '........', '...mm...', '........', '........']
}

// The grown-up's face, over a 6×4 window (so 12×8). A small face on a big body
// is exactly what made adults read as uglier than the child they grew out of,
// so from the teens on the eyes are big ovals with a glint, the way the eyes of
// anything cute are.
export const BIG_FACES: Record<Mood, string[]> = {
  happy: ['.ee......ee.', 'ewee....ewee', 'eeee....eeee', 'eeee....eeee', '.ee......ee.', 'hh..m..m..hh', '.....mm.....', '............'],
  ok: ['.ee......ee.', 'ewee....ewee', 'eeee....eeee', 'eeee....eeee', '.ee......ee.', 'hh........hh', '.....mm.....', '............'],
  hungry: ['.ee......ee.', 'ewee....ewee', 'eeee....eeee', 'eeee....eeee', '.ee......ee.', 'hh...mm...hh', '....mhhm....', '.....mm.....'],
  sad: ['............', '............', 'eeee....eeee', 'ewee....ewee', '.ee......ee.', '.w..........', '.w...mm.....', '....m..m....'],
  sick: ['............', 'ee........ee', '..ee....ee..', 'ee........ee', '............', '............', '...m..mm....', '....mm..m...'],
  asleep: ['............', '............', '............', 'e..e....e..e', '.ee......ee.', '............', '.....mm.....', '............']
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
  // Tabby bars down both flanks. Stripes right across, every other column, were
  // a barcode on a grown cat: the body was more stripe than cat.
  cat: (x, y, b) => ((x - b.x0 < 2 || b.x1 - x < 2) && (y - b.y0) % 2 === 0 ? 'h' : null),
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

// ---- the adult forms, as changes made to the grown body ----
//
// A form used to be its own grid, which cannot work once a strain owns the
// silhouette: four forms × eighteen animals is seventy-two bodies to draw and keep
// in step. Each form is a transformation instead, so it composes with any animal.
//
// Every form has to be something worth growing into. The first versions were
// punishments in disguise (a lumpy blob, a grey thing with red eyes), and the
// adult was the stage players liked least.

type Grid = string[][]
const at = (g: Grid, x: number, y: number): string => g[y]?.[x] ?? '.'
const extent = (g: Grid): Box | null => {
  let x0 = GRID
  let x1 = -1
  let y0 = GRID
  let y1 = -1
  g.forEach((row, y) =>
    row.forEach((ch, x) => {
      if (ch === '.') return
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
    })
  )
  return x1 < 0 ? null : { x0, x1, y0, y1 }
}

/**
 * Well fed: chubby. The middle column is doubled out to each side, so it gets
 * two dots rounder without its outline growing lumps. Fattening it all round
 * turned every ear and leg into a blob. Bodies already touching both edges get
 * a row taller under the face instead.
 */
function fatten(g: Grid, face: { y: number }): void {
  const box = extent(g)
  if (!box) return
  const left = box.x0 > 0
  const right = box.x1 < GRID - 1
  if (left || right) {
    const cx = Math.floor((box.x0 + box.x1) / 2)
    for (const row of g) {
      const old = [...row]
      for (let x = 0; x < row.length; x++) {
        if (left && x < cx) row[x] = old[x + 1]
        else if (right && x > cx) row[x] = old[x - 1]
      }
    }
    return
  }
  if (box.y1 >= GRID - 1) return
  const dup = face.y + 3
  for (let y = box.y1 + 1; y > dup; y--) g[y] = [...g[y - 1]]
}

/**
 * Radiant: little four-point stars in the empty air around it. A dotted aura
 * traced round the silhouette was the first try, and it read as mould. Stars
 * go where there is room for them, up to three, apart. Runs on the drawn grid,
 * where a star has room for long arms and a white heart.
 */
function sparkle(g: Grid): void {
  const before = g.map((r) => [...r])
  const roomy = (cx: number, cy: number): boolean => {
    for (let dy = -3; dy <= 3; dy++)
      for (let dx = -3; dx <= 3; dx++) if (at(before, cx + dx, cy + dy) !== '.') return false
    return true
  }
  const spots: Array<[number, number]> = []
  for (let y = 2; y < SPRITE_SIZE - 2; y++)
    for (let x = 2; x < SPRITE_SIZE - 2; x++) if (roomy(x, y)) spots.push([x, y])
  // Top corners first (a sparkle reads best up by the head), then anything.
  const byCorner = (side: number) => (a: [number, number], b: [number, number]): number =>
    a[1] + Math.abs(a[0] - side) - (b[1] + Math.abs(b[0] - side))
  const picks: Array<[number, number]> = []
  const far = (p: [number, number]): boolean =>
    picks.every((q) => Math.abs(q[0] - p[0]) + Math.abs(q[1] - p[1]) >= 12)
  for (const order of [byCorner(0), byCorner(SPRITE_SIZE - 1), byCorner(SPRITE_SIZE / 2)]) {
    const p = [...spots].sort(order).find(far)
    if (p) picks.push(p)
  }
  // The third star is a small one, so the three don't read as a pattern.
  picks.forEach(([x, y], i) => {
    const arm = i < 2 ? 2 : 1
    for (let d = -arm; d <= arm; d++) {
      g[y][x + d] = 'a'
      g[y + d][x] = 'a'
    }
    g[y][x] = 'w'
  })
  if (picks.length > 0) return
  // Packed edge to edge: a single glint wherever one fits.
  for (let y = 0; y < SPRITE_SIZE; y++)
    for (let x = 0; x < SPRITE_SIZE; x++) if (before[y][x] === '.' && (x + y) % 13 === 0) g[y][x] = 'a'
}

/**
 * Raised on neglect: a little ghost. Whatever it stood on is gone, and the hem
 * hangs in scallops. (Translucent and floating, in pet.css.) It keeps its own
 * colours and its coat: it is still the pet, just a sadder one.
 */
function haunt(g: Grid): void {
  const lastBody = g.reduce((last, row, y) => (row.includes('b') ? y : last), -1)
  if (lastBody < 0) return
  const hem = lastBody + 1
  for (let y = hem + 1; y < g.length; y++) g[y].fill('.')
  // Every other lit dot, counted from the first: on a hem whose dots all sit on
  // odd columns (a fish's tail fin) an x % 2 rule scalloped nothing.
  if (hem < g.length) {
    let n = 0
    for (let x = 0; x < g[hem].length; x++) if (g[hem][x] !== '.' && n++ % 2 === 0) g[hem][x] = '.'
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
const STRIPED: ReadonlySet<Species> = new Set(['cat'])

/**
 * A coat, doubled, was a scatter of fat blocks. Its marks are pulled one dot
 * back from the outline (a mark run into the edge reads as a hole in it), and
 * stripes are drawn one dot thick. Never so far that a strain shows nothing.
 */
function refineCoat(g: Grid, coat: boolean[][], species: Species): void {
  const marked = (x: number, y: number): boolean => {
    const ch = g[y][x]
    if (ch !== 'h' && ch !== 'a') return false
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

/** The face a pet wears, where it goes on the drawn grid. */
function faceOf(
  stage: Stage,
  sprite: Sprite,
  mood: Mood
): { x: number; y: number; w: number; rows: string[] } | null {
  const big = stage === 'teen' || stage === 'adult' ? bigFaceOf(sprite) : null
  if (big) return { x: big.x * 2, y: big.y * 2, w: 12, rows: BIG_FACES[mood] ?? BIG_FACES.ok }
  if (!sprite.face) return null
  return { x: sprite.face.x * 2, y: sprite.face.y * 2, w: 8, rows: FACES[mood] ?? FACES.ok }
}

/** The lit dots of a pet: its body, wearing its strain, with its mood on top. */
export function pixelsOf(stage: Stage, form: Form, mood: Mood, species: Species = 'cat'): Dot[] {
  const sprite = bodyOf(species, stage)
  const grid = sprite.rows.map((r) => r.split(''))

  // From the teens on it gets the big, expressive face, wherever it fits. The
  // window it is stamped into, on the authored grid:
  const big = stage === 'teen' || stage === 'adult' ? bigFaceOf(sprite) : null
  const window = big ? { ...big, w: 6 } : sprite.face ? { ...sprite.face, w: 4 } : null

  // What its upbringing made of it, applied to whichever animal it is.
  if (stage === 'adult') {
    if (form === 'titan') fatten(grid, window ?? { y: 0 })
    else if (form === 'wraith') haunt(grid)
  }

  // The coat, first. Only where there is body to mark (never over an outline,
  // never outside the silhouette) and never within a dot of the face: a marking
  // beside an eye reads as a bruise, not as a pattern.
  const rule = COAT_RULES[species]
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
    // only where there is room for it. A just-hatched body is barely wider than
    // its own face, and the margin left nowhere at all for its strain to show.
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
      // A strain has to be visible at EVERY size. On the smallest bodies the face
      // and its margin can cover the whole torso, leaving a belly or a sparse
      // speckle with nowhere to land, so fall back to marking the flanks.
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
  const face = faceOf(stage, sprite, mood)
  if (face)
    for (let y = face.y; y < face.y + 8; y++)
      for (let x = face.x; x < face.x + face.w; x++)
        if (fine[y]?.[x] === 'h' || fine[y]?.[x] === 'a') fine[y][x] = 'b'
  shade(fine)
  if (stage === 'adult' && form === 'radiant') sparkle(fine)

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

/** A row of same-coloured dots, drawn as one rect. */
export interface Run extends Dot {
  w: number
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
 * Keepsakes a grown-up earns by levelling. Drawn as their own layer (see
 * Creature), so a crown's gold doesn't twinkle like the stars do, at the drawn
 * size. A hat sits on its head; the neckwear is made to fit (see neckwear) and
 * only its charm is drawn here; the rest find a free spot of air around it.
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
  legend: ['..a..', '..a..', 'aawaa', '..a..', '..a..']
}

/** Smaller ones, for a pet that leaves no room for the full-size piece. */
const ACCESSORY_MINI: Partial<Record<Accessory, string[]>> = {
  heart: ['m.m', 'mmm', '.m.'],
  star: ['.a.', 'awa', 'a.a'],
  moon: ['.aa', 'aa.', '.aa'],
  flowers: ['waw', '.s.'],
  mushrooms: ['mmm', 'mwm', '.w.']
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
 * face, cut to its outline, with the item's charm (or a scarf's tail) on it.
 */
function neckwear(
  id: Accessory,
  face: { x: number; y: number; w: number; rows: string[] },
  body: Set<number>
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
  const band = id === 'scarf' ? 2 : 1
  for (let dy = 0; dy < band; dy++)
    for (let x = 0; x < SPRITE_SIZE; x++)
      if (body.has(keyOf(x, y + dy)) && Math.abs(x - (face.x + face.w / 2)) <= face.w)
        dots.push({ x, y: y + dy, ch: id === 'medal' ? 'h' : id === 'scarf' && (x + dy) % 3 === 0 ? 'h' : 'm' })
  if (!dots.length) return []
  const art = ACCESSORY_ART[id]
  const w = art[0].length
  // A scarf's tail hangs off one side; a bell or medal hangs in the middle.
  const x0 =
    id === 'scarf'
      ? face.x + face.w - 3
      : face.x + Math.floor((face.w - w) / 2)
  return [...dots, ...stamp(art, x0, y + band)]
}

/** Where a hat sits: centred over the face, its bottom row sunk into the outline of the head. */
function headwear(
  art: string[],
  face: { x: number; y: number; w: number },
  body: Dot[]
): Dot[] {
  const w = art[0].length
  const x0 = Math.max(0, Math.min(SPRITE_SIZE - w, face.x + Math.floor((face.w - w) / 2)))
  // The top of the head under the keepsake, ignoring a radiant pet's stars.
  let top = SPRITE_SIZE
  for (const d of body) if (d.x >= x0 && d.x < x0 + w && d.y < top) top = d.y
  // Over a head that touches the top of the grid it sinks into the head
  // instead, and where even that leaves no room above the eyes, the bottom of
  // it is cut off rather than drawn over them.
  const y0 = Math.max(0, Math.min(top - art.length + 2, face.y - art.length))
  return stamp(art, x0, y0, face.y)
}

/**
 * Everything a grown-up wears, already placed: `back` (its shine, drawn
 * behind and left to twinkle) and `front` (the rest). Each piece is fitted in
 * turn around the pet and what it already has on, so nothing covers its face
 * or another piece, and a piece with nowhere to go is left off.
 */
export function outfitPixels(
  stage: Stage,
  form: Form,
  species: Species,
  worn: Accessory[]
): { back: Dot[]; front: Dot[] } {
  const none = { back: [], front: [] }
  if (!worn.length || stage !== 'adult') return none
  const face = faceOf(stage, bodyOf(species, stage), 'ok')
  if (!face) return none
  const all = pixelsOf(stage, form, 'ok', species)
  const flesh = all.filter((d) => d.ch !== 'a' && d.ch !== 'w')
  const body = new Set(flesh.map((d) => keyOf(d.x, d.y)))
  const taken = new Set(all.map((d) => keyOf(d.x, d.y)))
  // The same without a radiant pet's stars, which a piece may cover if it must.
  const bare = new Set(body)
  const back: Dot[] = []
  const front: Dot[] = []
  const put = (dots: Dot[], into = front): void => {
    for (const d of dots) {
      taken.add(keyOf(d.x, d.y))
      bare.add(keyOf(d.x, d.y))
    }
    into.push(...dots)
  }
  const fit = (
    art: string[],
    anchor: [number, number],
    [minY, maxY] = [0, SPRITE_SIZE],
    into = front
  ): boolean => {
    // Best with a dot of air round it (a twinkle may brush the pet), then
    // snug against it, then over the stars rather than not at all.
    const tries: Array<[Set<number>, number]> =
      into === back
        ? [[taken, 0], [bare, 0]]
        : [[taken, 1], [taken, 0], [bare, 1], [bare, 0]]
    for (const [set, margin] of tries) {
      const at = nearestFit(art, anchor, set, minY, margin, maxY)
      if (at) {
        put(stamp(art, at.x, at.y), into)
        return true
      }
    }
    return false
  }
  const slotted = (slot: AccessorySlot): Accessory | undefined =>
    worn.find((a) => slotOf(a) === slot)
  // Fitted from the head out, so the pieces on the body get the best spots.
  const hat = slotted('head')
  if (hat) put(headwear(ACCESSORY_ART[hat], face, flesh))
  const neck = slotted('neck')
  if (neck) put(neckwear(neck, face, body))
  const friend = slotted('float')
  // Full size where it fits, else a smaller one, else left off.
  const fitAny = (id: Accessory, at: (art: string[]) => [number, number], rows: [number, number]): void => {
    for (const art of [ACCESSORY_ART[id], ACCESSORY_MINI[id]])
      if (art && fit(art, at(art), rows)) return
  }
  // Up by its head, never down at its feet.
  if (friend) fitAny(friend, (art) => [SPRITE_SIZE - art[0].length - 1, 1], [0, face.y + face.rows.length])
  const ground = slotted('ground')
  if (ground) {
    // One at each side of its feet, kept to the bottom few rows.
    const rows: [number, number] = [SPRITE_SIZE - 10, SPRITE_SIZE]
    fitAny(ground, (art) => [0, SPRITE_SIZE - art.length], rows)
    fitAny(ground, (art) => [SPRITE_SIZE - art[0].length, SPRITE_SIZE - art.length], rows)
  }
  const shine = slotted('aura')
  const aura = shine && AURA[shine]
  if (aura) {
    let spot = 0
    // A big twinkle with no room for it is a small one instead.
    for (let i = 0; i < aura.big; i++) {
      const at = AURA_SPOTS[spot++]
      if (!fit(ACCESSORY_ART.legend, at, undefined, back)) fit(ACCESSORY_ART.sparkle, at, undefined, back)
    }
    for (let i = 0; i < aura.small; i++)
      fit(ACCESSORY_ART.sparkle, AURA_SPOTS[spot++ % AURA_SPOTS.length], undefined, back)
  }
  return { back, front }
}

/** One keepsake on its own, as `outfitPixels` would place it. */
export function accessoryPixels(
  stage: Stage,
  form: Form,
  species: Species,
  accessory: Accessory | null
): Dot[] {
  if (!accessory) return []
  const { back, front } = outfitPixels(stage, form, species, [accessory])
  return [...back, ...front]
}
