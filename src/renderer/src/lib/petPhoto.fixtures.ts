import type { Rgba } from './petPhoto'

// Synthetic "photos" for the tests of the photo pipeline and the custom
// species: shapes painted on a background, with a little deterministic grain
// so nothing is a perfectly flat colour the way no photo is.

export function canvas(w: number, h: number, bg: (x: number, y: number) => number[]): Rgba {
  const data = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const c = bg(x, y)
      data.set([c[0], c[1], c[2], c[3] ?? 255], (y * w + x) * 4)
    }
  return { width: w, height: h, data }
}

export function paint(img: Rgba, inside: (x: number, y: number) => boolean, col: (x: number, y: number) => number[]): void {
  for (let y = 0; y < img.height; y++)
    for (let x = 0; x < img.width; x++)
      if (inside(x, y)) {
        const c = col(x, y)
        img.data.set([c[0], c[1], c[2], 255], (y * img.width + x) * 4)
      }
}

export const grain = (x: number, y: number): number => ((x * 7919 + y * 104729) % 23) - 11

/** An orange cat's head: two ears, a darker chin, a white muzzle, brown cheek stripes, on a grey gradient. */
export function catPhoto(): Rgba {
  const img = canvas(128, 128, (x, y) => [225 - y / 3 + grain(x, y) / 3, 228 - y / 3, 232 - y / 4])
  const head = (x: number, y: number): boolean => (x - 64) ** 2 / 40 ** 2 + (y - 74) ** 2 / 38 ** 2 <= 1
  const ear = (x: number, y: number, cx: number): boolean => y >= 22 && y <= 48 && Math.abs(x - cx) <= (y - 22) * 0.6
  paint(
    img,
    (x, y) => head(x, y) || ear(x, y, 40) || ear(x, y, 88),
    (x, y) => (y > 92 ? [170, 90, 30] : [235, 140, 55]).map((v) => v + grain(x, y) / 2)
  )
  paint(img, (x, y) => (x - 64) ** 2 / 14 ** 2 + (y - 92) ** 2 / 12 ** 2 <= 1, () => [250, 245, 238])
  paint(img, (x, y) => head(x, y) && y > 50 && y < 60 && (x < 40 || x > 88), () => [120, 60, 20])
  return img
}

/** A blue fish with yellow bands, its tail running off the right edge of a white frame. */
export function fishPhoto(): Rgba {
  const img = canvas(120, 120, () => [252, 252, 250])
  const body = (x: number, y: number): boolean => (x - 56) ** 2 / 46 ** 2 + (y - 60) ** 2 / 28 ** 2 <= 1
  const tail = (x: number, y: number): boolean => x >= 96 && Math.abs(y - 60) <= (x - 91) * 0.9
  paint(img, (x, y) => body(x, y) || tail(x, y), (x, y) => (y > 72 ? [30, 90, 170] : [60, 140, 220]))
  paint(img, (x, y) => body(x, y) && Math.floor(x / 10) % 3 === 0, () => [250, 200, 40])
  return img
}

/** A dark penguin with a white front and orange feet, on green. */
export function penguinPhoto(): Rgba {
  const img = canvas(100, 140, (x, y) => [70 + y / 4, 150, 90])
  paint(img, (x, y) => (x - 50) ** 2 / 26 ** 2 + (y - 80) ** 2 / 50 ** 2 <= 1, () => [35, 38, 48])
  paint(img, (x, y) => (x - 50) ** 2 / 16 ** 2 + (y - 92) ** 2 / 34 ** 2 <= 1, () => [240, 240, 236])
  paint(img, (x, y) => y > 126 && y < 134 && Math.abs(x - 50) < 20 && Math.abs(x - 50) > 4, () => [240, 150, 30])
  return img
}

/** A plain disk of one colour on a flat background. */
export function diskPhoto(size = 128, r = 40, fill = [200, 60, 80], bg = [240, 240, 240]): Rgba {
  const img = canvas(size, size, () => bg)
  paint(img, (x, y) => (x - size / 2) ** 2 + (y - size / 2) ** 2 <= r * r, () => fill)
  return img
}
