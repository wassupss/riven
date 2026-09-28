import { beforeEach, describe, expect, it, vi } from 'vitest'

// The session tree is the persistence layer, and it touches `window` at import.
// These tests are about the schedule, not about where it is written down.
vi.mock('./session', () => ({
  useSession: { getState: () => ({ ready: false, patch: vi.fn(), sessions: {} }), subscribe: vi.fn() }
}))

const { dueJobs, missedJobs, useJobs, fromLegacy, RUNS_KEPT } = await import('./jobs')
type Job = import('./jobs').Job

// A schedule people rely on has to be honest about three things: that a run
// happened, that it happened once, and that one was missed. These pin all three
// without touching a pane.

const WS = '/w'
const HOUR = 3_600_000

function job(over: Partial<Job> = {}): Job {
  return {
    id: 'j1',
    workspace: WS,
    name: '아침 요약',
    prompt: '어제 바뀐 것 요약해줘',
    trigger: { kind: 'daily', hour: 9, minute: 0 },
    target: { kind: 'new', cli: 'claude' },
    enabled: true,
    graceMinutes: 60,
    createdAt: new Date('2026-03-01T00:00').getTime(),
    runs: [],
    ...over
  }
}

const put = (...jobs: Job[]): void => useJobs.setState({ byWorkspace: { [WS]: jobs } })
const at = (iso: string): number => new Date(iso).getTime()

beforeEach(() => useJobs.setState({ byWorkspace: {} }))

describe('dueJobs', () => {
  it('finds the job whose time has come', () => {
    put(job())
    expect(dueJobs(at('2026-03-02T09:00')).map((j) => j.id)).toEqual(['j1'])
    expect(dueJobs(at('2026-03-02T08:00'))).toEqual([])
  })

  it('leaves a disabled job alone', () => {
    put(job({ enabled: false }))
    expect(dueJobs(at('2026-03-02T09:00'))).toEqual([])
  })

  it('does not run the same slot twice', () => {
    put(job({ lastRunAt: at('2026-03-02T09:00') }))
    expect(dueJobs(at('2026-03-02T09:30'))).toEqual([])
  })
})

describe('missedJobs', () => {
  it('reports a slot that went past while riven was closed', () => {
    put(job({ lastRunAt: at('2026-03-01T09:00') }))
    // Back at the machine in the afternoon: 9am is long gone.
    expect(missedJobs(at('2026-03-02T16:00')).map((j) => j.id)).toEqual(['j1'])
  })

  it('says nothing about a slot still inside its grace — that one RUNS', () => {
    put(job({ lastRunAt: at('2026-03-01T09:00') }))
    const now = at('2026-03-02T09:30')
    expect(missedJobs(now)).toEqual([])
    expect(dueJobs(now).map((j) => j.id)).toEqual(['j1'])
  })

  it('never reports a one-shot as missed — it is still owed', () => {
    put(job({ trigger: { kind: 'once', at: at('2026-03-01T09:00') } }))
    const now = at('2026-03-05T12:00')
    expect(missedJobs(now)).toEqual([])
    expect(dueJobs(now).map((j) => j.id)).toEqual(['j1'])
  })
})

describe('recordRun', () => {
  it('moves the clock so a missed slot is reported once, not for ever', () => {
    put(job({ lastRunAt: at('2026-03-01T09:00') }))
    const now = at('2026-03-02T16:00')
    useJobs.getState().recordRun(WS, 'j1', { at: now, status: 'missed' })
    expect(missedJobs(now)).toEqual([])
  })

  it('retires a one-shot after it fires', () => {
    put(job({ trigger: { kind: 'once', at: at('2026-03-01T09:00') } }))
    useJobs.getState().recordRun(WS, 'j1', { at: Date.now(), status: 'ok' })
    expect(useJobs.getState().byWorkspace[WS][0].enabled).toBe(false)
  })

  it('keeps the recent history, not all of it', () => {
    put(job())
    for (let i = 0; i < RUNS_KEPT + 5; i++) {
      useJobs.getState().recordRun(WS, 'j1', { at: i * HOUR, status: 'ok' })
    }
    const { runs } = useJobs.getState().byWorkspace[WS][0]
    expect(runs).toHaveLength(RUNS_KEPT)
    expect(runs[runs.length - 1].at).toBe((RUNS_KEPT + 4) * HOUR)
  })
})

describe('fromLegacy', () => {
  // The old per-pane "메시지 예약" stored a TIMESTAMP and a repeat word. Carried
  // over as rules, because a timestamp is what rots while the app is closed.
  const legacy = {
    id: 'sch_1',
    workspace: WS,
    chatKey: 'chat-7',
    targetTitle: '코더',
    text: '빌드 돌려줘\n두 번째 줄',
    fireAt: at('2026-03-02T09:30'),
    repeat: 'none' as const
  }

  it('keeps the message, the pane it was for, and its id', () => {
    const [job] = fromLegacy([legacy])
    expect(job.id).toBe('sch_1') // same id: carried twice would be worse
    expect(job.prompt).toBe('빌드 돌려줘\n두 번째 줄')
    expect(job.name).toBe('빌드 돌려줘') // first line, for the list
    expect(job.target).toEqual({ kind: 'pane', chatKey: 'chat-7', title: '코더' })
    expect(job.enabled).toBe(true)
  })

  it('turns a one-off into a one-shot at the same moment', () => {
    expect(fromLegacy([legacy])[0].trigger).toEqual({ kind: 'once', at: at('2026-03-02T09:30') })
  })

  it('turns "hourly" into the minute it was set for', () => {
    expect(fromLegacy([{ ...legacy, repeat: 'hourly' }])[0].trigger).toEqual({ kind: 'hourly', minute: 30 })
  })

  it('turns "daily" into that clock time', () => {
    expect(fromLegacy([{ ...legacy, repeat: 'daily' }])[0].trigger).toEqual({
      kind: 'daily',
      hour: 9,
      minute: 30
    })
  })
})
