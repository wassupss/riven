import { create } from 'zustand'
import { storeGet, storeSet } from '../lib/fileStore'

// Saved pipeline definitions (persisted, like agent groups). A pipeline is a named
// ordered list of stages; you create it once, then run it (with a task) as many
// times as you like and control the run from its tab. Runs themselves are the
// ephemeral [[pipelineRuns]] instances. Kept in userData/store/pipelines.json
// (lib/fileStore; it was localStorage 'pipelines:v1').

export interface PipelineStageDef {
  name: string
  // Which agent runs this stage (claude | codex). Absent = claude, so pipelines
  // saved before stages could pick are unchanged.
  cli?: 'claude' | 'codex'
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

function load(): Store {
  const v = storeGet<Store>('pipelines')
  return v && typeof v === 'object' ? v : {}
}

function persist(store: Store): void {
  storeSet('pipelines', store)
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
