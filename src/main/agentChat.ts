import { ipcMain, WebContents } from 'electron'
import { spawn, ChildProcess } from 'child_process'
import { promises as fsp } from 'fs'
import * as os from 'os'
import * as path from 'path'
import { resolveBin } from './shellPath'
import {
  writeMcpConfig,
  mcpSystemPrompt,
  MCP_TOOL_PREFIX,
  implementedToolNames
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
}

const sessions = new Map<string, Session>()

// A single fan-out channel (payload carries `key`) so the renderer attaches one
// listener regardless of how many chat panes are open — same pattern as pty:*.
type ChatEvent =
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

function emit(s: Session, ev: ChatEvent): void {
  if (!s.sender.isDestroyed()) s.sender.send('chat:event', ev)
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
  if (type === 'system' && ev.subtype === 'init') {
    s.sawInit = true
    s.sessionId = (ev.session_id as string) ?? s.sessionId
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
    s.sessionId = (ev.session_id as string) ?? s.sessionId
    // Slash commands (e.g. /usage, /context) return their output ONLY in the
    // result — nothing streams as assistant text. Surface it so the pane shows the
    // command's answer instead of an empty turn.
    if (!s.streamedText && typeof ev.result === 'string' && ev.result.trim()) {
      emit(s, { key: s.key, kind: 'text', delta: ev.result })
    }
    const isError = ev.is_error === true || (ev.subtype && ev.subtype !== 'success')
    emit(s, {
      key: s.key,
      kind: 'turnDone',
      costUSD: typeof ev.total_cost_usd === 'number' ? ev.total_cost_usd : null,
      sessionId: s.sessionId,
      error: isError ? String(ev.subtype ?? 'error') : null
    })
    return
  }
}

const DEFAULT_ALLOWED =
  'Task,Read,Grep,Glob,LS,Edit,Write,MultiEdit,NotebookEdit,Bash,BashOutput,WebFetch,WebSearch,TodoWrite'

