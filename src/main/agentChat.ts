import { app, ipcMain, WebContents } from 'electron'
import { spawn, ChildProcess } from 'child_process'
import { randomUUID } from 'crypto'
import { promises as fsp } from 'fs'
import * as os from 'os'
import * as path from 'path'
import { resolveBin } from './shellPath'
import { repairPastedAddServers, claudeStateFile } from './mcpRepair'
import { hookEnv } from './agentHooks'
import { userContent, type ChatImageInput } from './chatContent'
import { CodexChat } from './codexChat'
import { readCodexTranscript } from './codexSessions'
import {
  configuredMcpServers,
  allowedToolsValue,
  setMcpListRunner,
  setMcpCacheFile,
  rememberSessionServers
} from './mcpServers'
import {
  mcpConfigJson,
  mcpSystemPrompt,
  MCP_TOOL_PREFIX,
  implementedToolNames,
  agentMcpEnv,
  mcpReady
} from './mcpServer'

// Native-chat backend: drives the Claude Code CLI in headless stream-json mode
// (`claude -p --input-format stream-json --output-format stream-json`), the same
// contract the Swift ClaudeChatSession used. One CLI child per chat pane, keyed
// by a stable sessionKey and living in the MAIN process (survives renderer
// reloads; killed only on explicit stop). Approvals/subagents/riven-MCP land in
// Phase 3 — this slice covers spawn, streaming, tool lines, usage/cost + resume.
//
// Auth: we deliberately do NOT set ANTHROPIC_API_KEY or --bare, so the CLI uses
// the user's ~/.claude subscription login (no API billing), matching native.

export interface StartOpts {
  cwd: string
  resume?: string
  model?: string
  permissionMode?: string
  // riven's OWN tools the user switched off (ask_user, open_file, …).
  mcpDisabled?: string[]
  // Whole MCP SERVERS the user does not want riven's agents to use without
  // being asked. Everything else the project has configured is allowed, since
  // a pane cannot show a permission prompt.
  mcpServersDisabled?: string[]
  globalPrompt?: string
  // A custom agent defined in .claude/agents/<name>.md (project or ~). Runs the
  // pane as `claude --agent <name>` so it uses that agent's system prompt/tools.
  agent?: string
  // CLAUDE_CONFIG_DIR for this pane, when the user runs more than one Claude
  // account. Absent means inject nothing (the default, single-account setup).
  configDir?: string
  // Which agent backs the pane. Absent = Claude Code.
  cli?: 'claude' | 'codex'
}

// Codex-backed panes (codexChat.ts), keyed like `sessions`.
const codexChats = new Map<string, CodexChat>()

function startCodexChat(key: string, opts: StartOpts, sender: WebContents): Promise<{ ok: boolean; error?: string }> {
  const existing = codexChats.get(key)
  if (existing) {
    existing.sender = sender
    return Promise.resolve({ ok: true })
  }
  const chat = new CodexChat(
    key,
    {
      cwd: opts.cwd,
      resume: opts.resume,
      model: opts.model,
      permissionMode: opts.permissionMode,
      mcpDisabled: opts.mcpDisabled,
      globalPrompt: opts.globalPrompt
    },
    sender,
    (ev) => {
      if (!chat.sender.isDestroyed()) chat.sender.send('chat:event', ev)
    },
    (c) => {
      if (codexChats.get(key) === c) codexChats.delete(key)
    }
  )
  codexChats.set(key, chat)
  return chat.start().then((r) => {
    if (!r.ok) codexChats.delete(key)
    return r
  })
}

interface Session {
  key: string
  proc: ChildProcess
  sender: WebContents
  buf: string
  sessionId: string | null // Claude session id — used to --resume after a restart
  alive: boolean
  ctrlSeq: number
  sawInit: boolean // whether the CLI reached its init (used for resume fallback)
  streamedText: boolean // any assistant text_delta this turn (else surface result)
  opts: StartOpts // kept so an idle-parked pane can respawn its child unchanged
  lastActive: number
  turnBusy: boolean // a turn is in flight — never park mid-answer
  parking: boolean // killed by the idle reaper, so its exit isn't a real exit
  // Ids of the messages sent to this child that have not been answered yet,
  // oldest first. The CLI's stream never says WHICH turn a `result` ends, but it
  // answers messages in order — so the front of this queue is the turn being
  // answered, and its result is the one that ends it. Without this a late result
  // (an interrupted turn, a turn this side gave up on) closed whichever bubble
  // happened to be open, which was usually the NEXT one.
  turns: string[]
}

const sessions = new Map<string, Session>()
// What each pane was last started with. A message for a pane whose child is gone
// (killed, crashed, stopped) used to be dropped on the floor — the pane sat on
// "writing" forever with nothing to answer it. With this, the child is started
// again and the message goes to it.
const lastStart = new Map<string, { opts: StartOpts; sender: WebContents }>()

// A CLI child stays alive between turns to hold its context, so a pane left open
// pins ~200-500MB (and whatever its MCP workers spin) for as long as the app runs
// — days, in practice. Park the child once a pane has been quiet this long: the
// pane is untouched (its transcript lives in the renderer) and the next message
// respawns it with --resume. Cost is one resume instead of a permanent process.
// (RIVEN_CHAT_IDLE_PARK_MS shortens it so the park/revive path can be exercised
// without waiting half an hour.)
const IDLE_PARK_MS = Number(process.env.RIVEN_CHAT_IDLE_PARK_MS) || 30 * 60_000
const REAP_EVERY_MS = Math.min(60_000, Math.max(2_000, Math.floor(IDLE_PARK_MS / 2)))
const parked = new Map<string, { opts: StartOpts; sender: WebContents }>()

// A single fan-out channel (payload carries `key`) so the renderer attaches one
// listener regardless of how many chat panes are open — same pattern as pty:*.
// Every event may name the turn it belongs to (see Session.turns). Optional so
// an event nobody can place — an exit, a revived child — still gets through.
export type ChatEvent = { turn?: string | null } & (
  | {
      key: string
      kind: 'init'
      sessionId: string | null
      model: string | null
      tools: string[]
      slashCommands: string[]
      mcpServers: Array<{ name: string; status: string }>
    }
  | { key: string; kind: 'text'; delta: string }
  | {
      key: string
      kind: 'tool'
      name: string
      detail: string
      path: string | null
      code: string | null
      toolId: string | null
      parent: string | null
    }
  | { key: string; kind: 'toolResult'; toolId: string; isError: boolean }
  | { key: string; kind: 'fileEdited'; path: string }
  | { key: string; kind: 'usage'; input: number; output: number; isStart: boolean }
  | { key: string; kind: 'turnDone'; costUSD: number | null; sessionId: string | null; error: string | null }
  | { key: string; kind: 'exit'; code: number }
  // The CLI talking about itself, not about the answer. We parsed none of this
  // before, so a request stuck in retry backoff or an account that had hit its
  // limit looked exactly like a model thinking hard.
  | { key: string; kind: 'retry'; attempt: number; max: number; delayMs: number; status: number | null }
  | { key: string; kind: 'limit'; status: string; resetsAt?: number; limitKind?: string; utilization?: number }
  | { key: string; kind: 'compact'; trigger: 'manual' | 'auto'; pre: number; post?: number }
  // A tool saying it is still going. Proof of life during a long call — without
  // it a pane inside a twenty-minute test run looks like a pane that has died.
  | { key: string; kind: 'toolProgress'; toolId: string; elapsed: number }
  | { key: string; kind: 'hook'; name: string; event: string; running: boolean; error?: string | null }
)

function emit(s: Session, ev: ChatEvent): void {
  // Everything that happens while a turn is being answered belongs to that turn
  // (the front of the queue); a `result` names its own turn, see below.
  const tagged = 'turn' in ev ? ev : { ...ev, turn: s.turns[0] ?? null }
  if (!s.sender.isDestroyed()) s.sender.send('chat:event', tagged)
}

