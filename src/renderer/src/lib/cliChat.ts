// The CLI chat view's model (experimental): what services/clichat sends
// ('clichat:event') folded into something to draw. Pure, so it is tested
// without a pane.
//
// Rust sends transcript ITEMS (already branch-resolved: a rewind arrives as
// a reset), the session STATE from hooks, a best-effort PREVIEW of the reply
// still streaming, and PERMISSION requests. The view groups items into
// turns: a user message, then everything the agent did for it.

export type CliItem =
  | { kind: 'user'; key: string; text: string; command: string | null; images: number }
  | { kind: 'text'; key: string; msgId: string; text: string }
  | { kind: 'thinking'; key: string; text: string }
  | { kind: 'tool'; key: string; toolId: string; name: string; input: unknown }
  | { kind: 'toolResult'; key: string; toolId: string; text: string; isError: boolean }
  | {
      kind: 'usage'
      key: string
      msgId: string
      model: string
      input: number
      cacheWrite: number
      cacheRead: number
      output: number
    }
  | { kind: 'compact'; key: string; trigger: string; preTokens: number }
  | { kind: 'note'; key: string; level: string; text: string }
  | { kind: 'turnEnd'; key: string; durationMs: number }

export interface CliState {
  busy: boolean
  waiting: boolean
  ready: boolean
  blocked: string | null
  sessionId: string | null
  dead: boolean
  terminal: boolean
}

export interface CliPermission {
  id: string
  tool: string
  input: unknown
}

export type CliEvent = { key: string } & (
  | { kind: 'items'; reset: boolean; items: CliItem[] }
  | ({ kind: 'state' } & CliState)
  | { kind: 'preview'; text: string | null }
  | { kind: 'permission'; id: string; tool: string | null; input: unknown; suggestions?: unknown }
  | { kind: 'permissionDone'; id: string; decision: string }
  | { kind: 'notice'; level: string; text: string }
  | { kind: 'exit'; code: number }
)

export interface CliModel {
  items: CliItem[]
  state: CliState
  preview: string | null
  permissions: CliPermission[]
  notices: { level: string; text: string }[]
}

export const initialModel = (): CliModel => ({
  items: [],
  state: { busy: false, waiting: false, ready: false, blocked: null, sessionId: null, dead: false, terminal: false },
  preview: null,
  permissions: [],
  notices: []
})

const MAX_NOTICES = 20

export function reduce(m: CliModel, e: CliEvent): CliModel {
  switch (e.kind) {
    case 'items': {
      if (e.reset) return { ...m, items: e.items }
      // An append can repeat keys after a reattach race; keep the first.
      const seen = new Set(m.items.map((i) => i.key))
      const fresh = e.items.filter((i) => !seen.has(i.key))
      return fresh.length ? { ...m, items: [...m.items, ...fresh] } : m
    }
    case 'state': {
      const { busy, waiting, ready, blocked, sessionId, dead, terminal } = e
      return {
        ...m,
        state: { busy, waiting, ready, blocked, sessionId, dead, terminal },
        // A finished or stopped turn has nothing left streaming.
        preview: busy ? m.preview : null,
        permissions: dead ? [] : m.permissions
      }
    }
    case 'preview':
      return m.preview === e.text ? m : { ...m, preview: e.text }
    case 'permission':
      if (m.permissions.some((p) => p.id === e.id)) return m
      return { ...m, permissions: [...m.permissions, { id: e.id, tool: e.tool ?? '?', input: e.input }] }
    case 'permissionDone':
      return { ...m, permissions: m.permissions.filter((p) => p.id !== e.id) }
    case 'notice':
      return { ...m, notices: [...m.notices, { level: e.level, text: e.text }].slice(-MAX_NOTICES) }
    case 'exit':
      return { ...m, state: { ...m.state, busy: false, dead: true }, preview: null, permissions: [] }
  }
}

export interface ToolRow {
  key: string
  toolId: string
  name: string
  input: unknown
  result: { text: string; isError: boolean } | null
}

export type Block =
  | { kind: 'text'; key: string; text: string }
  | { kind: 'thinking'; key: string; text: string }
  | { kind: 'tool'; tool: ToolRow }
  | { kind: 'note'; key: string; level: string; text: string }
  | { kind: 'compact'; key: string; trigger: string; preTokens: number }

export interface Usage {
  requests: number
  input: number
  cacheWrite: number
  cacheRead: number
  output: number
}

export interface Turn {
  key: string
  user: Extract<CliItem, { kind: 'user' }> | null
  blocks: Block[]
  usage: Usage | null
  durationMs: number | null
}

/**
 * Items -> turns. Tool results attach to their call by id (a result whose
 * call is not on screen is dropped); usage sums per turn.
 */
export function buildTurns(items: CliItem[]): Turn[] {
  const turns: Turn[] = []
  const tools = new Map<string, ToolRow>()
  let cur: Turn | null = null
  const open = (key: string): Turn => {
    const t: Turn = { key, user: null, blocks: [], usage: null, durationMs: null }
    turns.push(t)
    return t
  }
  for (const it of items) {
    if (it.kind === 'user') {
      cur = open(it.key)
      cur.user = it
      continue
    }
    const t = cur ?? (cur = open(it.key))
    switch (it.kind) {
      case 'text':
        t.blocks.push({ kind: 'text', key: it.key, text: it.text })
        break
      case 'thinking':
        t.blocks.push({ kind: 'thinking', key: it.key, text: it.text })
        break
      case 'tool': {
        const row: ToolRow = { key: it.key, toolId: it.toolId, name: it.name, input: it.input, result: null }
        tools.set(it.toolId, row)
        t.blocks.push({ kind: 'tool', tool: row })
        break
      }
      case 'toolResult': {
        const row = tools.get(it.toolId)
        if (row) row.result = { text: it.text, isError: it.isError }
        break
      }
      case 'usage': {
        const u = t.usage ?? (t.usage = { requests: 0, input: 0, cacheWrite: 0, cacheRead: 0, output: 0 })
        u.requests += 1
        u.input += it.input
        u.cacheWrite += it.cacheWrite
        u.cacheRead += it.cacheRead
        u.output += it.output
        break
      }
      case 'note':
        t.blocks.push({ kind: 'note', key: it.key, level: it.level, text: it.text })
        break
      case 'compact':
        // A compaction starts a new stretch of conversation.
        cur = open(it.key)
        cur.blocks.push({ kind: 'compact', key: it.key, trigger: it.trigger, preTokens: it.preTokens })
        break
      case 'turnEnd':
        t.durationMs = it.durationMs
        break
    }
  }
  return turns
}

/** One line for a tool call: the argument a person recognises it by. */
export function toolSummary(name: string, input: unknown): string {
  const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const pick = (...keys: string[]): string => {
    for (const k of keys) {
      const v = o[k]
      if (typeof v === 'string' && v.trim()) return v
    }
    return ''
  }
  const raw =
    name === 'Bash'
      ? pick('command')
      : pick('file_path', 'notebook_path', 'path', 'pattern', 'url', 'query', 'description', 'prompt', 'command')
  const line = raw.split('\n')[0]
  return line.length > 140 ? `${line.slice(0, 140)}…` : line
}

/** "12.3k" style token counts for the usage line. */
export function tokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 100_000) return `${(n / 1000).toFixed(1)}k`
  return `${Math.round(n / 1000)}k`
}

/**
 * What the composer sends: the text as the CLI should get it. Trailing
 * whitespace is noise; a lone "/" is not a command.
 */
export function outgoing(text: string): string | null {
  const t = text.replace(/\s+$/, '')
  if (!t.trim() || t.trim() === '/') return null
  return t
}