async function startSession(
  key: string,
  opts: {
    cwd: string
    resume?: string
    model?: string
    permissionMode?: string
    mcpDisabled?: string[]
    globalPrompt?: string
    // A custom agent defined in .claude/agents/<name>.md (project or ~). Runs the
    // pane as `claude --agent <name>` so it uses that agent's system prompt/tools.
    agent?: string
  },
  sender: WebContents
): Promise<{ ok: boolean; error?: string }> {
  const existing = sessions.get(key)
  if (existing) {
    existing.sender = sender // reattach after a renderer reload
    return { ok: true }
  }
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
    '--permission-mode',
    opts.permissionMode || 'acceptEdits',
    '--allowedTools',
    `${DEFAULT_ALLOWED},${MCP_TOOL_PREFIX}`
  ]
  // riven's own MCP tools (ask_user / open_file / panels / workspaces / …): wire
  // the stdio relay via --mcp-config. Only implemented tools the user hasn't
  // disabled are advertised.
  const disabled = new Set(opts.mcpDisabled ?? [])
  const enabled = implementedToolNames().filter((n) => !disabled.has(n))
  const mcpConfig = enabled.length ? writeMcpConfig(enabled) : null
  if (mcpConfig) args.push('--mcp-config', mcpConfig)
  // Document available tools + the user's global instruction (--append-system-prompt).
  const globalPrompt = (opts.globalPrompt ?? '').trim()
  const promptParts: string[] = []
  if (mcpConfig) promptParts.push(mcpSystemPrompt())
  if (globalPrompt) promptParts.push('# 사용자 지정 지침\n' + globalPrompt)
  if (promptParts.length) args.push('--append-system-prompt', promptParts.join('\n\n'))
  if (opts.model && opts.model !== 'default') args.push('--model', opts.model)
  if (opts.agent) args.push('--agent', opts.agent)
  if (opts.resume) args.push('--resume', opts.resume)

  let proc: ChildProcess
  try {
    proc = spawn(cmd, args, { cwd: opts.cwd, env: { ...process.env }, stdio: ['pipe', 'pipe', 'pipe'] })
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
    streamedText: false
  }
  sessions.set(key, s)

  proc.stdout?.on('data', (chunk: Buffer) => {
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
    sessions.delete(key)
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

export function registerAgentChatHandlers(): void {
  ipcMain.handle(
    'chat:start',
    (
      event,
      key: string,
      opts: {
        cwd: string
        resume?: string
        model?: string
        permissionMode?: string
        mcpDisabled?: string[]
        globalPrompt?: string
        agent?: string
      }
    ) => startSession(key, opts, event.sender)
  )
  ipcMain.on('chat:send', (_e, key: string, text: string) => {
    const s = sessions.get(key)
    if (s) writeLine(s, { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null })
  })
  ipcMain.on('chat:interrupt', (_e, key: string) => {
    const s = sessions.get(key)
    if (s) writeLine(s, { type: 'control_request', request_id: `i${++s.ctrlSeq}`, request: { subtype: 'interrupt' } })
  })
  ipcMain.on('chat:setModel', (_e, key: string, model: string) => {
    const s = sessions.get(key)
    if (s)
      writeLine(s, {
        type: 'control_request',
        request_id: `m${++s.ctrlSeq}`,
        request: { subtype: 'set_model', model }
      })
  })
  ipcMain.on('chat:setMode', (_e, key: string, mode: string) => {
    const s = sessions.get(key)
    // riven's "auto" is a riven-side auto-allow policy; the CLI's own name is "default".
    if (s)
      writeLine(s, {
        type: 'control_request',
        request_id: `m${++s.ctrlSeq}`,
        request: { subtype: 'set_permission_mode', mode: mode === 'auto' ? 'default' : mode }
      })
  })
  ipcMain.on('chat:stop', (_e, key: string) => stopSession(key))

  // The session's REAL command list + MCP servers, fetched up front (cached per
  // cwd) by spawning a throwaway headless claude in that directory. stream-json
  // only emits `init` after the first input, so we send a nudge and kill at init
  // — this yields the exact list (built-ins + repo skills + MCP prompts) and MCP
  // connection/auth statuses WITHOUT the user having to send a message first.
  ipcMain.handle('chat:sessionInfo', (_e, cwd: string) => fetchSessionInfo(cwd))

  // List resumable past sessions for a cwd (native /resume), newest first.
  ipcMain.handle('chat:sessions', async (_e, cwd: string) => listSessions(cwd))

  // Custom agents defined in .claude/agents/<name>.md (project + ~), usable as
  // `claude --agent <name>`. Mirrors Claude Code's own agent discovery.
  ipcMain.handle('chat:agents', async (_e, cwd: string) => listAgents(cwd))

  // Reconstruct a past session's transcript for display when resuming.
  ipcMain.handle('chat:sessionTranscript', async (_e, cwd: string, id: string) =>
    readSessionTranscript(cwd, id)
  )

  // MCP management via `claude mcp …` run in the background (no visible terminal).
  ipcMain.handle('chat:mcpList', async (_e, cwd: string) => mcpList(cwd))
  ipcMain.handle('chat:mcpLogin', async (_e, cwd: string, name: string) =>
    runClaudeMcp(cwd, ['mcp', 'login', name], 180000)
  )
  ipcMain.handle('chat:mcpLogout', async (_e, cwd: string, name: string) =>
    runClaudeMcp(cwd, ['mcp', 'logout', name], 20000)
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
  ipcMain.handle('accounts:list', async (): Promise<AccountInfo[]> => {
    const [claude, codex] = await Promise.all([claudeAccount(), codexAccount()])
    return [claude, codex].filter((a): a is AccountInfo => a !== null)
  })
}

// ---- session info (slash commands + MCP servers), cached per cwd -------------
export interface SessionInfo {
  slashCommands: string[]
  mcpServers: Array<{ name: string; status: string }>
}
const sessionInfoCache = new Map<string, SessionInfo>()

async function fetchSessionInfo(cwd: string): Promise<SessionInfo> {
  const cached = sessionInfoCache.get(cwd)
  if (cached) return cached
  const cmd = await resolveBin('claude')
  const empty: SessionInfo = { slashCommands: [], mcpServers: [] }
  if (!cmd) return empty
  const mcpConfig = writeMcpConfig(implementedToolNames())
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose']
  if (mcpConfig) args.push('--mcp-config', mcpConfig)
  return await new Promise<SessionInfo>((resolve) => {
    let done = false
    let buf = ''
    const proc = spawn(cmd, args, { cwd, env: { ...process.env }, stdio: ['pipe', 'pipe', 'ignore'] })
    const finish = (v: SessionInfo): void => {
      if (done) return
      done = true
      try {
        proc.kill()
      } catch {
        /* ignore */
      }
      if (v.slashCommands.length) sessionInfoCache.set(cwd, v)
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
    setTimeout(() => finish(empty), 8000)
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
// Claude stores each session as ~/.claude/projects/<encoded-cwd>/<id>.jsonl,
// where the cwd's "/" and "." become "-".
function projectDir(cwd: string): string {
  return path.join(os.homedir(), '.claude', 'projects', cwd.replace(/[/.]/g, '-'))
}

export interface SessionSummary {
  id: string
  title: string
  mtime: number
  messages: number
}

async function listSessions(cwd: string): Promise<SessionSummary[]> {
  const dir = projectDir(cwd)
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
async function readSessionTranscript(
  cwd: string,
  id: string
): Promise<Array<{ role: 'user' | 'assistant'; text: string; tools: Array<{ name: string; detail: string }> }>> {
  const full = path.join(projectDir(cwd), `${id}.jsonl`)
  let raw: string
  try {
    raw = await fsp.readFile(full, 'utf8')
  } catch {
    return []
  }
  const msgs: Array<{ role: 'user' | 'assistant'; text: string; tools: Array<{ name: string; detail: string }> }> = []
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

// ---- MCP management via `claude mcp …` (background, no visible terminal) -----
export interface McpServer {
  name: string
  url: string
  status: 'connected' | 'needs-auth' | 'other'
}

async function mcpList(cwd: string): Promise<McpServer[]> {
  const cmd = await resolveBin('claude')
  if (!cmd) return []
  const out = await new Promise<string>((resolve) => {
    let s = ''
    const p = spawn(cmd, ['mcp', 'list'], { cwd, env: { ...process.env }, stdio: ['ignore', 'pipe', 'ignore'] })
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
    const status = /connected/i.test(m[3])
      ? 'connected'
      : /needs? auth/i.test(m[3])
        ? 'needs-auth'
        : 'other'
    servers.push({ name: m[1].trim(), url: m[2], status })
  }
  return servers
}

async function runClaudeMcp(
  cwd: string,
  args: string[],
  timeoutMs: number
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
    const p = spawn(cmd, args, { cwd, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] })
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
  mode?: 'subscription' | 'apikey'
}

// Claude Code: the CLI must be installed; its subscription plan lives in the macOS
// keychain item "Claude Code-credentials" (claudeAiOauth). Reading it may prompt
// for keychain access once — we only extract the plan + expiry, never the token.
async function claudeAccount(): Promise<AccountInfo | null> {
  if (!(await resolveBin('claude'))) return null
  const base: AccountInfo = { id: 'claude', name: 'Claude Code', loggedIn: null }
  if (process.platform !== 'darwin') return base
  const raw = await new Promise<string>((resolve) => {
    let out = ''
    const p = spawn('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], {
      stdio: ['ignore', 'pipe', 'ignore']
    })
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
    }, 4000)
  })
  try {
    const o = JSON.parse(raw).claudeAiOauth
    if (o?.accessToken) {
      const live = !o.expiresAt || o.expiresAt > Date.now()
      return { ...base, loggedIn: live, plan: o.subscriptionType || undefined, mode: 'subscription' }
    }
    return { ...base, loggedIn: false }
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
