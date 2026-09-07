import { ipcMain } from 'electron'
import { promises as fs } from 'fs'
import { execFile } from 'child_process'
import { createHash } from 'crypto'
import { promisify } from 'util'
import * as os from 'os'
import * as path from 'path'

const pexec = promisify(execFile)

// Local agent-usage tracker (no API keys, no network). Reads Claude Code's
// session logs — the same `~/.claude/projects/**/*.jsonl` files ccusage/openusage
// parse — sums TODAY's tokens per model and prices them at API rates. Extensible
// to codex/opencode later (their logs live under ~/.codex, ~/.local/share/opencode).

interface ModelUsage {
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

// USD per 1M tokens. Matched by substring; falls back to Sonnet rates.
const PRICING: Array<{ re: RegExp; in: number; out: number; cw: number; cr: number }> = [
  { re: /opus/i, in: 15, out: 75, cw: 18.75, cr: 1.5 },
  { re: /haiku/i, in: 0.8, out: 4, cw: 1.0, cr: 0.08 },
  { re: /sonnet|claude/i, in: 3, out: 15, cw: 3.75, cr: 0.3 }
]
function rate(model: string): { in: number; out: number; cw: number; cr: number } {
  return PRICING.find((p) => p.re.test(model)) ?? PRICING[2]
}

// Where a given account's session logs live. With an explicit configDir (a riven
// Claude account profile) the answer is exactly that directory — mixing in the
// default one would add another account's tokens to this account's total.
function claudeRoots(configDir?: string): string[] {
  if (configDir) return [path.join(configDir, 'projects')]
  const roots: string[] = []
  const cfg = process.env.CLAUDE_CONFIG_DIR
  if (cfg) cfg.split(',').forEach((d) => roots.push(path.join(d.trim(), 'projects')))
  const xdg = process.env.XDG_CONFIG_HOME
  if (xdg) roots.push(path.join(xdg, 'claude', 'projects'))
  roots.push(path.join(os.homedir(), '.claude', 'projects'))
  return [...new Set(roots)]
}

async function walkJsonl(dir: string, out: string[], cap = 4000): Promise<void> {
  if (out.length >= cap) return
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (out.length >= cap) return
    const full = path.join(dir, e.name)
    if (e.isDirectory()) await walkJsonl(full, out, cap)
    else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(full)
  }
}

