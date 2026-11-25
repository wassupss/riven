// Typewriter drain for text that arrives in bursts. The CLI emits a whole
// sentence at a time (MEASURED: ~87 characters every ~540ms, p90 660ms), so
// showing each arrival as it lands reads as a jerk every half second. Instead the
// visible text catches up to the target at the measured input rate, which turns
// those bursts into a steady flow. Used by the CLI chat's live preview (CliChatPanel).
import { useEffect, useRef, useState } from 'react'

/** Characters to reveal this frame, given the unrevealed buffer, the frame gap and the input rate (chars/ms). */
export function revealCount(buf: string, frameMs: number, rate: number): number {
  if (!buf) return 0
  let n = Math.max(1, Math.round(rate * frameMs * 1.05))
  // Don't let a backlog build unboundedly: drain proportionally faster past a threshold.
  if (buf.length > 400) n = Math.max(n, Math.ceil(buf.length / 12))
  if (n < buf.length) {
    // Prefer breaking after a space so words don't visibly assemble.
    const sp = buf.indexOf(' ', n)
    if (sp >= 0 && sp - n <= 12) n = sp + 1
  }
  return Math.min(n, buf.length)
}

function commonPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length)
  let i = 0
  while (i < max && a.charCodeAt(i) === b.charCodeAt(i)) i++
  return i
}

/**
 * The part of `target` that should be visible now. `target` normally only grows;
 * when it is rewritten (the screen heuristic can change earlier text) the shown
 * text snaps back to the common prefix and drains forward again. `null` clears it.
 */
export function useDrainedText(target: string | null, onTick?: () => void): string {
  const [shown, setShown] = useState('')
  const onTickRef = useRef(onTick)
  onTickRef.current = onTick
  const st = useRef({ shown: '', rate: 0.12, arrivedAt: 0, len: 0, last: 0, raf: 0 })

  useEffect(() => {
    const s = st.current
    const goal = target ?? ''
    cancelAnimationFrame(s.raf)
    s.raf = 0
    if (!goal) {
      s.shown = ''
      s.len = 0
      s.arrivedAt = 0
      setShown('')
      return
    }
    if (!goal.startsWith(s.shown)) s.shown = goal.slice(0, commonPrefixLength(goal, s.shown))
    const now = performance.now()
    if (goal.length > s.len) {
      // Learn the input rate from the gap since the previous arrival (EMA, 0.7/0.3).
      if (s.arrivedAt) {
        const inst = (goal.length - s.len) / Math.max(8, now - s.arrivedAt)
        s.rate = 0.7 * s.rate + 0.3 * inst
      }
      s.arrivedAt = now
      s.len = goal.length
    }
    const step = (): void => {
      s.raf = 0
      const t = performance.now()
      const frameMs = Math.min(50, Math.max(8, t - (s.last || t)))
      s.last = t
      const rest = goal.slice(s.shown.length)
      const n = revealCount(rest, frameMs, s.rate)
      if (n > 0) {
        s.shown = goal.slice(0, s.shown.length + n)
        setShown(s.shown)
        onTickRef.current?.()
      }
      if (s.shown.length < goal.length) s.raf = requestAnimationFrame(step)
    }
    if (s.shown.length < goal.length) s.raf = requestAnimationFrame(step)
    else setShown(s.shown)
    return () => {
      cancelAnimationFrame(s.raf)
      s.raf = 0
    }
  }, [target])

  return shown
}
