import { describe, it, expect, vi } from 'vitest'

vi.mock('./session', () => ({
  useSession: { getState: () => ({ patch: vi.fn(), ready: false, sessions: {} }), subscribe: vi.fn() }
}))

const { interruptStale } = await import('./pipelineRuns')

const run = (over: Record<string, unknown> = {}): never =>
  ({
    id: 'r1',
    workspace: '/w',
    pipelineId: null,
    name: 'p',
    task: 't',
    stages: [
      { name: 'a', model: '', role: '', agent: '', status: 'done' },
      { name: 'b', model: '', role: '', agent: '', status: 'running' },
      { name: 'c', model: '', role: '', agent: '', status: 'pending' }
    ],
    current: 1,
    done: false,
    canceled: false,
    startedAt: 0,
    ...over
  }) as never

describe('interruptStale', () => {
  it('ends a run whose driver died with the app, and says so', () => {
    const [r] = interruptStale([run()])
    expect({ done: r.done, canceled: r.canceled, current: r.current }).toEqual({
      done: true,
      canceled: true,
      current: -1
    })
    expect(r.stages.map((s) => s.status)).toEqual(['done', 'error', 'error'])
  })

  it('leaves a finished run exactly as it was', () => {
    const done = run({ done: true, current: -1 })
    expect(interruptStale([done])[0]).toBe(done)
  })
})
