import { create } from 'zustand'
import { useSession } from './session'
import { isDue, nextRun, type Trigger } from '../lib/schedule'

// Scheduled agent work.
//
// riven could already put a message into a pane at a future time, but only that:
// one prompt, to one pane that had to be open, with no record of whether it ever
// ran. A schedule people actually rely on ("every weekday at 9, summarise what
// changed and open a PR") needs the rest of it — somewhere to run when no pane
// is open, a note of what happened each time, and the honesty to say a run was
// missed rather than silently skipping it.
//
// The app is not a daemon: nothing fires while riven is closed. A job that came
// due during that time runs once, when riven comes back, if it is still recent
// enough to be worth doing (lib/schedule's grace). Anything older is reported as
// missed, which is information, where a silent no-op is not.

export type JobTarget =
  /** Send it to a pane that already exists — the "remind this agent" case. */
  | { kind: 'pane'; chatKey: string; title: string }
  /** Open a fresh chat for each run: no carried-over context, nothing to be open. */
  | { kind: 'new'; cli: 'claude' | 'codex'; model?: string }

export type RunStatus = 'ok' | 'failed' | 'missed'

export interface JobRun {
  at: number
  status: RunStatus
  /** Why it failed, or which pane it went to. */
  note?: string
}

export interface Job {
  id: string
  workspace: string
  name: string
  prompt: string
  trigger: Trigger
  target: JobTarget
  enabled: boolean
  /** How late a missed run may be and still be worth doing, in minutes. */
  graceMinutes: number
  createdAt: number
  lastRunAt?: number
  runs: JobRun[]
}

/** Enough to explain what happened without becoming a log file. */
export const RUNS_KEPT = 20

type Store = Record<string, Job[]>

function persist(store: Store, ws: string): void {
  adopt()
  const st = useSession.getState()
  if (!st.ready) return
  st.patch(ws, { jobs: store[ws] ?? [] })
}

// Sessions load asynchronously; adopt what the tree holds the moment it is
// there. Writing before that would persist "no jobs" over the real ones — the
// mistake this exact pattern was written to stop in agentGroups.
let adopted = false
function adopt(): void {
  if (adopted) return
  const st = useSession.getState()
  if (!st.ready) return
  adopted = true
  const fromTree: Store = {}
  for (const [ws, s] of Object.entries(st.sessions)) {
    const jobs = (s.jobs ?? []) as Job[]
    if (jobs.length) fromTree[ws] = jobs
  }
  if (Object.keys(fromTree).length) useJobs.setState({ byWorkspace: fromTree })
}
useSession.subscribe(adopt)
adopt()

interface JobsState {
  byWorkspace: Store
  add: (ws: string, job: Omit<Job, 'id' | 'createdAt' | 'runs' | 'workspace'>) => string
  update: (ws: string, id: string, patch: Partial<Job>) => void
  remove: (ws: string, id: string) => void
  /** Record an attempt and move the job's clock forward. */
  recordRun: (ws: string, id: string, run: JobRun) => void
}

const EMPTY: Job[] = []

export const useJobs = create<JobsState>((set) => ({
  byWorkspace: {},
  add: (ws, job) => {
    const id = `job_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
    set((st) => {
      const next = {
        ...st.byWorkspace,
        [ws]: [...(st.byWorkspace[ws] ?? []), { ...job, id, workspace: ws, createdAt: Date.now(), runs: [] }]
      }
      persist(next, ws)
      return { byWorkspace: next }
    })
    return id
  },
  update: (ws, id, patch) =>
    set((st) => {
      const next = {
        ...st.byWorkspace,
        [ws]: (st.byWorkspace[ws] ?? []).map((j) => (j.id === id ? { ...j, ...patch } : j))
      }
      persist(next, ws)
      return { byWorkspace: next }
    }),
  remove: (ws, id) =>
    set((st) => {
      const next = { ...st.byWorkspace, [ws]: (st.byWorkspace[ws] ?? []).filter((j) => j.id !== id) }
      persist(next, ws)
      return { byWorkspace: next }
    }),
  recordRun: (ws, id, run) =>
    set((st) => {
      const next = {
        ...st.byWorkspace,
        [ws]: (st.byWorkspace[ws] ?? []).map((j) =>
          j.id === id
            ? {
                ...j,
                // The clock moves on a MISSED run too: otherwise the same missed
                // slot is rediscovered on every tick and reported for ever.
                lastRunAt: run.at,
                runs: [...j.runs, run].slice(-RUNS_KEPT),
                // A one-shot has done all it will ever do.
                enabled: j.trigger.kind === 'once' ? false : j.enabled
              }
            : j
        )
      }
      persist(next, ws)
      return { byWorkspace: next }
    })
}))

export function jobsFor(ws: string): Job[] {
  return useJobs.getState().byWorkspace[ws] ?? EMPTY
}

/** When this job fires next, or null if nothing is scheduled (a spent one-shot). */
export function nextRunOf(job: Job, now = Date.now()): number | null {
  if (!job.enabled) return null
  return nextRun(job.trigger, Math.max(now, job.lastRunAt ?? 0), job.createdAt)
}

/** Every job whose moment has arrived, across all workspaces. */
export function dueJobs(now = Date.now()): Job[] {
  const out: Job[] = []
  for (const jobs of Object.values(useJobs.getState().byWorkspace)) {
    for (const job of jobs) {
      if (!job.enabled) continue
      if (isDue(job.trigger, now, {
        lastRunAt: job.lastRunAt,
        createdAt: job.createdAt,
        graceMs: Math.max(0, job.graceMinutes) * 60_000
      }))
        out.push(job)
    }
  }
  return out
}

/**
 * A slot that came and went while riven was closed, and is now too old to run.
 *
 * Said out loud rather than skipped silently: "it didn't run" is the one thing
 * someone relying on a schedule has to be able to find out.
 */
export function missedJobs(now = Date.now()): Job[] {
  const out: Job[] = []
  for (const jobs of Object.values(useJobs.getState().byWorkspace)) {
    for (const job of jobs) {
      if (!job.enabled || job.trigger.kind === 'once') continue
      const since = job.lastRunAt ?? job.createdAt
      const slotBefore = nextRun(job.trigger, since, job.createdAt)
      if (slotBefore == null) continue
      const tooOld = now - slotBefore > Math.max(0, job.graceMinutes) * 60_000
      if (slotBefore <= now && tooOld) out.push(job)
    }
  }
  return out
}
