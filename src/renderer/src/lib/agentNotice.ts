import type { TFn } from '../i18n'

// What the CLI says about itself while a turn runs.
//
// The stream carries more than the answer: it says when a request is being
// RETRIED (and for how long), when the account has hit a rate limit, and when
// the conversation was compacted. riven read none of it — so a CLI sitting in
// retry backoff looked exactly like a model thinking hard, which cost a morning
// of tracing sockets by hand to explain one stuck pane.
//
// These turn those payloads into the one line a person needs.

export interface RetryNotice {
  attempt: number
  max: number
  delayMs: number
  status: number | null
}

export interface LimitNotice {
  /** 'allowed_warning' — close to the cap; 'rejected' — refused right now. */
  status: string
  resetsAt?: number
  kind?: string
  utilization?: number
}

export interface CompactNotice {
  trigger: 'manual' | 'auto'
  pre: number
  post?: number
}

const secs = (ms: number): number => Math.max(1, Math.round(ms / 1000))

/** "재시도 2/5 · 30초 후" — what it is doing and how long it intends to wait. */
export function retryLabel(n: RetryNotice, t: TFn): string {
  const base = t('chat.retrying', { n: n.attempt, max: n.max, s: secs(n.delayMs) })
  return n.status ? `${base} (HTTP ${n.status})` : base
}

/** Minutes until a limit lifts, for the pane to show beside the warning. */
export function resetsInMinutes(resetsAt: number | undefined, now = Date.now()): number | null {
  if (!resetsAt) return null
  // The CLI reports seconds since the epoch; a value in milliseconds would be
  // ~1000× too large and would render as decades.
  const at = resetsAt > 1e12 ? resetsAt : resetsAt * 1000
  const mins = Math.round((at - now) / 60000)
  return mins > 0 ? mins : null
}

export function limitLabel(n: LimitNotice, t: TFn, now = Date.now()): string {
  const mins = resetsInMinutes(n.resetsAt, now)
  const head = n.status === 'rejected' ? t('chat.limitHit') : t('chat.limitNear')
  return mins ? `${head} · ${t('chat.limitResets', { n: mins })}` : head
}

const k = (n: number): string => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n))

/** "컨텍스트 압축 · 120k → 32k" — why the transcript above just got shorter. */
export function compactLabel(n: CompactNotice, t: TFn): string {
  const sizes = n.post ? `${k(n.pre)} → ${k(n.post)}` : k(n.pre)
  return `${n.trigger === 'auto' ? t('chat.compactAuto') : t('chat.compactManual')} · ${sizes}`
}
