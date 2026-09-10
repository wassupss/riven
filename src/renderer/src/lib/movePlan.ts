// What a drag-and-drop move inside the explorer is allowed to do.
//
// Kept pure and separate because this is the one place in the explorer where a
// wrong answer destroys data: fs.rename happily overwrites an existing file, and
// moving a folder inside itself detaches the whole subtree. Every rule here has
// a test.

export interface MovePlan {
  moves: Array<{ from: string; to: string }>
  skipped: Array<{ path: string; reason: SkipReason }>
}

export type SkipReason =
  | 'already-there' // the source already lives in the destination
  | 'into-itself' // a folder dropped on itself or into its own subtree
  | 'name-taken' // something with that name is already in the destination

const baseName = (p: string): string => p.slice(p.lastIndexOf('/') + 1)
const parentOf = (p: string): string => p.slice(0, p.lastIndexOf('/')) || '/'

// `existingNames` is what the destination directory already contains. A
// collision is REFUSED rather than overwritten or auto-renamed: silently
// replacing a file the user forgot about is the worst outcome available here,
// and picking "file (2).txt" for them is a guess.
export function planMove(sources: string[], destDir: string, existingNames: string[]): MovePlan {
  const taken = new Set(existingNames)
  const plan: MovePlan = { moves: [], skipped: [] }
  const seen = new Set<string>()

  for (const from of sources) {
    if (seen.has(from)) continue
    seen.add(from)
    const name = baseName(from)

    // Dropping a folder on itself, or anywhere beneath itself, would move the
    // subtree into a path that is about to stop existing.
    if (destDir === from || destDir.startsWith(from + '/')) {
      plan.skipped.push({ path: from, reason: 'into-itself' })
      continue
    }
    if (parentOf(from) === destDir) {
      plan.skipped.push({ path: from, reason: 'already-there' })
      continue
    }
    if (taken.has(name)) {
      plan.skipped.push({ path: from, reason: 'name-taken' })
      continue
    }
    // Two sources with the same base name would collide with each other, not
    // just with the destination, so claim the name as we go.
    taken.add(name)
    plan.moves.push({ from, to: `${destDir}/${name}` })
  }
  return plan
}
