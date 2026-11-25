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

export interface CliMenu {
  title: string
  options: { label: string; input: boolean }[]
  selected: number
}

export interface CliState {
  busy: boolean
  waiting: boolean
  ready: boolean
  blocked: string | null
  sessionId: string | null
  dead: boolean
  terminal: boolean
  /** Stopped for being idle; the next message resumes it. */
  parked?: boolean
  /** The permission mode the CLI reports (hooks), else the one asked for. */
  mode?: string | null
  /** The model the process was started with (null: the account default). */
  model?: string | null
  /** Background agents/shells from the last Stop hook. */
  background?: { id: string; type?: string; status?: string; description?: string }[]
  /** A numbered TUI menu on screen, drawn as a card. */
  menu?: CliMenu | null
  /** The plan an ExitPlanMode menu is asking about. */
  plan?: string | null
  /** A model/mode change or a CLI update waits for the turn to end. */
  restartPending?: boolean
}

export interface CliPermission {
  id: string
  tool: string
  input: unknown
}

export interface QuestionOption {
  label: string
  description?: string
}
export interface Question {
  question: string
  header?: string
  multiSelect?: boolean
  options: QuestionOption[]
}

/** A subagent's progress, under the Agent/Task card that started it. */
export interface AgentProgress {
  agentId: string
  toolId: string
  description: string
  agentType: string
  tools: number
  lastTool: string | null
  lastText: string | null
  done: boolean
}

export type CliEvent = { key: string } & (
  | { kind: 'items'; reset: boolean; items: CliItem[] }
  | ({ kind: 'state' } & CliState)
  | { kind: 'preview'; text: string | null }
  | { kind: 'permission'; id: string; tool: string | null; input: unknown; suggestions?: unknown }
  | { kind: 'question'; id: string; tool: string | null; input: unknown }
  | { kind: 'permissionDone'; id: string; decision: string }
  | { kind: 'notice'; level: string; text: string }
  | { kind: 'agents'; agents: AgentProgress[] }
  | { kind: 'meta'; title: string | null }
  | { kind: 'exit'; code: number }
  // A turn ended (Stop hook, interrupt, the CLI exiting mid-turn): what it
  // answered, for whoever asked (state/cliChats).
  | { key: string; kind: 'settle' }
  | { kind: 'turnDone'; reply: string; error: string | null; interrupted: boolean }
)

export interface CliModel {
  items: CliItem[]
  state: CliState
  preview: string | null
  /** Transcript text items that landed while `preview` was still on screen: not drawn until it is gone. */
  previewHides: string[]
  permissions: CliPermission[]
  questions: CliPermission[]
  agents: Record<string, AgentProgress>
  title: string | null
  notices: { level: string; text: string; at: number }[]
}

