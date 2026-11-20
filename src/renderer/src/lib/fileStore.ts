// The renderer's real data (pipelines, DB console tabs, query history and
// snippets, API client requests, ERD layouts, the sign-in session) as files in
// the user data folder, userData/store/<name>.json, instead of localStorage.
//
// localStorage belongs to the browser engine: Chromium in the Electron build,
// WebKit in the Tauri one, each with its own copy under its own origin. Files
// in the shared folder are the same for both, so the data follows the user
// from one build to the other. The main process (src/main/store.ts, and
// src-tauri/src/commands/store.rs) reads and writes them; both use the same
// folder and format.
//
// The API is synchronous, as localStorage's was: every file is read once at
// startup (hydrateFileStore, before the app's modules load, see main.tsx) and
// kept here; a write updates the copy at once and goes to disk in the
// background, one write per file at a time, the newest value winning.
//
// Moving over: the first start with this code copies each store's old
// localStorage entries into its file, but only when that file does not exist
// yet (data another build already wrote wins), and only once per engine (the
// marker below). The old entries are left in place.

export interface StoreSpec {
  /** The localStorage key it replaces (the value is JSON). */
  key?: string
  /** Or every key with this prefix: the file is { rest of key: value }. */
  prefix?: string
  /** prefix stores: keep the values as the raw strings localStorage held. */
  raw?: boolean
}

export const STORES = {
  pipelines: { key: 'pipelines:v1' },
  'db-console-tabs': { key: 'db.console.tabs.v1' },
  'db-console-history': { key: 'db.console.history.v1' },
  'db-console-snippets': { key: 'db.console.snippets.v1' },
  'apiclient-history': { key: 'apiclient.history.v1' },
  'apiclient-saved': { key: 'apiclient.saved.v1' },
  'apiclient-env': { key: 'apiclient.env.v1' },
  'db-erd-positions': { prefix: 'db.erd.pos.' },
  // supabase-js's session (sb-<project>-auth-token and its PKCE verifier):
  // signed in under one build, still signed in under the other.
  auth: { prefix: 'sb-', raw: true }
} satisfies Record<string, StoreSpec>

export type StoreName = keyof typeof STORES

/** Set in localStorage once this engine's entries were copied into the files. */
export const MIGRATED_KEY = 'riven.fileStore.migrated.v1'

/** True for a localStorage key whose data now lives in a store file. */
export function isMovedKey(key: string): boolean {
  if (key === MIGRATED_KEY) return true
  for (const s of Object.values(STORES) as StoreSpec[]) {
    if (s.key === key || (s.prefix && key.startsWith(s.prefix))) return true
  }
  return false
}

/** The value a store gets from localStorage-shaped entries, or undefined. */
export function fromEntries(spec: StoreSpec, entries: Record<string, string>): unknown {
  if (spec.key !== undefined) {
    const raw = entries[spec.key]
    if (raw == null) return undefined
    try {
      return JSON.parse(raw)
    } catch {
      return undefined
    }
  }
  if (spec.prefix) {
    const out: Record<string, unknown> = {}
    let any = false
    for (const [k, v] of Object.entries(entries)) {
      if (!k.startsWith(spec.prefix) || v == null) continue
      if (spec.raw) out[k] = v
      else {
        try {
          out[k.slice(spec.prefix.length)] = JSON.parse(v)
        } catch {
          continue
        }
      }
      any = true
    }
    return any ? out : undefined
  }
  return undefined
}

type Api = {
  loadAll(): Promise<Record<string, unknown>>
  save(name: string, data: unknown): Promise<void>
  saveSync(name: string, data: unknown): boolean
}

const cache = new Map<string, unknown>()
let hydrated = false
// Per file: the write on its way, and the newest value waiting behind it.
const writing = new Map<string, Promise<void>>()
const queued = new Map<string, unknown>()
let channel: BroadcastChannel | null = null

function api(): Api | null {
  return (globalThis as unknown as { window?: { api?: { store?: Api } } }).window?.api?.store ?? null
}

