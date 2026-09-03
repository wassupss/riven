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

export interface SearchOpts {
  regex?: boolean
  wholeWord?: boolean
  caseSensitive?: boolean
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Compile the query into a global RegExp honoring the regex/word/case toggles.
// Returns null if the user typed an invalid regex (caller treats as no match).
function buildMatcher(query: string, o: SearchOpts): RegExp | null {
  let src = o.regex ? query : escapeRe(query)
  if (o.wholeWord) src = `\\b(?:${src})\\b`
  try {
    return new RegExp(src, 'g' + (o.caseSensitive ? '' : 'i'))
  } catch {
    return null
  }
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
      opts: { root: string; query: string } & SearchOpts
    ): Promise<{ matches: SearchMatch[]; truncated: boolean }> => {
      const { root, query } = opts
      const matches: SearchMatch[] = []
      if (!query) return { matches, truncated: false }
      const re = buildMatcher(query, opts)
      if (!re) return { matches, truncated: false } // invalid regex → no results

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
          re.lastIndex = 0
          const m = re.exec(line)
          // Skip empty-width matches (e.g. a lone `*` regex) so we don't spin.
          if (m && m[0].length > 0) {
            matches.push({
              file,
              line: i + 1,
              column: m.index + 1,
              text: line.length > 240 ? line.slice(0, 240) : line,
              matchStart: m.index,
              matchLength: m[0].length
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
      opts: { root: string; query: string; replacement: string } & SearchOpts
    ): Promise<{ files: number; replacements: number }> => {
      const { root, query, replacement } = opts
      if (!query) return { files: 0, replacements: 0 }
      const re = buildMatcher(query, opts)
      if (!re) return { files: 0, replacements: 0 } // invalid regex
      // In literal mode, escape `$` in the replacement so RegExp replace treats it
      // as text. In regex mode, keep `$1`… capture references working.
      const safeRepl = opts.regex ? replacement : replacement.replace(/\$/g, '$$$$')

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
