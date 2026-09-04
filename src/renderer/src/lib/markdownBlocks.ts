// Split markdown into top-level blocks so a STREAMING message only re-parses its
// last (still-growing) block: earlier blocks are stable strings, so a memoised
// renderer skips them entirely. Re-parsing the whole message on every chunk is
// O(n) per frame — quadratic over a long reply — which is what made streaming
// stutter. (Same approach as paseo's splitMarkdownBlocks + block promotion.)
//
// Blocks break on blank lines, EXCEPT inside fenced code (``` or ~~~), which must
// stay in one piece or it would render as broken paragraphs mid-stream.
export function splitMarkdownBlocks(text: string): string[] {
  if (!text) return []
  const lines = text.split('\n')
  const blocks: string[] = []
  let cur: string[] = []
  let fence: string | null = null

  const flush = (): void => {
    if (cur.length) blocks.push(cur.join('\n'))
    cur = []
  }

  for (const line of lines) {
    const m = /^\s{0,3}(`{3,}|~{3,})/.exec(line)
    if (m) {
      if (!fence) {
        // A fence starts a new block so the paragraph before it stays stable.
        flush()
        fence = m[1][0]
        cur.push(line)
        continue
      }
      if (line.trimStart().startsWith(fence.repeat(3))) {
        cur.push(line)
        flush() // fence closed → this block is final
        fence = null
        continue
      }
    }
    if (!fence && line.trim() === '') {
      flush()
      continue
    }
    cur.push(line)
  }
  flush()
  return blocks
}