// Never throw on a write to a dead pipe (the child may have exited mid-turn).
function writeLine(s: Session, obj: unknown): void {
  if (!s.alive || !s.proc.stdin || s.proc.stdin.destroyed) return
  try {
    s.proc.stdin.write(JSON.stringify(obj) + '\n')
  } catch {
    /* broken pipe — child exited */
  }
}

const shorten = (p: string): string =>
  p.startsWith(process.env.HOME || '~') ? '~' + p.slice((process.env.HOME || '').length) : p

// Per-tool one-line detail, mirroring native toolDetail (clamped to 120 chars).
function toolDetail(name: string, input: Record<string, unknown>): string {
  const s = (v: unknown): string => (typeof v === 'string' ? v : '')
  let d = ''
  switch (name) {
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
    case 'NotebookEdit':
      d = shorten(s(input.file_path))
      break
    case 'Bash':
      d = s(input.description) || s(input.command)
      break
    case 'BashOutput':
      d = s(input.command)
      break
    case 'Grep':
      d = s(input.pattern) + (input.path ? ` in ${shorten(s(input.path))}` : '')
      break
    case 'Glob':
      d = s(input.pattern)
      break
    case 'LS':
      d = shorten(s(input.path))
      break
    case 'WebFetch':
      d = s(input.url)
      break
    case 'WebSearch':
      d = s(input.query)
      break
    case 'Task':
    case 'Agent':
      // Subagent: show its type + task description. (Current CLI names the tool
      // "Agent"; older builds used "Task" — handle both.)
      d = [s(input.subagent_type), s(input.description) || s(input.prompt)]
        .filter(Boolean)
        .join(' · ')
      break
    default:
      d = s(input.file_path) || s(input.path) || s(input.command) || s(input.pattern) || s(input.query)
  }
  return d.length > 120 ? d.slice(0, 120) + '…' : d
}

function toolPath(name: string, input: Record<string, unknown>): string | null {
  if (['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'LS'].includes(name)) {
    const p = input.file_path ?? input.path
    return typeof p === 'string' ? p : null
  }
  return null
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

// A compact LCS line-diff → unified body (" ctx", "-removed", "+added").
function lineDiff(before: string, after: string): string {
  const a = before ? before.split('\n') : []
  const b = after ? after.split('\n') : []
  const m = a.length
  const n = b.length
  if (m > 800 || n > 800) return [...a.map((l) => '-' + l), ...b.map((l) => '+' + l)].join('\n')
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = m - 1; i >= 0; i--)
    for (let j = n - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  const out: string[] = []
  let i = 0
  let j = 0
  while (i < m && j < n) {
    if (a[i] === b[j]) out.push(' ' + a[i++])
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push('-' + a[i++])
    else out.push('+' + b[j++])
  }
  while (i < m) out.push('-' + a[i++])
  while (j < n) out.push('+' + b[j++])
  return out.join('\n')
}

function countDiff(diff: string): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const l of diff.split('\n')) {
    if (l.startsWith('+')) added++
    else if (l.startsWith('-')) removed++
  }
  return { added, removed }
}

// The code/diff body shown when a tool line is expanded (mirrors native toolCode).
function toolCode(name: string, input: Record<string, unknown>): string | null {
  const s = (v: unknown): string => (typeof v === 'string' ? v : '')
  switch (name) {
    case 'Edit':
      return input.old_string !== undefined ? lineDiff(s(input.old_string), s(input.new_string)) : null
    case 'Write':
      return s(input.content) || null
    case 'NotebookEdit':
      return s(input.new_source) || null
    case 'MultiEdit': {
      const edits = (input.edits as Array<Record<string, unknown>>) ?? []
      const body = edits.map((e) => lineDiff(s(e.old_string), s(e.new_string))).join('\n')
      return body || null
    }
    case 'Bash':
      return s(input.command) || null
    default:
      return null
  }
}

function handleEvent(s: Session, ev: Record<string, unknown>): void {
  const type = ev.type as string
  // ---- the CLI's own status, which used to go straight in the bin ----
  if (type === 'system' && ev.subtype === 'api_retry') {
    emit(s, {
      key: s.key,
      kind: 'retry',
      attempt: Number(ev.attempt ?? 0),
      max: Number(ev.max_retries ?? 0),
      delayMs: Number(ev.retry_delay_ms ?? 0),
      status: typeof ev.error_status === 'number' ? ev.error_status : null
    })
    return
  }
  if (type === 'rate_limit_event') {
    const info = (ev.rate_limit_info ?? {}) as Record<string, unknown>
    const kind = typeof info.rateLimitType === 'string' ? info.rateLimitType : undefined
    // Utilization is not beside the status — it lives in the per-window table,
    // keyed by the window this event is about ('five_hour', 'seven_day', …).
    const windows = (info.unifiedWindows ?? {}) as Record<string, { utilization?: unknown }>
    const used = kind ? windows[kind]?.utilization : undefined
    emit(s, {
      key: s.key,
      kind: 'limit',
      status: String(info.status ?? 'allowed'),
      resetsAt: typeof info.resetsAt === 'number' ? info.resetsAt : undefined,
      limitKind: kind,
      utilization: typeof used === 'number' ? used : undefined
    })
    return
  }
  if (type === 'tool_progress') {
    // The heartbeat carries its own id ('<toolId>-heartbeat-0'); the tool it is
    // about is the parent. Matching on the former would never find the line.
    emit(s, {
      key: s.key,
      kind: 'toolProgress',
      toolId: String(ev.parent_tool_use_id ?? ev.tool_use_id ?? ''),
      elapsed: Number(ev.elapsed_time_seconds ?? 0)
    })
    return
  }
  if (type === 'system' && (ev.subtype === 'hook_started' || ev.subtype === 'hook_response')) {
    const running = ev.subtype === 'hook_started'
    const failed = !running && (ev.outcome === 'error' || (typeof ev.exit_code === 'number' && ev.exit_code !== 0))
    emit(s, {
      key: s.key,
      kind: 'hook',
      name: String(ev.hook_name ?? 'hook'),
      event: String(ev.hook_event ?? ''),
      running,
      // Only a FAILURE carries text: a hook that did its job quietly is noise.
      error: failed ? String(ev.stderr || ev.output || '').split('\n')[0].slice(0, 200) || 'failed' : null
    })
    return
  }
  if (type === 'system' && ev.subtype === 'compact_boundary') {
    const meta = (ev.compact_metadata ?? {}) as Record<string, unknown>
    emit(s, {
      key: s.key,
      kind: 'compact',
      trigger: meta.trigger === 'manual' ? 'manual' : 'auto',
      pre: Number(meta.pre_tokens ?? 0),
      post: typeof meta.post_tokens === 'number' ? meta.post_tokens : undefined
    })
    return
  }
  if (type === 'system' && ev.subtype === 'init') {
    s.sawInit = true
    s.sessionId = (ev.session_id as string) ?? s.sessionId
    // The servers this session really has, so the next pane in this folder is
    // allowed them even where `claude mcp list` leaves some out.
    if (Array.isArray(ev.mcp_servers)) {
      void rememberSessionServers(
        s.opts.cwd,
        s.opts.configDir,
        (ev.mcp_servers as Array<{ name?: string }>).map((m) => m?.name ?? '')
      )
    }
    emit(s, {
      key: s.key,
      kind: 'init',
      sessionId: s.sessionId,
      model: (ev.model as string) ?? null,
      tools: Array.isArray(ev.tools) ? (ev.tools as string[]) : [],
      // The commands actually available in this session (built-ins that work
      // headless + bundled/user skills + MCP prompts). Drives the "/" menu.
      slashCommands: Array.isArray(ev.slash_commands) ? (ev.slash_commands as string[]) : [],
      mcpServers: Array.isArray(ev.mcp_servers)
        ? (ev.mcp_servers as Array<{ name: string; status: string }>)
        : []
    })
    return
  }
  if (type === 'stream_event') {
    const e = ev.event as Record<string, unknown> | undefined
    if (!e) return
    const et = e.type as string
    if (et === 'message_start') {
      s.streamedText = false
      const u = ((e.message as Record<string, unknown>)?.usage ?? {}) as Record<string, number>
      emit(s, {
        key: s.key,
        kind: 'usage',
        input: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
        output: 0,
        isStart: true
      })
    } else if (et === 'message_delta') {
      const u = (e.usage ?? {}) as Record<string, number>
      emit(s, { key: s.key, kind: 'usage', input: -1, output: u.output_tokens ?? 0, isStart: false })
    } else if (et === 'content_block_delta') {
      const delta = e.delta as Record<string, unknown> | undefined
      if (delta?.type === 'text_delta') {
        s.streamedText = true
        emit(s, { key: s.key, kind: 'text', delta: delta.text as string })
      }
    }
    return
  }
  if (type === 'assistant') {
    const content = ((ev.message as Record<string, unknown>)?.content ?? []) as Array<Record<string, unknown>>
    for (const block of content) {
      if (block.type === 'tool_use') {
        const name = block.name as string
        const input = (block.input ?? {}) as Record<string, unknown>
        const code = toolCode(name, input)
        let detail = toolDetail(name, input)
        // Show +added -removed on edit tools (like native "Edit foo.ts +18 -4").
        if (EDIT_TOOLS.has(name) && code && name !== 'Write' && name !== 'NotebookEdit') {
          const { added, removed } = countDiff(code)
          if (added || removed) detail += `  +${added} -${removed}`
        }
        emit(s, {
          key: s.key,
          kind: 'tool',
          name,
          detail,
          path: toolPath(name, input),
          code,
          toolId: (block.id as string) ?? null,
          // A subagent's own tool calls arrive with parent_tool_use_id = the Task's
          // id, so the renderer can nest them under that subagent card.
          parent: (ev.parent_tool_use_id as string) ?? null
        })
      }
      // Full `text` blocks are ignored — the streamed text_delta already rendered
      // them, so re-emitting would duplicate the assistant message.
    }
    return
  }
  if (type === 'user') {
    const content = ((ev.message as Record<string, unknown>)?.content ?? []) as Array<Record<string, unknown>>
    for (const block of content) {
      if (block.type === 'tool_result') {
        // A tool finished — tell the renderer so it flips that tool (and, for the
        // Agent tool, its subagent card) from "running" to "done". For a subagent
        // this tool_use_id is the Agent tool's id.
        const id = block.tool_use_id as string | undefined
        if (id) emit(s, { key: s.key, kind: 'toolResult', toolId: id, isError: block.is_error === true })
      }
    }
    return
  }
  if (type === 'result') {
    s.turnBusy = false // turn over — the pane is now parkable if it stays quiet
    s.sessionId = (ev.session_id as string) ?? s.sessionId
    // Resume THIS conversation if the pane ever has to be revived.
    const prev = lastStart.get(s.key)
    if (prev && s.sessionId) lastStart.set(s.key, { ...prev, opts: { ...prev.opts, resume: s.sessionId } })
    // Slash commands (e.g. /usage, /context) return their output ONLY in the
    // result — nothing streams as assistant text. Surface it so the pane shows the
    // command's answer instead of an empty turn.
    if (!s.streamedText && typeof ev.result === 'string' && ev.result.trim()) {
      emit(s, { key: s.key, kind: 'text', delta: ev.result })
    }
    const isError = ev.is_error === true || (ev.subtype && ev.subtype !== 'success')
    // This result ends the OLDEST unanswered message, which is not necessarily
    // the turn the pane is showing now.
    const turn = s.turns.shift() ?? null
    emit(s, {
      key: s.key,
      kind: 'turnDone',
      costUSD: typeof ev.total_cost_usd === 'number' ? ev.total_cost_usd : null,
      sessionId: s.sessionId,
      error: isError ? String(ev.subtype ?? 'error') : null,
      turn
    })
    return
  }
}

