import { ipcMain } from 'electron'
import { promises as fs } from 'fs'
import { execFile } from 'child_process'
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

function claudeRoots(): string[] {
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
}

function tokenFrom(blob: string): string | null {
  try {
    return (JSON.parse(blob) as { claudeAiOauth?: { accessToken?: string } })?.claudeAiOauth?.accessToken?.trim() || null
  } catch {
    return null
  }
}

// Claude Code stores its OAuth credentials in the macOS Keychain (service
// "Claude Code-credentials"); older versions used ~/.claude/.credentials.json.
async function claudeToken(): Promise<string | null> {
  if (process.platform === 'darwin') {
    try {
      const { stdout } = await pexec('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], {
        timeout: 5000
      })
      const tok = tokenFrom(stdout.trim())
      if (tok) return tok
    } catch {
      /* not in keychain — fall through to file */
    }
  }
  try {
    return tokenFrom(await fs.readFile(path.join(os.homedir(), '.claude', '.credentials.json'), 'utf8'))
  } catch {
    return null
  }
}

export function registerUsageHandlers(): void {
  ipcMain.handle('usage:limits', async (): Promise<UsageLimits> => {
    const token = await claudeToken()
    if (!token) return { session: null, weekly: null }
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
      if (!res.ok) return { session: null, weekly: null }
      const b = (await res.json()) as Record<string, { utilization?: number; resets_at?: string }>
      const win = (o?: { utilization?: number; resets_at?: string }): PlanLimit | null =>
        o && typeof o.utilization === 'number'
          ? { usedPct: o.utilization, resetsAt: o.resets_at ?? null }
          : null
      return { session: win(b.five_hour), weekly: win(b.seven_day) }
    } catch {
      return { session: null, weekly: null }
    } finally {
      clearTimeout(timer)
    }
  })

  ipcMain.handle('usage:today', async (): Promise<UsageToday> => {
    const today = todayKey()
    const files: string[] = []
    for (const root of claudeRoots()) await walkJsonl(root, files)

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
