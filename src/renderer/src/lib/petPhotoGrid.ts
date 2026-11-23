// The faithful picture's grid constants and helpers, with no imports, so the
// pet modules that need them (pixelEdit, petFrames, petAiPixels) don't loop
// back through state/petSpecies while it is still loading.

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