const DEFAULT_ALLOWED =
  'Task,Read,Grep,Glob,LS,Edit,Write,MultiEdit,NotebookEdit,Bash,BashOutput,WebFetch,WebSearch,TodoWrite'

// Plugins — and therefore their skills AND their MCP servers — are resolved
// under the CONFIG dir, so a profile riven created starts with none of them: the
// same workspace silently loses figma/lsp/skills the moment it pins a profile.
// Share the user's plugin store (a symlink, so installs stay in ONE place) and
// seed enabledPlugins once. Idempotent, best-effort, never fatal: a session
// without plugins is worse than a session, so nothing here may throw.
async function ensureProfilePlugins(configDir: string): Promise<void> {
  const home = path.join(os.homedir(), '.claude')
  if (path.resolve(configDir) === path.resolve(home)) return
  try {
    await fsp.mkdir(configDir, { recursive: true })
    const link = path.join(configDir, 'plugins')
    // Only create it if nothing is there — never replace a real directory the
    // user (or the CLI) has put plugins into.
    if (!(await fsp.lstat(link).catch(() => null))) {
      await fsp.symlink(path.join(home, 'plugins'), link, 'dir').catch(() => {})
    }
    const file = path.join(configDir, 'settings.json')
    const read = async (p: string): Promise<Record<string, unknown>> => {
      try {
        return JSON.parse(await fsp.readFile(p, 'utf8')) as Record<string, unknown>
      } catch {
        return {}
      }
    }
    const settings = await read(file)
    // Seed once: after that the profile owns its own enabled set, so disabling a
    // plugin in one profile is not undone on the next launch.
    if (settings.enabledPlugins) return
    const enabled = (await read(path.join(home, 'settings.json'))).enabledPlugins
    if (!enabled) return
    await fsp.writeFile(file, JSON.stringify({ ...settings, enabledPlugins: enabled }, null, 2))
  } catch {
    /* a profile without plugins still runs */
  }
}

