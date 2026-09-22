import { describe, it, expect } from 'vitest'
import { addEdge, dropEdge, wouldCycle, type AskEdges } from './askGraph'

const edges = (...pairs: Array<[string, string]>): AskEdges => {
  const e: AskEdges = new Map()
  for (const [a, b] of pairs) addEdge(e, a, b)
  return e
}

describe('wouldCycle', () => {
  it('catches the pair that deadlocks: lead waits on member, member asks back', () => {
    expect(wouldCycle(edges(['lead', 'member']), 'member', 'lead')).toBe(true)
  })

  it('catches a longer ring', () => {
    expect(wouldCycle(edges(['a', 'b'], ['b', 'c']), 'c', 'a')).toBe(true)
  })

  it('refuses to let an agent wait on itself', () => {
    expect(wouldCycle(new Map(), 'a', 'a')).toBe(true)
  })

  it('allows a fan-out and a chain that does not close', () => {
    const e = edges(['lead', 'one'], ['lead', 'two'])
    expect(wouldCycle(e, 'lead', 'three')).toBe(false)
    expect(wouldCycle(e, 'one', 'two')).toBe(false)
  })

  it('stops caring once the wait is over', () => {
    const e = edges(['lead', 'member'])
    dropEdge(e, 'lead', 'member')
    expect(wouldCycle(e, 'member', 'lead')).toBe(false)
    expect(e.size).toBe(0)
  })

  it('survives a ring in the edges themselves without spinning', () => {
    expect(wouldCycle(edges(['a', 'b'], ['b', 'a']), 'c', 'a')).toBe(false)
  })
})
