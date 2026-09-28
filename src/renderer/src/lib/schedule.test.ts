import { describe, expect, it } from 'vitest'
import { isDue, nextRun, triggerLabel, untilLabel, type Trigger } from './schedule'

// Local time, deliberately: a person schedules "9am" meaning their own 9am.
const at = (iso: string): number => new Date(iso).getTime()

describe('nextRun', () => {
  it('daily rolls to tomorrow once today has passed', () => {
    const t: Trigger = { kind: 'daily', hour: 9, minute: 0 }
    expect(nextRun(t, at('2026-03-02T08:00'))).toBe(at('2026-03-02T09:00'))
    expect(nextRun(t, at('2026-03-02T09:00'))).toBe(at('2026-03-03T09:00')) // never "now"
    expect(nextRun(t, at('2026-03-02T23:30'))).toBe(at('2026-03-03T09:00'))
  })

  it('weekdays skips the weekend instead of piling onto Monday', () => {
    const t: Trigger = { kind: 'weekdays', hour: 9, minute: 0 }
    // Friday 10:00 → Monday, not Saturday.
    expect(nextRun(t, at('2026-03-06T10:00'))).toBe(at('2026-03-09T09:00'))
    expect(nextRun(t, at('2026-03-07T10:00'))).toBe(at('2026-03-09T09:00'))
  })

  it('weekly lands on the named day', () => {
    const t: Trigger = { kind: 'weekly', day: 1, hour: 18, minute: 30 }
    expect(new Date(nextRun(t, at('2026-03-04T12:00'))!).getDay()).toBe(1)
    expect(nextRun(t, at('2026-03-04T12:00'))).toBe(at('2026-03-09T18:30'))
  })

  it('hourly keeps its minute', () => {
    const t: Trigger = { kind: 'hourly', minute: 15 }
    expect(nextRun(t, at('2026-03-02T08:10'))).toBe(at('2026-03-02T08:15'))
    expect(nextRun(t, at('2026-03-02T08:20'))).toBe(at('2026-03-02T09:15'))
  })

  it('every-N keeps its phase instead of drifting', () => {
    const created = at('2026-03-02T08:00')
    const t: Trigger = { kind: 'every', minutes: 30 }
    // Asked at 08:47 — a run that started late does not move the 09:00 slot.
    expect(nextRun(t, at('2026-03-02T08:47'), created)).toBe(at('2026-03-02T09:00'))
  })

  it('a one-shot that has fired has no next run', () => {
    const t: Trigger = { kind: 'once', at: at('2026-03-02T09:00') }
    expect(nextRun(t, at('2026-03-02T08:00'))).toBe(at('2026-03-02T09:00'))
    expect(nextRun(t, at('2026-03-02T09:30'))).toBeNull()
  })
})

describe('isDue', () => {
  const daily: Trigger = { kind: 'daily', hour: 9, minute: 0 }
  const createdAt = at('2026-03-01T00:00')
  const grace = 60 * 60_000

  it('fires once its time arrives', () => {
    expect(isDue(daily, at('2026-03-02T09:00'), { createdAt, graceMs: grace })).toBe(true)
    expect(isDue(daily, at('2026-03-02T08:59'), { createdAt, graceMs: grace })).toBe(false)
  })

  it('does not fire twice for the same slot', () => {
    const lastRunAt = at('2026-03-02T09:00')
    expect(isDue(daily, at('2026-03-02T09:05'), { lastRunAt, createdAt, graceMs: grace })).toBe(false)
    expect(isDue(daily, at('2026-03-03T09:00'), { lastRunAt, createdAt, graceMs: grace })).toBe(true)
  })

  it('catches up a slot missed while the app was closed, within the grace', () => {
    const lastRunAt = at('2026-03-01T09:00')
    // 09:40 — worth doing.
    expect(isDue(daily, at('2026-03-02T09:40'), { lastRunAt, createdAt, graceMs: grace })).toBe(true)
    // 16:00 — the moment has passed; the next 9am is the one that matters.
    expect(isDue(daily, at('2026-03-02T16:00'), { lastRunAt, createdAt, graceMs: grace })).toBe(false)
  })

  it('does not stampede after days away', () => {
    // A laptop shut for a week comes back to at most ONE run, not seven.
    const lastRunAt = at('2026-03-01T09:00')
    expect(isDue(daily, at('2026-03-08T16:00'), { lastRunAt, createdAt, graceMs: grace })).toBe(false)
  })

  it('still delivers a one-shot that was missed entirely', () => {
    // Nothing else will ever run it, so late beats never.
    const t: Trigger = { kind: 'once', at: at('2026-03-02T09:00') }
    expect(isDue(t, at('2026-03-04T12:00'), { createdAt, graceMs: grace })).toBe(true)
  })
})

describe('labels', () => {
  it('says the rule, not a timestamp', () => {
    expect(triggerLabel({ kind: 'weekdays', hour: 9, minute: 0 })).toBe('평일 09:00')
    expect(triggerLabel({ kind: 'every', minutes: 30 })).toBe('30분마다')
    expect(triggerLabel({ kind: 'every', minutes: 120 })).toBe('2시간마다')
    expect(triggerLabel({ kind: 'hourly', minute: 5 })).toBe('매시 05분')
    expect(triggerLabel({ kind: 'weekly', day: 1, hour: 18, minute: 30 })).toBe('매주 월 18:30')
  })

  it('counts down in the unit a person would use', () => {
    const now = at('2026-03-02T08:00')
    expect(untilLabel(at('2026-03-02T08:03'), now)).toBe('3분 후')
    expect(untilLabel(at('2026-03-02T13:00'), now)).toBe('5시간 후')
    expect(untilLabel(at('2026-03-05T08:00'), now)).toBe('3일 후')
    expect(untilLabel(null, now)).toBe('예정 없음')
  })
})
