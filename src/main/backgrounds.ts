import { createHash } from 'crypto'
import { app, ipcMain } from 'electron'
import { promises as fs } from 'fs'
import * as path from 'path'

// The panel background image (Settings > appearance). src-tauri/src/services/
// backgrounds.rs is the Tauri build's twin; keep the two in step.
//
// The page hands over the picked file's bytes as a data URL; they are copied to
// userData/backgrounds/bg-<16 hex of sha256>.<ext>, so the original can move or
// go away. The type comes from the bytes (magic numbers), never from the name
// or the data URL's label, and only raster formats are accepted: no SVG, which
// can carry script. One image is kept: importing a new one removes the others.
//
// media.ts serves it as riven-media://bg/<name>, and only a name of exactly
// that shape, read from that folder.

export const MAX_BG_BYTES = 25 * 1024 * 1024

const NAME_RE = /^bg-[0-9a-f]{16}\.(png|jpg|gif|webp|avif|bmp)$/

export function isBackgroundName(name: string): boolean {
  return NAME_RE.test(name)
}

/** The image type from the file's first bytes, as an extension. */
export function sniffImage(b: Uint8Array): string | null {
  const at = (i: number, s: string): boolean => {
    if (b.length < i + s.length) return false
    for (let k = 0; k < s.length; k++) if (b[i + k] !== s.charCodeAt(k)) return false
    return true
  }
  if (at(0, '\x89PNG\r\n\x1a\n')) return 'png'
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg'
  if (at(0, 'GIF87a') || at(0, 'GIF89a')) return 'gif'
  if (at(0, 'RIFF') && at(8, 'WEBP')) return 'webp'
  if (at(4, 'ftyp') && (at(8, 'avif') || at(8, 'avis'))) return 'avif'
  if (at(0, 'BM') && b.length > 26) return 'bmp'
  return null
}

export function backgroundName(bytes: Uint8Array, ext: string): string {
  return `bg-${createHash('sha256').update(bytes).digest('hex').slice(0, 16)}.${ext}`
}

/** "data:<anything>;base64,<payload>" -> the bytes, or null when it is not one. */
export function decodeDataUrl(dataUrl: string): Buffer | null {
  const comma = dataUrl.indexOf(',')
  if (comma < 0) return null
  const head = dataUrl.slice(0, comma)
  if (!head.startsWith('data:') || !head.endsWith(';base64')) return null
  return Buffer.from(dataUrl.slice(comma + 1), 'base64')
}

export function backgroundsDir(): string {
  return path.join(app.getPath('userData'), 'backgrounds')
}

/** The file behind a served name, null for any other name. */
export function backgroundFile(name: string): string | null {
  return isBackgroundName(name) ? path.join(backgroundsDir(), name) : null
}

async function prune(keep: string | null): Promise<void> {
  const dir = backgroundsDir()
  let names: string[] = []
  try {
    names = await fs.readdir(dir)
  } catch {
    return
  }
  for (const n of names) if (n !== keep) await fs.rm(path.join(dir, n), { force: true }).catch(() => {})
}

export function registerBackgroundHandlers(): void {
  ipcMain.handle('background:import', async (_e, dataUrl: string): Promise<string> => {
    if (typeof dataUrl !== 'string' || dataUrl.length / 4 * 3 > MAX_BG_BYTES + 3)
      throw new Error('image too large')
    const bytes = decodeDataUrl(dataUrl)
    if (!bytes) throw new Error('not a base64 data URL')
    if (bytes.length > MAX_BG_BYTES) throw new Error('image too large')
    const ext = sniffImage(bytes)
    if (!ext) throw new Error('not a supported image (png, jpg, gif, webp, avif, bmp)')
    const name = backgroundName(bytes, ext)
    const dir = backgroundsDir()
    await fs.mkdir(dir, { recursive: true })
    const file = path.join(dir, name)
    const exists = await fs.stat(file).then((s) => s.isFile(), () => false)
    if (!exists) {
      const tmp = `${file}.tmp`
      await fs.writeFile(tmp, bytes)
      await fs.rename(tmp, file)
    }
    await prune(name)
    return name
  })
  ipcMain.handle('background:remove', () => prune(null))
}
