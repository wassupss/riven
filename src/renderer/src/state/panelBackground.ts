// Panel background image: the pure half (settings shape, validation and what
// the page should show). No DOM and no window here, so it runs in plain-node
// unit tests; lib/panelBackground.ts applies the result to the page.
//
// The image itself is a copy in userData/backgrounds/ (main/backgrounds.ts and
// src-tauri services/backgrounds.rs), named by a hash of its bytes, so the
// original can move or be deleted. Settings keep only that file name.

/** Panel kinds whose own background can be made see-through. */
export const PANEL_BG_KINDS = ['terminal', 'editor', 'chat'] as const
export type PanelBgKind = (typeof PANEL_BG_KINDS)[number]

/** 'app': one image behind the whole dock. 'panels': an image in each chosen panel kind. */
export type PanelBgScope = 'app' | 'panels'

/**
 * How the image is sized in its area (the whole dock, or each panel):
 * 'cover' fills it (cropping), 'contain' shows all of it, 'size' is a width
 * picked as a share of the area's width, 'tile' repeats it at that width.
 * The aspect ratio is always kept.
 */
export const PANEL_BG_FITS = ['cover', 'contain', 'size', 'tile'] as const
export type PanelBgFit = (typeof PANEL_BG_FITS)[number]

export interface PanelBgSettings {
  /** File name in userData/backgrounds, '' = no background (the default). */
  panelBgImage: string
  /** How strongly the image shows through the theme tint, 0.05..1. */
  panelBgOpacity: number
  /** Blur radius in CSS px, 0..MAX_BLUR. */
  panelBgBlur: number
  panelBgScope: PanelBgScope
  /** The panel kinds that show it when the scope is 'panels'. */
  panelBgKinds: PanelBgKind[]
  panelBgFit: PanelBgFit
  /** Image (or tile) width as % of the area's width, MIN_SIZE..MAX_SIZE; 'size' and 'tile' only. */
  panelBgSize: number
  /**
   * Position, 0..100 on each axis, read like CSS background-position %: that
   * point of the image sits on the same point of the area (0 0 = top left
   * corners together, 50 50 = centred). Relative, so it follows panel size.
   */
  panelBgX: number
  panelBgY: number
}

export const PANEL_BG_DEFAULTS: PanelBgSettings = {
  panelBgImage: '',
  panelBgOpacity: 0.3,
  panelBgBlur: 0,
  panelBgScope: 'app',
  panelBgKinds: ['terminal', 'editor', 'chat'],
  // Cover, centred: exactly what the first version always drew.
  panelBgFit: 'cover',
  panelBgSize: 40,
  panelBgX: 50,
  panelBgY: 50
}

export const MIN_OPACITY = 0.05
export const MAX_BLUR = 40
export const MIN_SIZE = 5
export const MAX_SIZE = 150

/**
 * The names the main process hands out: "bg-" + 16 hex of the content hash +
 * an image extension. Anything else is not ours and is not served.
 */
export const BG_NAME_RE = /^bg-[0-9a-f]{16}\.(png|jpg|gif|webp|avif|bmp)$/

export function isBgName(v: unknown): v is string {
  return typeof v === 'string' && BG_NAME_RE.test(v)
}

/** One decimal: fine enough for a drag, and a stable string for the CSS. */
export const round1 = (v: number): number => Math.round(v * 10) / 10

