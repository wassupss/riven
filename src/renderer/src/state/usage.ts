import { create } from 'zustand'
import { getSettings } from './settings'

export interface ModelUsage {
  model: string
  input: number
  output: number
  cacheWrite: number
  cacheRead: number
  cost: number
}
export interface UsageToday {
  totalCost: number
  totalTokens: number
  perModel: ModelUsage[]
}
export interface PlanLimit {
  usedPct: number
  resetsAt: string | null
}
export interface UsageLimits {
  session: PlanLimit | null
  weekly: PlanLimit | null
}

interface UsageState {
  today: UsageToday | null
  limits: UsageLimits | null
  refresh: () => void
  // A usage consumer (status widget / pinned view) mounted / unmounted; poll
  // only while at least one is mounted, and never while the window is hidden.
  acquire: () => void
  release: () => void
}

let interval: ReturnType<typeof setInterval> | null = null
let consumers = 0

// Shared usage data so the status-bar widget and the pinned sidebar view read
// one source (single fetch loop).
export const useUsage = create<UsageState>((set, get) => ({
  today: null,
  limits: null,
  refresh: () => {
    window.api.usage
      .today()
      .then((t) => set({ today: t }))
      .catch(() => {})
    window.api.usage
      .limits()
      .then((l) => set({ limits: l }))
      .catch(() => {})
  },
  acquire: () => {
    consumers++
    if (interval) return
    get().refresh()
    interval = setInterval(() => {
      // Skip while backgrounded — no point walking session logs for a hidden app.
      if (document.visibilityState === 'visible') get().refresh()
    }, 60000)
  },
  release: () => {
    consumers = Math.max(0, consumers - 1)
    if (consumers === 0 && interval) {
      clearInterval(interval)
      interval = null
    }
  }
}))

export function fmtTokens(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`
  return String(n)
}
export function resetIn(iso: string | null): string {
  if (!iso) return ''
  const ms = new Date(iso).getTime() - Date.now()
  if (Number.isNaN(ms) || ms <= 0) return ''
  const ko = getSettings().language === 'ko'
  const u = ko ? { d: '일', h: '시간', m: '분', sep: ' ' } : { d: 'd', h: 'h', m: 'm', sep: ' ' }
  const h = Math.floor(ms / 3600000)
  if (h >= 24) return `${Math.round(h / 24)}${u.d}`
  if (h >= 1) return `${h}${u.h}${u.sep}${Math.round((ms % 3600000) / 60000)}${u.m}`
  return `${Math.max(1, Math.round(ms / 60000))}${u.m}`
}
export function remaining(l: PlanLimit): number {
  return Math.max(0, Math.round(100 - l.usedPct))
}
// Remaining-based color: <20% danger, <50% warning, else accent.
export function remainingColor(pct: number): string {
  if (pct < 20) return 'var(--danger)'
  if (pct < 50) return 'var(--warning)'
  return 'var(--accent)'
}
