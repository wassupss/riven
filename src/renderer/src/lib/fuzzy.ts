// Fuzzy subsequence score: all query chars must appear in order. Higher is better;
// rewards consecutive matches, matches right after a separator, and short paths.
// Shared by the quick-open palette and the notes document picker so both rank
// file paths the same way.
export function score(text: string, q: string): number {
  if (!q) return 1
  const t = text.toLowerCase()
  let ti = 0
  let s = 0
  let streak = 0
  for (let qi = 0; qi < q.length; qi++) {
    const c = q[qi]
    const found = t.indexOf(c, ti)
    if (found === -1) return -1
    let pt = 1
    if (found === ti) {
      streak++
      pt += streak * 2
    } else streak = 0
    const prev = found > 0 ? t[found - 1] : '/'
    if (prev === '/' || prev === '.' || prev === '-' || prev === '_') pt += 3
    s += pt
    ti = found + 1
  }
  // Prefer shorter paths + basename matches.
  s += Math.max(0, 20 - text.length / 4)
  return s
}
