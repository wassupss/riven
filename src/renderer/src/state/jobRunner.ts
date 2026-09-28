import { addChat } from '../dock/registry'
import { resolveAgent } from './agents'
import { dueJobs, missedJobs, useJobs, type Job } from './jobs'

// Firing the scheduled jobs.
//
// Kept apart from the store so the store stays a plain record of intent (what
// should happen, when) and this holds the awkward part: the pane may be closed,
// the workspace may not be mounted, and the app may have been shut through the
// moment the job was meant to run.

const TICK_MS = 20_000
/** Long enough for the dock to have restored its panes before anything fires. */
const SETTLE_MS = 8_000

function notify(title: string, body: string): void {
  try {
    window.api.notify.show(title, body)
  } catch {
    /* a missing notifier must never take the runner down */
  }
}

/** Deliver a job's prompt, returning what to record about the attempt. */
export function runJob(job: Job): { status: 'ok' | 'failed'; note?: string } {
  if (job.target.kind === 'pane') {
    // By key first, then by title: a pane reopened after a restart keeps its
    // name but not always its key, and the name is what the user recognises.
    const agent = resolveAgent(job.target.chatKey, undefined, job.workspace) ??
      resolveAgent(job.target.title, undefined, job.workspace)
    if (!agent) {
      return {
        status: 'failed',
        note: `"${job.target.title}" 패널이 열려 있지 않아 보내지 못했습니다`
      }
    }
    agent.send(job.prompt)
    return { status: 'ok', note: agent.getTitle() }
  }
  // A fresh pane per run: the job's prompt is the pane's opening message, so it
  // starts with no context from any previous run — which is the point of asking
  // for a new one.
  const key = addChat(
    job.prompt,
    'right',
    job.target.model && job.target.model !== 'default' ? job.target.model : undefined,
    undefined,
    job.name,
    true, // never steal focus: a schedule fires while the user is doing something else
    undefined,
    undefined,
    job.workspace,
    job.target.cli
  )
  if (!key) {
    return { status: 'failed', note: '워크스페이스가 열려 있지 않아 패널을 만들지 못했습니다' }
  }
  return { status: 'ok', note: key }
}

let started = false
export function startJobRunner(): void {
  if (started) return
  started = true
  const tick = (): void => {
    const now = Date.now()
    const store = useJobs.getState()
    // Reported before it is forgotten: recordRun moves the clock past the slot,
    // so a missed run that was never written down cannot be found again.
    for (const job of missedJobs(now)) {
      store.recordRun(job.workspace, job.id, {
        at: now,
        status: 'missed',
        note: 'riven이 꺼져 있는 동안 지나갔습니다'
      })
      notify('예약 작업을 놓쳤습니다', job.name)
    }
    for (const job of dueJobs(now)) {
      const result = runJob(job)
      store.recordRun(job.workspace, job.id, { at: Date.now(), ...result })
      if (result.status === 'failed') notify('예약 작업 실패', `${job.name}: ${result.note ?? ''}`)
    }
  }
  setInterval(tick, TICK_MS)
  // Not immediately: at startup the panes a job targets are still being
  // restored, and a job that fires into that gap fails for no reason but haste.
  setTimeout(tick, SETTLE_MS)
}