function todayKey(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
function localDayKey(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// ---- live plan limits (session 5h / weekly 7d) via Claude OAuth usage API ----
// openusage's approach: read Claude Code's local OAuth token and GET the usage
// endpoint. `utilization` is the % of the window used (remaining = 100 - it).
export interface PlanLimit {
  usedPct: number
  resetsAt: string | null
}
export interface UsageLimits {
  session: PlanLimit | null
  weekly: PlanLimit | null
  // Served from the last successful read because this one failed (the usage
  // endpoint rate limits), with when that read happened. Claude Code's own client
  // does the same rather than showing empty bars.
  stale?: boolean
  at?: number
}

const LIMITS_TTL_MS = 60 * 60_000
const limitsCache = new Map<string, { at: number; val: UsageLimits }>()

function cachedLimits(key: string): UsageLimits {
  const c = limitsCache.get(key)
  if (c && Date.now() - c.at < LIMITS_TTL_MS) return { ...c.val, stale: true, at: c.at }
  return { session: null, weekly: null }
}

interface OauthBlob {
  accessToken?: string
  expiresAt?: number
}

function oauthFrom(blob: string): OauthBlob | null {
  try {
    const o = (JSON.parse(blob) as { claudeAiOauth?: OauthBlob })?.claudeAiOauth
    return o?.accessToken?.trim() ? o : null
  } catch {
    return null
  }
}

const KEYCHAIN_SERVICE = 'Claude Code-credentials'

// Claude Code namespaces the keychain item by config dir: with CLAUDE_CONFIG_DIR
// set, the SERVICE becomes "Claude Code-credentials-<first 8 hex of sha256(dir)>"
// and the bare service name keeps belonging to the default ~/.claude login. The
// account field is just the OS user in every item, so guessing the account (the
// dir, its basename) never matched — which is why a second, separately signed-in
// profile reported no plan limits at all.
function keychainService(configDir?: string): string {
  if (!configDir) return KEYCHAIN_SERVICE
  return `${KEYCHAIN_SERVICE}-${createHash('sha256').update(configDir).digest('hex').slice(0, 8)}`
}

async function keychainBlob(service: string, account?: string): Promise<string> {
  const args = ['find-generic-password', '-s', service]
  if (account) args.push('-a', account)
  args.push('-w')
  const { stdout } = await pexec('security', args, { timeout: 5000 })
  return stdout.trim()
}

// Claude Code stores its OAuth credentials in the macOS Keychain (service
// "Claude Code-credentials"); older versions used ~/.claude/.credentials.json.
//
// A machine can hold SEVERAL items under that service — observed here: one under
// the OS user and a second under account "unknown" — and a logout/login can leave
// the live token in a different one than the first match. Reading only the first
// match (no -a) is why plan usage went blank after signing back in: that item
// carried no token at all. So try each candidate and take the newest live token.
async function claudeToken(configDir?: string): Promise<string | null> {
  // A profile keeps its credentials under its OWN config dir, so read that file
  // first: the keychain items below belong to the default login and would report
  // the wrong account's limits for this profile.
  if (configDir) {
    try {
      const o = oauthFrom(await fs.readFile(path.join(configDir, '.credentials.json'), 'utf8'))
      if (o?.accessToken) return o.accessToken
    } catch {
      /* fall through: on macOS the CLI may have put it in the keychain instead */
    }
    // Keyed to the directory through the service name (see keychainService). No
    // account filter: the item is written under the OS user, and the service
    // already pins it to this dir, so there is nothing to tell apart.
    try {
      const o = oauthFrom(await keychainBlob(keychainService(configDir)))
      if (o?.accessToken) return o.accessToken
    } catch {
      /* no item for this dir — this profile is not signed in */
    }
    return null
  }
  if (process.platform === 'darwin') {
    const accounts = [...new Set([os.userInfo().username, undefined, 'unknown'])]
    let best: { token: string; expiresAt: number } | null = null
    for (const a of accounts) {
      try {
        const o = oauthFrom(await keychainBlob(KEYCHAIN_SERVICE, a))
        if (!o?.accessToken) continue
        const expiresAt = typeof o.expiresAt === 'number' ? o.expiresAt : Number.MAX_SAFE_INTEGER
        if (expiresAt <= Date.now()) continue // expired: it would only 401
        if (!best || expiresAt > best.expiresAt) best = { token: o.accessToken, expiresAt }
      } catch {
        /* no item for this account — try the next */
      }
    }
    if (best) return best.token
  }
  try {
    return (
      oauthFrom(await fs.readFile(path.join(os.homedir(), '.claude', '.credentials.json'), 'utf8'))
        ?.accessToken ?? null
    )
  } catch {
    return null
  }
}

// ---- Codex -----------------------------------------------------------------
// Codex keeps rollouts at ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl, and its
// `token_count` events carry BOTH the token counts and the plan's rate limits, so
// this needs no network and no token: everything is on disk.
//
//   payload.info.last_token_usage.{input,cached_input,output,reasoning_output}_tokens
//   payload.rate_limits.primary.{used_percent,window_minutes,resets_at}
export interface CodexUsage {
  installed: boolean
  totalTokens: number
  primary: PlanLimit | null // usually the 30-day window
  primaryWindowMinutes: number | null
  secondary: PlanLimit | null
}

function dayDir(d: Date): string {
  return path.join(
    os.homedir(),
    '.codex',
    'sessions',
    String(d.getFullYear()),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0')
  )
}

async function codexUsage(): Promise<CodexUsage> {
  const empty: CodexUsage = {
    installed: false,
    totalTokens: 0,
    primary: null,
    primaryWindowMinutes: null,
    secondary: null
  }
  try {
    await fs.stat(path.join(os.homedir(), '.codex'))
  } catch {
    return empty
  }
  const out: CodexUsage = { ...empty, installed: true }
  const today = todayKey()
  const files: string[] = []
  // Today's directory, plus yesterday's: a session started before midnight keeps
  // writing into its start date's folder, and its later turns are still today's.
  const now = new Date()
  for (const d of [now, new Date(now.getTime() - 24 * 3600 * 1000)])
    await walkJsonl(dayDir(d), files)

  // The freshest rate_limits win: they are a snapshot of the plan window, not a
  // per-turn delta, so summing them would be meaningless.
  let newestLimitsAt = 0
  for (const file of files) {
    let text: string
    try {
      text = await fs.readFile(file, 'utf8')
    } catch {
      continue
    }
    for (const line of text.split('\n')) {
      if (!line.includes('token_count')) continue
      let obj: Record<string, unknown>
      try {
        obj = JSON.parse(line)
      } catch {
        continue
      }
      const payload = obj.payload as Record<string, unknown> | undefined
      if (payload?.type !== 'token_count') continue
      const ts = (obj.timestamp as string) ?? ''
      const info = payload.info as Record<string, unknown> | undefined
      const last = info?.last_token_usage as Record<string, number> | undefined
      if (last && localDayKey(ts) === today) {
        out.totalTokens +=
          (last.input_tokens ?? 0) +
          (last.output_tokens ?? 0) +
          (last.reasoning_output_tokens ?? 0) +
          (last.cache_write_input_tokens ?? 0)
      }
      const rl = payload.rate_limits as Record<string, unknown> | undefined
      const at = new Date(ts).getTime() || 0
      if (rl && at >= newestLimitsAt) {
        newestLimitsAt = at
        const win = (o: unknown): PlanLimit | null => {
          const w = o as { used_percent?: number; resets_at?: number } | null
          if (!w || typeof w.used_percent !== 'number') return null
          return {
            usedPct: w.used_percent,
            // resets_at is unix SECONDS here, unlike Claude's ISO string.
            resetsAt: w.resets_at ? new Date(w.resets_at * 1000).toISOString() : null
          }
        }
        out.primary = win(rl.primary)
        out.secondary = win(rl.secondary)
        const pw = (rl.primary as { window_minutes?: number } | null)?.window_minutes
        out.primaryWindowMinutes = typeof pw === 'number' ? pw : null
      }
    }
  }
  return out
}

export function registerUsageHandlers(): void {
  ipcMain.handle('usage:codex', async (): Promise<CodexUsage> => codexUsage())

  ipcMain.handle('usage:limits', async (_e, configDir?: string): Promise<UsageLimits> => {
    const cacheKey = configDir ?? '<default>'
    const token = await claudeToken(configDir)
    if (!token) return cachedLimits(cacheKey)
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 10000)
    try {
      const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
        signal: ctrl.signal,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'anthropic-beta': 'oauth-2025-04-20',
          'User-Agent': 'claude-code/2.1.69'
        }
      })
      if (!res.ok) return cachedLimits(cacheKey)
      const b = (await res.json()) as Record<string, { utilization?: number; resets_at?: string }>
      const win = (o?: { utilization?: number; resets_at?: string }): PlanLimit | null =>
        o && typeof o.utilization === 'number'
          ? { usedPct: o.utilization, resetsAt: o.resets_at ?? null }
          : null
      const val: UsageLimits = { session: win(b.five_hour), weekly: win(b.seven_day) }
      if (val.session || val.weekly) limitsCache.set(cacheKey, { at: Date.now(), val })
      return val
    } catch {
      return cachedLimits(cacheKey)
    } finally {
      clearTimeout(timer)
    }
  })

  ipcMain.handle('usage:today', async (_e, configDir?: string): Promise<UsageToday> => {
    const today = todayKey()
    const files: string[] = []
    for (const root of claudeRoots(configDir)) await walkJsonl(root, files)

    const seen = new Set<string>()
    const byModel = new Map<string, ModelUsage>()

    // Only read files touched today (mtime) to keep it cheap.
    const cutoff = Date.now() - 36 * 3600 * 1000
    for (const file of files) {
      let stat
      try {
        stat = await fs.stat(file)
      } catch {
        continue
      }
      if (stat.mtimeMs < cutoff) continue
      let text: string
      try {
        text = await fs.readFile(file, 'utf8')
      } catch {
        continue
      }
      for (const line of text.split('\n')) {
        if (!line.includes('"usage"')) continue
        let obj: Record<string, unknown>
        try {
          obj = JSON.parse(line)
        } catch {
          continue
        }
        const ts = (obj.timestamp as string) ?? ''
        if (localDayKey(ts) !== today) continue
        const msg = obj.message as Record<string, unknown> | undefined
        const usage = msg?.usage as Record<string, number> & {
          cache_creation?: Record<string, number>
        }
        if (!usage) continue
        const id = (msg?.id as string) ?? ''
        const reqId = (obj.requestId as string) ?? ''
        const key = `${id}|${reqId}`
        if (id && seen.has(key)) continue
        if (id) seen.add(key)

        const model = (msg?.model as string) ?? 'claude'
        const cc = usage.cache_creation
        const cacheWrite =
          (usage.cache_creation_input_tokens ?? 0) ||
          (cc ? (cc.ephemeral_5m_input_tokens ?? 0) + (cc.ephemeral_1h_input_tokens ?? 0) : 0)
        const input = usage.input_tokens ?? 0
        const output = usage.output_tokens ?? 0
        const cacheRead = usage.cache_read_input_tokens ?? 0
        const r = rate(model)
        const cost =
          (obj.costUSD as number | undefined) ??
          (input * r.in + output * r.out + cacheWrite * r.cw + cacheRead * r.cr) / 1e6

        let m = byModel.get(model)
        if (!m) {
          m = { model, input: 0, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0 }
          byModel.set(model, m)
        }
        m.input += input
        m.output += output
        m.cacheWrite += cacheWrite
        m.cacheRead += cacheRead
        m.cost += cost
      }
    }

    const perModel = [...byModel.values()].sort((a, b) => b.cost - a.cost)
    const totalCost = perModel.reduce((s, m) => s + m.cost, 0)
    const totalTokens = perModel.reduce((s, m) => s + m.input + m.output + m.cacheWrite + m.cacheRead, 0)
    return { totalCost, totalTokens, perModel }
  })
}
