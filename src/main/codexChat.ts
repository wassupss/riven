import { spawn, type ChildProcess } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import type { WebContents } from 'electron'
import { resolveBin } from './shellPath'
import { mcpPaneUrl, mcpSystemPrompt, mcpAuthToken, mcpRequestTimeoutMs, implementedToolNames, mcpReady } from './mcpServer'
import { reportAgentEdit } from './agentHooks'
import { isUsableImage, type ChatImageInput } from './chatContent'
import type { ChatEvent } from './agentChat'

// A chat pane backed by Codex.
//
// Codex's interactive protocol is `codex app-server`: JSON-RPC over stdio, one
// message per line — the same one its editor extensions use. A thread is a
// conversation (its id is what `codex resume` takes), a turn is one exchange,
// and everything that happens inside a turn arrives as notifications: the
// answer as text deltas, and each command, patch or MCP call as an item that
// starts and completes. This file turns that into the chat pane's own event
// stream, so the pane renders a Codex conversation exactly like a Claude one.
//
// Auth is the user's own Codex login; nothing here touches ~/.codex.

export interface CodexStartOpts {
  cwd: string
  resume?: string
  model?: string
  permissionMode?: string
  mcpDisabled?: string[]
  globalPrompt?: string
}

type Emit = (ev: ChatEvent) => void

// ---------------------------------------------------------------------------
// Mapping (pure)
// ---------------------------------------------------------------------------

// The pane's permission modes are Claude's. Codex expresses the same intent as
// a sandbox plus an approval policy. A chat pane has nobody to answer a prompt
// mid-turn, so what Codex does ask is answered by riven (see onServerRequest).
export function codexPolicy(mode: string | undefined): { sandbox: string; approvalPolicy: string } {
  switch (mode) {
    case 'plan':
      return { sandbox: 'read-only', approvalPolicy: 'never' }
    case 'bypassPermissions':
      return { sandbox: 'danger-full-access', approvalPolicy: 'never' }
    default:
      return { sandbox: 'workspace-write', approvalPolicy: 'on-request' }
  }
}

// The same intent as a per-turn policy, so a mode picked mid-conversation
// applies from the next message on.
export function codexSandboxPolicy(mode: string | undefined): Record<string, unknown> {
  switch (mode) {
    case 'plan':
      return { type: 'readOnly', networkAccess: false }
    case 'bypassPermissions':
      return { type: 'dangerFullAccess' }
    default:
      return { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false }
  }
}

export function codexUserInput(text: string, images?: ChatImageInput[] | null): unknown[] {
  const input: unknown[] = []
  if (text.trim()) input.push({ type: 'text', text, text_elements: [] })
  for (const img of (images ?? []).filter(isUsableImage)) {
    input.push({ type: 'image', url: `data:${img.mediaType};base64,${img.data}` })
  }
  return input
}

const clamp = (s: string): string => (s.length > 120 ? s.slice(0, 120) + '…' : s)
const home = process.env.HOME || ''
const shorten = (p: string): string => (home && p.startsWith(home) ? '~' + p.slice(home.length) : p)

function diffCounts(diff: string): string {
  let added = 0
  let removed = 0
  for (const l of diff.split('\n')) {
    if (l.startsWith('+') && !l.startsWith('+++')) added++
    else if (l.startsWith('-') && !l.startsWith('---')) removed++
  }
  return added || removed ? `  +${added} -${removed}` : ''
}

export interface CodexToolLine {
  name: string
  detail: string
  path: string | null
  code: string | null
}

