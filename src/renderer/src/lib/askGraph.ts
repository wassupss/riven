// Who is waiting on whom, while they wait.
//
// A lead asks a member with wait=true and blocks. The member, doing as it was
// told, asks the lead something back — and the lead is busy, so the member
// blocks too. Neither can move until both time out five minutes later, with
// nothing on screen to say why. The same happens around a longer ring
// (A→B→C→A).
//
// So every waiting delegation records an edge while it is in flight, and a
// request that would close a ring is refused immediately with an answer the
// agent can act on.

export type AskEdges = Map<string, Set<string>>

export function addEdge(edges: AskEdges, from: string, to: string): void {
  const set = edges.get(from) ?? new Set<string>()
  set.add(to)
  edges.set(from, set)
}

export function dropEdge(edges: AskEdges, from: string, to: string): void {
  const set = edges.get(from)
  if (!set) return
  set.delete(to)
  if (set.size === 0) edges.delete(from)
}

/** Would `from` waiting on `to` close a ring (or point at itself)? */
export function wouldCycle(edges: AskEdges, from: string, to: string): boolean {
  if (from === to) return true
  const seen = new Set<string>()
  const stack = [to]
  while (stack.length) {
    const at = stack.pop() as string
    if (at === from) return true
    if (seen.has(at)) continue
    seen.add(at)
    for (const next of edges.get(at) ?? []) stack.push(next)
  }
  return false
}
