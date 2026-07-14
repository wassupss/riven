import { ipcMain } from 'electron'
import { promises as fs } from 'fs'
import * as path from 'path'

// Simple find-in-files over the workspace. Node-based walk (no ripgrep dep);
// skips ignored dirs, binary and large files, and caps results.

const IGNORED_DIRS = new Set(['.git', 'node_modules', 'out', 'dist', '.cache', '.riven'])
const MAX_FILE_BYTES = 1_000_000
const MAX_RESULTS = 600
const MAX_PER_FILE = 50
const NUL = String.fromCharCode(0)

export interface SearchMatch {
  file: string
  line: number // 1-based
  column: number // 1-based
  text: string
  matchStart: number
  matchLength: number
}

async function* walk(dir: string): AsyncGenerator<string> {
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (e.name === '.DS_Store' || IGNORED_DIRS.has(e.name)) continue
    const full = path.join(dir, e.name)
    if (e.isDirectory()) yield* walk(full)
    else if (e.isFile()) yield full
  }
}

export function registerSearchHandlers(): void {
  ipcMain.handle(
    'search:inFiles',
    async (
      _e,
      opts: { root: string; query: string; caseSensitive?: boolean }
    ): Promise<{ matches: SearchMatch[]; truncated: boolean }> => {
      const { root, query, caseSensitive } = opts
      const matches: SearchMatch[] = []
      if (!query) return { matches, truncated: false }
      const needle = caseSensitive ? query : query.toLowerCase()

      for await (const file of walk(root)) {
        if (matches.length >= MAX_RESULTS) return { matches, truncated: true }
        let stat
        try {
          stat = await fs.stat(file)
        } catch {
          continue
        }
        if (stat.size > MAX_FILE_BYTES) continue

        let content: string
        try {
          content = await fs.readFile(file, 'utf8')
        } catch {
          continue
        }
        if (content.includes(NUL)) continue // binary

        const lines = content.split('\n')
        let perFile = 0
        for (let i = 0; i < lines.length && perFile < MAX_PER_FILE; i++) {
          const line = lines[i]
          const hay = caseSensitive ? line : line.toLowerCase()
          const idx = hay.indexOf(needle)
          if (idx >= 0) {
            matches.push({
              file,
              line: i + 1,
              column: idx + 1,
              text: line.length > 240 ? line.slice(0, 240) : line,
              matchStart: idx,
              matchLength: query.length
            })
            perFile++
            if (matches.length >= MAX_RESULTS) return { matches, truncated: true }
          }
        }
      }
      return { matches, truncated: false }
    }
  )

  // Literal find-and-replace across the workspace. Matches the same guards as
  // search (skip ignored dirs, binary, and large files) and writes atomically.
  ipcMain.handle(
    'search:replaceInFiles',
    async (
      _e,
      opts: { root: string; query: string; replacement: string; caseSensitive?: boolean }
    ): Promise<{ files: number; replacements: number }> => {
      const { root, query, replacement, caseSensitive } = opts
      if (!query) return { files: 0, replacements: 0 }
      // Escape the query so it matches literally; escape `$` in the replacement
      // so RegExp replace treats it as text, not a capture reference.
      const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const re = new RegExp(escapeRe(query), caseSensitive ? 'g' : 'gi')
      const safeRepl = replacement.replace(/\$/g, '$$$$')

      let files = 0
      let replacements = 0
      for await (const file of walk(root)) {
        let stat
        try {
          stat = await fs.stat(file)
        } catch {
          continue
        }
        if (stat.size > MAX_FILE_BYTES) continue

        let content: string
        try {
          content = await fs.readFile(file, 'utf8')
        } catch {
          continue
        }
        if (content.includes(NUL)) continue // binary

        const count = content.match(re)?.length ?? 0
        if (!count) continue
        const next = content.replace(re, safeRepl)
        try {
          const tmp = `${file}.tmp`
          await fs.writeFile(tmp, next)
          await fs.rename(tmp, file)
          files++
          replacements += count
        } catch {
          /* skip unwritable files */
        }
      }
      return { files, replacements }
    }
  )
}
