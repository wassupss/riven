import { User, UserRound, Users, Brain, Bot, PersonStanding, type LucideIcon } from 'lucide-react'

// Deterministic agent avatar (mirrors native AgentAvatar): a person glyph + a hue
// picked from an FNV-1a hash of the agent's name, so the same key yields the same
// face everywhere it appears (org chart, dock tab). A user-picked override wins,
// stored as an "glyph.color" index pair (e.g. "3.7") so it survives list changes.

const HUES = [0.02, 0.08, 0.12, 0.28, 0.38, 0.46, 0.53, 0.6, 0.68, 0.75, 0.83, 0.92]
const ICONS: LucideIcon[] = [User, UserRound, Users, Brain, Bot, PersonStanding]

export const AVATAR_GLYPH_COUNT = ICONS.length
export const AVATAR_COLOR_COUNT = HUES.length

function mod(n: number, m: number): number {
  return ((n % m) + m) % m
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.toLowerCase().charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

export function hueColor(i: number): string {
  return `hsl(${Math.round(HUES[mod(i, HUES.length)] * 360)} 60% 55%)`
}
// A bright, high-contrast version of the hue for text on a tinted surface.
export function hueText(i: number): string {
  return `hsl(${Math.round(HUES[mod(i, HUES.length)] * 360)} 85% 78%)`
}

export function glyphIcon(i: number): LucideIcon {
  return ICONS[mod(i, ICONS.length)]
}

export function encodeAvatar(glyph: number, color: number): string {
  return `${glyph}.${color}`
}

export function decodeAvatar(s?: string | null): { glyph: number; color: number } | null {
  if (!s) return null
  const parts = s.split('.')
  if (parts.length !== 2) return null
  const g = Number(parts[0])
  const c = Number(parts[1])
  if (!Number.isInteger(g) || !Number.isInteger(c)) return null
  if (g < 0 || g >= ICONS.length || c < 0 || c >= HUES.length) return null
  return { glyph: g, color: c }
}

// The active (glyph, color) for a name — the user override if set, else the hash.
export function avatarSpec(name: string, override?: string | null): { glyph: number; color: number } {
  const d = decodeAvatar(override)
  if (d) return d
  const h = fnv1a(name || '?')
  return { glyph: h % ICONS.length, color: Math.floor(h / 8) % HUES.length }
}

export function avatarFor(name: string, override?: string | null): { color: string; Icon: LucideIcon } {
  const { glyph, color } = avatarSpec(name, override)
  return { color: hueColor(color), Icon: glyphIcon(glyph) }
}

// Sentinel override meaning "no colour" (a colourless tab/row/node).
export const AVATAR_NONE = 'none'

// The whole-surface tint for a tab / rail row / org node: a tinted background
// plus a bright matching text colour, or null when the agent is colourless.
export function tintStyle(
  name: string,
  override?: string | null,
  base = 'transparent'
): { background: string; color: string } | null {
  // Tint ONLY when the user has explicitly picked a colour (an encoded glyph.color
  // override). No override — or the "none" sentinel — means a plain, untinted
  // surface; we never auto-colour from the name hash.
  void name
  const d = decodeAvatar(override)
  if (!d) return null
  return {
    background: `color-mix(in srgb, ${hueColor(d.color)} 26%, ${base})`,
    color: hueText(d.color)
  }
}

/**
 * One or two characters standing in for a name, when there is no picture.
 *
 * A workspace that is not a GitHub checkout has no avatar to show, and leaving
 * it as a bare dot beside cards that DO have one breaks the row's rhythm —
 * the list stops reading as one list. A monogram fills the same tile.
 *
 * Latin names give their initials ("riven-electron" → RE); a script with no
 * case and no word breaks gives its first character ("테스트" → 테), because two
 * Hangul syllables in a 16px tile are unreadable.
 */
export function monogram(name: string): string {
  const cleaned = (name || '').trim()
  if (!cleaned) return '?'
  const words = cleaned.split(/[\s._/\\-]+/).filter(Boolean)
  const latin = /^[A-Za-z0-9]/
  if (words.length >= 2 && latin.test(words[0]) && latin.test(words[1])) {
    return (words[0][0] + words[1][0]).toUpperCase()
  }
  const first = words[0] ?? cleaned
  // Intl-aware: a surrogate pair (an emoji folder name) must not be cut in half.
  const chars = [...first]
  if (latin.test(first)) return chars.slice(0, 2).join('').toUpperCase()
  return chars[0]
}
