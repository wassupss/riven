import { describe, expect, it } from 'vitest'
import { timelineFor, unseenFor, type TimelineEntry } from './agentEdits'

// The changes timeline is ONE list for the whole app (entries carry the
// workspace they belong to). Every reader must scope itself, or one project's
// status pill reports another project's edits.

const entry = (workspace: string, path: string, at: number): TimelineEntry => ({
  path,
  workspace,
  at,
  added: 1,
  removed: 0,
  isNew: false
})

const timeline = [
  entry('ws-a', '/a/one.ts', 300),
  entry('ws-b', '/b/two.ts', 200),
  entry('ws-a', '/a/three.ts', 100)
]

describe('timelineFor', () => {
  it('returns only the given workspace, in order', () => {
    expect(timelineFor(timeline, 'ws-a').map((e) => e.path)).toEqual(['/a/one.ts', '/a/three.ts'])
    expect(timelineFor(timeline, 'ws-b').map((e) => e.path)).toEqual(['/b/two.ts'])
  })

  it('is empty with no workspace, rather than everything', () => {
    expect(timelineFor(timeline, null)).toEqual([])
  })
})

describe('unseenFor', () => {
  it('counts only entries newer than that workspace’s last look', () => {
    expect(unseenFor(timeline, {}, 'ws-a')).toBe(2)
    expect(unseenFor(timeline, { 'ws-a': 150 }, 'ws-a')).toBe(1)
    expect(unseenFor(timeline, { 'ws-a': 300 }, 'ws-a')).toBe(0)
  })

  it('reading one workspace does not clear another', () => {
    const seen = { 'ws-a': 999 }
    expect(unseenFor(timeline, seen, 'ws-a')).toBe(0)
    expect(unseenFor(timeline, seen, 'ws-b')).toBe(1)
  })

  it('is zero with no workspace', () => {
    expect(unseenFor(timeline, {}, null)).toBe(0)
  })
})
