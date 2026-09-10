import { app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { mcpAuthToken, mcpBaseUrl, registerHttpRoute } from './mcpServer'
import { claudeHookToEvent, type HookEvent } from './terminal/activity'

// Agent lifecycle hooks: Claude Code tells riven when a turn starts, ends and
// when it is waiting on the user, instead of riven guessing from output flow
// and `pgrep`. This is the design the native app uses (AgentHookServer.swift)
// and the one paseo and orca both settled on.
//
// Mechanics: riven writes a settings file with `hooks` entries and hands it to
// the CLI with --settings (the CLI deep-merges it, so the user's own hooks keep
// firing). Each hook is a one-line shell command that POSTs the hook's stdin to
// riven's loopback server, tagged with the pane it runs in. The pane is known
// from RIVEN_PANE, which every terminal riven opens exports; a `claude` started
// anywhere else finds the variable empty and the command is a no-op — no
// spawn, no cost, no error.
//
// curl: present on every macOS and on virtually all Linux desktops. A missing
// curl makes the hook a silent no-op (2>/dev/null), never a failed hook.

const HOOK_EVENTS = ['UserPromptSubmit', 'Stop', 'StopFailure', 'SessionEnd', 'Notification'] as const

let settingsPath: string | null = null
let onEvent:
  | ((pane: string, event: HookEvent, hook: string, sessionId: string | null) => void)
  | null = null

// The CLI puts its session id in every hook payload. It is the only way riven
// learns which conversation a TERMINAL agent is having — a chat pane gets it
// from the stream, but a hand-typed `claude` tells us nothing else.
//
// It ends up interpolated into a shell command (`claude --resume <id>`), so it
// is accepted ONLY in the exact shape the CLI emits. The hook route is
// loopback + token, but a value that reaches a shell gets checked on its own.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
function sessionIdOf(payload: unknown): string | null {
  const raw = (payload as { session_id?: unknown } | null)?.session_id
  return typeof raw === 'string' && UUID_RE.test(raw) ? raw : null
}

function hookCommand(event: string): string {
  // Everything the hook needs comes from the environment the CLI inherited from
  // its terminal; the token on the query string keeps this dependency-free.
  return (
    `if [ -n "$RIVEN_PANE" ] && [ -n "$RIVEN_HOOK_URL" ]; then ` +
    `curl -s -m 2 -X POST -H 'content-type: application/json' --data-binary @- ` +
    `"$RIVEN_HOOK_URL?pane=$RIVEN_PANE&event=${event}&token=$RIVEN_HOOK_TOKEN" >/dev/null 2>&1; fi; exit 0`
  )
}

// Write the --settings file once per run. Returns its path, or null if it could
// not be written (a terminal without hooks still works — the heuristic stays).
export function ensureHookSettings(): string | null {
  if (settingsPath) return settingsPath
  try {
    const dir = path.join(app.getPath('userData'), 'hooks')
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    const file = path.join(dir, 'claude-settings.json')
    const hooks: Record<string, unknown> = {}
    for (const ev of HOOK_EVENTS) {
      hooks[ev] = [{ matcher: '', hooks: [{ type: 'command', command: hookCommand(ev), timeout: 5 }] }]
    }
    fs.writeFileSync(file, JSON.stringify({ hooks }, null, 2) + '\n', { mode: 0o600 })
    settingsPath = file
  } catch (e) {
    console.error('[hooks] settings write failed', e)
    settingsPath = null
  }
  return settingsPath
}

// Environment a terminal (or chat CLI) needs so its hooks reach us.
export function hookEnv(pane: string): Record<string, string> {
  const base = mcpBaseUrl()
  const settings = ensureHookSettings()
  if (!base || !settings) return {}
  return {
    RIVEN_PANE: pane,
    RIVEN_HOOK_URL: `${base}/hook`,
    RIVEN_HOOK_TOKEN: mcpAuthToken(),
    RIVEN_HOOKS_SETTINGS: settings
  }
}

// Hook delivery is the whole basis for busy/attention and completion
// notifications, and a hook that goes nowhere fails silently by design (the
// route always answers 204 so the agent is never blocked). Count both outcomes,
// and with RIVEN_HOOK_DEBUG=1 say which pane each one landed on.
const hookStats = { delivered: 0, dropped: 0 }
const debugHooks = process.env.RIVEN_HOOK_DEBUG === '1'
export function hookDeliveryStats(): { delivered: number; dropped: number } {
  return { ...hookStats }
}

export function registerAgentHooks(
  handler: (pane: string, event: HookEvent, hook: string, sessionId: string | null) => void
): void {
  onEvent = handler
  registerHttpRoute('/hook', (_req, res, url, body) => {
    const pane = url.searchParams.get('pane')
    const hook = url.searchParams.get('event') ?? ''
    // Always 204: a hook must never make the agent wait on riven's opinion.
    res.writeHead(204).end()
    if (!pane) {
      hookStats.dropped++
      if (debugHooks) console.log(`[hooks] ${hook || '(none)'} dropped: no pane`)
      return
    }
    let payload: unknown = null
    try {
      payload = body ? JSON.parse(body) : null
    } catch {
      payload = null
    }
    const event = claudeHookToEvent(hook, payload)
    if (!event) {
      hookStats.dropped++
      if (debugHooks) console.log(`[hooks] ${hook || '(none)'} dropped: unmapped, pane=${pane}`)
      return
    }
    hookStats.delivered++
    if (debugHooks) console.log(`[hooks] ${hook} pane=${pane} -> ${event} ok`)
    onEvent?.(pane, event, hook, sessionIdOf(payload))
  })
}
