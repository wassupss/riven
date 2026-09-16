// A unified diff, turned into lines that can be rendered and — crucially —
// commented on.
//
// A review comment is addressed by FILE LINE NUMBER and side, not by position
// in the patch, so every rendered line has to carry the number it has in the
// old file, the new file, or both. Getting this wrong doesn't look wrong: the
// diff still renders, and the comment lands on a different line than the one
// the reviewer pointed at.

export type PatchLineKind = 'add' | 'del' | 'context' | 'hunk'

export interface PatchLine {
  kind: PatchLineKind
  text: string
  // Line number in the base (old) file — a deleted or context line.
  oldLine: number | null
  // Line number in the head (new) file — an added or context line.
  newLine: number | null
}

export interface PatchHunk {
  header: string
  lines: PatchLine[]
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

export function parsePatch(patch: string | null | undefined): PatchHunk[] {
  if (!patch) return []
  const hunks: PatchHunk[] = []
  let current: PatchHunk | null = null
  let oldLine = 0
  let newLine = 0
  for (const raw of patch.split('\n')) {
    const m = HUNK_RE.exec(raw)
    if (m) {
      oldLine = Number(m[1])
      newLine = Number(m[3])
      current = { header: raw, lines: [{ kind: 'hunk', text: raw, oldLine: null, newLine: null }] }
      hunks.push(current)
      continue
    }
    if (!current) continue // preamble (---/+++), nothing to show
    const tag = raw[0]
    const text = raw.slice(1)
    if (tag === '+') {
      current.lines.push({ kind: 'add', text, oldLine: null, newLine: newLine++ })
    } else if (tag === '-') {
      current.lines.push({ kind: 'del', text, oldLine: oldLine++, newLine: null })
    } else if (tag === '\\') {
      // "\ No newline at end of file" — part of the diff, not of either file, so
      // it advances no counter and can't be commented on.
      current.lines.push({ kind: 'context', text: raw, oldLine: null, newLine: null })
    } else {
      current.lines.push({ kind: 'context', text, oldLine: oldLine++, newLine: newLine++ })
    }
  }
  return hunks
}

// Where a thread belongs, as a key over (path, side, line). GitHub reports the
// current line as null once a thread goes outdated, keeping only where it
// originally sat — so fall back, or outdated threads vanish from the file.
export function threadAnchor(t: {
  path: string
  line: number | null
  originalLine: number | null
  diffSide: 'LEFT' | 'RIGHT'
}): string {
  const line = t.line ?? t.originalLine
  return line === null ? `${t.path}::none` : `${t.path}::${t.diffSide}::${line}`
}

export function lineAnchor(path: string, line: PatchLine): string | null {
  if (line.kind === 'add' && line.newLine !== null) return `${path}::RIGHT::${line.newLine}`
  if (line.kind === 'del' && line.oldLine !== null) return `${path}::LEFT::${line.oldLine}`
  // A context line exists on both sides; GitHub addresses it by its NEW number
  // on the RIGHT, which is what its own review UI sends.
  if (line.kind === 'context' && line.newLine !== null) return `${path}::RIGHT::${line.newLine}`
  return null
}