// One started item → the tool line(s) the pane shows. Tool names follow the
// pane's vocabulary (Bash, Edit, Write, WebSearch, Agent, mcp__server__tool) so
// its icons, grouping and subagent strip work unchanged.
export function codexToolLines(item: Record<string, unknown>): CodexToolLine[] {
  const str = (v: unknown): string => (typeof v === 'string' ? v : '')
  switch (item.type) {
    case 'commandExecution': {
      const command = str(item.command)
      return [{ name: 'Bash', detail: clamp(command), path: null, code: command || null }]
    }
    case 'fileChange': {
      const changes = Array.isArray(item.changes) ? (item.changes as Array<Record<string, unknown>>) : []
      return changes.map((ch) => {
        const kind = (ch.kind as { type?: string } | undefined)?.type
        const file = str((ch.kind as { move_path?: unknown })?.move_path) || str(ch.path)
        const diff = str(ch.diff)
        return {
          name: kind === 'add' ? 'Write' : 'Edit',
          detail: clamp(shorten(file)) + (kind === 'add' ? '' : diffCounts(diff)),
          path: file || null,
          code: diff || null
        }
      })
    }
    case 'mcpToolCall':
      return [
        {
          name: `mcp__${str(item.server)}__${str(item.tool)}`,
          detail: clamp(typeof item.arguments === 'object' ? JSON.stringify(item.arguments) : str(item.arguments)),
          path: null,
          code: null
        }
      ]
    case 'webSearch':
      return [{ name: 'WebSearch', detail: clamp(str(item.query)), path: null, code: null }]
    case 'collabAgentToolCall':
      return [{ name: 'Agent', detail: clamp(str(item.prompt) || str(item.tool)), path: null, code: null }]
    default:
      return []
  }
}

// An elicitation that only asks "may I?": a form with no fields to fill in.
export function isPlainApproval(params: Record<string, unknown>): boolean {
  if (params.mode !== 'form' && params.mode !== 'openai/form' && params.mode !== 'openaiForm') return false
  const schema = params.requestedSchema as { properties?: Record<string, unknown>; required?: unknown[] } | null
  const props = schema?.properties ? Object.keys(schema.properties) : []
  const required = Array.isArray(schema?.required) ? schema.required : []
  return props.length === 0 && required.length === 0
}

