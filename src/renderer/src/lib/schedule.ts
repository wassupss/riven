// When a scheduled job runs.
//
// riven is a desktop app, not a daemon: it can only fire while it is open. That
// single fact shapes everything here. A schedule is stored as a RULE, never as
// "the next timestamp" — a stored timestamp silently rots while the app is
// closed, and the job either stampedes (every missed hour at once) or is lost.
// The rule is evaluated against the clock each tick, and a run that was missed
// while the machine was asleep is honoured only if it is still recent enough to
// be worth doing (see `graceMs`).

export type Trigger =
  | { kind: 'once'; at: number }
  /** Every N minutes from when it was created. */
  | { kind: 'every'; minutes: number }
  | { kind: 'hourly'; minute: number }
  | { kind: 'daily'; hour: number; minute: number }
  /** Monday–Friday. */
  | { kind: 'weekdays'; hour: number; minute: number }
  | { kind: 'weekly'; day: number; hour: number; minute: number }

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

const atClock = (from: Date, hour: number, minute: number): number => {
  const d = new Date(from)
  d.setHours(hour, minute, 0, 0)
  return d.getTime()
}

const isWeekday = (ms: number): boolean => {
  const day = new Date(ms).getDay()
  return day >= 1 && day <= 5
}

/**
 * The first firing strictly after `after`.
 *
 * Returns null for a one-shot that has already fired — the caller deletes it
 * rather than leaving a schedule that can never run again.
 */
export function nextRun(trigger: Trigger, after: number, createdAt = after): number | null {
  switch (trigger.kind) {
    case 'once':
      return trigger.at > after ? trigger.at : null
    case 'every': {
      const step = Math.max(1, Math.round(trigger.minutes)) * MIN
      // Anchored to creation so "every 30 minutes" keeps its phase instead of
      // drifting a little later on every run.
      const elapsed = after - createdAt
      const steps = Math.floor(elapsed / step) + 1
      return createdAt + steps * step
    }
    case 'hourly': {
      const d = new Date(after)
      d.setMinutes(trigger.minute, 0, 0)
      const at = d.getTime()
      return at > after ? at : at + HOUR
    }
    case 'daily': {
      const today = atClock(new Date(after), trigger.hour, trigger.minute)
      return today > after ? today : today + DAY
    }
    case 'weekdays': {
      let at = atClock(new Date(after), trigger.hour, trigger.minute)
      if (at <= after) at += DAY
      // Saturday and Sunday are skipped, not merged into Monday morning.
      while (!isWeekday(at)) at += DAY
      return at
    }
    case 'weekly': {
      let at = atClock(new Date(after), trigger.hour, trigger.minute)
      if (at <= after) at += DAY
      while (new Date(at).getDay() !== trigger.day) at += DAY
      return at
    }
  }
}

/** The most recent firing at or before `now`, or null if it has never fired. */
export function previousRun(trigger: Trigger, now: number, createdAt = now): number | null {
  switch (trigger.kind) {
    case 'once':
      return trigger.at <= now ? trigger.at : null
    case 'every': {
      const step = Math.max(1, Math.round(trigger.minutes)) * MIN
      if (now < createdAt) return null
      return createdAt + Math.floor((now - createdAt) / step) * step
    }
    case 'hourly': {
      const d = new Date(now)
      d.setMinutes(trigger.minute, 0, 0)
      const at = d.getTime()
      return at <= now ? at : at - HOUR
    }
    case 'daily': {
      const today = atClock(new Date(now), trigger.hour, trigger.minute)
      return today <= now ? today : today - DAY
    }
    case 'weekdays': {
      let at = atClock(new Date(now), trigger.hour, trigger.minute)
      if (at > now) at -= DAY
      while (!isWeekday(at)) at -= DAY
      return at
    }
    case 'weekly': {
      let at = atClock(new Date(now), trigger.hour, trigger.minute)
      if (at > now) at -= DAY
      while (new Date(at).getDay() !== trigger.day) at -= DAY
      return at
    }
  }
}

/**
 * Should this job run right now?
 *
 * Asked of the slot the clock is IN — the most recent one that has come due —
 * never of the next slot after the last run. Those differ exactly when the app
 * was closed for a while, and the difference matters: a daily job idle for a
 * week would otherwise be judged by last Tuesday's slot, and either stampede
 * through every missed day or be written off as too old to run at all.
 *
 * `lastRunAt` is what stops the same slot firing twice. `graceMs` is how stale a
 * missed slot may be and still be worth doing: a 9am report is worth running at
 * 9:40 and not at 4pm. At most ONE run comes out of any absence, however long.
 */
export function isDue(
  trigger: Trigger,
  now: number,
  opts: { lastRunAt?: number; createdAt: number; graceMs: number }
): boolean {
  const since = opts.lastRunAt ?? opts.createdAt
  const slot = previousRun(trigger, now, opts.createdAt)
  if (slot == null || slot <= since) return false
  // A one-shot has no later slot to fall back to, so late beats never.
  if (trigger.kind === 'once') return true
  return now - slot <= opts.graceMs
}

const pad = (n: number): string => String(n).padStart(2, '0')

const DAY_KO = ['일', '월', '화', '수', '목', '금', '토']
const DAY_EN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/** A human-readable rule: "평일 09:00", "30분마다". */
export function triggerLabel(trigger: Trigger, lang: 'ko' | 'en' = 'ko'): string {
  const ko = lang === 'ko'
  switch (trigger.kind) {
    case 'once': {
      const d = new Date(trigger.at)
      const when = `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`
      return ko ? `한 번 · ${when}` : `Once · ${when}`
    }
    case 'every': {
      const m = Math.max(1, Math.round(trigger.minutes))
      if (m % 60 === 0) return ko ? `${m / 60}시간마다` : `Every ${m / 60}h`
      return ko ? `${m}분마다` : `Every ${m}m`
    }
    case 'hourly':
      return ko ? `매시 ${pad(trigger.minute)}분` : `Hourly at :${pad(trigger.minute)}`
    case 'daily':
      return ko
        ? `매일 ${pad(trigger.hour)}:${pad(trigger.minute)}`
        : `Daily at ${pad(trigger.hour)}:${pad(trigger.minute)}`
    case 'weekdays':
      return ko
        ? `평일 ${pad(trigger.hour)}:${pad(trigger.minute)}`
        : `Weekdays at ${pad(trigger.hour)}:${pad(trigger.minute)}`
    case 'weekly':
      return ko
        ? `매주 ${DAY_KO[trigger.day]} ${pad(trigger.hour)}:${pad(trigger.minute)}`
        : `${DAY_EN[trigger.day]}s at ${pad(trigger.hour)}:${pad(trigger.minute)}`
  }
}

/** "3분 후", "내일 09:00" — what the list shows under each job. */
export function untilLabel(at: number | null, now: number, lang: 'ko' | 'en' = 'ko'): string {
  const ko = lang === 'ko'
  if (at == null) return ko ? '예정 없음' : 'not scheduled'
  const left = at - now
  if (left <= 0) return ko ? '곧' : 'due'
  const mins = Math.round(left / MIN)
  if (mins < 60) return ko ? `${Math.max(1, mins)}분 후` : `in ${Math.max(1, mins)}m`
  const hours = Math.round(left / HOUR)
  if (hours < 24) return ko ? `${hours}시간 후` : `in ${hours}h`
  return ko ? `${Math.round(left / DAY)}일 후` : `in ${Math.round(left / DAY)}d`
}
