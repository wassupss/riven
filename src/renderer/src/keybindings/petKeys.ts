// The pet's three keys, in one place because two windows need them.
//
// riven's window registers them as normal actions (see actions.ts) and relays a
// press through main to whichever window is showing the device. But the floating
// pet is its own window with no keymap of its own, so when IT has focus it has to
// match the same chords itself — reading the same overrides file, or a rebind
// would work in one window and not the other.

export const PET_KEY_DEFS: Array<{ key: 'a' | 'b' | 'c'; def: string; label: string }> = [
  // Two-finger chords on keys that sit next to each other. The first cut used
  // ⌘⌥A / S / D, and a three-finger stretch to feed a pet is a shortcut nobody
  // presses. ⌘; and ⌘' are unclaimed — by riven, by Monaco (⌘[ / ⌘] indent, ⌘/
  // comments) and by the shell — and C is Escape, which already means "never
  // mind" everywhere.
  { key: 'a', def: 'Mod+;', label: '리븐펫 A · 아이콘 이동' },
  { key: 'b', def: "Mod+'", label: '리븐펫 B · 실행' },
  { key: 'c', def: 'Mod+Escape', label: '리븐펫 C · 취소 / 뒤로' }
]

/** id → chord, with the user's overrides applied. */
export async function petKeyChords(): Promise<Record<string, 'a' | 'b' | 'c'>> {
  let overrides: Record<string, string> = {}
  try {
    overrides = ((await window.api.config.load('keybindings.json')) as Record<string, string>) ?? {}
  } catch {
    // No file yet, or unreadable: the defaults are answer enough.
  }
  const out: Record<string, 'a' | 'b' | 'c'> = {}
  for (const { key, def } of PET_KEY_DEFS) {
    const chord = overrides[`pet.key.${key}`] ?? def
    // An action the user has unbound ('') must not swallow every keystroke.
    if (chord) out[chord] = key
  }
  return out
}
