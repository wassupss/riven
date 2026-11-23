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
}

export const PANEL_BG_DEFAULTS: PanelBgSettings = {
  panelBgImage: '',
  panelBgOpacity: 0.3,
  panelBgBlur: 0,
  panelBgScope: 'app',
  panelBgKinds: ['terminal', 'editor', 'chat']
}

export const MIN_OPACITY = 0.05
export const MAX_BLUR = 40

/**
 * The names the main process hands out: "bg-" + 16 hex of the content hash +
 * an image extension. Anything else is not ours and is not served.
 */
export const BG_NAME_RE = /^bg-[0-9a-f]{16}\.(png|jpg|gif|webp|avif|bmp)$/

export function isBgName(v: unknown): v is string {
  return typeof v === 'string' && BG_NAME_RE.test(v)
}

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
    panelBgKinds: kinds
  }
}

export function samePanelBg(a: PanelBgSettings, b: PanelBgSettings): boolean {
  return (
    a.panelBgImage === b.panelBgImage &&
    a.panelBgOpacity === b.panelBgOpacity &&
    a.panelBgBlur === b.panelBgBlur &&
    a.panelBgScope === b.panelBgScope &&
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
}

export function panelBgView(s: PanelBgSettings): PanelBgView {
  const c = sanitizePanelBg(s)
  if (!c.panelBgImage || (c.panelBgScope === 'panels' && !c.panelBgKinds.length))
    return { image: null, app: false, kinds: [], tint: 1, filter: 'none' }
  return {
    image: c.panelBgImage,
    app: c.panelBgScope === 'app',
    kinds: c.panelBgScope === 'panels' ? c.panelBgKinds : [],
    // Rounded so the property string is stable (no re-style for 0.30000000004).
    tint: Math.round((1 - c.panelBgOpacity) * 100) / 100,
    filter: c.panelBgBlur > 0 ? `blur(${c.panelBgBlur}px)` : 'none'
  }
}
