import { setShikiTheme } from '../editor/highlight'

// Color theme sets for the "obsidian workbench" system. Each theme provides
// only the primitive tokens that differ from the default (ember) :root palette
// in styles.css; applyTheme resets managed tokens then applies overrides.
//
// Rules every theme follows:
// - --bg sits in the near-black obsidian range (~#0e0f11–#121417); --bg-2/--bg-3
//   layer just above it. Hairlines/edges are white-alpha in shared CSS — themes
//   never set them.
// - Identity comes from the accent plus a subtle hue cast in the ink (bg/fg).
// - --fg on --bg clears ~7:1 contrast; --accent on --bg clears ~4.5:1
//   (all verified: fg 14.7–18:1, accents 5.6–17:1).
// - --accent-2 is the agent/AI affordance — violet by default, shifted per
//   theme when the accent itself is violet-adjacent.
// - shiki must be one of the pre-loaded highlighter themes in
//   editor/highlight.ts: vesper, night-owl, kanagawa-wave, houston, dark-plus
//   (dark) / github-light, solarized-light (light).
// - mode drives the alpha-derived system tokens (hairlines, edges, hover,
//   lift, elevation, glass, scrollbars): applyTheme stamps it on
//   <html data-theme-mode>, and styles.css flips white-alpha → black-alpha
//   under :root[data-theme-mode='light']. Omitted mode means 'dark'.
// - Light themes must override ALL 12 primitives (the :root defaults are the
//   dark ember palette) and keep --fg on --bg ≥ ~7:1, accents ≥ ~4.5:1.
export interface Theme {
  id: string
  name: string
  shiki: string
  swatch: string
  mode?: 'dark' | 'light' // default 'dark'
  tokens: Record<string, string>
}