async function startSession(
  key: string,
  opts: StartOpts,
  sender: WebContents
): Promise<{ ok: boolean; error?: string }> {
  if (opts.cli === 'codex') return startCodexChat(key, opts, sender)
  const existing = sessions.get(key)
  if (existing) {
    existing.sender = sender // reattach after a renderer reload
    existing.lastActive = Date.now()
    return { ok: true }
  }
  // Starting explicitly supersedes a parked child: this call carries the pane's
  // own resume id, so the parked copy would only respawn a duplicate.
  parked.delete(key)
  // The riven MCP config is built from the loopback server's base url, and
  // mcpConfigJson() returns NULL until it is listening. A chat pane starts as
  // soon as its panel mounts — which is during startup, exactly when the server
  // may still be coming up — and a null config means the CLI is spawned with
  // neither --mcp-config nor the prompt describing the tools. The agent then has
  // no riven tools at all and says so, for the life of that session, with
  // nothing logged. Same guard as pty:open.
  await mcpReady()
  const cmd = await resolveBin('claude')
  if (!cmd) return { ok: false, error: 'claude CLI not found on PATH' }

  const args = [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    // Hook lifecycle on the stream. A user's own hook that blocks a tool or
    // fails silently is otherwise indistinguishable from the agent stalling.
    '--include-hook-events',
    '--permission-mode',
    opts.permissionMode || 'acceptEdits'
  ]
  // Every MCP server this project has, allowed by name.
  //
  // The CLI refuses a tool that isn't pre-allowed, and a chat pane is
  // non-interactive — there is nobody to answer its permission prompt. Passing
  // only riven's own prefix meant a server the user had deliberately added
  // (devhub, sentry, …) failed here while working in a terminal, where a human
  // can approve it, and the agent reported it simply had no such tool.
  const externalServers = await configuredMcpServers(opts.cwd, opts.configDir)
  args.push(
    '--allowedTools',
    allowedToolsValue(DEFAULT_ALLOWED, MCP_TOOL_PREFIX, externalServers, opts.mcpServersDisabled ?? [])
  )
  if (externalServers.length) console.log(`[chat:${key}] mcp servers allowed: ${externalServers.join(', ')}`)
  // riven's own MCP tools (ask_user / open_file / panels / workspaces / …): the
  // loopback HTTP server, inline in --mcp-config. Only implemented tools the
  // user hasn't disabled are advertised; the pane key rides on the URL so every
  // call comes back tagged with WHICH conversation made it.
  const disabled = new Set(opts.mcpDisabled ?? [])
  const enabled = implementedToolNames().filter((n) => !disabled.has(n))
  const mcpConfig = enabled.length ? mcpConfigJson(enabled, key) : null
  if (mcpConfig) args.push('--mcp-config', mcpConfig)
  else if (enabled.length) {
    // Tools are switched on but we could not build a config: the server never
    // came up. Say it — this used to be silent, and the only symptom was the
    // agent claiming it has no riven tools.
    console.error(`[chat:${key}] starting WITHOUT riven MCP (no loopback server)`)
  }
  // Document available tools + the user's global instruction (--append-system-prompt).
  const globalPrompt = (opts.globalPrompt ?? '').trim()
  const promptParts: string[] = []
  if (mcpConfig) promptParts.push(mcpSystemPrompt())
  if (globalPrompt) promptParts.push('# 사용자 지정 지침\n' + globalPrompt)
  if (promptParts.length) args.push('--append-system-prompt', promptParts.join('\n\n'))
  if (opts.model && opts.model !== 'default') args.push('--model', opts.model)
  if (opts.agent) args.push('--agent', opts.agent)
  // A pane with a session id resumes it. A pane WITHOUT one wants a new
  // conversation — and must say so explicitly: given neither --resume nor
  // --session-id, the CLI continues the most recent conversation for the cwd, so
  // a pane the user had just opened came up already holding the last chat's
  // history (verified: three freshly created panes all reported the newest
  // session id in ~/.claude, whose file the CLI never even touched). Pinning a
  // fresh uuid makes "no resume id" mean what it says.
  if (opts.resume) args.push('--resume', opts.resume)
  else args.push('--session-id', randomUUID())

  // The same hooks a terminal CLI gets. Lifecycle hooks are redundant here (a
  // chat pane reads its own stream) and land on a pane main has no PTY session
  // for, which is a no-op — but PreToolUse/PostToolUse are how this pane's file
  // edits reach the changes timeline, and they must be reported the same way a
  // terminal's are (see agentEdits.ts).
  const hooks = hookEnv(key)
  if (hooks.RIVEN_HOOKS_SETTINGS) args.push('--settings', hooks.RIVEN_HOOKS_SETTINGS)
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...agentMcpEnv(),
    ...hooks,
    RIVEN_CHAT_KEY: key
  }
  if (opts.configDir) {
    childEnv.CLAUDE_CONFIG_DIR = opts.configDir
    await ensureProfilePlugins(opts.configDir)
  }
  let proc: ChildProcess
  try {
    // childEnv carries the pane's key so its riven MCP calls come back tagged with
    // WHICH conversation made them (see mcpServer's relay).
    proc = spawn(cmd, args, { cwd: opts.cwd, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] })
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }

  const s: Session = {
    key,
    proc,
    sender,
    buf: '',
    sessionId: opts.resume ?? null,
    alive: true,
    ctrlSeq: 0,
    sawInit: false,
    streamedText: false,
    opts,
    lastActive: Date.now(),
    turnBusy: false,
    parking: false,
    turns: []
  }
  sessions.set(key, s)
  lastStart.set(key, { opts, sender })

  proc.stdout?.on('data', (chunk: Buffer) => {
    s.lastActive = Date.now()
    s.buf += chunk.toString()
    let nl: number
    while ((nl = s.buf.indexOf('\n')) >= 0) {
      const line = s.buf.slice(0, nl)
      s.buf = s.buf.slice(nl + 1)
      if (!line.trim()) continue
      let ev: Record<string, unknown>
      try {
        ev = JSON.parse(line)
      } catch {
        continue
      }
      handleEvent(s, ev)
    }
  })
  proc.stderr?.on('data', (d: Buffer) => console.log(`[chat:${key}]`, d.toString().trim()))
  proc.on('exit', (code) => {
    s.alive = false
    // A child exits ASYNCHRONOUSLY: by the time this runs, the pane may already
    // have been given a NEW child (chat:restart). Only clear the map when it
    // still holds THIS one, or the restart's session is deleted out from under
    // it and the pane's next message reaches nothing.
    if (sessions.get(key) !== s) return
    sessions.delete(key)
    // Parked by the idle reaper — the pane is still open and will respawn on its
    // next message, so this exit must not reach the renderer as a session end.
    if (s.parking) return
    // Resume fallback: if we asked to --resume a session but the CLI exited before
    // ever reaching init, the session id was likely stale (deleted / other
    // machine). Restart once WITHOUT resume so the pane stays usable instead of
    // dying — the visible transcript is kept; only server-side context is lost.
    if (opts.resume && !s.sawInit) {
      console.log(`[chat:${key}] resume failed (stale session), starting fresh`)
      void startSession(key, { ...opts, resume: undefined }, sender)
      return
    }
    emit(s, { key, kind: 'exit', code: code ?? 0 })
  })
  proc.on('error', (e) => {
    s.alive = false
    console.error(`[chat:${key}] spawn error`, e)
    sessions.delete(key)
  })
  return { ok: true }
}

function stopSession(key: string): void {
  parked.delete(key)
  const codex = codexChats.get(key)
  if (codex) {
    codexChats.delete(key)
    codex.stop()
  }
  const s = sessions.get(key)
  if (!s) return
  s.alive = false
  try {
    s.proc.stdin?.end()
  } catch {
    /* ignore */
  }
  try {
    s.proc.kill()
  } catch {
    /* already exited */
  }
  sessions.delete(key)
}

// Park every pane that has been quiet past the threshold. Runs on a slow timer
// (unref'd so it never holds the app open) — a turn in flight is always skipped.
function reapIdleSessions(): void {
  const now = Date.now()
  for (const [key, s] of [...sessions]) {
    // No sessionId means the CLI never reached init, so there is nothing to
    // --resume from: killing it would lose the pane's context outright.
    if (s.turnBusy || !s.sessionId) continue
    if (now - s.lastActive < IDLE_PARK_MS) continue
    s.parking = true
    const entry = { opts: { ...s.opts, resume: s.sessionId }, sender: s.sender }
    stopSession(key) // clears any stale parked entry first
    parked.set(key, entry)
  }
}

// Kill every CLI child. Called at quit: the app's shutdown path SIGKILLs itself,
// which would otherwise leave these children reparented to launchd and running
// (each one holding its memory) long after riven is gone.
// Chat panes whose agent is mid-turn — what quitting would cut off.
export function runningChatCount(): number {
  let n = 0
  for (const s of sessions.values()) if (s.turnBusy) n++
  for (const c of codexChats.values()) if (c.turnBusy) n++
  return n
}

export function killAllChatSessions(): void {
  for (const c of codexChats.values()) c.stop()
  codexChats.clear()
  for (const s of sessions.values()) {
    s.parking = true // suppress exit events during teardown
    try {
      s.proc.kill()
    } catch {
      /* already exited */
    }
  }
  sessions.clear()
  parked.clear()
}

