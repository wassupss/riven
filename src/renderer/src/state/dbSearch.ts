import { create } from 'zustand'
import type { SearchHit, SearchOptions } from '../../../main/db/dataSearchSql'
import { dbUid, useDb } from './db'

// Full data search runs, by console tab. Kept outside the view so a search
// keeps going (and its hits stay) while another tab is shown; closing the tab
// cancels it.

export interface SearchRun {
  searchId: string
  options: SearchOptions
  running: boolean
  done: number
  /** Undefined while the table list loads. */
  total?: number
  hits: SearchHit[]
  error?: string
  cancelled?: boolean
  startedAt: number
  ms?: number
}

interface SearchState {
  runs: Record<string, SearchRun>
  start: (tabId: string, connId: string, db: string | undefined, o: SearchOptions) => Promise<void>
  cancel: (tabId: string) => void
}

let listening = false

export const useDbSearch = create<SearchState>((set, get) => {
  const patch = (tabId: string, searchId: string, p: Partial<SearchRun> | ((r: SearchRun) => Partial<SearchRun>)): void =>
    set((s) => {
      const r = s.runs[tabId]
      // A newer search replaced this one: its late events are dropped.
      if (!r || r.searchId !== searchId) return s
      return { runs: { ...s.runs, [tabId]: { ...r, ...(typeof p === 'function' ? p(r) : p) } } }
    })

  const listen = (): void => {
    if (listening) return
    listening = true
    window.api.db.search.onProgress((searchId, p) => {
      const tabId = Object.keys(get().runs).find((k) => get().runs[k].searchId === searchId)
      if (!tabId) return
      patch(tabId, searchId, (r) => ({ done: p.done, total: p.total, hits: p.hit ? [...r.hits, p.hit] : r.hits }))
    })
    // Closing a tab stops its search.
    useDb.subscribe((s, prev) => {
      if (s.tabs === prev.tabs) return
      const open = new Set(s.tabs.map((x) => x.id))
      const gone = Object.keys(get().runs).filter((k) => !open.has(k))
      if (!gone.length) return
      for (const k of gone) if (get().runs[k].running) void window.api.db.search.cancel(get().runs[k].searchId)
      set((st) => ({ runs: Object.fromEntries(Object.entries(st.runs).filter(([k]) => open.has(k))) }))
    })
  }

  return {
    runs: {},
    start: async (tabId, connId, db, o) => {
      listen()
      const prev = get().runs[tabId]
      if (prev?.running) void window.api.db.search.cancel(prev.searchId)
      const searchId = dbUid()
      const startedAt = performance.now()
      set((s) => ({ runs: { ...s.runs, [tabId]: { searchId, options: o, running: true, done: 0, hits: [], startedAt } } }))
      try {
        const sum = await window.api.db.search.run(connId, db, o, searchId)
        patch(tabId, searchId, { running: false, done: sum.done, total: sum.total, cancelled: sum.cancelled, ms: performance.now() - startedAt })
      } catch (e) {
        const msg = e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e)
        patch(tabId, searchId, { running: false, error: msg, ms: performance.now() - startedAt })
      }
    },
    cancel: (tabId) => {
      const r = get().runs[tabId]
      if (!r?.running) return
      void window.api.db.search.cancel(r.searchId)
      patch(tabId, r.searchId, { running: false, cancelled: true, ms: performance.now() - r.startedAt })
    }
  }
})