export const initialModel = (): CliModel => ({
  items: [],
  state: { busy: false, waiting: false, ready: false, blocked: null, sessionId: null, dead: false, terminal: false },
  preview: null,
  previewHides: [],
  permissions: [],
  questions: [],
  agents: {},
  title: null,
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
      if (!fresh.length) return m
      const items = [...m.items, ...fresh]
      if (m.preview == null) return { ...m, items }
      // The reply on screen is the preview. Its transcript copy lands now: keep the
      // preview until it has been drawn out (LivePreview), and hide the copy until
      // then, so the answer never vanishes and is never shown twice.
      const landed = fresh.filter((i): i is Extract<CliItem, { kind: 'text' }> => i.kind === 'text')
      if (landed.length && fresh.length === landed.length) {
        // The whole reply so far (its text items since the person's last message) is the
        // target: the preview draws out the same paragraphs the transcript then shows,
        // none of them alone, so nothing pops in at the end.
        let start = items.length - 1
        while (start >= 0 && items[start].kind !== 'user') start--
        const reply = items.slice(start + 1).filter((i): i is Extract<CliItem, { kind: 'text' }> => i.kind === 'text')
        return {
          ...m,
          items,
          preview: reply.map((i) => i.text).join('\n\n'),
          previewHides: reply.map((i) => i.key)
        }
      }
      // Anything else (a tool, a thought) means the streamed message is over and
      // the next one is not the preview's: its text goes in order, the preview goes.
      return { ...m, items, preview: null, previewHides: [] }
    }
    case 'state': {
      const { key: _key, kind: _kind, ...state } = e
      return {
        ...m,
        state,
        // The turn ending does not clear the preview: the Stop hook can arrive a tick
        // before the transcript's text does, and clearing here made the reply vanish and
        // come back whole. The page draws the preview out and settles it ('settle').
        preview: m.preview,
        previewHides: m.previewHides,
        permissions: state.dead ? [] : m.permissions,
        questions: state.dead ? [] : m.questions
      }
    }
    case 'settle':
      return { ...m, preview: null, previewHides: [] }
    case 'preview':
      if (m.preview === e.text) return m
      // A new streamed message: whatever the old one left hidden goes back in order.
      return { ...m, preview: e.text, previewHides: [] }
    case 'permission':
      if (m.permissions.some((p) => p.id === e.id)) return m
      return { ...m, permissions: [...m.permissions, { id: e.id, tool: e.tool ?? '?', input: e.input }] }
    case 'question':
      if (m.questions.some((p) => p.id === e.id)) return m
      return { ...m, questions: [...m.questions, { id: e.id, tool: e.tool ?? 'AskUserQuestion', input: e.input }] }
    case 'permissionDone':
      return {
        ...m,
        permissions: m.permissions.filter((p) => p.id !== e.id),
        questions: m.questions.filter((p) => p.id !== e.id)
      }
    case 'notice':
      return { ...m, notices: [...m.notices, { level: e.level, text: e.text, at: Date.now() }].slice(-MAX_NOTICES) }
    case 'agents': {
      const agents: Record<string, AgentProgress> = {}
      for (const a of e.agents) agents[a.toolId] = a
      return { ...m, agents }
    }
    case 'meta':
      return m.title === e.title ? m : { ...m, title: e.title }
    case 'exit':
      return { ...m, state: { ...m.state, busy: false, dead: true }, preview: null, permissions: [], questions: [] }
    case 'turnDone':
      return m
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

// ---- attachments -------------------------------------------------------------
//
// What the interactive CLI accepts (checked live against 2.1.330): an image
// as its file path pasted on its own (it becomes "[Image #N]"), any other
// file as an @-mention, quoted when the path has spaces.

/** Image types the CLI attaches as images when their path is pasted. */
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']
const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i

export function isImagePath(path: string): boolean {
  return IMAGE_EXT.test(path)
}

/** An @-mention the CLI reads into the turn: @path, or @"path" with spaces. */
export function mention(path: string): string {
  return /[\s"'\\]/.test(path) ? `@"${path.replace(/"/g, '\\"')}"` : `@${path}`
}

export interface Attachment {
  id: string
  name: string
  /** A file on disk (dropped, or saved by Rust for a paste). */
  path: string
  /** Sent as an image paste (else as an @-mention). */
  image: boolean
  /** data: URL for the composer thumbnail (images only). */
  preview?: string
}

/** The text and image paths to send for the composer's text + attachments. */
export function compose(text: string, atts: Attachment[]): { text: string; images: string[] } {
  const files = atts.filter((a) => !a.image).map((a) => mention(a.path))
  const body = [text.replace(/\s+$/, ''), ...files].filter((x) => x.trim()).join(' ')
  return { text: body, images: atts.filter((a) => a.image).map((a) => a.path) }
}

export type UserPart = { kind: 'text'; text: string } | { kind: 'file'; path: string; name: string }

/**
 * A user message as sent, for its bubble: the CLI's "[Image #N]" markers
 * dropped (the images are drawn as thumbnails) and @-mentions as file chips.
 */
export function userParts(text: string): UserPart[] {
  const clean = text.replace(/\[Image #\d+\]/g, '').replace(/[ \t]+$/gm, '')
  const parts: UserPart[] = []
  const re = /(^|\s)@(?:"((?:[^"\\]|\\.)+)"|([^\s"]+))/g
  let last = 0
  for (let m = re.exec(clean); m; m = re.exec(clean)) {
    const path = m[2] !== undefined ? m[2].replace(/\\"/g, '"') : m[3]
    // "@someone" in prose is not a file: a mention the CLI reads has a
    // path separator or an extension.
    if (!/[/.]/.test(path)) continue
    const start = m.index + m[1].length
    if (start > last) parts.push({ kind: 'text', text: clean.slice(last, start) })
    parts.push({ kind: 'file', path, name: path.split('/').filter(Boolean).pop() ?? path })
    last = re.lastIndex
  }
  if (last < clean.length) parts.push({ kind: 'text', text: clean.slice(last) })
  const out = parts.filter((p) => p.kind === 'file' || p.text.trim())
  if (out.length && out[0].kind === 'text') out[0] = { kind: 'text', text: out[0].text.replace(/^\s+/, '') }
  const end = out[out.length - 1]
  if (end?.kind === 'text') out[out.length - 1] = { kind: 'text', text: end.text.replace(/\s+$/, '') }
  return out
}

/** The transcript record a user item came from (its key is "<uuid>:<n>"). */
export function recordOf(itemKey: string): string {
  return itemKey.split(':')[0]
}

// ---- header ------------------------------------------------------------------

/** The model the last reply came from (the transcript's own record). */
export function lastModel(items: CliItem[]): string | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]
    if (it.kind === 'usage' && it.model && it.model !== '<synthetic>') return it.model
  }
  return null
}

