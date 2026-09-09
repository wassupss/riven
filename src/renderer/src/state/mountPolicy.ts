// Which workspaces stay mounted. Pure, so the rule can be tested without a
// dockview or a renderer — App.tsx only supplies the inputs.
//
// Bounding the live set is what keeps the renderer heap flat (every mounted
// workspace holds its chats, xterms and Monaco models). But unmounting costs the
// panel's React state, and for a chat mid-turn that state is not recoverable:
// main keeps streaming, while the on-disk CLI transcript only gains the answer
// once the turn ENDS. So busy workspaces are held past the cap and released as
// soon as they go idle.

export function nextMounted(
  mounted: readonly string[],
  active: string,
  open: readonly string[],
  busy: ReadonlySet<string>,
  max: number
): string[] {
  const recent = [...mounted.filter((w) => w !== active && open.includes(w)), active]
  const keep = recent.slice(-max)
  const held = recent.filter((w) => !keep.includes(w) && busy.has(w))
  // `held` are older than everything in `keep`, so this preserves LRU order and
  // they are the first candidates to drop once they finish.
  return held.length ? [...held, ...keep] : keep
}
