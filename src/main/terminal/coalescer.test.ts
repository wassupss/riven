import { describe, expect, it } from 'vitest'
import { OutputCoalescer, type CoalescerTimers, type CoalescedOutput } from './coalescer'

// A fake clock: timers fire only when `tick` advances past them.
function fakeTimers(): CoalescerTimers & { tick: (ms: number) => void } {
  let now = 1000
  let seq = 0
  const timers = new Map<number, { at: number; fn: () => void }>()
  return {
    now: () => now,
    setTimeout: (fn, ms) => {
      const id = ++seq
      timers.set(id, { at: now + ms, fn })
      return id
    },
    clearTimeout: (h) => {
      timers.delete(h as number)
    },
    tick: (ms) => {
      now += ms
      for (const [id, t] of [...timers]) {
        if (t.at <= now) {
          timers.delete(id)
          t.fn()
        }
      }
    }
  }
}

function setup(delay = 5, maxChars = 1000) {
  const t = fakeTimers()
  const out: CoalescedOutput[] = []
  const c = new OutputCoalescer(t, (o) => out.push(o), delay, maxChars)
  return { t, out, c }
}

describe('OutputCoalescer', () => {
  it('flushes the first chunk after a quiet spell immediately (leading edge)', () => {
    const { out, c } = setup()
    c.handle('a', 1)
    expect(out).toEqual([{ data: 'a', rev: 1 }])
  })

  it('batches a burst behind the trailing timer and carries the LAST revision', () => {
    const { t, out, c } = setup()
    c.handle('a', 1) // leading: out immediately
    c.handle('b', 2)
    c.handle('c', 3)
    expect(out).toHaveLength(1)
    t.tick(5)
    expect(out).toEqual([
      { data: 'a', rev: 1 },
      { data: 'bc', rev: 3 }
    ])
  })

  it('a keystroke echo after the window has passed does not wait', () => {
    const { t, out, c } = setup()
    c.handle('x', 1)
    t.tick(10)
    c.handle('y', 2)
    expect(out.map((o) => o.data)).toEqual(['x', 'y'])
  })

  it('flushes at once past maxChars regardless of the timer', () => {
    const { out, c } = setup(5, 4)
    c.handle('a', 1) // leading edge
    c.handle('bc', 2) // 2 pending → waits
    c.handle('de', 3) // 4 pending → immediate, no tick needed
    expect(out.map((o) => o.data)).toEqual(['a', 'bcde'])
    expect(out[1].rev).toBe(3)
  })

  it('markFlushed keeps the next chunk on the trailing path', () => {
    const { t, out, c } = setup()
    c.handle('a', 1)
    t.tick(10)
    c.markFlushed() // e.g. a snapshot just went out
    c.handle('b', 2)
    expect(out).toHaveLength(1)
    t.tick(5)
    expect(out).toHaveLength(2)
  })

  it('flush() with nothing pending is a no-op', () => {
    const { out, c } = setup()
    c.flush()
    expect(out).toEqual([])
  })
})
