// Panel background images: the pure half (shapes, validation, resolution,
// legacy migration and which stored files are still in use). No DOM and no
// window here, so it runs in plain-node unit tests; lib/panelBackground.ts and
// dock/PanelBgHost.tsx apply the result to the page.
//
// Two levels, resolved per panel:
//   1. a default per panel kind, in settings (Settings.panelBgs)
//   2. an override per panel, in that pane's state in sessions.json
//      (PaneState.bg): a background of its own, or 'none'
// The panel's own override wins, then its kind's default, then nothing.
//
// Each image is a copy in userData/backgrounds/ (main/backgrounds.ts and
// src-tauri services/backgrounds.rs), named by a hash of its bytes, so the
// original can move or be deleted. Settings and panes keep only that file name;
// files nothing refers to any more are removed (referencedBackgrounds + the
// main process's background:gc).

/**
 * The dock's panel kinds (Workbench's components) that can have a background.
 * The launcher is left out: it is a one-off picker that replaces itself.
 */
export const PANEL_BG_KINDS = [
  'terminal',
  'editor',
  'chat',
  'preview',
  'notes',
  'db',
  'api',
  'git',
  'search',
  'explorer',
  'agentgroup',
  'scheduler',
  'prdiff',
  'assistant'
] as const
export type PanelBgKind = (typeof PANEL_BG_KINDS)[number]

export function isBgKind(v: unknown): v is PanelBgKind {
  return typeof v === 'string' && (PANEL_BG_KINDS as readonly string[]).includes(v)
}

/** The i18n key naming each kind (the panel titles riven already uses). */
export const PANEL_BG_KIND_LABEL: Record<PanelBgKind, string> = {
  terminal: 'title.terminal',
  editor: 'title.editor',
  chat: 'title.chat',
  preview: 'title.preview',
  notes: 'title.notes',
  db: 'title.db',
  api: 'title.api',
  git: 'title.git',
  search: 'title.search',
  explorer: 'title.explorer',
  agentgroup: 'title.agentgroup',
  scheduler: 'title.scheduler',
  prdiff: 'title.prdiff',
  assistant: 'title.assistant'
}

/**
 * How the image is sized in its panel: 'cover' fills it (cropping), 'contain'
 * shows all of it, 'size' is a width picked as a share of the panel's width,
 * 'tile' repeats it at that width. The aspect ratio is always kept.
 */
export const PANEL_BG_FITS = ['cover', 'contain', 'size', 'tile'] as const
export type PanelBgFit = (typeof PANEL_BG_FITS)[number]

/** One background: an image and how it is drawn. */
export interface PanelBg {
  /** File name in userData/backgrounds (always a valid name once stored). */
  image: string
  /** How strongly the image shows through the theme tint, MIN_OPACITY..1. */
  opacity: number
  /** Blur radius in CSS px, 0..MAX_BLUR. */
  blur: number
  fit: PanelBgFit
  /** Image (or tile) width as % of the panel's width, MIN_SIZE..MAX_SIZE; 'size' and 'tile' only. */
  size: number
  /**
   * Position, 0..100 on each axis, read like CSS background-position %: that
   * point of the image sits on the same point of the panel (0 0 = top left
   * corners together, 50 50 = centred). Relative, so it follows panel size.
   */
  x: number
  y: number
}

/** Settings.panelBgs: the default background of each kind that has one. */
export type PanelBgKinds = Partial<Record<PanelBgKind, PanelBg>>

/**
 * PaneState.bg: absent = use the kind's default, 'none' = no background in
 * this panel even when its kind has one, an object = this panel's own.
 */
export type PaneBg = PanelBg | 'none'

