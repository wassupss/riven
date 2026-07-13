import { setShikiTheme } from '../editor/highlight'

// Color theme sets. Each provides only the tokens that differ from the default
// (ember) :root palette; applyTheme resets managed tokens then applies overrides.
export interface Theme {
  id: string
  name: string
  shiki: string
  swatch: string
  tokens: Record<string, string>
}

export const THEMES: Theme[] = [
  { id: 'ember', name: 'Ember', shiki: 'vesper', swatch: '#ff6b3d', tokens: {} },
  {
    id: 'glacial',
    name: 'Glacial',
    shiki: 'night-owl',
    swatch: '#3ec5b7',
    tokens: {
      accent: '#3ec5b7',
      'accent-2': '#6ea8ff',
      success: '#5cbe6e',
      bg: '#14181c',
      'bg-2': '#1a1f25',
      'bg-3': '#232a31',
      border: '#2c343c'
    }
  },
  {
    id: 'gold',
    name: 'Gold',
    shiki: 'kanagawa-wave',
    swatch: '#e5b455',
    tokens: { accent: '#e5b455', 'accent-2': '#9d8cff', warning: '#c98a2e' }
  },
  {
    id: 'rose',
    name: 'Rose',
    shiki: 'houston',
    swatch: '#f0596e',
    tokens: { accent: '#f0596e', 'accent-2': '#b98cff' }
  },
  {
    id: 'slate',
    name: 'Slate',
    shiki: 'dark-plus',
    swatch: '#4c82c4',
    tokens: {
      accent: '#4c82c4',
      'accent-2': '#9d8cff',
      bg: '#1a1d21',
      'bg-2': '#212429',
      'bg-3': '#2a2e34',
      border: '#343a42'
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
  setShikiTheme(t.shiki)
}
