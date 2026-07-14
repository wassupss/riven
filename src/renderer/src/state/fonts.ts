import { getSettings } from './settings'

// Curated monospace fonts offered in the font picker. The user's machine may not
// have all of them; the CSS stack falls back gracefully.
export const CURATED_FONTS = [
  'SF Mono',
  'Menlo',
  'Monaco',
  'JetBrains Mono',
  'Fira Code',
  'Cascadia Code',
  'Source Code Pro',
  'IBM Plex Mono',
  'Hack',
  'Roboto Mono',
  'MesloLGS NF',
  'Consolas'
]

const injected = new Set<string>()

// Register an imported font file (data URL) as an @font-face so it's usable.
export function injectFont(family: string, dataUrl: string): void {
  if (injected.has(family)) return
  injected.add(family)
  const style = document.createElement('style')
  style.textContent = `@font-face { font-family: "${family}"; src: url(${dataUrl}); font-display: swap; }`
  document.head.appendChild(style)
}

// Re-inject all previously imported fonts on boot.
export function injectImportedFonts(): void {
  for (const f of getSettings().importedFonts) injectFont(f.family, f.dataUrl)
}