export function itemFailed(item: Record<string, unknown>): boolean {
  const status = item.status
  return status === 'failed' || status === 'declined' || (typeof item.exitCode === 'number' && item.exitCode !== 0)
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

const MAX_DIFF_BYTES = 2_000_000
function readForDiff(p: string): string | null {
  try {
    const st = fs.statSync(p)
    if (!st.isFile() || st.size > MAX_DIFF_BYTES) return null
    return fs.readFileSync(p, 'utf8')
  } catch {
    return null
  }
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void }

export class CodexChat {
  private proc: ChildProcess | null = null
  private buf = ''
  private seq = 0
  private readonly pending = new Map<number, Pending>()
  private threadId: string | null = null
  private turnId: string | null = null
  private ready: Promise<boolean> | null = null
  private model: string | undefined
  private alive = false
  private sawThread = false
  // Content of each file a patch is about to touch, read when the patch item
  // starts, so the changes panel gets a real before/after.
  private readonly baselines = new Map<string, string | null>()
  turnBusy = false
  lastActive = Date.now()

  constructor(
    readonly key: string,
    private opts: CodexStartOpts,
    public sender: WebContents,
    private readonly emitEvent: Emit,
    private readonly onExit: (chat: CodexChat) => void
  ) {
    this.model = opts.model
  }

  private emit(ev: ChatEvent): void {
    if (!this.sender.isDestroyed()) this.emitEvent(ev)
  }

  async start(): Promise<{ ok: boolean; error?: string }> {
    await mcpReady()
    const cmd = await resolveBin('codex')
    if (!cmd) return { ok: false, error: 'codex CLI not found on PATH' }
    const disabled = new Set(this.opts.mcpDisabled ?? [])
    const enabled = implementedToolNames().filter((n) => !disabled.has(n))
    const url = enabled.length ? mcpPaneUrl(enabled, this.key) : null
    const args: string[] = []
    if (url) {
      args.push('-c', `mcp_servers.riven.url=${JSON.stringify(url)}`)
      args.push('-c', 'mcp_servers.riven.bearer_token_env_var="RIVEN_MCP_TOKEN"')
      args.push('-c', `mcp_servers.riven.tool_timeout_sec=${Math.round(mcpRequestTimeoutMs() / 1000)}`)
      // Codex asks before every MCP tool call, and a chat pane has nobody to ask
      // — riven declined on the pane's behalf, so "open a Claude pane" came back
      // as "user rejected MCP tool call". riven's own tools already confirm with
      // the user where it matters (an arbitrary terminal command, closing panes),
      // the same trust a Claude chat pane gives them via --allowedTools.
      args.push('-c', 'mcp_servers.riven.default_tools_approval_mode="approve"')
    }
    args.push('app-server')
    try {
      this.proc = spawn(cmd, args, {
        cwd: this.opts.cwd,
        env: { ...process.env, RIVEN_MCP_TOKEN: mcpAuthToken(), RIVEN_CHAT_KEY: this.key },
        stdio: ['pipe', 'pipe', 'pipe']
      })
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
    this.alive = true
    this.proc.stdout?.on('data', (chunk: Buffer) => this.onData(chunk))
    this.proc.stderr?.on('data', (d: Buffer) => {
      const line = d.toString().trim()
      if (line) console.log(`[codex:${this.key}]`, line.slice(0, 500))
    })
    this.proc.on('exit', (code) => {
      this.alive = false
      for (const [, p] of this.pending) p.reject(new Error('codex app-server exited'))
      this.pending.clear()
      this.onExit(this)
      this.emit({ key: this.key, kind: 'exit', code: code ?? 0 })
    })
    this.proc.on('error', (e) => console.error(`[codex:${this.key}] spawn error`, e))
    this.ready = this.open(url !== null)
    return { ok: true }
  }

  private developerInstructions(withTools: boolean): string | null {
    const parts: string[] = []
    if (withTools) parts.push(mcpSystemPrompt())
    const g = (this.opts.globalPrompt ?? '').trim()
    if (g) parts.push('# 사용자 지정 지침\n' + g)
    return parts.length ? parts.join('\n\n') : null
  }

  private async open(withTools: boolean): Promise<boolean> {
    try {
      await this.request('initialize', { clientInfo: { name: 'riven', title: 'riven', version: '1' }, capabilities: null })
      this.notify('initialized', {})
      const policy = codexPolicy(this.opts.permissionMode)
      const common = {
        cwd: this.opts.cwd,
        model: this.model ?? null,
        approvalPolicy: policy.approvalPolicy,
        sandbox: policy.sandbox,
        developerInstructions: this.developerInstructions(withTools)
      }
      type Opened = { thread?: { id?: string }; model?: string }
      let res = null as Opened | null
      if (this.opts.resume) {
        try {
          res = (await this.request('thread/resume', { threadId: this.opts.resume, ...common })) as Opened
        } catch (e) {
          // A thread that no longer exists (deleted, other machine): start a new
          // one rather than leave the pane dead. The visible transcript stays.
          console.log(`[codex:${this.key}] resume failed, starting fresh:`, (e as Error).message)
        }
      }
      if (!res) res = (await this.request('thread/start', common)) as Opened
      this.threadId = res?.thread?.id ?? null
      this.sawThread = !!this.threadId
      this.emit({
        key: this.key,
        kind: 'init',
        sessionId: this.threadId,
        model: res?.model ?? null,
        tools: [],
        slashCommands: [],
        mcpServers: []
      })
      return !!this.threadId
    } catch (e) {
      console.error(`[codex:${this.key}] could not open a thread`, e)
      this.emit({ key: this.key, kind: 'turnDone', costUSD: null, sessionId: null, error: (e as Error).message })
      return false
    }
  }

  // ---- JSON-RPC plumbing ----

  private write(obj: unknown): void {
    const stdin = this.proc?.stdin
    if (!this.alive || !stdin || stdin.destroyed) return
    try {
      stdin.write(JSON.stringify(obj) + '\n')
    } catch {
      /* broken pipe — the child exited */
    }
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.write({ id, method, params })
    })
  }

  private notify(method: string, params: unknown): void {
    this.write({ method, params })
  }

  private onData(chunk: Buffer): void {
    this.lastActive = Date.now()
    this.buf += chunk.toString()
    let nl: number
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl)
      this.buf = this.buf.slice(nl + 1)
      if (!line.trim()) continue
      let msg: { id?: number | string; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { message?: string } }
      try {
        msg = JSON.parse(line)
      } catch {
        continue
      }
      if (msg.method && msg.id !== undefined) this.onServerRequest(msg.id, msg.method, msg.params ?? {})
      else if (msg.method) this.onNotification(msg.method, msg.params ?? {})
      else if (typeof msg.id === 'number') {
        const p = this.pending.get(msg.id)
        if (!p) continue
        this.pending.delete(msg.id)
        if (msg.error) p.reject(new Error(msg.error.message ?? 'codex error'))
        else p.resolve(msg.result)
      }
    }
  }

  // Codex asks before an escalation (a command outside the sandbox, a patch
  // outside the workspace, extra permissions). A chat pane runs unattended —
  // the same position a Claude chat pane is in with its allowed tools — so these
  // are accepted for the pane's own mode, and anything riven can't answer is
  // declined rather than left hanging a turn forever.
  private onServerRequest(id: number | string, method: string, params: Record<string, unknown>): void {
    const plan = this.opts.permissionMode === 'plan'
    switch (method) {
      case 'item/commandExecution/requestApproval':
      case 'execCommandApproval':
        this.write({ id, result: { decision: plan ? 'decline' : 'accept' } })
        return
      case 'item/fileChange/requestApproval':
      case 'applyPatchApproval':
        this.write({ id, result: { decision: plan ? 'decline' : 'accept' } })
        return
      case 'mcpServer/elicitation/request': {
        // Another MCP server's tool-call approval: a message with nothing to
        // fill in. A Claude chat pane allows the servers the user configured, so
        // this does too (not in plan mode). A form that asks for actual input,
        // or a URL to visit, needs a person — declined, and said so in the log.
        const accept = !plan && isPlainApproval(params)
        if (!accept)
          console.log(
            `[codex:${this.key}] declined MCP elicitation from ${String(params.serverName)}: ${String(params.message ?? '').slice(0, 160)}`
          )
        this.write({ id, result: accept ? { action: 'accept', content: {}, _meta: null } : { action: 'decline', content: null, _meta: null } })
        return
      }
      default:
        console.log(`[codex:${this.key}] unanswered request ${method}`, JSON.stringify(params).slice(0, 200))
        this.write({ id, error: { code: -32601, message: `riven does not handle ${method}` } })
    }
  }

  private onNotification(method: string, params: Record<string, unknown>): void {
    switch (method) {
      case 'turn/started':
        this.turnId = ((params.turn as { id?: string } | undefined)?.id ?? null) as string | null
        this.turnBusy = true
        return
      case 'item/agentMessage/delta':
        if (typeof params.delta === 'string') this.emit({ key: this.key, kind: 'text', delta: params.delta })
        return
      case 'item/started': {
        const item = (params.item ?? {}) as Record<string, unknown>
        if (item.type === 'fileChange') this.captureBaselines(item)
        const id = typeof item.id === 'string' ? item.id : null
        codexToolLines(item).forEach((t, i) =>
          this.emit({
            key: this.key,
            kind: 'tool',
            name: t.name,
            detail: t.detail,
            path: t.path,
            code: t.code,
            // One patch can touch several files; each line needs its own id to be
            // closed, and the first keeps the item's id.
            toolId: id ? (i === 0 ? id : `${id}#${i}`) : null,
            parent: null
          })
        )
        return
      }
      case 'item/completed': {
        const item = (params.item ?? {}) as Record<string, unknown>
        const id = typeof item.id === 'string' ? item.id : null
        const lines = codexToolLines(item)
        if (id && lines.length) {
          const isError = itemFailed(item)
          lines.forEach((_, i) =>
            this.emit({ key: this.key, kind: 'toolResult', toolId: i === 0 ? id : `${id}#${i}`, isError })
          )
        }
        if (item.type === 'fileChange' && !itemFailed(item)) this.reportEdits(item)
        return
      }
      case 'thread/tokenUsage/updated': {
        const last = (params.tokenUsage as { last?: Record<string, number> } | undefined)?.last
        if (last) {
          this.emit({ key: this.key, kind: 'usage', input: last.inputTokens ?? 0, output: 0, isStart: true })
          this.emit({ key: this.key, kind: 'usage', input: -1, output: last.outputTokens ?? 0, isStart: false })
        }
        return
      }
      case 'turn/completed': {
        const turn = (params.turn ?? {}) as { status?: string; error?: { message?: string } | null }
        this.turnBusy = false
        this.turnId = null
        this.emit({
          key: this.key,
          kind: 'turnDone',
          costUSD: null,
          sessionId: this.threadId,
          error:
            turn.status === 'failed'
              ? turn.error?.message ?? 'failed'
              : turn.status === 'interrupted'
                ? 'interrupted'
                : null
        })
        return
      }
      case 'error': {
        const e = params as { error?: { message?: string }; willRetry?: boolean }
        if (!e.willRetry && e.error?.message) console.log(`[codex:${this.key}] error:`, e.error.message)
        return
      }
      default:
        return
    }
  }

  private filesOf(item: Record<string, unknown>): string[] {
    const changes = Array.isArray(item.changes) ? (item.changes as Array<Record<string, unknown>>) : []
    const out: string[] = []
    for (const ch of changes) {
      for (const p of [ch.path, (ch.kind as { move_path?: unknown })?.move_path]) {
        if (typeof p !== 'string' || !p) continue
        out.push(path.isAbsolute(p) ? p : path.resolve(this.opts.cwd, p))
      }
    }
    return out
  }

  private captureBaselines(item: Record<string, unknown>): void {
    for (const f of this.filesOf(item)) if (!this.baselines.has(f)) this.baselines.set(f, readForDiff(f))
  }

  private reportEdits(item: Record<string, unknown>): void {
    for (const f of this.filesOf(item)) {
      const saw = this.baselines.has(f)
      const before = this.baselines.get(f) ?? null
      this.baselines.delete(f)
      const after = readForDiff(f)
      if (after == null) continue
      // The patch may already have landed by the time its start was seen; an
      // unchanged "baseline" is not a before, so the diff falls back to git.
      const known = saw && before !== after ? before : null
      reportAgentEdit({ pane: this.key, path: f, before: known, after })
      this.emit({ key: this.key, kind: 'fileEdited', path: f })
    }
  }

  // ---- pane actions ----

  async send(text: string, images?: ChatImageInput[]): Promise<void> {
    this.lastActive = Date.now()
    this.turnBusy = true
    const ok = await (this.ready ?? Promise.resolve(false))
    if (!ok || !this.threadId) {
      this.turnBusy = false
      this.emit({ key: this.key, kind: 'turnDone', costUSD: null, sessionId: null, error: 'codex thread not open' })
      return
    }
    const input = codexUserInput(text, images)
    if (!input.length) {
      this.turnBusy = false
      return
    }
    try {
      // A message sent while a turn runs steers it, like typing into Codex's TUI.
      if (this.turnId) {
        await this.request('turn/steer', { threadId: this.threadId, expectedTurnId: this.turnId, input })
      } else {
        await this.request('turn/start', {
          threadId: this.threadId,
          input,
          model: this.model ?? null,
          approvalPolicy: codexPolicy(this.opts.permissionMode).approvalPolicy,
          sandboxPolicy: codexSandboxPolicy(this.opts.permissionMode)
        })
      }
    } catch (e) {
      this.turnBusy = false
      this.emit({ key: this.key, kind: 'turnDone', costUSD: null, sessionId: this.threadId, error: (e as Error).message })
    }
  }

  interrupt(): void {
    if (this.threadId && this.turnId) void this.request('turn/interrupt', { threadId: this.threadId, turnId: this.turnId }).catch(() => {})
  }

  setModel(model: string): void {
    this.model = model && model !== 'default' ? model : undefined
  }

  setMode(mode: string): void {
    this.opts = { ...this.opts, permissionMode: mode }
  }

  stop(): void {
    this.alive = false
    try {
      this.proc?.stdin?.end()
    } catch {
      /* ignore */
    }
    try {
      this.proc?.kill()
    } catch {
      /* already gone */
    }
  }

  get opened(): boolean {
    return this.sawThread
  }
}
