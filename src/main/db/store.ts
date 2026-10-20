import { app, safeStorage } from 'electron'
import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { ConnectionConfig, ConnectionInfo } from './types'

// Saved data sources: userData/db/connections.json. Passwords are sealed with
// the OS keychain (safeStorage) into a separate map; when no real keychain is
// available they're kept for this session only and never written in plain text.

interface FileShape {
  version: 1
  connections: ConnectionConfig[]
  /** id -> base64 safeStorage blob */
  secrets: Record<string, string>
}

const sessionSecrets = new Map<string, string>()
let cache: FileShape | null = null

const dir = (): string => join(app.getPath('userData'), 'db')
const file = (): string => join(dir(), 'connections.json')

function canSeal(): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false
  if (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text') return false
  return true
}

function load(): FileShape {
  if (cache) return cache
  try {
    const raw = JSON.parse(readFileSync(file(), 'utf8')) as Partial<FileShape>
    cache = { version: 1, connections: raw.connections ?? [], secrets: raw.secrets ?? {} }
  } catch {
    cache = { version: 1, connections: [], secrets: {} }
  }
  return cache
}

function save(): void {
  const d = load()
  if (!existsSync(dir())) mkdirSync(dir(), { recursive: true })
  const tmp = file() + '.tmp'
  writeFileSync(tmp, JSON.stringify(d, null, 2), { mode: 0o600 })
  renameSync(tmp, file())
}

const info = (c: ConnectionConfig): ConnectionInfo => ({
  ...c,
  hasPassword: sessionSecrets.has(c.id) || c.id in load().secrets
})

export function listConnections(): ConnectionInfo[] {
  return load().connections.map(info)
}

export function getConnection(id: string): ConnectionConfig | undefined {
  return load().connections.find((c) => c.id === id)
}

export function getPassword(id: string): string | undefined {
  const s = sessionSecrets.get(id)
  if (s !== undefined) return s
  const blob = load().secrets[id]
  if (!blob || !canSeal()) return undefined
  try {
    return safeStorage.decryptString(Buffer.from(blob, 'base64'))
  } catch {
    return undefined
  }
}

/** Insert or update. password: string = set, '' or null = clear, undefined = keep. */
export function saveConnection(
  input: Omit<ConnectionConfig, 'id'> & { id?: string },
  password?: string | null
): ConnectionInfo {
  const d = load()
  const c: ConnectionConfig = { ...input, id: input.id || randomUUID() }
  const i = d.connections.findIndex((x) => x.id === c.id)
  if (i >= 0) d.connections[i] = c
  else d.connections.push(c)
  if (password !== undefined) {
    sessionSecrets.delete(c.id)
    delete d.secrets[c.id]
    if (password) {
      if (canSeal()) d.secrets[c.id] = safeStorage.encryptString(password).toString('base64')
      else sessionSecrets.set(c.id, password)
    }
  }
  save()
  return info(c)
}

export function deleteConnection(id: string): void {
  const d = load()
  d.connections = d.connections.filter((c) => c.id !== id)
  delete d.secrets[id]
  sessionSecrets.delete(id)
  save()
}

/** id, then exact name (case-insensitive), then a unique substring of the name. */
export function resolveConnection(ref: string): ConnectionConfig {
  const all = load().connections
  const byId = all.find((c) => c.id === ref)
  if (byId) return byId
  const q = ref.trim().toLowerCase()
  const exact = all.filter((c) => c.name.toLowerCase() === q)
  if (exact.length === 1) return exact[0]
  const sub = all.filter((c) => c.name.toLowerCase().includes(q))
  if (sub.length === 1) return sub[0]
  const names = all.map((c) => c.name).join(', ') || '(none)'
  if (exact.length + sub.length > 1)
    throw new Error(`Connection '${ref}' is ambiguous. Matches: ${(exact.length ? exact : sub).map((c) => c.name).join(', ')}`)
  throw new Error(`No connection named '${ref}'. Available: ${names}`)
}