/** What a new background starts as before the image is picked. Cover, centred. */
export const PANEL_BG_LOOK: Omit<PanelBg, 'image'> = {
  opacity: 0.3,
  blur: 0,
  fit: 'cover',
  size: 40,
  x: 50,
  y: 50
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

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * Any saved (or hand-edited) value -> a valid background, or null when it has
 * no usable image. Broken numbers fall back to the defaults or are clamped.
 */
export function sanitizeBg(v: unknown): PanelBg | null {
  if (!isObj(v) || !isBgName(v.image)) return null
  const d = PANEL_BG_LOOK
  return {
    image: v.image,
    opacity: clamp(v.opacity, MIN_OPACITY, 1, d.opacity),
    blur: Math.round(clamp(v.blur, 0, MAX_BLUR, d.blur)),
    fit: (PANEL_BG_FITS as readonly unknown[]).includes(v.fit) ? (v.fit as PanelBgFit) : d.fit,
    size: round1(clamp(v.size, MIN_SIZE, MAX_SIZE, d.size)),
    x: round1(clamp(v.x, 0, 100, d.x)),
    y: round1(clamp(v.y, 0, 100, d.y))
  }
}

/** Settings.panelBgs as saved -> only known kinds with a usable background. */
export function sanitizeKindBgs(v: unknown): PanelBgKinds {
  const out: PanelBgKinds = {}
  if (!isObj(v)) return out
  for (const k of PANEL_BG_KINDS) {
    const bg = sanitizeBg(v[k])
    if (bg) out[k] = bg
  }
  return out
}

/** PaneState.bg as saved -> a valid value, undefined (= kind default) for anything else. */
export function sanitizePaneBg(v: unknown): PaneBg | undefined {
  if (v === 'none') return 'none'
  return sanitizeBg(v) ?? undefined
}

export function sameBg(a: PanelBg | null | undefined, b: PanelBg | null | undefined): boolean {
  if (!a || !b) return !a && !b
  return (
    a.image === b.image &&
    a.opacity === b.opacity &&
    a.blur === b.blur &&
    a.fit === b.fit &&
    a.size === b.size &&
    a.x === b.x &&
    a.y === b.y
  )
}

export function sameKindBgs(a: PanelBgKinds, b: PanelBgKinds): boolean {
  return PANEL_BG_KINDS.every((k) => sameBg(a[k], b[k]))
}

/** The kinds map with one kind's default replaced (null removes it). */
export function withKindBg(kinds: PanelBgKinds, kind: PanelBgKind, bg: PanelBg | null): PanelBgKinds {
  const next = { ...kinds }
  if (bg) next[kind] = bg
  else delete next[kind]
  return next
}

/**
 * The background a panel shows: its own override, else its kind's default,
 * else none. Everything is sanitized on the way, so a broken value in either
 * place means "none" rather than something unexpected in the CSS.
 */
export function resolveBg(kinds: PanelBgKinds | undefined, kind: string, pane: unknown): PanelBg | null {
  const own = sanitizePaneBg(pane)
  if (own === 'none') return null
  if (own) return own
  if (!isBgKind(kind)) return null
  return sanitizeBg(kinds?.[kind])
}

/** The CSS custom properties PanelBgHost puts on a panel's .pbg-host. */
export interface PanelBgVars {
  /** --pbg-image: url() of the stored copy. */
  '--pbg-image': string
  /** --pbg-tint: opacity of the theme-coloured tint over the image. */
  '--pbg-tint': string
  /** --pbg-filter: 'none' or 'blur(Npx)'. */
  '--pbg-filter': string
  /** --pbg-size: background-size ('cover', 'contain' or '<n>% auto'). */
  '--pbg-size': string
  /** --pbg-pos: background-position ('<x>% <y>%'). */
  '--pbg-pos': string
  /** --pbg-repeat: background-repeat. */
  '--pbg-repeat': string
  /**
   * --pbg-origin: background-origin. The image layer is overscanned by the
   * blur margin; 'cover' keeps sizing against that larger box (the first
   * version's look), the rest size and place against the visible area itself
   * (content-box), so 0% really is the panel's edge.
   */
  '--pbg-origin': string
}

/** The CSS background-size/position/repeat/origin for a placement. */
export function placementCss(s: Pick<PanelBg, 'fit' | 'size' | 'x' | 'y'>): {
  size: string
  pos: string
  repeat: 'no-repeat' | 'repeat'
  origin: 'border-box' | 'content-box'
} {
  const fit = s.fit
  return {
    size: fit === 'cover' || fit === 'contain' ? fit : `${s.size}% auto`,
    pos: `${s.x}% ${s.y}%`,
    repeat: fit === 'tile' ? 'repeat' : 'no-repeat',
    origin: fit === 'cover' ? 'border-box' : 'content-box'
  }
}

/** A background -> its CSS variables; `url` turns the stored name into a page URL. */
export function bgVars(bg: PanelBg, url: (name: string) => string): PanelBgVars {
  const p = placementCss(bg)
  return {
    '--pbg-image': `url("${url(bg.image)}")`,
    // Rounded so the property string is stable (no re-style for 0.30000000004).
    '--pbg-tint': String(Math.round((1 - bg.opacity) * 100) / 100),
    '--pbg-filter': bg.blur > 0 ? `blur(${bg.blur}px)` : 'none',
    '--pbg-size': p.size,
    '--pbg-pos': p.pos,
    '--pbg-repeat': p.repeat,
    '--pbg-origin': p.origin
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

// ---- the first version's single, app-wide setting ---------------------------

/** settings.json keys of the single background (2b37940, a863c2c). Dropped on load. */
export const LEGACY_BG_KEYS = [
  'panelBgImage',
  'panelBgOpacity',
  'panelBgBlur',
  'panelBgScope',
  'panelBgKinds',
  'panelBgFit',
  'panelBgSize',
  'panelBgX',
  'panelBgY'
] as const

/**
 * The kinds that showed the single image. 'app' scope drew it behind the
 * whole dock with these kinds made see-through (every other panel kept its own
 * background and covered it); 'panels' scope drew it in the chosen ones.
 */
const LEGACY_KINDS: readonly PanelBgKind[] = ['terminal', 'editor', 'chat']

/**
 * Settings as loaded (or pulled from the cloud) -> the same with the old
 * single background turned into kind defaults and its keys removed.
 *
 * Only a valid stored image converts, into each kind that showed it and has no
 * default of its own yet (so running it twice, or on a cloud row an older
 * build wrote, never overwrites a newer choice). The look carries over as it
 * was: fit, size, position, opacity, blur. Returns the input object itself when
 * there is nothing to do.
 */
export function migrateLegacyBg<T extends Record<string, unknown>>(s: T): T {
  if (!LEGACY_BG_KEYS.some((k) => k in s)) return s
  const out: Record<string, unknown> = { ...s }
  for (const k of LEGACY_BG_KEYS) delete out[k]
  const bg = sanitizeBg({
    image: s.panelBgImage,
    opacity: s.panelBgOpacity,
    blur: s.panelBgBlur,
    fit: s.panelBgFit,
    size: s.panelBgSize,
    x: s.panelBgX,
    y: s.panelBgY
  })
  if (bg) {
    // The old default scope was 'app'; anything but 'panels' read as it.
    const kinds =
      s.panelBgScope === 'panels'
        ? Array.isArray(s.panelBgKinds)
          ? LEGACY_KINDS.filter((k) => (s.panelBgKinds as unknown[]).includes(k))
          : LEGACY_KINDS
        : LEGACY_KINDS
    const map = sanitizeKindBgs(s.panelBgs)
    for (const k of kinds) if (!map[k]) map[k] = { ...bg }
    out.panelBgs = map
  }
  return out as T
}

// ---- which stored files are in use ------------------------------------------

/** The slice of a saved session the reference scan reads (state/session's Session). */
export interface BgSessionLike {
  /** Pane id -> pane state; only its `bg` is read. */
  panes?: Record<string, unknown>
}

/**
 * Every stored background some setting or saved pane still names: the kind
 * defaults and the override of every pane in every workspace's session (the
 * ones on screen and the ones only in a saved layout alike). Anything not in
 * here may be deleted, so this reads the raw values and keeps any valid file
 * name it finds, even in an entry that is otherwise broken.
 */
export function referencedBackgrounds(kinds: unknown, sessions: Record<string, BgSessionLike | null | undefined>): string[] {
  const names = new Set<string>()
  const take = (v: unknown): void => {
    if (isObj(v) && isBgName(v.image)) names.add(v.image)
  }
  if (isObj(kinds)) for (const v of Object.values(kinds)) take(v)
  for (const s of Object.values(sessions ?? {})) {
    if (!isObj(s) || !isObj(s.panes)) continue
    for (const p of Object.values(s.panes)) if (isObj(p)) take(p.bg)
  }
  return [...names].sort()
}
