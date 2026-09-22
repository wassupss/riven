// The pet's three keys, in one place because two windows need them.
//
// riven's window registers them as normal actions (see actions.ts) and relays a
// press through main to whichever window is showing the device. But the floating
// pet is its own window with no keymap of its own, so when IT has focus it has to
// match the same chords itself — reading the same overrides file, or a rebind
// would work in one window and not the other.

export const PET_KEY_DEFS: Array<{ key: 'a' | 'b' | 'c'; def: string; label: string }> = [
  // L, ; and ' — three keys next to each other on the home row, under one hand,
  // in the same order as the three buttons on the case. Two fingers, not the
  // three-finger stretch of the first cut (⌘⌥A / S / D), which is a shortcut
  // nobody presses. None of them is claimed by riven or the shell; ⌘L is Monaco's
  // select-line inside the code editor, and this shadows it there.
  { key: 'a', def: 'Mod+l', label: '리븐펫 A · 아이콘 이동' },
  { key: 'b', def: 'Mod+;', label: '리븐펫 B · 실행' },
  { key: 'c', def: "Mod+'", label: '리븐펫 C · 취소 / 뒤로' }
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
