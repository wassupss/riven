import { create } from 'zustand'
import { dbUid } from './db'
import { storeGet, storeSet, type StoreName } from '../lib/fileStore'

// The SQL console's query history (every run, newest first, capped) and saved
// snippets. Both live in userData/store (lib/fileStore; they were localStorage
// 'db.console.history.v1' / 'db.console.snippets.v1'); history writes are
// debounced so a burst of runs costs one write.

export interface HistoryEntry {
  id: string
  sql: string
  connId: string
  db?: string
  at: number
  ms?: number
  rows?: number | null
  error?: string
}

export interface Snippet {
  id: string
  name: string
  sql: string
  at: number
}

const LS_HISTORY: StoreName = 'db-console-history'
const LS_SNIPPETS: StoreName = 'db-console-snippets'
const MAX_HISTORY = 500
const MAX_SQL = 20_000

const read = <T>(k: StoreName): T[] => {
  const v = storeGet<T[]>(k)
  return Array.isArray(v) ? v : []
}

let saveTimer: ReturnType<typeof setTimeout> | null = null
const saveHistory = (list: HistoryEntry[]): void => {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    storeSet(LS_HISTORY, list)
  }, 500)
}

interface HistoryState {
  history: HistoryEntry[]
  snippets: Snippet[]
  record: (e: Omit<HistoryEntry, 'id' | 'at'>) => void
  removeHistory: (id: string) => void
  clearHistory: () => void
  saveSnippet: (name: string, sql: string) => void
  updateSnippet: (id: string, patch: Partial<Pick<Snippet, 'name' | 'sql'>>) => void
  removeSnippet: (id: string) => void
}

export const useDbHistory = create<HistoryState>((set, get) => ({
  history: read<HistoryEntry>(LS_HISTORY),
  snippets: read<Snippet>(LS_SNIPPETS),
  record: (e) => {
    const sql = e.sql.length > MAX_SQL ? e.sql.slice(0, MAX_SQL) : e.sql
    const prev = get().history
    // Re-running the newest query again moves nothing; it just updates the entry.
    const rest = prev[0] && prev[0].sql === sql && prev[0].connId === e.connId && prev[0].db === e.db ? prev.slice(1) : prev
    const history = [{ ...e, sql, id: dbUid(), at: Date.now() }, ...rest].slice(0, MAX_HISTORY)
    set({ history })
    saveHistory(history)
  },
  removeHistory: (id) => {
    const history = get().history.filter((h) => h.id !== id)
    set({ history })
    saveHistory(history)
  },
  clearHistory: () => {
    set({ history: [] })
    saveHistory([])
  },
  saveSnippet: (name, sql) => {
    const snippets = [...get().snippets, { id: dbUid(), name, sql, at: Date.now() }]
    set({ snippets })
    storeSet(LS_SNIPPETS, snippets)
  },
  updateSnippet: (id, patch) => {
    const snippets = get().snippets.map((s) => (s.id === id ? { ...s, ...patch, at: Date.now() } : s))
    set({ snippets })
    storeSet(LS_SNIPPETS, snippets)
  },
  removeSnippet: (id) => {
    const snippets = get().snippets.filter((s) => s.id !== id)
    set({ snippets })
    storeSet(LS_SNIPPETS, snippets)
  }
}))
