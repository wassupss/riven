import { describe, it, expect, vi } from 'vitest'

vi.mock('./session', () => ({ useSession: { getState: () => ({ patch: vi.fn() }), subscribe: vi.fn() } }))

const { mergeRosters } = await import('./agentGroups')

const g = (name: string): { group: string; members: [] } => ({ group: name, members: [] })

describe('mergeRosters', () => {
  it('prefers what the workspace tree holds', () => {
    expect(mergeRosters({ '/a': [g('tree')] }, { '/a': [g('old')] })['/a']).toEqual([g('tree')])
  })

  it('adopts the old store for a workspace the tree has nothing for', () => {
    expect(mergeRosters({ '/a': [] }, { '/a': [g('old')] })['/a']).toEqual([g('old')])
  })

  it('keeps groups of a workspace that is not open right now', () => {
    expect(mergeRosters({}, { '/closed': [g('old')] })['/closed']).toEqual([g('old')])
  })

  it('is empty when both are', () => {
    expect(mergeRosters({ '/a': [] }, {})).toEqual({ '/a': [] })
  })
})
