// Batches PTY output into one IPC message per short window.
//
// Leading + trailing, NOT trailing-only: the first chunk after a quiet spell is
// flushed synchronously, and only a sustained burst waits for the timer. A
// trailing-only batcher taxes every keystroke echo with a full window — the
// shell answers within a millisecond and the user waits out the timer anyway.
// Same shape and the same reason as paseo's TerminalOutputCoalescer (5ms) and
// orca's PTY_BATCH_INTERVAL_MS (2ms).
//
// Timers are injected so the behaviour is testable with a fake clock.

export interface CoalescerTimers {
  setTimeout: (fn: () => void, ms: number) => unknown
  clearTimeout: (handle: unknown) => void
  now: () => number
}

export interface CoalescedOutput {
  data: string
  // Model revision after the LAST chunk in the batch was ingested — a merged
  // batch must carry the highest one, or snapshot dedup would wrongly skip it.
  rev: number
}

export const DEFAULT_FLUSH_DELAY_MS = 5
// A batch this large goes out at once regardless of the timer: no point holding
// a quarter megabyte to save one IPC.
export const FLUSH_MAX_CHARS = 256 * 1024

export class OutputCoalescer {
  private chunks: string[] = []
  private chars = 0
  private rev = 0
  private timer: unknown = null
  private lastFlushAt: number | null = null

  constructor(
    private readonly timers: CoalescerTimers,
    private readonly onFlush: (out: CoalescedOutput) => void,
    private readonly delayMs = DEFAULT_FLUSH_DELAY_MS,
    private readonly maxChars = FLUSH_MAX_CHARS
  ) {}

  handle(data: string, rev: number): void {
    if (data.length === 0) return
    this.chunks.push(data)
    this.chars += data.length
    this.rev = rev
    if (this.chars >= this.maxChars) {
      this.flush()
      return
    }
    if (this.timer) return
    const elapsed = this.lastFlushAt === null ? Infinity : this.timers.now() - this.lastFlushAt
    if (elapsed >= this.delayMs) {
      this.flush()
      return
    }
    this.timer = this.timers.setTimeout(() => {
      this.timer = null
      this.flush()
    }, this.delayMs)
  }

  flush(): void {
    if (this.timer) {
      this.timers.clearTimeout(this.timer)
      this.timer = null
    }
    if (this.chunks.length === 0) return
    const data = this.chunks.length === 1 ? this.chunks[0] : this.chunks.join('')
    const rev = this.rev
    this.chunks = []
    this.chars = 0
    this.lastFlushAt = this.timers.now()
    this.onFlush({ data, rev })
  }

  // Something went out on this stream bypassing the coalescer (a snapshot): the
  // next chunk should take the trailing path rather than flush right behind it.
  markFlushed(): void {
    this.lastFlushAt = this.timers.now()
  }

  get pendingChars(): number {
    return this.chars
  }

  dispose(): void {
    if (this.timer) this.timers.clearTimeout(this.timer)
    this.timer = null
    this.chunks = []
    this.chars = 0
  }
}

export const realTimers: CoalescerTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  now: () => Date.now()
}
