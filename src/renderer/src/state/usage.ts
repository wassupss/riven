import { create } from 'zustand'
import { getSettings, useSettings } from './settings'

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
  stale?: boolean
  at?: number
}

// One entry per account riven knows about. `id` is the Claude profile id, or
// 'claude' when the user has no profiles (a single default login).
export interface AccountUsage {
  id: string
  cli: 'claude' | 'codex'
  label: string
  today: UsageToday | null
  limits: UsageLimits | null
  // Codex reports its plan window locally; Claude reports session + weekly.
  codexWindowMinutes?: number | null
}

interface UsageState {
  today: UsageToday | null
  limits: UsageLimits | null
  // Per-account breakdown, in display order: Claude accounts, then Codex.
  accounts: AccountUsage[]
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
  accounts: [],
  refresh: () => {
    const st = getSettings()
    // Every Claude account is read with ITS OWN config dir, so one account's
    // tokens never land in another's total. With no profiles there is a single
    // default login and no dir to pass.
    const claudeAccounts = st.claudeProfiles.length
      ? st.claudeProfiles.map((p) => ({ id: p.id, label: p.label, dir: p.dir ?? undefined }))
      : [{ id: 'claude', label: '', dir: undefined }]

    void Promise.all(
      claudeAccounts.map(async (a) => {
        const [today, limits] = await Promise.all([
          window.api.usage.today(a.dir).catch(() => null),
          window.api.usage.limits(a.dir).catch(() => null)
        ])
        return { id: a.id, cli: 'claude' as const, label: a.label, today, limits }
      })
    ).then(async (claude) => {
      // The legacy single-account fields stay in sync with the ACTIVE account, so
      // the compact status-bar readout keeps working unchanged.
      const activeId = st.claudeProfileId ?? claude[0]?.id
      const active = claude.find((c) => c.id === activeId) ?? claude[0]
      if (active) set({ today: active.today, limits: active.limits })

      const cx = await window.api.usage.codex().catch(() => null)
      const accounts: AccountUsage[] = [...claude]
      if (cx?.installed)
        accounts.push({
          id: 'codex',
          cli: 'codex',
          label: '',
          today: { totalCost: 0, totalTokens: cx.totalTokens, perModel: [] },
          limits: { session: cx.secondary, weekly: cx.primary },
          codexWindowMinutes: cx.primaryWindowMinutes
        })
      set({ accounts })
    })
  },
  acquire: () => {
    consumers++
    // Refresh on EVERY mount, not just the first. The status-bar widget mounts
    // before settings finish loading, so its fetch can predate the account list;
    // the pinned view mounting later must not inherit that stale answer.
    get().refresh()
    if (interval) return
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

// Rebuild the per-account list whenever the set of accounts changes. This also
// covers startup: settings load asynchronously, so the first refresh (fired when
// the widget mounts) can run before the profiles exist and would otherwise show a
// single account until the 60s poll came round.
let lastAccountKey = ''
useSettings.subscribe((s) => {
  const key = s.settings.claudeProfiles.map((p) => `${p.id}:${p.dir ?? ''}`).join(',')
  if (key === lastAccountKey) return
  // Don't record the key unless we actually refetch, or the one change that
  // matters (settings finishing their load) would be swallowed when no consumer
  // is mounted yet.
  if (consumers === 0) return
  lastAccountKey = key
  useUsage.getState().refresh()
})

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
// Used % (what the header widget shows — usage, not remaining).
export function used(l: PlanLimit): number {
  return Math.min(100, Math.max(0, Math.round(l.usedPct)))
}
// Remaining-based color: <20% danger, <50% warning, else accent.
export function remainingColor(pct: number): string {
  if (pct < 20) return 'var(--danger)'
  if (pct < 50) return 'var(--warning)'
  return 'var(--accent)'
}
// Usage-based color: high usage = danger. (mirror of remainingColor)
export function usedColor(usedPct: number): string {
  return remainingColor(100 - usedPct)
}
