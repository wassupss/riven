import { describe, it, expect } from 'vitest'
import { nextMounted } from './mountPolicy'

const none = new Set<string>()
const MAX = 3

describe('nextMounted', () => {
  it('mounts the active workspace and keeps LRU order', () => {
    let m = nextMounted([], 'a', ['a', 'b', 'c'], none, MAX)
    expect(m).toEqual(['a'])
    m = nextMounted(m, 'b', ['a', 'b', 'c'], none, MAX)
    expect(m).toEqual(['a', 'b'])
    m = nextMounted(m, 'a', ['a', 'b', 'c'], none, MAX)
    expect(m).toEqual(['b', 'a']) // re-activating moves it to the end
  })

  it('drops the least-recent past the cap', () => {
    const m = nextMounted(['a', 'b', 'c'], 'd', ['a', 'b', 'c', 'd'], none, MAX)
    expect(m).toEqual(['b', 'c', 'd'])
  })

  it('forgets a workspace the user closed', () => {
    const m = nextMounted(['a', 'b'], 'c', ['b', 'c'], none, MAX)
    expect(m).toEqual(['b', 'c'])
  })

  // The bug: two chat panes mid-turn were unmounted by a couple of workspace
  // switches, and came back idle with the streamed reply gone.
  it('holds a workspace that has a pane mid-turn', () => {
    const m = nextMounted(['a', 'b', 'c'], 'd', ['a', 'b', 'c', 'd'], new Set(['a']), MAX)
    expect(m).toEqual(['a', 'b', 'c', 'd'])
  })

  it('releases it once the turn ends', () => {
    const busy = nextMounted(['a', 'b', 'c'], 'd', ['a', 'b', 'c', 'd'], new Set(['a']), MAX)
    const idle = nextMounted(busy, 'e', ['a', 'b', 'c', 'd', 'e'], none, MAX)
    expect(idle).toEqual(['c', 'd', 'e'])
  })

  it('holds several at once without disturbing the cap', () => {
    const m = nextMounted(['a', 'b', 'c', 'd'], 'e', ['a', 'b', 'c', 'd', 'e'], new Set(['a', 'b']), MAX)
    expect(m).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  it('does not resurrect a busy workspace that was already unmounted', () => {
    const m = nextMounted(['b', 'c'], 'd', ['a', 'b', 'c', 'd'], new Set(['a']), MAX)
    expect(m).toEqual(['b', 'c', 'd'])
  })

  it('does not duplicate the active workspace when it is itself busy', () => {
    const m = nextMounted(['a', 'b', 'c'], 'a', ['a', 'b', 'c'], new Set(['a']), MAX)
    expect(m).toEqual(['b', 'c', 'a'])
  })
})