export function registerAgentChatHandlers(): void {
  setInterval(reapIdleSessions, REAP_EVERY_MS).unref()
  // Here, not at module load: userData only exists once the app is ready, and
  // this list is what lets the FIRST pane of a cold start know which MCP
  // servers exist — asking the CLI takes seconds (it health-checks each one),
  // and every restored pane spawns in the first moment after launch.
  setMcpCacheFile(path.join(app.getPath('userData'), 'mcp-servers.json'))

  ipcMain.handle('chat:start', (event, key: string, opts: StartOpts) =>
    startSession(key, opts, event.sender)
  )
  ipcMain.on('chat:send', (event, key: string, text: string, images?: ChatImageInput[], turn?: string) => {
    const codex = codexChats.get(key)
    if (codex) {
      void codex.send(text, images, turn)
      return
    }
    const line = {
      type: 'user',
      message: { role: 'user', content: userContent(text, images) },
      parent_tool_use_id: null
    }
    const s = sessions.get(key)
    if (s) {
      s.turnBusy = true
      s.lastActive = Date.now()
      // ALWAYS push, even when the renderer did not name the turn (a bare
      // /clear does not). One user line produces exactly one result, so a line
      // with no id still has to occupy a slot — without it the queue runs one
      // short and the NEXT turn's result is handed to the wrong id, which the
      // pane then reads as "your new message is already done" while the agent
      // is still working on it.
      s.turns.push(turn ?? `main_${randomUUID()}`)
      writeLine(s, line)
      return
    }
    // Parked while idle, or simply gone (killed, crashed): respawn the child —
    // resuming the conversation it was in — and deliver the message to it, so a
    // message is never silently dropped.
    const p = parked.get(key) ?? lastStart.get(key)
    if (!p) {
      // Nothing to revive: tell the pane instead of leaving it waiting forever.
      if (!event.sender.isDestroyed()) {
        event.sender.send('chat:event', {
          key,
          kind: 'turnDone',
          costUSD: null,
          sessionId: null,
          error: 'no agent for this pane',
          turn: turn ?? null
        })
      }
      return
    }
    parked.delete(key)
    void startSession(key, p.opts, event.sender).then(() => {
      const revived = sessions.get(key)
      if (!revived) return
      revived.turnBusy = true
      revived.lastActive = Date.now()
      revived.turns.push(turn ?? `main_${randomUUID()}`)
      writeLine(revived, line)
    })
  })
  // Is there still an agent behind this pane? The pane asks before deciding a
  // silent turn is a dead one: a turn can go minutes without a word while a tool
  // runs (a test suite, a long read), and that is not the same as nobody home.
  ipcMain.handle('chat:alive', (_e, key: string) => {
    const s = sessions.get(key)
    if (s) return { alive: s.alive, running: s.turnBusy }
    const c = codexChats.get(key)
    if (c) return { alive: true, running: c.turnBusy }
    // Parked (or revivable) counts as alive: the next message brings it back.
    return { alive: parked.has(key) || lastStart.has(key), running: false }
  })

  ipcMain.on('chat:interrupt', (_e, key: string) => {
    codexChats.get(key)?.interrupt()
    const s = sessions.get(key)
    if (!s) return
    s.lastActive = Date.now()
    writeLine(s, { type: 'control_request', request_id: `i${++s.ctrlSeq}`, request: { subtype: 'interrupt' } })
  })
  ipcMain.on('chat:setModel', (_e, key: string, model: string) => {
    codexChats.get(key)?.setModel(model)
    const s = sessions.get(key)
    if (s)
      writeLine(s, {
        type: 'control_request',
        request_id: `m${++s.ctrlSeq}`,
        request: { subtype: 'set_model', model }
      })
  })
  ipcMain.on('chat:setMode', (_e, key: string, mode: string) => {
    codexChats.get(key)?.setMode(mode)
    const s = sessions.get(key)
    // riven's "auto" is a riven-side auto-allow policy; the CLI's own name is "default".
    if (s)
      writeLine(s, {
        type: 'control_request',
        request_id: `m${++s.ctrlSeq}`,
        request: { subtype: 'set_permission_mode', mode: mode === 'auto' ? 'default' : mode }
      })
  })
  // The pane is gone (closed): forget how to revive it, or a stray message
  // would bring a closed conversation back.
  ipcMain.on('chat:stop', (_e, key: string) => {
    lastStart.delete(key)
    stopSession(key)
  })

  // Restart the CLI behind a pane (or every pane) WITHOUT losing the
  // conversation: the child is replaced and resumes the same session, which is
  // what makes "update the CLI" mean anything for panes that are already open —
  // a running child keeps the binary it started with. A pane mid-turn is left
  // alone: killing it there would throw away the answer being written.
  ipcMain.handle('chat:restart', async (event, key?: string) => {
    const keys = key ? [key] : [...sessions.keys(), ...codexChats.keys()]
    let restarted = 0
    let busy = 0
    for (const k of keys) {
      const claude = sessions.get(k)
      if (claude) {
        if (claude.turnBusy) {
          busy++
          continue
        }
        const opts = { ...claude.opts, resume: claude.sessionId ?? claude.opts.resume }
        const sender = claude.sender
        // The pane is not ending — it is getting a new process — so its exit
        // must not reach the renderer as a session that stopped.
        claude.parking = true
        stopSession(k)
        const res = await startSession(k, opts, sender)
        if (res.ok) restarted++
        continue
      }
      const codex = codexChats.get(k)
      if (!codex) continue
      if (codex.turnBusy) {
        busy++
        continue
      }
      const opts = codex.restartOpts()
      const sender = codex.sender
      stopSession(k)
      const res = await startCodexChat(k, { ...opts, cli: 'codex' }, sender)
      if (res.ok) restarted++
    }
    void event
    return { restarted, busy }
  })

  // The session's REAL command list + MCP servers, fetched up front (cached per
  // cwd) by spawning a throwaway headless claude in that directory. stream-json
  // only emits `init` after the first input, so we send a nudge and kill at init
  // — this yields the exact list (built-ins + repo skills + MCP prompts) and MCP
  // connection/auth statuses WITHOUT the user having to send a message first.
  ipcMain.handle('chat:sessionInfo', (_e, cwd: string, configDir?: string) =>
    fetchSessionInfo(cwd, configDir)
  )

  // List resumable past sessions for a cwd (native /resume), newest first.
  ipcMain.handle('chat:sessions', async (_e, cwd: string, configDir?: string) =>
    listSessions(cwd, configDir)
  )

  // Custom agents defined in .claude/agents/<name>.md (project + ~), usable as
  // `claude --agent <name>`. Mirrors Claude Code's own agent discovery.
  ipcMain.handle('chat:agents', async (_e, cwd: string) => listAgents(cwd))

  // Reconstruct a past session's transcript for display when resuming.
  // A Codex pane's conversation lives in Codex's rollout, not in ~/.claude.
  ipcMain.handle('chat:sessionTranscript', async (_e, cwd: string, id: string, configDir?: string) => {
    const claude = await readSessionTranscript(cwd, id, configDir)
    return claude.length ? claude : readCodexTranscript(id)
  })
  ipcMain.handle('chat:sessionTitle', async (_e, cwd: string, id: string, configDir?: string) =>
    readSessionTitle(cwd, id, configDir)
  )

  // MCP status/teardown via `claude mcp …`. Both take the pane's configDir: the
  // chat itself runs under the workspace's CLAUDE_CONFIG_DIR, so asking the CLI
  // without it reports a DIFFERENT config's servers — the card then shows a
  // server as missing or unauthenticated while the agent is happily using it.
  // `mcp login`/`mcp add` are NOT here: they are interactive and run in a real
  // terminal panel (see McpCard), which a hidden spawn with no stdin cannot do.
  ipcMain.handle('chat:mcpList', async (_e, cwd: string, configDir?: string) =>
    mcpList(cwd, configDir)
  )
  // What the AGENT actually gets, which `mcp list` does NOT answer: it reports a
  // claude.ai connector as connected off stored credentials while a real session
  // reports the same one as needs-auth, and it omits connectors (Figma) and
  // plugin servers entirely. The card has to show the session's own answer or it
  // keeps telling the user something is fine when the agent cannot use it.
  ipcMain.handle('chat:mcpSession', async (_e, cwd: string, configDir?: string, fresh?: boolean) =>
    (await fetchSessionInfo(cwd, configDir, fresh)).mcpServers
  )
  ipcMain.handle('chat:mcpLogout', async (_e, cwd: string, name: string, configDir?: string) =>
    runClaudeMcp(cwd, ['mcp', 'logout', name], 20000, configDir)
  )
  // Approving a .mcp.json server is a stored decision, not a conversation: the
  // CLI only offers it as an interactive trust prompt, so write the same record
  // instead of parking an invisible REPL that nobody can answer.
  ipcMain.handle('chat:mcpApprove', async (_e, cwd: string, name: string, configDir?: string) =>
    approveMcpJson(cwd, name, configDir)
  )

  // Generate a short AI title from the user's first message (native refreshAITitle).
  // A one-off cheap haiku call; returns '' on any failure so the caller keeps the
  // immediate first-message title.
  ipcMain.handle('chat:title', async (_e, message: string): Promise<string> => {
    const cmd = await resolveBin('claude')
    if (!cmd) return ''
    const prompt =
      '다음 요청을 한국어로 2~5단어의 짧은 제목으로 요약해. 따옴표·마침표 없이 제목만 한 줄로 출력:\n\n' +
      message.slice(0, 800)
    return await new Promise<string>((resolve) => {
      let out = ''
      let done = false
      const finish = (v: string): void => {
        if (!done) {
          done = true
          resolve(v)
        }
      }
      try {
        const proc = spawn(cmd, ['-p', prompt, '--model', 'haiku', '--output-format', 'text'], {
          stdio: ['ignore', 'pipe', 'ignore'],
          env: { ...process.env }
        })
        proc.stdout?.on('data', (c: Buffer) => (out += c.toString()))
        proc.on('close', () => finish(out.trim().split('\n')[0].replace(/^["'`]|["'`]$/g, '').slice(0, 40)))
        proc.on('error', () => finish(''))
        setTimeout(() => {
          try {
            proc.kill()
          } catch {
            /* ignore */
          }
          finish('')
        }, 12000)
      } catch {
        finish('')
      }
    })
  })

  // List the AI CLIs installed on the login-shell PATH, with a version string
  // when the tool reports one (native AgentDiscovery.available + claudeVersion).
  // Shown in Settings › AI so the user can see what's detected and update it.
  ipcMain.handle(
    'chat:detectClis',
    async (): Promise<Array<{ name: string; cmd: string; path: string; version: string | null }>> => {
      const candidates = [
        { name: 'Claude Code', cmd: 'claude' },
        { name: 'Codex', cmd: 'codex' }
      ]
      const out: Array<{ name: string; cmd: string; path: string; version: string | null }> = []
      for (const c of candidates) {
        const p = await resolveBin(c.cmd)
        if (!p) continue
        let version: string | null = null
        try {
          const r = await new Promise<string>((resolve) => {
            let s = ''
            const proc = spawn(p, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] })
            proc.stdout?.on('data', (b: Buffer) => (s += b.toString()))
            proc.on('close', () => resolve(s))
            proc.on('error', () => resolve(''))
            setTimeout(() => {
              try {
                proc.kill()
              } catch {
                /* ignore */
              }
              resolve(s)
            }, 4000)
          })
          const m = r.match(/\d+\.\d+(\.\d+)?/)
          version = m ? m[0] : null
        } catch {
          /* leave version null */
        }
        out.push({ name: c.name, cmd: c.cmd, path: p, version })
      }
      return out
    }
  )

  // Connected AI accounts (native Settings › Account). Reads each CLI's own login
  // state locally: Claude Code's plan from its keychain item, Codex's email/plan
  // from its OAuth token. Tokens themselves NEVER leave the main process — only
  // {loggedIn, plan, email} are returned. Login/logout run in a terminal.
  // Where a new Claude account profile keeps its CLAUDE_CONFIG_DIR. Under
  // userData so it is riven's to manage, and never the user's own ~/.claude.
  ipcMain.handle('accounts:profileDir', (_e, id: string): string =>
    path.join(app.getPath('userData'), 'claude-profiles', id.replace(/[^\w-]/g, ''))
  )

  // `claude auth logout` is a real, non-interactive subcommand, so it runs right
  // here. Opening a terminal panel for it (as riven used to) was pure noise: the
  // CLI has nothing to ask. Login still needs a terminal — that one runs a browser
  // OAuth flow and may ask the user to paste a code back.
  ipcMain.handle('accounts:logout', async (_e, configDir?: string) =>
    runClaudeMcp(os.homedir(), ['auth', 'logout'], 30000, configDir)
  )

  // NOTE: there is deliberately no background login. Claude Code documents the
  // browser sign-in as interactive — it may ask you to press `c` to copy the URL,
  // or to paste a code back at its prompt — and names `claude setup-token` as the
  // path for environments without an interactive terminal. So login runs in a
  // real terminal pane; riven watches `auth status` to know when it finished.

  ipcMain.handle('accounts:list', async (_e, configDir?: string): Promise<AccountInfo[]> => {
    const [claude, codex] = await Promise.all([claudeAccount(configDir), codexAccount()])
    return [claude, codex].filter((a): a is AccountInfo => a !== null)
  })
}

// ---- session info (slash commands + MCP servers), cached per cwd -------------
export interface SessionInfo {
  slashCommands: string[]
  mcpServers: Array<{ name: string; status: string }>
}
const sessionInfoCache = new Map<string, SessionInfo>()
// Keyed by config dir too: the same cwd under two Claude profiles has different
// slash commands, plugins and MCP servers.
const sessionInfoKey = (cwd: string, configDir?: string): string => `${configDir ?? ''} ${cwd}`

// One probe per key at a time. Two callers want this at once on every chat open
// (slash commands + the MCP card), and each miss is a whole CLI session — without
// this they spawn two and both wait the full latency.
const sessionInfoInflight = new Map<string, Promise<SessionInfo>>()

// `fresh` re-probes instead of trusting the cache — after a login the whole point
// is that the answer has changed.
async function fetchSessionInfo(
  cwd: string,
  configDir?: string,
  fresh = false
): Promise<SessionInfo> {
  const key = sessionInfoKey(cwd, configDir)
  const cached = sessionInfoCache.get(key)
  if (cached && !fresh) return cached
  const running = sessionInfoInflight.get(key)
  if (running) return await running
  const probe = probeSessionInfo(cwd, configDir, key)
  sessionInfoInflight.set(key, probe)
  try {
    return await probe
  } finally {
    sessionInfoInflight.delete(key)
  }
}

async function probeSessionInfo(
  cwd: string,
  configDir: string | undefined,
  key: string
): Promise<SessionInfo> {
  const cmd = await resolveBin('claude')
  const empty: SessionInfo = { slashCommands: [], mcpServers: [] }
  if (!cmd) return empty
  const mcpConfig = mcpConfigJson(implementedToolNames())
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose']
  if (mcpConfig) args.push('--mcp-config', mcpConfig)
  const env = { ...process.env }
  if (configDir) {
    env.CLAUDE_CONFIG_DIR = configDir
    await ensureProfilePlugins(configDir)
  }
  return await new Promise<SessionInfo>((resolve) => {
    let done = false
    let buf = ''
    const proc = spawn(cmd, args, { cwd, env, stdio: ['pipe', 'pipe', 'ignore'] })
    const finish = (v: SessionInfo): void => {
      if (done) return
      done = true
      try {
        proc.kill()
      } catch {
        /* ignore */
      }
      if (v.slashCommands.length) sessionInfoCache.set(key, v)
      resolve(v)
    }
    proc.stdout?.on('data', (d: Buffer) => {
      buf += d.toString()
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        if (!line.trim()) continue
        let j: Record<string, unknown>
        try {
          j = JSON.parse(line)
        } catch {
          continue
        }
        if (j.type === 'system' && j.subtype === 'init') {
          finish({
            slashCommands: Array.isArray(j.slash_commands) ? (j.slash_commands as string[]) : [],
            mcpServers: Array.isArray(j.mcp_servers)
              ? (j.mcp_servers as Array<{ name: string; status: string }>)
              : []
          })
        }
      }
    })
    proc.on('error', () => finish(empty))
    // stream-json emits init only after the first input; nudge it, then kill at init.
    try {
      proc.stdin?.write(JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }) + '\n')
    } catch {
      /* ignore */
    }
    // Measured at ~7s in a workspace with plugins enabled — the old 8s budget sat
    // right on top of that, so a normal probe timed out, returned nothing, and
    // (caching only a non-empty result) paid the full wait again on every call.
    setTimeout(() => finish(empty), 25000)
  })
}

