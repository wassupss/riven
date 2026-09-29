import { promises as fsp } from 'fs'
import { readLinesFrom } from './lineStream'
import { emptyScan, scanLine, type TitleScan } from './sessionTitle'

// Reading past conversations without reading them whole.
//
// The session list needs, per transcript, a title and an exact message count.
// It got them by reading every transcript into one string and splitting it:
// measured on a real project, 92 files / 360MB, which took the main process from
// 176MB to 1.2GB for as long as the strings lived — every time a chat pane
// without a session opened, several at once after a restart.
//
// Two things make that unnecessary, and neither costs any exactness:
//   · a transcript is read as a stream, line by line, so memory is one chunk
//     and one line, not the file;
//   · the CLI only ever APPENDS to a transcript (a rename is one more line), so
//     once a file has been scanned, the next look only reads what was added
//     and continues the count from where it stopped.

interface Entry {
  size: number
  mtimeMs: number
  /** Byte offset just past the last complete line scanned. */
  offset: number
  scan: TitleScan
}

const cache = new Map<string, Entry>()
/** Bounded so a long-running app with many projects cannot grow this forever. */
const CACHE_MAX = 2000

/**
 * The title scan of one transcript, reading only what it has not read before.
 * Exact: the same fold over the same lines as reading the whole file.
 */
export async function scanSessionFile(file: string): Promise<{ scan: TitleScan; mtimeMs: number }> {
  const stat = await fsp.stat(file)
  const hit = cache.get(file)
  if (hit && hit.size === stat.size && hit.mtimeMs === stat.mtimeMs) {
    return { scan: hit.scan, mtimeMs: stat.mtimeMs }
  }
  // Grown since last time: carry on from where the last complete line ended.
  // Shrunk or replaced: start over.
  const resume = hit && stat.size >= hit.offset && stat.size >= hit.size
  const scan: TitleScan = resume ? { ...hit.scan } : emptyScan()
  const offset = await readLinesFrom(file, resume ? hit.offset : 0, (line) => scanLine(scan, line))
  if (!cache.has(file) && cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  cache.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, offset, scan })
  return { scan, mtimeMs: stat.mtimeMs }
}

/** Forget a transcript (it was deleted). */
export function forgetSessionFile(file: string): void {
  cache.delete(file)
}
