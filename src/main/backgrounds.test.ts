import { existsSync, mkdtempSync, readdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it, vi } from 'vitest'

const userData = mkdtempSync(join(tmpdir(), 'riven-bg-test-'))
const handlers = new Map<string, (...a: unknown[]) => unknown>()
vi.mock('electron', () => ({
  app: { getPath: () => userData },
  ipcMain: {
    handle: (ch: string, fn: (...a: unknown[]) => unknown) => handlers.set(ch, fn)
  }
}))

const { registerBackgroundHandlers, sniffImage, isBackgroundName, backgroundFile, decodeDataUrl, backgroundsDir, unusedBackgrounds } =
  await import('./backgrounds')
registerBackgroundHandlers()
const call = (ch: string, ...a: unknown[]): Promise<unknown> => Promise.resolve(handlers.get(ch)!({}, ...a))

afterAll(() => rmSync(userData, { recursive: true, force: true }))

const PNG = Buffer.concat([Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'), Buffer.from('pixels')])
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])
const dataUrl = (b: Buffer, mime = 'image/png'): string => `data:${mime};base64,${b.toString('base64')}`

describe('background images', () => {
  it('sniffs the type from the bytes, never svg', () => {
    expect(sniffImage(PNG)).toBe('png')
    expect(sniffImage(JPG)).toBe('jpg')
    expect(sniffImage(Buffer.from('GIF89a...'))).toBe('gif')
    expect(sniffImage(Buffer.from('RIFF\0\0\0\0WEBPVP8 ', 'latin1'))).toBe('webp')
    expect(sniffImage(Buffer.from('\0\0\0\x1cftypavif', 'latin1'))).toBe('avif')
    expect(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull()
    expect(sniffImage(new Uint8Array())).toBeNull()
  })

  // state/panelBackground.test.ts checks the renderer's BG_NAME_RE on the same names.
  it('accepts only its own names', () => {
    for (const bad of ['', 'bg-0123456789abcdef.svg', '../bg-0123456789abcdef.png', 'bg-0123456789ABCDEF.png', 'settings.json']) {
      expect(isBackgroundName(bad)).toBe(false)
      expect(backgroundFile(bad)).toBeNull()
    }
    expect(isBackgroundName('bg-0123456789abcdef.webp')).toBe(true)
  })

  it('decodes only base64 data URLs', () => {
    expect(decodeDataUrl('data:image/png;base64,aGk=')?.toString()).toBe('hi')
    expect(decodeDataUrl('aGk=')).toBeNull()
    expect(decodeDataUrl('data:image/png,hi')).toBeNull()
  })

  it('picks only unused files of its own name shape to delete', () => {
    const files = [
      'bg-0123456789abcdef.png',
      'bg-1111111111111111.jpg',
      'bg-2222222222222222.webp',
      'bg-2222222222222222.webp.tmp',
      'notes.txt'
    ]
    expect(unusedBackgrounds(files, ['bg-1111111111111111.jpg', 'bg-9999999999999999.png'])).toEqual([
      'bg-0123456789abcdef.png',
      'bg-2222222222222222.webp'
    ])
    expect(unusedBackgrounds(files, ['bg-0123456789abcdef.png', 'bg-1111111111111111.jpg', 'bg-2222222222222222.webp'])).toEqual([])
  })

  it('keeps every import until a collection leaves it out', async () => {
    const a = (await call('background:import', dataUrl(PNG))) as string
    expect(isBackgroundName(a)).toBe(true)
    expect(a.endsWith('.png')).toBe(true)
    // The same bytes give the same name.
    expect(await call('background:import', dataUrl(PNG))).toBe(a)
    // The label on the data URL is not trusted: these bytes are a JPEG.
    const b = (await call('background:import', dataUrl(JPG, 'image/png'))) as string
    expect(b.endsWith('.jpg')).toBe(true)
    // Several images can be in use at once: importing removes nothing.
    expect(readdirSync(backgroundsDir()).sort()).toEqual([a, b].sort())
    // A file in the keep list stays, the rest goes.
    expect(await call('background:gc', [b])).toBe(1)
    expect(readdirSync(backgroundsDir())).toEqual([b])
    expect(existsSync(join(backgroundsDir(), a))).toBe(false)
    // A broken list is refused, never read as "nothing in use".
    await expect(call('background:gc', null)).rejects.toThrow()
    await expect(call('background:gc', [3])).rejects.toThrow()
    expect(readdirSync(backgroundsDir())).toEqual([b])
    expect(await call('background:gc', [])).toBe(1)
    expect(readdirSync(backgroundsDir())).toEqual([])
  })

  it('refuses what is not an image', async () => {
    await expect(call('background:import', dataUrl(Buffer.from('<svg/>'), 'image/svg+xml'))).rejects.toThrow()
    await expect(call('background:import', 'file:///etc/passwd')).rejects.toThrow()
  })
})