// ---- custom agents (.claude/agents) -----------------------------------------
export interface AgentDef {
  name: string
  description: string
  source: 'project' | 'user'
}

// A Claude agent .md starts with YAML frontmatter (name, description, ...). Pull
// name (default to the filename) and description for the picker.
function parseAgentMd(file: string, raw: string): { name: string; description: string } {
  const base = path.basename(file, '.md')
  const m = /^---\s*\n([\s\S]*?)\n---/.exec(raw)
  let name = base
  let description = ''
  if (m) {
    for (const line of m[1].split('\n')) {
      const kv = /^(\w+):\s*(.*)$/.exec(line.trim())
      if (!kv) continue
      const v = kv[2].replace(/^["']|["']$/g, '').trim()
      if (kv[1] === 'name' && v) name = v
      else if (kv[1] === 'description' && v) description = v
    }
  }
  return { name, description }
}

async function listAgents(cwd: string): Promise<AgentDef[]> {
  const dirs: Array<{ dir: string; source: 'project' | 'user' }> = [
    { dir: path.join(cwd, '.claude', 'agents'), source: 'project' },
    { dir: path.join(os.homedir(), '.claude', 'agents'), source: 'user' }
  ]
  const seen = new Set<string>()
  const out: AgentDef[] = []
  for (const { dir, source } of dirs) {
    let files: string[]
    try {
      files = (await fsp.readdir(dir)).filter((f) => f.endsWith('.md'))
    } catch {
      continue
    }
    for (const f of files) {
      try {
        const raw = await fsp.readFile(path.join(dir, f), 'utf8')
        const { name, description } = parseAgentMd(f, raw)
        if (seen.has(name)) continue // project overrides user on name clash
        seen.add(name)
        out.push({ name, description, source })
      } catch {
        /* skip unreadable */
      }
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

// ---- past sessions for /resume ----------------------------------------------
// Claude stores each session as <config>/projects/<encoded-cwd>/<id>.jsonl,
// where the cwd's "/" and "." become "-".
//
// <config> is CLAUDE_CONFIG_DIR when set, else ~/.claude — and a pane's chat is
// spawned with the workspace's profile as CLAUDE_CONFIG_DIR. Reading this back
// from ~/.claude unconditionally meant a profiled workspace's panes found NO
// transcript: the CLI resumed fine (the child carries the profile, so the model
// kept its context) while the panel came back blank. Every caller must pass the
// same configDir the pane runs under.
function projectDir(cwd: string, configDir?: string): string {
  const base = configDir || path.join(os.homedir(), '.claude')
  return path.join(base, 'projects', cwd.replace(/[/.]/g, '-'))
}

export interface SessionSummary {
  id: string
  title: string
  mtime: number
  messages: number
}

async function listSessions(cwd: string, configDir?: string): Promise<SessionSummary[]> {
  const dir = projectDir(cwd, configDir)
  let files: string[]
  try {
    files = (await fsp.readdir(dir)).filter((f) => f.endsWith('.jsonl'))
  } catch {
    return []
  }
  const out: SessionSummary[] = []
  for (const f of files) {
    const full = path.join(dir, f)
    try {
      const stat = await fsp.stat(full)
      const raw = await fsp.readFile(full, 'utf8')
      const lines = raw.split('\n').filter(Boolean)
      let title = ''
      let messages = 0
      for (const l of lines) {
        let j: Record<string, unknown>
        try {
          j = JSON.parse(l)
        } catch {
          continue
        }
        if (j.type === 'ai-title' && typeof j.title === 'string' && j.title) title = j.title
        if (j.type === 'user' || j.type === 'assistant') messages++
        if (!title && j.type === 'user') {
          const c = (j.message as Record<string, unknown>)?.content
          if (typeof c === 'string' && !c.startsWith('<')) title = c.slice(0, 60)
        }
      }
      if (messages === 0) continue
      out.push({ id: f.replace(/\.jsonl$/, ''), title: title || '(제목 없음)', mtime: stat.mtimeMs, messages })
    } catch {
      /* skip unreadable */
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, 50)
}

// Reconstruct a session transcript for display (user text + assistant text/tools).
// The title of ONE session, without listSessions' scan of every file in the
// project directory. A terminal running a CLI knows its session id (from the
// hooks) but nothing about the conversation, and "claude" on ten tabs says
// nothing — this is what the tab can show instead.
export async function readSessionTitle(
  cwd: string,
  id: string,
  configDir?: string
): Promise<string | null> {
  const full = path.join(projectDir(cwd, configDir), `${id}.jsonl`)
  let raw: string
  try {
    raw = await fsp.readFile(full, 'utf8')
  } catch {
    return null
  }
  let firstUser = ''
  for (const line of raw.split('\n')) {
    if (!line) continue
    let j: Record<string, unknown>
    try {
      j = JSON.parse(line)
    } catch {
      continue
    }
    // The CLI writes an ai-title entry once it has summarised the conversation;
    // prefer it, and fall back to the opening message the way the picker does.
    if (j.type === 'ai-title' && typeof j.title === 'string' && j.title.trim()) return j.title.trim()
    if (!firstUser && j.type === 'user') {
      const c = (j.message as Record<string, unknown>)?.content
      if (typeof c === 'string' && !c.startsWith('<')) firstUser = c.split('\n')[0].trim()
    }
  }
  return firstUser ? (firstUser.length > 48 ? firstUser.slice(0, 48) + '…' : firstUser) : null
}

async function readSessionTranscript(
  cwd: string,
  id: string,
  configDir?: string
): Promise<
  Array<{ role: 'user' | 'assistant'; text: string; tools: Array<{ name: string; detail: string }>; images?: number }>
> {
  const full = path.join(projectDir(cwd, configDir), `${id}.jsonl`)
  let raw: string
  try {
    raw = await fsp.readFile(full, 'utf8')
  } catch {
    return []
  }
  const msgs: Array<{
    role: 'user' | 'assistant'
    text: string
    tools: Array<{ name: string; detail: string }>
    images?: number
  }> = []
  for (const line of raw.split('\n').filter(Boolean)) {
    let j: Record<string, unknown>
    try {
      j = JSON.parse(line)
    } catch {
      continue
    }
    const msg = j.message as Record<string, unknown> | undefined
    if (j.type === 'user' && msg) {
      const c = msg.content
      if (typeof c === 'string') {
        if (c.startsWith('<') || c.startsWith('/')) continue // caveats / slash echoes
        msgs.push({ role: 'user', text: c, tools: [] })
      } else if (Array.isArray(c)) {
        // A message sent with images is stored as blocks. Skipping every array
        // (which is also how tool results are stored) made a question asked
        // with a screenshot vanish from the restored conversation.
        const blocks = c as Array<Record<string, unknown>>
        if (blocks.some((b) => b.type === 'tool_result')) continue
        const text = blocks
          .filter((b) => b.type === 'text' && typeof b.text === 'string')
          .map((b) => b.text as string)
          .join('\n')
        const images = blocks.filter((b) => b.type === 'image').length
        if (!text && !images) continue
        if (text.startsWith('<')) continue
        msgs.push({ role: 'user', text, tools: [], images })
      }
    } else if (j.type === 'assistant' && msg && Array.isArray(msg.content)) {
      let text = ''
      const tools: Array<{ name: string; detail: string }> = []
      for (const b of msg.content as Array<Record<string, unknown>>) {
        if (b.type === 'text') text += (b.text as string) ?? ''
        else if (b.type === 'tool_use') {
          const inp = (b.input as Record<string, unknown>) ?? {}
          const detail = (inp.file_path as string) || (inp.command as string) || (inp.pattern as string) || ''
          tools.push({ name: (b.name as string) ?? 'tool', detail: String(detail).slice(0, 120) })
        }
      }
      if (text.trim() || tools.length) msgs.push({ role: 'assistant', text: text.trim(), tools })
    }
  }
  return msgs
}

// ---- MCP management via `claude mcp …` ---------------------------------------
export interface McpServer {
  name: string
  url: string
  status: 'connected' | 'needs-auth' | 'pending' | 'other'
}

async function mcpList(cwd: string, configDir?: string): Promise<McpServer[]> {
  const cmd = await resolveBin('claude')
  if (!cmd) return []
  // Before listing, replace any server that was registered as its own
  // `claude mcp add` line with what that line meant to add (see mcpRepair.ts).
  // Listing first would only show the user a server that cannot ever connect.
  const repaired = await repairPastedAddServers(cwd, configDir, (args) =>
    runClaudeMcp(cwd, args, 20000, configDir)
  )
  for (const r of repaired) {
    if (r.ok) console.log(`[mcp] repaired "${r.name}": it was registered as its own add command`)
    else console.warn(`[mcp] could not repair "${r.name}"`, r.output.slice(0, 300))
  }
  const env = { ...process.env }
  if (configDir) env.CLAUDE_CONFIG_DIR = configDir
  const out = await new Promise<string>((resolve) => {
    let s = ''
    const p = spawn(cmd, ['mcp', 'list'], { cwd, env, stdio: ['ignore', 'pipe', 'ignore'] })
    p.stdout?.on('data', (b: Buffer) => (s += b.toString()))
    p.on('close', () => resolve(s))
    p.on('error', () => resolve(''))
    setTimeout(() => {
      try {
        p.kill()
      } catch {
        /* ignore */
      }
      resolve(s)
    }, 20000)
  })
  const servers: McpServer[] = []
  for (const line of out.split('\n')) {
    // "<name>: <url>[ (HTTP)] - <status>"
    const m = line.match(/^(.+?):\s+(\S+).*?\s-\s(.+)$/)
    if (!m) continue
    // A .mcp.json server the project has not approved yet reports "Pending
    // approval", NOT a failure — it is one keypress away from working, so it
    // gets its own state instead of being lumped in with the broken ones.
    const status = /connected/i.test(m[3])
      ? 'connected'
      : /needs? auth/i.test(m[3])
        ? 'needs-auth'
        : /pending approval/i.test(m[3])
          ? 'pending'
          : 'other'
    servers.push({ name: m[1].trim(), url: m[2], status })
  }
  return servers
}

// Record the approval Claude Code would otherwise only take through its
// interactive trust prompt: the server moves out of `disabled` and into
// `enabled` for THIS project, in whichever config dir the session uses.
async function approveMcpJson(
  cwd: string,
  name: string,
  configDir?: string
): Promise<{ ok: boolean; output: string }> {
  // ~/.claude.json at the home root when there is no profile — the old
  // ~/.claude/.claude.json is not a file the CLI reads, so approvals written
  // there without a profile were silently ignored.
  const file = claudeStateFile(configDir)
  try {
    const cfg = JSON.parse(await fsp.readFile(file, 'utf8')) as {
      projects?: Record<string, { enabledMcpjsonServers?: string[]; disabledMcpjsonServers?: string[] }>
    }
    const projects = (cfg.projects ??= {})
    const proj = (projects[cwd] ??= {})
    const enabled = (proj.enabledMcpjsonServers ??= [])
    if (!enabled.includes(name)) enabled.push(name)
    proj.disabledMcpjsonServers = (proj.disabledMcpjsonServers ?? []).filter((n) => n !== name)
    await fsp.writeFile(file, JSON.stringify(cfg, null, 2))
    return { ok: true, output: '' }
  } catch (e) {
    return { ok: false, output: e instanceof Error ? e.message : String(e) }
  }
}

// How mcpServers.ts asks the CLI what servers exist. It lives here because this
// module already owns finding and spawning the CLI; the list itself is cached
// there, so this runs at most once every few minutes per project.
setMcpListRunner(async (cwd, configDir) => {
  const r = await runClaudeMcp(cwd, ['mcp', 'list'], 20000, configDir)
  return r.ok ? r.output : ''
})

async function runClaudeMcp(
  cwd: string,
  args: string[],
  timeoutMs: number,
  configDir?: string
): Promise<{ ok: boolean; output: string }> {
  const cmd = await resolveBin('claude')
  if (!cmd) return { ok: false, output: 'claude CLI not found' }
  return await new Promise((resolve) => {
    let out = ''
    let done = false
    const finish = (ok: boolean): void => {
      if (done) return
      done = true
      resolve({ ok, output: out })
    }
    // login opens the OS browser for the OAuth flow; inherit no stdin.
    const env = { ...process.env }
    if (configDir) env.CLAUDE_CONFIG_DIR = configDir
    const p = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    p.stdout?.on('data', (b: Buffer) => (out += b.toString()))
    p.stderr?.on('data', (b: Buffer) => (out += b.toString()))
    p.on('close', (code) => finish(code === 0))
    p.on('error', () => finish(false))
    setTimeout(() => {
      try {
        p.kill()
      } catch {
        /* ignore */
      }
      finish(false)
    }, timeoutMs)
  })
}

export interface AccountInfo {
  id: 'claude' | 'codex'
  name: string
  loggedIn: boolean | null // null = installed but status could not be read
  plan?: string
  email?: string
  org?: string // the Anthropic organization — personal vs team seat
  mode?: 'subscription' | 'apikey'
  configDir?: string // which CLAUDE_CONFIG_DIR this answer is for (undefined = default)
}

// Claude Code: ask the CLI itself who it is (`claude auth status --json`, ~180ms).
// We deliberately do NOT read the macOS keychain item directly any more: that read
// can raise a keychain access prompt, is macOS-only, and is keyed to
// CLAUDE_CONFIG_DIR — so with more than one config dir it reports the WRONG
// account. Asking the CLI is correct by construction, including for a configDir
// the user keeps a second login in.
async function claudeAccount(configDir?: string): Promise<AccountInfo | null> {
  const cmd = await resolveBin('claude')
  if (!cmd) return null
  const base: AccountInfo = { id: 'claude', name: 'Claude Code', loggedIn: null, configDir }
  const env = { ...process.env }
  if (configDir) env.CLAUDE_CONFIG_DIR = configDir
  const raw = await new Promise<string>((resolve) => {
    let out = ''
    const p = spawn(cmd, ['auth', 'status', '--json'], { env, stdio: ['ignore', 'pipe', 'ignore'] })
    p.stdout?.on('data', (b: Buffer) => (out += b.toString()))
    p.on('close', () => resolve(out))
    p.on('error', () => resolve(''))
    setTimeout(() => {
      try {
        p.kill()
      } catch {
        /* ignore */
      }
      resolve(out)
    }, 8000)
  })
  try {
    const j = JSON.parse(raw) as {
      loggedIn?: boolean
      authMethod?: string
      email?: string
      orgName?: string
      subscriptionType?: string
    }
    if (typeof j.loggedIn !== 'boolean') return base
    return {
      ...base,
      loggedIn: j.loggedIn,
      email: j.email || undefined,
      // The organization is what distinguishes a personal plan from a team seat.
      org: j.orgName || undefined,
      plan: j.subscriptionType || undefined,
      // Signed out has no auth mode at all; only label one when there is a login.
      mode: !j.loggedIn ? undefined : j.authMethod === 'claude.ai' ? 'subscription' : 'apikey'
    }
  } catch {
    return base
  }
}

// Codex: reads ~/.codex/auth.json. An API key = key mode; otherwise the OAuth
// id_token (a JWT) carries the account email + ChatGPT plan.
async function codexAccount(): Promise<AccountInfo | null> {
  if (!(await resolveBin('codex'))) return null
  const base: AccountInfo = { id: 'codex', name: 'Codex', loggedIn: null }
  try {
    const j = JSON.parse(await fsp.readFile(path.join(os.homedir(), '.codex', 'auth.json'), 'utf8'))
    const idToken: string | undefined = j?.tokens?.id_token
    if (idToken) {
      try {
        const payload = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64').toString('utf8'))
        const prof = payload['https://api.openai.com/profile'] || {}
        const auth = payload['https://api.openai.com/auth'] || {}
        return {
          ...base,
          loggedIn: true,
          email: payload.email || prof.email || undefined,
          plan: auth.chatgpt_plan_type || undefined,
          mode: 'subscription'
        }
      } catch {
        return { ...base, loggedIn: true, mode: 'subscription' }
      }
    }
    if (j?.OPENAI_API_KEY) return { ...base, loggedIn: true, mode: 'apikey' }
    return { ...base, loggedIn: false }
  } catch {
    return { ...base, loggedIn: false }
  }
}