/**
 * The modes the header offers, in the CLI's cycle order. "default" is what
 * the hooks call manual approval (2.1.330's flag spells it "manual").
 */
export const MODES = ['default', 'acceptEdits', 'plan', 'auto'] as const

/** A mode as the hooks report it, folded onto the picker's values. */
export function modeValue(m: string | null | undefined): string {
  if (!m || m === 'manual') return 'default'
  return m
}

// ---- questions ---------------------------------------------------------------

export function questionsOf(input: unknown): Question[] {
  const qs = (input as { questions?: unknown } | null)?.questions
  if (!Array.isArray(qs)) return []
  return qs
    .filter((q): q is Question => !!q && typeof (q as Question).question === 'string')
    .map((q) => ({ ...q, options: Array.isArray(q.options) ? q.options.filter((o) => o && typeof o.label === 'string') : [] }))
}

/**
 * The answers map for a question card: per question the picked labels (one,
 * or several for a multi-select) or the typed "other" text. Null while a
 * question has no answer yet.
 */
export function questionAnswers(
  qs: Question[],
  picked: Record<number, string[]>,
  other: Record<number, string>
): Record<string, string | string[]> | null {
  const out: Record<string, string | string[]> = {}
  for (let i = 0; i < qs.length; i++) {
    const typed = (other[i] ?? '').trim()
    const labels = picked[i] ?? []
    if (typed) out[qs[i].question] = qs[i].multiSelect ? [...labels, typed] : typed
    else if (labels.length) out[qs[i].question] = qs[i].multiSelect ? labels : labels[0]
    else return null
  }
  return out
}

// ---- the composer's queue ------------------------------------------------------

/**
 * Whether the next message typed during a turn can go now: the turn is over
 * and nothing waits on the person (a card, a menu, the terminal view). A
 * parked CLI is fine: the message resumes it.
 */
export function canSendQueued(s: CliState): boolean {
  if (s.dead || s.busy || s.waiting || s.menu || s.blocked || s.terminal) return false
  return s.ready || !!s.parked
}

// ---- tool code ---------------------------------------------------------------

/**
 * A line diff of an edit, " kept", "-removed", "+added" per line (an LCS
 * walk, as the headless chat's tool_code does). Past 800 lines a side it is
 * all removed then all added.
 */
export function lineDiff(before: string, after: string): string {
  const a = before ? before.split('\n') : []
  const b = after ? after.split('\n') : []
  const m = a.length
  const n = b.length
  if (m > 800 || n > 800) return [...a.map((l) => `-${l}`), ...b.map((l) => `+${l}`)].join('\n')
  const w = n + 1
  const dp = new Uint32Array((m + 1) * w)
  for (let i = m - 1; i >= 0; i--)
    for (let j = n - 1; j >= 0; j--)
      dp[i * w + j] = a[i] === b[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1])
  const out: string[] = []
  let i = 0
  let j = 0
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      out.push(` ${a[i]}`)
      i++
      j++
    } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) out.push(`-${a[i++]}`)
    else out.push(`+${b[j++]}`)
  }
  while (i < m) out.push(`-${a[i++]}`)
  while (j < n) out.push(`+${b[j++]}`)
  return out.join('\n')
}

/** The code a tool row shows: an edit's diff, a command, a file's content. */
export function toolCode(name: string, input: unknown): { code: string; diff: boolean; path: string | null } | null {
  const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const str = (k: string, from: Record<string, unknown> = o): string => (typeof from[k] === 'string' ? (from[k] as string) : '')
  const path = str('file_path') || str('notebook_path') || null
  switch (name) {
    case 'Edit':
      return 'old_string' in o ? { code: lineDiff(str('old_string'), str('new_string')), diff: true, path } : null
    case 'MultiEdit': {
      const edits = Array.isArray(o.edits) ? (o.edits as Record<string, unknown>[]) : []
      const body = edits.map((e) => lineDiff(str('old_string', e), str('new_string', e))).join('\n')
      return body ? { code: body, diff: true, path } : null
    }
    case 'Write':
      return str('content') ? { code: str('content'), diff: false, path } : null
    case 'NotebookEdit':
      return str('new_source') ? { code: str('new_source'), diff: false, path } : null
    case 'Bash':
      return str('command') ? { code: str('command'), diff: false, path: null } : null
    default:
      return null
  }
}
