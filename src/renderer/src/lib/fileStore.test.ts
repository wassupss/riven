import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  __resetFileStore,
  flushFileStore,
  fromEntries,
  hydrateFileStore,
  isMovedKey,
  MIGRATED_KEY,
  STORES,
  storeGet,
  storeMapGet,
  storeMapSet,
  storeSet
} from './fileStore'

// localStorage and window.api.store, in memory.
function memStorage(init: Record<string, string> = {}): Storage {
  const m = new Map(Object.entries(init))
  return {
    get length() {
      return m.size
    },
    key: (i: number) => [...m.keys()][i] ?? null,
    getItem: (k: string) => (m.has(k) ? (m.get(k) as string) : null),
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear()
  }
}

let files: Record<string, unknown>
let saves: Array<[string, unknown]>
let syncSaves: Array<[string, unknown]>
const g = globalThis as unknown as { window: unknown; localStorage: Storage }

function setup(ls: Record<string, string>, onDisk: Record<string, unknown> = {}): void {
  files = { ...onDisk }
  saves = []
  syncSaves = []
  g.localStorage = memStorage(ls)
  g.window = {
    addEventListener: () => {},
    api: {
      store: {
        loadAll: async () => JSON.parse(JSON.stringify(files)),
        save: async (name: string, data: unknown) => {
          saves.push([name, data])
          if (data === null) delete files[name]
          else files[name] = JSON.parse(JSON.stringify(data))
        },
        saveSync: (name: string, data: unknown) => {
          syncSaves.push([name, data])
          return true
        }
      }
    }
  }
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

beforeEach(() => __resetFileStore())
afterEach(() => __resetFileStore())

describe('fileStore', () => {
  it('moves this engine\'s localStorage into files that do not exist yet, once', async () => {
    const pipelines = { '/ws': [{ id: 'pl_1', name: 'p', stages: [] }] }
    setup(
      {
        'pipelines:v1': JSON.stringify(pipelines),
        'db.console.snippets.v1': JSON.stringify([{ id: 's', name: 'n', sql: 'select 1', at: 1 }]),
        'db.erd.pos.c1//public': JSON.stringify({ users: { x: 1, y: 2 } }),
        'sb-abc-auth-token': '{"access_token":"t"}',
        'db.console.history.v1': 'not json',
        railCollapsed: '[]'
      },
      // Another build already wrote snippets: kept, not replaced.
      { 'db-console-snippets': [{ id: 'other', name: 'kept', sql: 'x', at: 2 }] }
    )
    await hydrateFileStore()
    expect(storeGet('pipelines')).toEqual(pipelines)
    expect(files.pipelines).toEqual(pipelines)
    expect(storeGet('db-console-snippets')).toEqual([{ id: 'other', name: 'kept', sql: 'x', at: 2 }])
    expect(storeMapGet('db-erd-positions', 'c1//public')).toEqual({ users: { x: 1, y: 2 } })
    expect(files.auth).toEqual({ 'sb-abc-auth-token': '{"access_token":"t"}' })
    expect(storeGet('db-console-history')).toBeUndefined() // unreadable: not moved
    expect(saves.map((s) => s[0]).sort()).toEqual(['auth', 'db-erd-positions', 'pipelines'])
    expect(localStorage.getItem(MIGRATED_KEY)).toBe('1')
    // The old entries stay where they were.
    expect(localStorage.getItem('pipelines:v1')).toBe(JSON.stringify(pipelines))

    // Second start: the marker means localStorage is not read again, even
    // for a file that has gone since.
    __resetFileStore()
    delete files.pipelines
    saves = []
    await hydrateFileStore()
    expect(storeGet('pipelines')).toBeUndefined()
    expect(saves).toEqual([])
  })

  it('writes one file at a time, the newest value last, and nothing before hydration', async () => {
    setup({ [MIGRATED_KEY]: '1' })
    storeSet('pipelines', { early: [] })
    expect(saves).toEqual([])
    await hydrateFileStore()
    storeSet('pipelines', { a: [] })
    storeSet('pipelines', { b: [] })
    storeSet('pipelines', { c: [] })
    expect(saves).toEqual([['pipelines', { a: [] }]]) // b and c wait behind a
    await tick()
    await tick()
    expect(saves).toEqual([
      ['pipelines', { a: [] }],
      ['pipelines', { c: [] }]
    ])
    expect(files.pipelines).toEqual({ c: [] })
    // The same value again is not written.
    const v = storeGet('pipelines')
    storeSet('pipelines', v)
    await tick()
    expect(saves.length).toBe(2)
  })

  it('map stores add, replace and drop keys; an empty map removes the file', async () => {
    setup({ [MIGRATED_KEY]: '1' })
    await hydrateFileStore()
    storeMapSet('auth', 'sb-x-auth-token', 'v1')
    await tick()
    storeMapSet('auth', 'sb-x-auth-token-code-verifier', 'cv')
    await tick()
    expect(files.auth).toEqual({ 'sb-x-auth-token': 'v1', 'sb-x-auth-token-code-verifier': 'cv' })
    storeMapSet('auth', 'sb-x-auth-token', undefined)
    storeMapSet('auth', 'sb-x-auth-token-code-verifier', undefined)
    await tick()
    await tick()
    expect('auth' in files).toBe(false)
  })

  it('flush writes what has not landed synchronously', async () => {
    setup({ [MIGRATED_KEY]: '1' })
    await hydrateFileStore()
    storeSet('apiclient-env', [{ key: 'a', value: 'b', enabled: true }])
    storeSet('apiclient-env', [{ key: 'a', value: 'c', enabled: true }])
    flushFileStore()
    expect(syncSaves).toEqual([['apiclient-env', [{ key: 'a', value: 'c', enabled: true }]]])
  })

  it('knows which localStorage keys moved', () => {
    for (const k of ['pipelines:v1', 'db.console.tabs.v1', 'apiclient.saved.v1', 'db.erd.pos.x/y/z', 'sb-p-auth-token', MIGRATED_KEY]) {
      expect(isMovedKey(k), k).toBe(true)
    }
    for (const k of ['railCollapsed', 'paneSeq:v1', 'chatlog:chat-1', 'agentGroups:v1', 'db.console.limit']) {
      expect(isMovedKey(k), k).toBe(false)
    }
    expect(fromEntries(STORES['db-erd-positions'], {})).toBeUndefined()
  })
})

describe('the bridge export hook', () => {
  it('hands main every localStorage entry that did not move, and says it is ready', async () => {
    setup({ [MIGRATED_KEY]: '1', 'pipelines:v1': '{}', 'sb-x-auth-token': 't', railCollapsed: '["a"]', 'paneSeq:v1': '7', 'chatlog:chat-1': '[]' })
    let ready = 0
    ;(g.window as { api: { store: { exportReady?: () => Promise<boolean> } } }).api.store.exportReady = async () => {
      ready++
      return true
    }
    await hydrateFileStore()
    const fn = (g.window as { __rivenLocalStorageExport?: () => Record<string, string> }).__rivenLocalStorageExport
    expect(fn?.()).toEqual({ railCollapsed: '["a"]', 'paneSeq:v1': '7', 'chatlog:chat-1': '[]' })
    expect(ready).toBe(1)
  })
})
