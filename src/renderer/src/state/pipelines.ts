import { create } from 'zustand'

// Saved pipeline definitions (persisted, like agent groups). A pipeline is a named
// ordered list of stages; you create it once, then run it (with a task) as many
// times as you like and control the run from its tab. Runs themselves are the
// ephemeral [[pipelineRuns]] instances.

export interface PipelineStageDef {
  name: string
  model: string
  role: string
  agent: string
}

export interface PipelineDef {
  id: string
  name: string
  stages: PipelineStageDef[]
}

type Store = Record<string, PipelineDef[]> // keyed by workspace

const LS_KEY = 'pipelines:v1'

function load(): Store {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (raw) return JSON.parse(raw) as Store
  } catch {
    /* ignore */
  }
  return {}
}

function persist(store: Store): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(store))
  } catch {
    /* ignore */
  }
}

interface State {
  byWorkspace: Store
  create: (ws: string, name: string, stages: PipelineStageDef[]) => string
  update: (ws: string, id: string, patch: Partial<Omit<PipelineDef, 'id'>>) => void
  remove: (ws: string, id: string) => void
}

export const usePipelines = create<State>((set) => ({
  byWorkspace: load(),
  create: (ws, name, stages) => {
    const id = `pl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
    set((s) => {
      const list = [...(s.byWorkspace[ws] ?? []), { id, name, stages }]
      const next = { ...s.byWorkspace, [ws]: list }
      persist(next)
      return { byWorkspace: next }
    })
    return id
  },
  update: (ws, id, patch) =>
    set((s) => {
      const list = (s.byWorkspace[ws] ?? []).map((p) => (p.id === id ? { ...p, ...patch } : p))
      const next = { ...s.byWorkspace, [ws]: list }
      persist(next)
      return { byWorkspace: next }
    }),
  remove: (ws, id) =>
    set((s) => {
      const list = (s.byWorkspace[ws] ?? []).filter((p) => p.id !== id)
      const next = { ...s.byWorkspace, [ws]: list }
      persist(next)
      return { byWorkspace: next }
    })
}))
