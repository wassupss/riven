// Line diff producing individual changed regions (hunks) so agent edits can be
// reviewed one-by-one (git-conflict style). LCS-based; falls back to a single
// prefix/suffix block for very large files.
export interface ChangedRange {
  fromLine: number
  toLine: number
  hasChange: boolean
}

export interface Hunk {
  beforeStart: number // 0-based line index in "before"
  beforeCount: number
  afterStart: number // 0-based line index in "after"
  afterCount: number
  beforeLines: string[]
  afterLines: string[]
}

// Legacy single-range (kept for callers that only need one span).
export function changedLineRange(before: string, after: string): ChangedRange {
  if (before === after) return { fromLine: 1, toLine: 1, hasChange: false }
  const b = before.split('\n')
  const a = after.split('\n')
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length - 1
  let endB = b.length - 1
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA--
    endB--
  }
  if (endA < start) {
    const line = Math.min(start + 1, a.length)
    return { fromLine: line, toLine: line, hasChange: true }
  }
  return { fromLine: start + 1, toLine: endA + 1, hasChange: true }
}

export function computeHunks(before: string, after: string): Hunk[] {
  if (before === after) return []
  const a = before.split('\n')
  const b = after.split('\n')
  const n = a.length
  const m = b.length

  // Guard against O(n*m) blowup on huge files → single block fallback.
  if (n * m > 4_000_000) {
    const r = changedLineRange(before, after)
    if (!r.hasChange) return []
    return [
      {
        beforeStart: 0,
        beforeCount: a.length,
        afterStart: r.fromLine - 1,
        afterCount: r.toLine - r.fromLine + 1,
        beforeLines: a,
        afterLines: b.slice(r.fromLine - 1, r.toLine)
      }
    ]
  }

  // LCS length table.
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }

  const hunks: Hunk[] = []
  let i = 0
  let j = 0
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      i++
      j++
      continue
    }
    // start of a change region
    const bs = i
    const as = j
    while (i < n || j < m) {
      if (i < n && j < m && a[i] === b[j]) break
      if (j >= m || (i < n && dp[i + 1][j] >= dp[i][j + 1])) i++ // deletion
      else j++ // insertion
    }
    hunks.push({
      beforeStart: bs,
      beforeCount: i - bs,
      afterStart: as,
      afterCount: j - as,
      beforeLines: a.slice(bs, i),
      afterLines: b.slice(as, j)
    })
  }
  return hunks
}