const clamp = (v: unknown, lo: number, hi: number, dflt: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt

/**
 * Any saved (or synced, or hand-edited) values -> a valid set. Unknown or
 * broken values fall back to the defaults, which means "off".
 */
export function sanitizePanelBg(s: Partial<Record<keyof PanelBgSettings, unknown>>): PanelBgSettings {
  const kinds = Array.isArray(s.panelBgKinds)
    ? PANEL_BG_KINDS.filter((k) => (s.panelBgKinds as unknown[]).includes(k))
    : PANEL_BG_DEFAULTS.panelBgKinds
  return {
    panelBgImage: isBgName(s.panelBgImage) ? s.panelBgImage : '',
    panelBgOpacity: clamp(s.panelBgOpacity, MIN_OPACITY, 1, PANEL_BG_DEFAULTS.panelBgOpacity),
    panelBgBlur: Math.round(clamp(s.panelBgBlur, 0, MAX_BLUR, PANEL_BG_DEFAULTS.panelBgBlur)),
    panelBgScope: s.panelBgScope === 'panels' ? 'panels' : 'app',
    panelBgKinds: kinds,
    panelBgFit: (PANEL_BG_FITS as readonly unknown[]).includes(s.panelBgFit)
      ? (s.panelBgFit as PanelBgFit)
      : PANEL_BG_DEFAULTS.panelBgFit,
    panelBgSize: round1(clamp(s.panelBgSize, MIN_SIZE, MAX_SIZE, PANEL_BG_DEFAULTS.panelBgSize)),
    panelBgX: round1(clamp(s.panelBgX, 0, 100, PANEL_BG_DEFAULTS.panelBgX)),
    panelBgY: round1(clamp(s.panelBgY, 0, 100, PANEL_BG_DEFAULTS.panelBgY))
  }
}

export function samePanelBg(a: PanelBgSettings, b: PanelBgSettings): boolean {
  return (
    a.panelBgImage === b.panelBgImage &&
    a.panelBgOpacity === b.panelBgOpacity &&
    a.panelBgBlur === b.panelBgBlur &&
    a.panelBgScope === b.panelBgScope &&
    a.panelBgFit === b.panelBgFit &&
    a.panelBgSize === b.panelBgSize &&
    a.panelBgX === b.panelBgX &&
    a.panelBgY === b.panelBgY &&
    Array.isArray(a.panelBgKinds) &&
    Array.isArray(b.panelBgKinds) &&
    a.panelBgKinds.length === b.panelBgKinds.length &&
    a.panelBgKinds.every((k, i) => b.panelBgKinds[i] === k)
  )
}

/**
 * Does a panel of this kind see through to an image? In 'app' scope every
 * supported kind does (the image sits behind the dock); in 'panels' scope only
 * the chosen kinds (each draws its own copy).
 */
export function bgActiveFor(s: PanelBgSettings, kind: string): boolean {
  if (!isBgName(s.panelBgImage)) return false
  if (!(PANEL_BG_KINDS as readonly string[]).includes(kind)) return false
  return s.panelBgScope === 'app' || s.panelBgKinds.includes(kind as PanelBgKind)
}

/** What lib/panelBackground puts on <html>: attributes + CSS custom properties. */
export interface PanelBgView {
  /** null: no image anywhere, every attribute and property is removed. */
  image: string | null
  /** data-pbg-app: one layer behind the whole dock. */
  app: boolean
  /** data-pbg: the kinds that draw their own layer (space separated in the DOM). */
  kinds: PanelBgKind[]
  /** --pbg-tint: opacity of the theme-coloured tint over the image. */
  tint: number
  /** --pbg-filter: 'none' or 'blur(Npx)'. */
  filter: string
  /** --pbg-size: background-size ('cover', 'contain' or '<n>% auto'). */
  size: string
  /** --pbg-pos: background-position ('<x>% <y>%'). */
  pos: string
  /** --pbg-repeat: background-repeat. */
  repeat: 'no-repeat' | 'repeat'
  /**
   * --pbg-origin: background-origin. The image layer is overscanned by the
   * blur margin; 'cover' keeps sizing against that larger box (the first
   * version's look), the rest size and place against the visible area itself
   * (content-box), so 0% really is the panel's edge.
   */
  origin: 'border-box' | 'content-box'
}

/** The CSS background-size/position/repeat/origin for a placement. */
export function placementCss(
  s: Pick<PanelBgSettings, 'panelBgFit' | 'panelBgSize' | 'panelBgX' | 'panelBgY'>
): Pick<PanelBgView, 'size' | 'pos' | 'repeat' | 'origin'> {
  const fit = s.panelBgFit
  return {
    size: fit === 'cover' || fit === 'contain' ? fit : `${s.panelBgSize}% auto`,
    pos: `${s.panelBgX}% ${s.panelBgY}%`,
    repeat: fit === 'tile' ? 'repeat' : 'no-repeat',
    origin: fit === 'cover' ? 'border-box' : 'content-box'
  }
}

/** 3x3 anchors, row by row from the top left, as background-position %. */
export const PANEL_BG_ANCHORS: ReadonlyArray<readonly [number, number]> = [0, 50, 100].flatMap((y) =>
  [0, 50, 100].map((x) => [x, y] as const)
)

/**
 * The drawn image size (px) in an area of w x h for an image of iw x ih, so a
 * drag can be turned into a position change. Mirrors background-size.
 */
export function drawnSize(
  fit: PanelBgFit,
  sizePct: number,
  w: number,
  h: number,
  iw: number,
  ih: number
): { w: number; h: number } {
  if (!(iw > 0 && ih > 0)) return { w, h }
  if (fit === 'cover' || fit === 'contain') {
    const k = fit === 'cover' ? Math.max(w / iw, h / ih) : Math.min(w / iw, h / ih)
    return { w: iw * k, h: ih * k }
  }
  const dw = (w * sizePct) / 100
  return { w: dw, h: (dw * ih) / iw }
}

/**
 * Moving the image by dx px on an axis where the area is `area` px and the
 * image `img` px: the position % change that does it. background-position %
 * moves the image by (area - img) * pct / 100, so an image larger than the
 * area moves the other way per % (the sign takes care of it), and one the
 * exact size of the area cannot move at all.
 */
export function dragDelta(dx: number, area: number, img: number): number {
  const free = area - img
  return Math.abs(free) < 1 ? 0 : (dx / free) * 100
}

export function clampPos(v: number): number {
  return round1(Math.min(100, Math.max(0, v)))
}

export function panelBgView(s: PanelBgSettings): PanelBgView {
  const c = sanitizePanelBg(s)
  if (!c.panelBgImage || (c.panelBgScope === 'panels' && !c.panelBgKinds.length))
    return { image: null, app: false, kinds: [], tint: 1, filter: 'none', ...placementCss(PANEL_BG_DEFAULTS) }
  return {
    ...placementCss(c),
    image: c.panelBgImage,
    app: c.panelBgScope === 'app',
    kinds: c.panelBgScope === 'panels' ? c.panelBgKinds : [],
    // Rounded so the property string is stable (no re-style for 0.30000000004).
    tint: Math.round((1 - c.panelBgOpacity) * 100) / 100,
    filter: c.panelBgBlur > 0 ? `blur(${c.panelBgBlur}px)` : 'none'
  }
}