export const THEMES: Theme[] = [
  // -- ember: the default. Empty tokens = the :root palette itself. --------
  { id: 'ember', name: 'Ember', shiki: 'vesper', swatch: '#ff7847', tokens: {} },

  // -- glacial: cold teal ink, mint filament --------------------------------
  {
    id: 'glacial',
    name: 'Glacial',
    shiki: 'night-owl',
    swatch: '#3ec5b7',
    tokens: {
      bg: '#0e1214',
      'bg-2': '#14191c',
      'bg-3': '#1c2327',
      border: '#242c30',
      fg: '#e1e7e8',
      'fg-dim': '#839396',
      accent: '#3ec5b7',
      'accent-2': '#6ea8ff'
    }
  },

  // -- gold: warm parchment ink, brass filament -----------------------------
  {
    id: 'gold',
    name: 'Gold',
    shiki: 'kanagawa-wave',
    swatch: '#e5b455',
    tokens: {
      bg: '#121110',
      'bg-2': '#181613',
      'bg-3': '#201d18',
      border: '#2a2620',
      fg: '#e7e3da',
      'fg-dim': '#948c7c',
      accent: '#e5b455',
      'accent-2': '#9d8cff',
      warning: '#c9862e' // deeper than the accent so warnings stay legible
    }
  },

  // -- rose: faint plum ink, hot rose filament ------------------------------
  {
    id: 'rose',
    name: 'Rose',
    shiki: 'houston',
    swatch: '#f0596e',
    tokens: {
      bg: '#121012',
      'bg-2': '#181518',
      'bg-3': '#201c20',
      border: '#2a252a',
      fg: '#e8e2e5',
      'fg-dim': '#93888e',
      accent: '#f0596e',
      'accent-2': '#b98cff',
      danger: '#e8493a' // pushed orange-red so it never reads as the accent
    }
  },

  // -- slate: cool blue-gray ink, steel-blue filament ------------------------
  {
    id: 'slate',
    name: 'Slate',
    shiki: 'dark-plus',
    swatch: '#5b8fd0',
    tokens: {
      bg: '#0f1114',
      'bg-2': '#14171b',
      'bg-3': '#1c2026',
      border: '#262b32',
      fg: '#e2e5ea',
      'fg-dim': '#848c99',
      accent: '#5b8fd0',
      'accent-2': '#9d8cff'
    }
  },

  // -- graphite: dead-neutral ink, Linear-register indigo filament -----------
  {
    id: 'graphite',
    name: 'Graphite',
    shiki: 'dark-plus',
    swatch: '#7c86e8',
    tokens: {
      bg: '#111113',
      'bg-2': '#171719',
      'bg-3': '#1f1f22',
      border: '#29292d',
      fg: '#e4e4e7',
      'fg-dim': '#8a8a92',
      accent: '#7c86e8',
      'accent-2': '#a18fff'
    }
  },

  // -- abyss: deep ocean-blue ink, electric cyan filament ---------------------
  {
    id: 'abyss',
    name: 'Abyss',
    shiki: 'night-owl',
    swatch: '#35c0e8',
    tokens: {
      bg: '#0d1217',
      'bg-2': '#12181e',
      'bg-3': '#192129',
      border: '#222c36',
      fg: '#dfe7ec',
      'fg-dim': '#7e909c',
      accent: '#35c0e8',
      'accent-2': '#8f9dff',
      info: '#7cc4f5' // lifted above the accent band
    }
  },

  // -- iris: violet-cast ink, violet filament; agent affordance shifts cyan ---
  {
    id: 'iris',
    name: 'Iris',
    shiki: 'houston',
    swatch: '#a48fff',
    tokens: {
      bg: '#100f15',
      'bg-2': '#16151d',
      'bg-3': '#1e1c26',
      border: '#282631',
      fg: '#e5e3ee',
      'fg-dim': '#8b8898',
      accent: '#a48fff',
      'accent-2': '#6ec6ff' // accent is violet, so the agent goes cool cyan
    }
  },

  // -- fern: forest ink, leaf-green filament ----------------------------------
  {
    id: 'fern',
    name: 'Fern',
    shiki: 'kanagawa-wave',
    swatch: '#58c07a',
    tokens: {
      bg: '#0e1310',
      'bg-2': '#131a16',
      'bg-3': '#1b241e',
      border: '#253028',
      fg: '#e0e7e1',
      'fg-dim': '#83948a',
      accent: '#58c07a',
      'accent-2': '#a18fff',
      success: '#7fd0a8' // lighter mint so success chips differ from the accent
    }
  },

  // -- orchid: plum ink, magenta-orchid filament -------------------------------
  {
    id: 'orchid',
    name: 'Orchid',
    shiki: 'houston',
    swatch: '#d678db',
    tokens: {
      bg: '#130f13',
      'bg-2': '#1a151a',
      'bg-3': '#231c23',
      border: '#2e252e',
      fg: '#e9e2e9',
      'fg-dim': '#968a96',
      accent: '#d678db',
      'accent-2': '#9d8cff'
    }
  },

  // -- void: near-pure black, monochrome white filament (max contrast) ---------
  {
    id: 'void',
    name: 'Void',
    shiki: 'dark-plus',
    swatch: '#eef0f3',
    tokens: {
      bg: '#0a0a0c',
      'bg-2': '#0f0f12',
      'bg-3': '#161619',
      border: '#232327',
      fg: '#f4f4f6',
      'fg-dim': '#9a9aa3',
      accent: '#eef0f3',
      'accent-2': '#a18fff'
    }
  },

  // ==== light themes — every primitive overridden; mode flips the alpha
  // ==== system (hairlines/edges/hover/lift/elevation) to black-alpha.
  // ==== Contrast verified: fg 12.1–14.8:1, accents/semantics 4.5–5.5:1 on bg.

  // -- paper: warm off-white stock, burnt-ember filament (light ember) --------
  {
    id: 'paper',
    name: 'Paper',
    shiki: 'github-light',
    swatch: '#b8430a',
    mode: 'light',
    tokens: {
      bg: '#faf9f5', // warm paper canvas
      'bg-2': '#f2f0e9',
      'bg-3': '#e9e6dc',
      border: '#dbd6c8',
      fg: '#2b2822', // warm near-black ink (13.9:1)
      'fg-dim': '#6e675a',
      accent: '#b8430a', // burnt ember (5.2:1)
      'accent-2': '#6d4fd0', // agent violet, darkened for light (5.4:1)
      success: '#1d7a45',
      warning: '#8f6400',
      danger: '#bc3423',
      info: '#0f6cad'
    }
  },

  // -- daylight: cool neutral white, work-blue filament ------------------------
  {
    id: 'daylight',
    name: 'Daylight',
    shiki: 'github-light',
    swatch: '#0969da',
    mode: 'light',
    tokens: {
      bg: '#f6f8fa', // cool white canvas
      'bg-2': '#eceff3',
      'bg-3': '#e2e6ec',
      border: '#d0d7de',
      fg: '#1f2328', // cool near-black (14.8:1)
      'fg-dim': '#59626d',
      accent: '#0969da', // clear work-blue (4.9:1)
      'accent-2': '#7a3ee8', // agent violet (5.4:1)
      success: '#1a7f37',
      warning: '#9a6700',
      danger: '#cf222e',
      info: '#0b7285'
    }
  },

  // -- solarized-light: the classic cream lab bench, deepened blue filament ----
  {
    id: 'solarized-light',
    name: 'Solarized Light',
    shiki: 'solarized-light',
    swatch: '#17699f',
    mode: 'light',
    tokens: {
      bg: '#fdf6e3', // solarized base3
      'bg-2': '#f3ecd7',
      'bg-3': '#eae2ca',
      border: '#d8cfb2',
      fg: '#073642', // solarized base02 (12.1:1)
      'fg-dim': '#5c727c', // base00 deepened to clear 4.5:1
      accent: '#17699f', // solarized blue deepened from #268bd2 (5.5:1)
      'accent-2': '#5c62c0', // solarized violet deepened (4.9:1)
      success: '#5c7a00', // solarized green deepened
      warning: '#8f6c00', // solarized yellow deepened
      danger: '#c22f2c', // solarized red deepened
      info: '#17699f'
    }
  }
]

const MANAGED = [
  'bg',
  'bg-2',
  'bg-3',
  'border',
  'fg',
  'fg-dim',
  'accent',
  'accent-2',
  'success',
  'warning',
  'danger',
  'info'
]

export function applyTheme(id: string): void {
  const t = THEMES.find((x) => x.id === id) ?? THEMES[0]
  const root = document.documentElement
  MANAGED.forEach((p) => root.style.removeProperty('--' + p))
  Object.entries(t.tokens).forEach(([k, v]) => root.style.setProperty('--' + k, v))
  // Flips the alpha-derived system tokens (hairline/edge/hover/lift/elevation/
  // glass/scrollbar) between white-alpha and black-alpha in styles.css.
  root.dataset.themeMode = t.mode ?? 'dark'
  setShikiTheme(t.shiki)
}
