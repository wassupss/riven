import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it, vi } from 'vitest'

const userData = mkdtempSync(join(tmpdir(), 'riven-store-test-'))
const handlers = new Map<string, (...a: unknown[]) => unknown>()
vi.mock('electron', () => ({
  app: { getPath: () => userData },
  ipcMain: {
    handle: (ch: string, fn: (...a: unknown[]) => unknown) => handlers.set(ch, fn),
    on: (ch: string, fn: (...a: unknown[]) => unknown) => handlers.set(ch, fn)
  }
}))

const { registerStoreHandlers, loadAll, storeDir } = await import('./store')
registerStoreHandlers()
const call = (ch: string, ...a: unknown[]): unknown => handlers.get(ch)!({}, ...a)

afterAll(() => rmSync(userData, { recursive: true, force: true }))

describe('store (userData/store/<name>.json)', () => {
  it('saves as JSON.stringify(v, null, 2), loads all, removes on null', async () => {
    await call('store:save', 'pipelines', { '/ws': [{ id: 'p', name: '한글' }] })
    const file = join(storeDir(userData), 'pipelines.json')
    expect(readFileSync(file, 'utf8')).toBe(JSON.stringify({ '/ws': [{ id: 'p', name: '한글' }] }, null, 2))
    writeFileSync(join(storeDir(userData), 'broken.json'), '{')
    writeFileSync(join(storeDir(userData), 'Bad Name.json'), '1')
    expect(await call('store:loadAll')).toEqual({ pipelines: { '/ws': [{ id: 'p', name: '한글' }] } })
    await call('store:save', 'pipelines', null)
    expect(existsSync(file)).toBe(false)
  })

  it('refuses names that are not plain', async () => {
    for (const bad of ['../x', 'a/b', '', 'UP', '.hidden']) {
      await expect(Promise.resolve().then(() => call('store:save', bad, 1))).rejects.toThrow(/bad name/)
    }
  })

  it('save-sync writes before returning', () => {
    const e: { returnValue?: unknown } = {}
    handlers.get('store:save-sync')!(e, 'db-console-tabs', { tabs: [], active: null })
    expect(e.returnValue).toBe(true)
    expect(JSON.parse(readFileSync(join(storeDir(userData), 'db-console-tabs.json'), 'utf8'))).toEqual({ tabs: [], active: null })
  })

  it('a missing folder loads as empty', async () => {
    const d = join(userData, 'nope')
    expect(await loadAll(d)).toEqual({})
    mkdirSync(d)
    expect(await loadAll(d)).toEqual({})
  })
})