function lsEntries(): Record<string, string> {
  const out: Record<string, string> = {}
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k == null) continue
      const v = localStorage.getItem(k)
      if (v != null) out[k] = v
    }
  } catch {
    /* no storage */
  }
  return out
}

/**
 * Read every store file (and, the first time, move this engine's localStorage
 * entries into the files that do not exist yet). Must finish before anything
 * reads a store.
 */
export async function hydrateFileStore(): Promise<void> {
  if (hydrated) return
  const a = api()
  if (!a) {
    hydrated = true
    return
  }
  const files = await a.loadAll().catch((e) => {
    console.error('[fileStore] loading failed', e)
    return {} as Record<string, unknown>
  })
  for (const [k, v] of Object.entries(files)) cache.set(k, v)
  let moved = false
  try {
    moved = localStorage.getItem(MIGRATED_KEY) === '1'
  } catch {
    moved = true // no localStorage, nothing to move
  }
  if (!moved) {
    const entries = lsEntries()
    let ok = true
    for (const [name, spec] of Object.entries(STORES) as Array<[StoreName, StoreSpec]>) {
      if (name in files) continue
      const v = fromEntries(spec, entries)
      if (v === undefined) continue
      cache.set(name, v)
      try {
        await a.save(name, v)
      } catch (e) {
        ok = false
        console.error(`[fileStore] moving ${name} failed`, e)
      }
    }
    if (ok) {
      try {
        localStorage.setItem(MIGRATED_KEY, '1')
      } catch {
        /* tried again next start: files that exist by then are kept */
      }
    }
  }
  hydrated = true
  try {
    channel = new BroadcastChannel('riven-file-store')
    channel.onmessage = (e: MessageEvent<{ name: string; value: unknown }>): void => {
      if (e.data?.name) cache.set(e.data.name, e.data.value)
    }
  } catch {
    channel = null
  }
  window.addEventListener('beforeunload', flushFileStore)
}

export function storeGet<T>(name: StoreName): T | undefined {
  if (!hydrated && import.meta.env?.DEV) console.warn(`[fileStore] '${name}' read before hydrateFileStore()`)
  return cache.get(name) as T | undefined
}

function pump(name: string): void {
  const a = api()
  if (!a || writing.has(name) || !queued.has(name)) return
  const value = queued.get(name)
  queued.delete(name)
  const p = a
    .save(name, value ?? null)
    .catch((e) => console.error(`[fileStore] saving ${name} failed`, e))
    .finally(() => {
      writing.delete(name)
      pump(name)
    })
  writing.set(name, p)
}

/** Replace a store's value (undefined/null removes the file). */
export function storeSet(name: StoreName, value: unknown): void {
  // Before hydration nothing may be written: an empty start would replace the file.
  if (!hydrated) return
  if (cache.get(name) === value) return
  if (value === undefined || value === null) cache.delete(name)
  else cache.set(name, value)
  queued.set(name, value ?? null)
  pump(name)
  try {
    channel?.postMessage({ name, value: value ?? undefined })
  } catch {
    /* a value that cannot be cloned stays in this window only */
  }
}

/** One key of a prefix store ({ key: value }). */
export function storeMapGet<T>(name: StoreName, key: string): T | undefined {
  return (storeGet<Record<string, unknown>>(name) ?? {})[key] as T | undefined
}

export function storeMapSet(name: StoreName, key: string, value: unknown): void {
  const cur = storeGet<Record<string, unknown>>(name) ?? {}
  const next = { ...cur }
  if (value === undefined || value === null) delete next[key]
  else next[key] = value
  storeSet(name, Object.keys(next).length ? next : null)
}

/** Unload: anything not on disk yet is written synchronously. */
export function flushFileStore(): void {
  const a = api()
  if (!a) return
  for (const name of new Set([...writing.keys(), ...queued.keys()])) {
    a.saveSync(name, cache.has(name) ? cache.get(name) : null)
  }
  queued.clear()
}

/** Tests only. */
export function __resetFileStore(): void {
  cache.clear()
  writing.clear()
  queued.clear()
  hydrated = false
  channel?.close()
  channel = null
}
