import { create } from 'zustand'

// A running (or finished) pipeline instance. Unlike agent groups these are NOT
// persisted — a run is an ephemeral execution that the user watches progress on.
// It shows up as its own tab in the Agent Group panel, like a group, with each
// stage's live status.

export type StageStatus = 'pending' | 'running' | 'done' | 'error'

export interface RunStage {
  name: string
  model: string
  role: string
  agent: string
  status: StageStatus
  chatKey?: string
}

export interface PipelineRun {
  id: string
  workspace: string
  pipelineId: string | null // the saved pipeline this run came from (if any)
  name: string
  task: string
  stages: RunStage[]
  current: number // index of the running stage, -1 when idle/done
  done: boolean
  canceled: boolean
  startedAt: number
}

interface State {
  runs: PipelineRun[]
  start: (
    workspace: string,
    pipelineId: string | null,
    name: string,
    task: string,
    stages: Array<Omit<RunStage, 'status'>>
  ) => string
  setStage: (id: string, idx: number, patch: Partial<RunStage>) => void
  setCurrent: (id: string, idx: number) => void
  finish: (id: string) => void
  cancel: (id: string) => void
  isCanceled: (id: string) => boolean
  remove: (id: string) => void
}

export const usePipelineRuns = create<State>((set, get) => ({
  runs: [],
  start: (workspace, pipelineId, name, task, stages) => {
    const id = `pr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
    set((s) => ({
      runs: [
        ...s.runs,
        {
          id,
          workspace,
          pipelineId,
          name,
          task,
          stages: stages.map((st) => ({ ...st, status: 'pending' as StageStatus })),
          current: -1,
          done: false,
          canceled: false,
          startedAt: Date.now()
        }
      ]
    }))
    return id
  },
  setStage: (id, idx, patch) =>
    set((s) => ({
      runs: s.runs.map((r) =>
        r.id === id
          ? { ...r, stages: r.stages.map((st, i) => (i === idx ? { ...st, ...patch } : st)) }
          : r
      )
    })),
  setCurrent: (id, idx) =>
    set((s) => ({ runs: s.runs.map((r) => (r.id === id ? { ...r, current: idx } : r)) })),
  finish: (id) =>
    set((s) => ({ runs: s.runs.map((r) => (r.id === id ? { ...r, done: true, current: -1 } : r)) })),
  // Mark canceled and flip any not-yet-finished stage to error, so the run view
  // reflects the stop immediately. The run loop polls isCanceled() to break.
  cancel: (id) =>
    set((s) => ({
      runs: s.runs.map((r) =>
        r.id === id
          ? {
              ...r,
              canceled: true,
              done: true,
              current: -1,
              stages: r.stages.map((st) =>
                st.status === 'running' || st.status === 'pending'
                  ? { ...st, status: 'error' as StageStatus }
                  : st
              )
            }
          : r
      )
    })),
  isCanceled: (id) => get().runs.find((r) => r.id === id)?.canceled ?? true,
  remove: (id) => set((s) => ({ runs: s.runs.filter((r) => r.id !== id) }))
}))

export function runsForWorkspace(ws: string): PipelineRun[] {
  return usePipelineRuns.getState().runs.filter((r) => r.workspace === ws)
}
