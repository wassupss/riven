// ---------------------------------------------------------------------------
// The small pure pieces of the species maker (components/PetMaker.tsx) that
// are not pixels: the name a new species starts with.
// ---------------------------------------------------------------------------

/**
 * The first `label(n)` (n = 1, 2, ...) no species is called yet, so a new
 * species can be saved without typing a name ("내 펫 1", "내 펫 2", ...).
 * Names are compared trimmed and case-blind.
 */
export function nextName(taken: string[], label: (n: number) => string): string {
  const used = new Set(taken.map((s) => s.trim().toLowerCase()))
  for (let n = 1; ; n++) {
    const name = label(n)
    if (!used.has(name.trim().toLowerCase())) return name
  }
}
