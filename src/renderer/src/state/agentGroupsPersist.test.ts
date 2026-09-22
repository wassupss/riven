import { describe, it, expect, vi, beforeEach } from 'vitest'

// A session store we can drive: not ready at first (as at launch), then ready
// with a workspace whose tree already holds a roster.
const patch = vi.fn()
let state: { ready: boolean; sessions: Record<string, { groups?: unknown[] }>; patch: typeof patch } = {
  ready: false,
  sessions: {},
  patch
}
const subscribers: Array<() => void> = []
vi.mock('./session', () => ({
  useSession: {
    getState: () => state,
    subscribe: (fn: () => void) => {
      subscribers.push(fn)
      return () => undefined
    }
  }
}))

const { useAgentGroups } = await import('./agentGroups')

const member = { name: 'A', persona: null, model: 'default', parent: null, chatKey: 'chat-1' }

describe('roster persistence', () => {
  beforeEach(() => patch.mockClear())

  it('does not write anything before the sessions have loaded', () => {
    useAgentGroups.getState().createGroup('/w', 'early', [member])
    expect(patch).not.toHaveBeenCalled()
  })

  it('adopts what the tree holds once it is ready', () => {
    state = {
      ready: true,
      sessions: { '/w': { groups: [{ group: 'saved', members: [member] }] } },
      patch
    }
    subscribers.forEach((fn) => fn())
    expect(useAgentGroups.getState().byWorkspace['/w'].map((g) => g.group)).toEqual(['saved'])
  })

  it('writes to the tree after that', () => {
    useAgentGroups.getState().createGroup('/w', 'later', [member])
    expect(patch).toHaveBeenCalledWith('/w', {
      groups: [{ group: 'saved', members: [member] }, { group: 'later', members: [member] }]
    })
  })
})
