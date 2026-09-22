import { create } from 'zustand'
import { useSession } from './session'

// A running (or finished) pipeline instance. It shows up as its own tab in the
// Agent Group panel, like a group, with each stage's live status.
//
// Saved with its workspace so the tabs are still there after a restart. The loop
// that drives a run lives in this renderer, so it does NOT survive: anything
// still going when the app closed is marked interrupted when it loads, rather
// than restored as "running" and waited on forever.

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

/** A run whose driver died with the process: finished, and honest about it. */
export function interruptStale(runs: PipelineRun[]): PipelineRun[] {
  return runs.map((r) =>
    r.done
      ? r
      : {
          ...r,
          done: true,
          canceled: true,
          current: -1,
          stages: r.stages.map((st) =>
            st.status === 'running' || st.status === 'pending' ? { ...st, status: 'error' as StageStatus } : st
          )
        }
  )
}

function persist(ws: string): void {
  adopt()
  const st = useSession.getState()
  if (!st.ready) return // never write an empty list over runs still being loaded
  st.patch(ws, { runs: usePipelineRuns.getState().runs.filter((r) => r.workspace === ws) })
}

let adopted = false
function adopt(): void {
  if (adopted) return
  const st = useSession.getState()
  if (!st.ready) return
  adopted = true
  const restored: PipelineRun[] = []
  for (const s of Object.values(st.sessions)) restored.push(...interruptStale((s.runs ?? []) as PipelineRun[]))
  if (restored.length) usePipelineRuns.setState({ runs: restored })
}
useSession.subscribe(adopt)
adopt()

// Save after any change, per workspace. Cheap (a run is a handful of strings)
// and keeps the tabs and their outcome across restarts.
usePipelineRuns.subscribe((s, prev) => {
  if (s.runs === prev.runs) return
  const touched = new Set([...s.runs, ...prev.runs].map((r) => r.workspace))
  for (const ws of touched) persist(ws)
})
