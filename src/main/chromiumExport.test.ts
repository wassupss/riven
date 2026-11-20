import { mkdtempSync, readFileSync, rmSync, existsSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it, vi } from 'vitest'

const userData = mkdtempSync(join(tmpdir(), 'riven-export-test-'))
const handlers = new Map<string, (...a: unknown[]) => unknown>()
let lsAnswer: unknown = { railCollapsed: '["a"]', 'paneSeq:v1': '9' }
const cookies = [{ name: 'sid', value: 's3cret', domain: '.example.com', path: '/', secure: true, httpOnly: true, expirationDate: 1893456000 }]
vi.mock('electron', () => ({
  app: { getPath: () => userData, getVersion: () => '0.3.3' },
  ipcMain: { handle: (ch: string, fn: (...a: unknown[]) => unknown) => handlers.set(ch, fn) },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.concat([Buffer.from('v10'), Buffer.from(s).reverse()])
  },
  session: { fromPartition: (p: string) => ({ cookies: { get: async () => (p === 'persist:riven-browser' ? cookies : []) } }) },
  BrowserWindow: { getAllWindows: () => [] }
}))
vi.mock('./appWindow', () => ({
  appWindow: () => ({
    isDestroyed: () => false,
    webContents: { executeJavaScript: async () => lsAnswer, getURL: () => 'file:///Applications/riven.app/Contents/Resources/app.asar/out/renderer/index.html' }
  })
}))

const { registerChromiumExport, exportChromiumData, EXPORT_DIR } = await import('./chromiumExport')
registerChromiumExport()
const dir = join(userData, EXPORT_DIR)
afterAll(() => rmSync(userData, { recursive: true, force: true }))

describe('chromiumExport (the bridge to the Tauri build)', () => {
  it('writes localStorage, sealed cookies and a manifest once at startup', async () => {
    expect(await handlers.get('export:ready')!({})).toBe(true)
    const ls = JSON.parse(readFileSync(join(dir, 'local-storage.json'), 'utf8'))
    expect(ls).toEqual({ version: 1, page: 'file:///Applications/riven.app/Contents/Resources/app.asar/out/renderer/index.html', entries: { railCollapsed: '["a"]', 'paneSeq:v1': '9' } })
    const sealed = Buffer.from(readFileSync(join(dir, 'browser-cookies.bin'), 'utf8'), 'base64')
    expect(sealed.subarray(0, 3).toString()).toBe('v10')
    expect(JSON.parse(Buffer.from(sealed.subarray(3)).reverse().toString())).toEqual({ version: 1, partition: 'persist:riven-browser', cookies })
    expect(statSync(join(dir, 'browser-cookies.bin')).mode & 0o777).toBe(0o600)
    const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'))
    expect(m).toMatchObject({ version: 1, reason: 'first start', appVersion: '0.3.3', localStorageEntries: 2, cookies: 1 })
    // Already done: the startup export does not run again.
    expect(await handlers.get('export:ready')!({})).toBe(false)
  })

  it('an update always writes it again; without the page no manifest is claimed', async () => {
    lsAnswer = { railCollapsed: '[]' }
    const m = await exportChromiumData('update 1.0.0 downloaded')
    expect(m?.localStorageEntries).toBe(1)
    expect(JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')).reason).toBe('update 1.0.0 downloaded')
    rmSync(join(dir, 'manifest.json'))
    lsAnswer = null
    const again = await exportChromiumData('install')
    expect(again?.localStorageEntries).toBeNull()
    expect(existsSync(join(dir, 'manifest.json'))).toBe(false)
  })
})
