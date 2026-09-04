import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  ArrowUp,
  Square,
  Loader2,
  Check,
  FileText,
  Pencil,
  TerminalSquare,
  Search,
  FolderSearch,
  List,
  Globe,
  CheckSquare,
  Wrench,
  Copy,
  Bot,
  History,
  Server,
  RotateCw,
  Clock,
  X as XIcon
} from 'lucide-react'
import type { DockviewPanelApi } from 'dockview-core'
import { pathOf, useSession, loadPaneState, setPaneState, flushSessionSaveSync } from '../../state/session'
import { getSettings } from '../../state/settings'
import {
  registerAgent,
  useAgents,
  setAgentStatus,
  agentsForWorkspace,
  resolveAgent
} from '../../state/agents'
import { useWorkspaceStatus } from '../../state/workspaceStatus'
import { useScheduled, schedulesFor, type Repeat } from '../../state/scheduledMessages'
import { ensureEditor, addTerminal, setDelegator, takeInitialText, getActiveApi } from '../registry'
import { useUI } from '../../state/ui'
import { useT, type TFn } from '../../i18n'
import Markdown from '../../components/Markdown'

// Native agent-chat panel — visual design ported 1:1 from the Swift ChatViews:
// user turns are a left-aligned accent-tinted bubble, assistant turns are an
// open column (no card) with a status/token footer below, tool calls are quiet
// step rows, and the composer is a glass card with mode/model chips + a round
// send/stop button. (Streaming CLI driver lives in main/agentChat.ts.)

interface ToolLine {
  name: string
  detail: string
  code?: string | null
  path?: string | null
  toolId?: string | null
  parent?: string | null // subagent (Task) tool_use id this call belongs to
  done?: boolean // its tool_result arrived (subagent/tool finished)
  error?: boolean
}
// Ordered content of an assistant turn: text and tool calls in the exact sequence
// they streamed, so a tool/subagent card renders in its real position (not hoisted
// above the text). `text` chunks are contiguous runs between tool calls.
type MsgItem = { type: 'text'; text: string } | { type: 'tool'; tool: ToolLine }
interface Msg {
  role: 'user' | 'assistant'
  text: string // full concatenated text (copy button / title)
  tools: ToolLine[] // all tools (kept for compatibility)
  items: MsgItem[] // ordered text/tool stream — the render source of truth
  done: boolean
  interrupted: boolean
  startedAt: number
  completedAt?: number
  durationMs: number
  tokensIn: number
  tokensOut: number
  // Special inline cards rendered in the transcript (native /mcp, /resume, /model).
  card?: 'mcp' | 'resume' | 'model'
  cardId?: string
  // A user message typed while a turn was still running — shown dimmed until it's
  // dequeued and sent (native lets you queue/steer mid-turn).
  queued?: boolean
}

// Fill in `items` for messages that predate the ordered model (restored logs /
// resumed transcripts): text first, then any tools. New turns build items live.
function ensureItems(m: Msg): MsgItem[] {
  if (m.items && m.items.length) return m.items
  const out: MsgItem[] = []
  if (m.text) out.push({ type: 'text', text: m.text })
  for (const tool of m.tools ?? []) out.push({ type: 'tool', tool })
  return out
}

const fmtK = (n: number): string => (n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n))
// Relative "방금 / N분 전 / N시간 전 / N일 전" (native ChatText.relative).
const fmtRelative = (ts: number, now: number, t: TFn): string => {
  const s = Math.max(0, Math.floor((now - ts) / 1000))
  if (s < 60) return t('chat.time.now')
  if (s < 3600) return t('chat.time.min', { n: Math.floor(s / 60) })
  if (s < 86400) return t('chat.time.hour', { n: Math.floor(s / 3600) })
  return t('chat.time.day', { n: Math.floor(s / 86400) })
}
const fmtDur = (ms: number): string => {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}초`
  const m = Math.floor(s / 60)
  return s % 60 ? `${m}분 ${s % 60}초` : `${m}분`
}
// Korean action verb per tool (native ToolGroup.verb) for the running header.
const TOOL_VERB: Record<string, string> = {
  Read: 'chat.tools.read',
  LS: 'chat.tools.read',
  Edit: 'chat.tools.edit',
  Write: 'chat.tools.edit',
  MultiEdit: 'chat.tools.edit',
  NotebookEdit: 'chat.tools.edit',
  Bash: 'chat.tools.run',
  BashOutput: 'chat.tools.run',
  Grep: 'chat.tools.search',
  Glob: 'chat.tools.search',
  WebFetch: 'chat.tools.web',
  WebSearch: 'chat.tools.web',
  TodoWrite: 'chat.tools.todo'
}
// Map a raw CLI model id (e.g. "claude-opus-5[1m]") to the chip's short alias.
const modelAlias = (m: string | null): string => {
  if (!m) return 'default'
  if (/opus/i.test(m)) return 'opus'
  if (/sonnet/i.test(m)) return 'sonnet'
  if (/haiku/i.test(m)) return 'haiku'
  if (/fable/i.test(m)) return 'fable'
  return 'default'
}
// "claude-opus-5[1m]" → "opus 5" (friendly label for the active model).
const fmtModel = (raw: string): string =>
  raw
    .replace(/^claude-/, '')
    .replace(/\[.*\]$/, '')
    .replace(/-/g, ' ')
    .trim()

const TOOL_ICON: Record<string, typeof FileText> = {
  Read: FileText,
  Edit: Pencil,
  Write: Pencil,
  MultiEdit: Pencil,
  NotebookEdit: Pencil,
  Bash: TerminalSquare,
  BashOutput: TerminalSquare,
  Grep: Search,
  Glob: FolderSearch,
  LS: List,
  WebFetch: Globe,
  WebSearch: Globe,
  TodoWrite: CheckSquare
}
function ToolIcon({ name }: { name: string }): JSX.Element {
  const Icon = TOOL_ICON[name] ?? Wrench
  return <Icon size={12} />
}

const isEditName = (n: string): boolean => n === 'Edit' || n === 'MultiEdit'

// Lightweight, language-agnostic syntax highlighting (native ChatText.highlight):
// comments dim, strings green, numbers amber, keywords accent — a single regex
// pass, not a full grammar. Big blocks skip it (perf, like native's 2500 cap).
const HL_KW =
  'func|let|var|const|if|else|elif|for|while|do|return|import|from|as|class|struct|enum|protocol|extension|interface|type|def|function|lambda|public|private|internal|fileprivate|static|final|override|guard|switch|case|default|break|continue|new|delete|async|await|try|catch|finally|throw|throws|typealias|package|self|this|super|true|false|nil|null|none|undefined|True|False|None|and|or|not|in|is|export|module|namespace|use|fn|impl|mut|pub|match|where|with|yield|assert|print|echo'
const HL_RE = new RegExp(
  '(\\/\\/[^\\n]*|#[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/)' + // comments
    '|("(?:\\\\.|[^"\\\\])*"|\'(?:\\\\.|[^\'\\\\])*\'|`[^`]*`)' + // strings
    '|(\\b\\d[\\d_.eExXa-fA-F]*\\b)' + // numbers
    '|(\\b(?:' + HL_KW + ')\\b)', // keywords
  'g'
)
function hl(code: string): ReactNode[] {
  if (code.length > 2500) return [code]
  const out: ReactNode[] = []
  let last = 0
  let k = 0
  let m: RegExpExecArray | null
  HL_RE.lastIndex = 0
  while ((m = HL_RE.exec(code)) !== null) {
    if (m[0].length === 0) {
      HL_RE.lastIndex++
      continue
    }
    if (m.index > last) out.push(code.slice(last, m.index))
    const cls = m[1] ? 'tok-c' : m[2] ? 'tok-s' : m[3] ? 'tok-n' : 'tok-k'
    out.push(
      <span key={k++} className={cls}>
        {m[0]}
      </span>
    )
    last = m.index + m[0].length
  }
  if (last < code.length) out.push(code.slice(last))
  return out
}

// Copy-to-clipboard icon button (native copyButton): flips to a check for 1.2s.
function CopyBtn({ code, title }: { code: string; title?: string }): JSX.Element {
  const t = useT()
  const [done, setDone] = useState(false)
  return (
    <button
      className={`chat-code-btn${done ? ' ok' : ''}`}
      title={title ?? t('chat.copy')}
      onClick={() => {
        void navigator.clipboard.writeText(code)
        setDone(true)
        setTimeout(() => setDone(false), 1200)
      }}
    >
      {done ? <Check size={12} /> : <Copy size={12} />}
    </button>
  )
}

// Expandable code / diff body for a tool line, matching native ChatText.codeBlock:
// - short single-line non-diff commands render as a compact one-line lozenge;
// - everything else is a card: header (lang label + copy / "변경 보기") over a
//   syntax-highlighted body (or +/- diff bands for Edit).
function ChatCode({
  code,
  diff,
  path
}: {
  code: string
  diff: boolean
  path?: string | null
}): JSX.Element {
  const t = useT()
  const openFile = useSession((s) => s.openFile)
  const oneLiner = !code.includes('\n') && code.length <= 110 && !diff
  if (oneLiner) {
    return (
      <div className="chat-code-compact">
        <code className="chat-code-compact-text">{hl(code)}</code>
        <CopyBtn code={code} />
      </div>
    )
  }
  const isEdit = diff && !!path
  return (
    <div className="chat-code-card">
      <div className="chat-code-head">
        <span className="chat-code-lang">{diff ? 'diff' : ''}</span>
        {isEdit ? (
          <button
            className="chat-code-viewdiff"
            onClick={() => {
              openFile(path as string)
              ensureEditor()
            }}
          >
            {t('chat.viewDiff')}
          </button>
        ) : (
          <CopyBtn code={code} />
        )}
      </div>
      {diff ? (
        <div className="chat-code-body diff">
          {code.split('\n').map((line, i) => {
            const add = line[0] === '+'
            const del = line[0] === '-'
            const content = add || del ? line.slice(1) : line
            const cls = add ? ' add' : del ? ' del' : ''
            const sign = add ? '+ ' : del ? '- ' : '  '
            return (
              <div key={i} className={`chat-code-line${cls}`}>
                <span className="sign">{sign}</span>
                {content ? hl(content) : ' '}
              </div>
            )
          })}
        </div>
      ) : (
        <pre className="chat-code-body">
          <code>{hl(code)}</code>
        </pre>
      )}
    </div>
  )
}

// Consecutive tool calls in a turn, collapsed into one accordion (like native
// ToolGroup): a quiet header (running shimmer / "N commands +A -B"), expanding to
// the tool lines + their code/diff.
// One tool line: icon + name + detail, with an optional expandable code block.
function ToolItem({ tl }: { tl: ToolLine }): JSX.Element {
  return (
    <div className="tg-item">
      <div className="chat-tool">
        <span className="chat-tool-ico">
          <ToolIcon name={tl.name} />
        </span>
        <span className="chat-tool-name">{tl.name}</span>
        {tl.detail && <span className="chat-tool-detail">{tl.detail}</span>}
      </div>
      {tl.code && <ChatCode code={tl.code} diff={isEditName(tl.name)} path={tl.path} />}
    </div>
  )
}

// A subagent delegation (Agent/Task tool) shown as its own card OUTSIDE the
// command group — a labelled accordion nesting the subagent's own tool calls,
// with a live running/done status like native's SubagentEntry.
function SubagentCard({
  task,
  kids,
  turnRunning
}: {
  task: ToolLine
  kids: ToolLine[]
  turnRunning: boolean
}): JSX.Element {
  const t = useT()
  const [open, setOpen] = useState(false)
  // Done when the Agent tool's tool_result arrived, or the whole turn ended.
  const done = task.done || !turnRunning
  const running = !done
  const state = task.error ? ' err' : running ? ' running' : ' done'
  return (
    <div className={`chat-subagent${state}`}>
      <button className="chat-subagent-head" onClick={() => setOpen((o) => !o)}>
        <span className={`tg-chevron${open ? ' open' : ''}`}>›</span>
        <Bot size={13} />
        <span className="chat-subagent-title">{t('chat.subagent')}</span>
        {task.detail && <span className="chat-subagent-desc">{task.detail}</span>}
        <span className="chat-subagent-status">
          {running ? (
            <>
              <Loader2 size={11} className="spin" /> {t('chat.tools.run')}
            </>
          ) : task.error ? (
            <>
              <Square size={9} fill="currentColor" /> {t('chat.stopped')}
            </>
          ) : (
            <>
              <Check size={11} /> {t('chat.done')}
            </>
          )}
        </span>
        {kids.length > 0 && <span className="chat-subagent-count">{kids.length}</span>}
      </button>
      {open && kids.length > 0 && (
        <div className="chat-subagent-kids">
          {kids.map((c, j) => (
            <ToolItem key={j} tl={c} />
          ))}
        </div>
      )}
    </div>
  )
}

const ToolGroup = memo(function ToolGroup({
  tools,
  interrupted
}: {
  tools: ToolLine[]
  interrupted: boolean
}): JSX.Element {
  const t = useT()
  // Running = a tool in this group is still awaiting its result. Derived per-tool
  // (each ToolLine gets `done` when its toolResult arrives) so a finished tool
  // shows done immediately, instead of staying "running" until the whole turn ends.
  const running = !interrupted && tools.some((tl) => !tl.done)
  const [open, setOpen] = useState(false)
  let added = 0
  let removed = 0
  let changed = 0
  for (const tl of tools) {
    if (isEditName(tl.name) || tl.name === 'Write' || tl.name === 'NotebookEdit') changed++
    if (tl.code && isEditName(tl.name))
      for (const l of tl.code.split('\n')) {
        if (l[0] === '+') added++
        else if (l[0] === '-') removed++
      }
  }
  const latest = tools[tools.length - 1]
  const state = running ? ' running' : interrupted ? ' interrupted' : ' done'
  return (
    <div className={`chat-toolgroup${state}`}>
      <button className="chat-toolgroup-head" onClick={() => setOpen((o) => !o)}>
        <span className={`tg-chevron${open ? ' open' : ''}`}>›</span>
        <span className="chat-tool-ico">
          <Wrench size={12} />
        </span>
        {running ? (
          <span className="chat-shimmer-text">
            {t(TOOL_VERB[latest?.name ?? ''] ?? 'chat.tools.run')}
            {latest?.detail ? ` · ${latest.detail}` : ''}
          </span>
        ) : (
          <span className="tg-title">
            {interrupted ? t('chat.stopped') + ' · ' : ''}
            {t('chat.toolCount', { n: tools.length })}
            {changed > 0 ? ' · ' + t('chat.tools.changed', { n: changed }) : ''}
            {(added > 0 || removed > 0) && (
              // Native appends "+A -B" inline (two-space gap), not right-aligned.
              <span className="tg-counts">
                {'  '}
                {added > 0 && <span className="add">+{added}</span>}
                {removed > 0 && <span className="del">{added > 0 ? ' ' : ''}-{removed}</span>}
              </span>
            )}
          </span>
        )}
      </button>
      {open && (
        <div className="chat-toolgroup-body">
          {tools.map((tl, i) => (
            <ToolItem key={i} tl={tl} />
          ))}
        </div>
      )}
    </div>
  )
})

// One text block of an assistant turn, rendered as LIVE markdown (tables/code
// form as they stream). Memoized on its text, so completed blocks never re-parse;
// only the still-growing tail block re-parses per frame — bounding the cost that
// used to make the whole message re-parse and stutter.
const AssistantText = memo(function AssistantText({ text }: { text: string }): JSX.Element {
  return (
    <div className="chat-assistant-text">
      <Markdown text={text} />
    </div>
  )
})

// One transcript turn. Memoized so that while the latest turn streams, the
// earlier turns (unchanged object identity) don't re-render or re-parse markdown.
const ChatMessage = memo(function ChatMessage({
  msg,
  now
}: {
  msg: Msg
  now: number
}): JSX.Element {
  const t = useT()
  if (msg.role === 'user') {
    return (
      <div className={`chat-turn user${msg.queued ? ' queued' : ''}`}>
        <div className="chat-user-bubble">{msg.text}</div>
        {msg.queued && <span className="chat-queued-tag">{t('chat.queued')}</span>}
      </div>
    )
  }
  // Walk the ordered stream into render groups so tools/subagents appear in their
  // real position relative to text (subagent = "Agent"/"Task" tool + the following
  // tools whose parent is its id).
  const isSubagent = (n: string): boolean => n === 'Agent' || n === 'Task'
  type RG =
    | { k: 'text'; text: string; key: number }
    | { k: 'tools'; tools: ToolLine[] }
    | { k: 'agent'; tool: ToolLine; kids: ToolLine[] }
  const groups: RG[] = []
  const agentById = new Map<string, RG & { k: 'agent' }>()
  ensureItems(msg).forEach((it, i) => {
    if (it.type === 'text') {
      groups.push({ k: 'text', text: it.text, key: i })
      return
    }
    const tl = it.tool
    if (tl.parent && agentById.has(tl.parent)) {
      agentById.get(tl.parent)!.kids.push(tl)
      return
    }
    if (isSubagent(tl.name)) {
      const g = { k: 'agent' as const, tool: tl, kids: [] as ToolLine[] }
      groups.push(g)
      if (tl.toolId) agentById.set(tl.toolId, g)
      return
    }
    const last = groups[groups.length - 1]
    if (last && last.k === 'tools') last.tools.push(tl)
    else groups.push({ k: 'tools', tools: [tl] })
  })
  return (
    <div className="chat-turn assistant">
      {groups.map((g, i) =>
        g.k === 'text' ? (
          <AssistantText key={`t${g.key}`} text={g.text} />
        ) : g.k === 'agent' ? (
          <SubagentCard key={`a${i}`} task={g.tool} kids={g.kids} turnRunning={!msg.done} />
        ) : (
          <ToolGroup key={`g${i}`} tools={g.tools} interrupted={msg.interrupted} />
        )
      )}
      <div className="chat-turn-foot">
        {!msg.done ? (
          <span className="chat-foot-running">
            <Loader2 size={12} className="spin" />
            {/* 생각 중 → (텍스트가 흐르기 시작하면) 작성 중, native와 동일 */}
            <span className="chat-shimmer-text">
              {msg.text ? t('chat.writing') : t('chat.thinking')}
            </span>
          </span>
        ) : (
          <span className="chat-foot-done">
            {msg.interrupted ? (
              <Square size={11} fill="currentColor" className="foot-stop" />
            ) : (
              <Check size={12} className="foot-check" />
            )}
            {(msg.interrupted ? t('chat.stopped') : t('chat.done')) + ' · ' + fmtDur(msg.durationMs)}
            {(msg.tokensIn > 0 || msg.tokensOut > 0) &&
              ` · ↑${fmtK(msg.tokensIn)} ↓${fmtK(msg.tokensOut)}`}
            {msg.completedAt ? ' · ' + fmtRelative(msg.completedAt, now, t) : ''}
            {msg.text && <CopyBtn code={msg.text} title={t('chat.copyMessage')} />}
          </span>
        )}
      </div>
    </div>
  )
})

// Descriptions for the built-in slash commands (Claude Code's own set). The live
// list comes from the session's init `slash_commands`; this only labels the ones
// we recognise — unknown entries (user skills / MCP prompts) show name-only.
const SLASH_DESC: Record<string, { ko: string; en: string }> = {
  clear: { ko: '새 대화 시작 (컨텍스트 비우기)', en: 'Start a new conversation (clear context)' },
  compact: { ko: '대화를 요약해 컨텍스트 확보', en: 'Summarize the conversation to free context' },
  context: { ko: '컨텍스트 사용량 보기', en: 'Show context usage' },
  usage: { ko: '토큰 사용량·비용', en: 'Token usage and cost' },
  model: { ko: '모델 변경', en: 'Switch the model' },
  config: { ko: '설정 열기', en: 'Open settings' },
  resume: { ko: '이전 세션 불러오기', en: 'Resume a previous session' },
  mcp: { ko: 'MCP 서버 상태·연결 관리', en: 'MCP servers: status & connections' },
  agents: { ko: '서브에이전트 관리', en: 'Manage subagents' },
  'list-agents': { ko: '에이전트·세션 목록', en: 'List agents and sessions' },
  init: { ko: 'CLAUDE.md 생성', en: 'Create a CLAUDE.md' },
  'code-review': { ko: '변경/PR 코드 리뷰', en: 'Review a diff or PR' },
  'security-review': { ko: '보안 취약점 검사', en: 'Security vulnerability review' },
  verify: { ko: '변경 검증', en: 'Verify changes' },
  doctor: { ko: '설치 점검·진단', en: 'Diagnose the setup' },
  insights: { ko: '최근 세션 분석 리포트', en: 'Analyze recent sessions' },
  recap: { ko: '대화 요약', en: 'Recap the conversation' },
  'deep-research': { ko: '웹 리서치·교차검증', en: 'Fan out web research' },
  memory: { ko: 'CLAUDE.md·메모리 편집', en: 'Edit CLAUDE.md and memory' },
  review: { ko: '코드 리뷰', en: 'Review code' },
  batch: { ko: '대규모 변경 오케스트레이션', en: 'Orchestrate large-scale changes' },
  loop: { ko: '프롬프트 반복 실행', en: 'Run a prompt on a loop' },
  design: { ko: 'UI 목업·화면 설계', en: 'Draft UI mockups' },
  dataviz: { ko: '차트·대시보드 설계', en: 'Design charts and dashboards' }
}

// The CLI only emits its real `slash_commands` after the first message (stream-
// json waits for input before init), so a fresh pane seeds the menu with the
// actual headless built-ins and swaps to the exact session list (which adds
// skills / MCP prompts) once init arrives. These names are verified present in a
// headless session — commands that need an interactive terminal are excluded.
const DEFAULT_SLASH = [
  'clear', 'compact', 'context', 'usage', 'model', 'agents',
  'list-agents', 'init', 'code-review', 'security-review', 'verify', 'doctor',
  'insights', 'recap', 'deep-research'
]
// Commands riven handles with its OWN native UI (the CLI's versions are
// interactive-terminal-only, so forwarding them headless does nothing). These are
// always offered and take precedence over any same-named CLI command.
const NATIVE_SLASH = ['resume', 'mcp', 'model', 'config'] as const

interface McpSrv {
  name: string
  url: string
  status: 'connected' | 'needs-auth' | 'other'
}

// Keyboard nav for inline command cards: ↑/↓ move, Enter confirms, Esc dismisses.
// The card container autofocuses so keys work right after "/command" — no click.
function useCardNav(
  count: number,
  onEnter: (i: number) => void,
  onDismiss: () => void
): {
  index: number
  setIndex: (i: number) => void
  ref: React.RefObject<HTMLDivElement>
  onKeyDown: (e: React.KeyboardEvent) => void
} {
  const [index, setIndex] = useState(0)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    ref.current?.focus()
  }, [])
  const clamped = count > 0 ? Math.min(index, count - 1) : 0
  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      onDismiss()
      return
    }
    if (count === 0) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setIndex((clamped + 1) % count)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setIndex((clamped - 1 + count) % count)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      onEnter(clamped)
    }
  }
  return { index: clamped, setIndex, ref, onKeyDown }
}

function CardSkeleton(): JSX.Element {
  return (
    <div className="card-skeleton">
      <span />
      <span />
      <span />
    </div>
  )
}

// Inline /mcp card: real server status from `claude mcp list`, with auth/logout
// driven by `claude mcp login|logout` in a hidden background process (no visible
// terminal). Keyboard-navigable, rendered in the transcript (not a modal).
function McpCard({ cwd, onDismiss }: { cwd: string; onDismiss: () => void }): JSX.Element {
  const t = useT()
  const [servers, setServers] = useState<McpSrv[] | null>(null)
  const [busyName, setBusyName] = useState<string | null>(null)
  const load = useCallback(() => {
    setServers(null)
    window.api.chat.mcpList(cwd).then(setServers)
  }, [cwd])
  useEffect(() => load(), [load])
  const login = async (name: string): Promise<void> => {
    setBusyName(name)
    await window.api.chat.mcpLogin(cwd, name)
    setBusyName(null)
    load()
  }
  const logout = async (name: string): Promise<void> => {
    setBusyName(name)
    await window.api.chat.mcpLogout(cwd, name)
    setBusyName(null)
    load()
  }
  const list = servers ?? []
  // Nav rows = servers, then the two footer actions.
  const count = servers ? list.length + 2 : 0
  const enter = (i: number): void => {
    if (i < list.length) {
      const s = list[i]
      if (s.status === 'connected') void logout(s.name)
      else void login(s.name)
    } else if (i === list.length) useUI.getState().openSettings('ai')
    else addTerminal('claude mcp add')
  }
  const { index, setIndex, ref, onKeyDown } = useCardNav(count, enter, onDismiss)
  useEffect(() => {
    if (servers) ref.current?.scrollIntoView({ block: 'end' })
  }, [servers, ref])

  return (
    <div className="chat-card" tabIndex={0} ref={ref} onKeyDown={onKeyDown}>
      <div className="chat-card-head">
        <Server size={14} />
        <span>{t('chat.mcpTitle')}</span>
        <button className="chat-card-refresh" title={t('common.refresh')} onClick={load}>
          <RotateCw size={12} />
        </button>
      </div>
      {servers === null ? (
        <CardSkeleton />
      ) : list.length === 0 ? (
        <div className="set-note">{t('chat.mcpEmpty')}</div>
      ) : (
        list.map((s, i) => (
          <div
            className={`mcp-item${index === i ? ' active' : ''}`}
            key={s.name}
            onMouseMove={() => index !== i && setIndex(i)}
          >
            <span className={`mcp-dot ${s.status}`} />
            <span className="mcp-name" title={s.url}>
              {s.name}
            </span>
            {busyName === s.name ? (
              <span className="mcp-status">
                <Loader2 size={12} className="spin" />
              </span>
            ) : s.status === 'connected' ? (
              <button className="btn-small" onClick={() => void logout(s.name)}>
                {t('chat.mcpLogout')}
              </button>
            ) : (
              <button className="btn-small" onClick={() => void login(s.name)}>
                {t('chat.mcpLoginBtn')}
              </button>
            )}
          </div>
        ))
      )}
      <div className="mcp-actions">
        <button
          className={`btn-small${servers && index === list.length ? ' active' : ''}`}
          onMouseMove={() => setIndex(list.length)}
          onClick={() => useUI.getState().openSettings('ai')}
        >
          {t('chat.mcpRivenTools')}
        </button>
        <button
          className={`btn-small${servers && index === list.length + 1 ? ' active' : ''}`}
          onMouseMove={() => setIndex(list.length + 1)}
          onClick={() => addTerminal('claude mcp add')}
        >
          {t('chat.mcpAdd')}
        </button>
      </div>
      <div className="set-note">{t('chat.mcpAuthNote')}</div>
    </div>
  )
}

// Inline /resume card: past sessions for this cwd; pick one to load it in place.
// Keyboard-navigable (↑/↓/Enter), Esc dismisses.
function ResumeCard({
  cwd,
  now,
  onResume,
  onDismiss
}: {
  cwd: string
  now: number
  onResume: (id: string) => void
  onDismiss: () => void
}): JSX.Element {
  const t = useT()
  const [sessions, setSessions] = useState<
    Array<{ id: string; title: string; mtime: number; messages: number }> | null
  >(null)
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([])
  useEffect(() => {
    window.api.chat.sessions(cwd).then(setSessions)
  }, [cwd])
  const list = sessions ?? []
  const { index, setIndex, ref, onKeyDown } = useCardNav(
    list.length,
    (i) => list[i] && onResume(list[i].id),
    onDismiss
  )
  useEffect(() => {
    if (sessions) ref.current?.scrollIntoView({ block: 'end' })
  }, [sessions, ref])
  useEffect(() => {
    itemRefs.current[index]?.scrollIntoView({ block: 'nearest' })
  }, [index])

  return (
    <div className="chat-card" tabIndex={0} ref={ref} onKeyDown={onKeyDown}>
      <div className="chat-card-head">
        <History size={14} />
        <span>{t('chat.resumeTitle')}</span>
      </div>
      {sessions === null ? (
        <CardSkeleton />
      ) : list.length === 0 ? (
        <div className="set-note">{t('chat.resumeEmpty')}</div>
      ) : (
        <div className="chat-card-scroll">
          {list.map((s, i) => (
            <button
              key={s.id}
              ref={(el) => (itemRefs.current[i] = el)}
              className={`picker-item${index === i ? ' active' : ''}`}
              onMouseMove={() => index !== i && setIndex(i)}
              onClick={() => onResume(s.id)}
            >
              <span className="picker-title">{s.title}</span>
              <span className="picker-meta">
                {fmtRelative(s.mtime, now, t)} · {s.messages}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// Inline /model card: pick the model with the keyboard (↑/↓/Enter), Esc cancels.
function ModelCard({
  models,
  current,
  onPick,
  onDismiss
}: {
  models: string[]
  current: string
  onPick: (m: string) => void
  onDismiss: () => void
}): JSX.Element {
  const t = useT()
  const start = Math.max(0, models.indexOf(current))
  const { index, setIndex, ref, onKeyDown } = useCardNav(
    models.length,
    (i) => onPick(models[i]),
    onDismiss
  )
  useEffect(() => {
    setIndex(start)
    ref.current?.scrollIntoView({ block: 'end' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return (
    <div className="chat-card" tabIndex={0} ref={ref} onKeyDown={onKeyDown}>
      <div className="chat-card-head">
        <Bot size={14} />
        <span>{t('chat.modelTitle')}</span>
      </div>
      {models.map((m, i) => (
        <button
          key={m}
          className={`picker-item model-row${index === i ? ' active' : ''}`}
          onMouseMove={() => index !== i && setIndex(i)}
          onClick={() => onPick(m)}
        >
          <span className="picker-title">{m}</span>
          {m === current && <Check size={13} className="model-check" />}
        </button>
      ))}
    </div>
  )
}

// Popover to schedule the composed message: quick delays, an exact time, a repeat
// option, and the list of this pane's pending schedules (with cancel).
function SchedulePopover({
  hasText,
  repeat,
  setRepeat,
  onSchedule,
  pending,
  onCancel,
  onClose
}: {
  hasText: boolean
  repeat: Repeat
  setRepeat: (r: Repeat) => void
  onSchedule: (fireAt: number) => void
  pending: Array<{ id: string; text: string; fireAt: number; repeat: Repeat }>
  onCancel: (id: string) => void
  onClose: () => void
}): JSX.Element {
  const t = useT()
  const presets: Array<[string, number]> = [
    [t('chat.schedule.p5m'), 5 * 60_000],
    [t('chat.schedule.p15m'), 15 * 60_000],
    [t('chat.schedule.p30m'), 30 * 60_000],
    [t('chat.schedule.p1h'), 60 * 60_000],
    [t('chat.schedule.p3h'), 180 * 60_000]
  ]
  const [dt, setDt] = useState('')
  const fmt = (ms: number): string =>
    new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  const repeatTag = (r: Repeat): string =>
    r === 'hourly' ? ' · ' + t('chat.schedule.hourly') : r === 'daily' ? ' · ' + t('chat.schedule.daily') : ''
  return (
    <div className="chat-sched-pop">
      <div className="chat-sched-head">
        <span>{t('chat.schedule.title')}</span>
        <button className="chat-sched-x" onClick={onClose}>
          <XIcon size={12} />
        </button>
      </div>
      <div className="chat-sched-repeat">
        {(['none', 'hourly', 'daily'] as Repeat[]).map((r) => (
          <button
            key={r}
            className={`chat-sched-rep${repeat === r ? ' on' : ''}`}
            onClick={() => setRepeat(r)}
          >
            {r === 'none' ? t('chat.schedule.once') : r === 'hourly' ? t('chat.schedule.hourly') : t('chat.schedule.daily')}
          </button>
        ))}
      </div>
      {hasText ? (
        <>
          <div className="chat-sched-presets">
            {presets.map(([label, ms]) => (
              <button key={label} className="chat-sched-preset" onClick={() => onSchedule(Date.now() + ms)}>
                {label}
              </button>
            ))}
          </div>
          <div className="chat-sched-exact">
            <input
              type="datetime-local"
              className="ui-input"
              value={dt}
              onChange={(e) => setDt(e.target.value)}
            />
            <button
              className="ui-btn ui-btn-primary"
              disabled={!dt}
              onClick={() => {
                const ms = new Date(dt).getTime()
                if (Number.isFinite(ms)) onSchedule(ms)
              }}
            >
              {t('chat.schedule.set')}
            </button>
          </div>
        </>
      ) : (
        <div className="chat-sched-empty">{t('chat.schedule.needText')}</div>
      )}
      {pending.length > 0 && (
        <div className="chat-sched-list">
          {pending.map((s) => (
            <div key={s.id} className="chat-sched-item">
              <span className="chat-sched-when">
                {fmt(s.fireAt)}
                {repeatTag(s.repeat)}
              </span>
              <span className="chat-sched-text">{s.text}</span>
              <button className="chat-sched-x" onClick={() => onCancel(s.id)}>
                <XIcon size={11} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// A teammate's @mention handle: the name only, dropping the " · group" suffix that
// group-member panes carry in their title.
function mentionHandle(title: string): string {
  return (title.split(' · ')[0] || title).trim()
}

export default function ChatPanel({
  workspace,
  chatKey,
  pinnedTitle,
  agent,
  setTitle,
  api
}: {
  workspace: string
  chatKey: string
  // A caller-pinned tab title (agent-group members show their name · group). When
  // present the pane keeps it instead of auto-titling from the first message.
  pinnedTitle?: string
  // A custom agent (.claude/agents/<name>.md) this pane runs as `claude --agent`.
  agent?: string
  setTitle?: (title: string) => void
  api?: DockviewPanelApi
}): JSX.Element {
  const t = useT()
  // The pane's persisted state (single source of truth) — read once at mount from
  // the workspace tree (sessions.json), with a one-time fallback to legacy keys.
  const [pane0] = useState(() => loadPaneState(workspace, chatKey))
  const savePane = useCallback(
    (patch: Parameters<typeof setPaneState>[2]) => setPaneState(workspace, chatKey, patch),
    [workspace, chatKey]
  )
  const [msgs, setMsgs] = useState<Msg[]>(() => {
    const arr = (pane0.log as Msg[] | undefined) ?? []
    // A turn that was still streaming when the app reloaded isn't running anymore.
    const last = arr[arr.length - 1]
    if (last && last.role === 'assistant' && !last.done) last.done = true
    return arr
  })
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [model, setModel] = useState<string | null>(null)
  const [pickedModel, setPickedModel] = useState(
    () => pane0.model || getSettings().defaultChatModel || 'default'
  )
  const [mode, setMode] = useState(
    () => pane0.mode || getSettings().defaultPermissionMode || 'acceptEdits'
  )

  const [error, setError] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  // Slash-command menu: open while the input is a bare "/query" (no space yet).
  // The available commands come from the session's init `slash_commands`.
  const [slashIndex, setSlashIndex] = useState(0)
  const [slashCommands, setSlashCommands] = useState<string[]>(DEFAULT_SLASH)
  // @mention menu: type "@query" to address a teammate; sending "@name msg"
  // delegates that message to the named agent (native chat parity).
  const [mentionIndex, setMentionIndex] = useState(0)
  // Scheduled messages (명령 예약): pick a time to auto-send the composed message.
  const [scheduleOpen, setScheduleOpen] = useState(false)
  const [schedRepeat, setSchedRepeat] = useState<Repeat>('none')
  useScheduled((s) => s.items) // re-render when this pane's schedule list changes
  // Ticks once a minute so the "N분 전" footer stays current without a per-frame
  // clock (native refreshes the relative time on a 1-min timer too).
  const [now, setNow] = useState(() => Date.now())
  const rootRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  // Batch streamed text deltas into one state update per animation frame so the
  // markdown isn't re-parsed on every single token (that was the choppiness).
  const pendingText = useRef('')
  const rafRef = useRef<number | null>(null)
  const slashItemRefs = useRef<Array<HTMLButtonElement | null>>([])

  useEffect(() => {
    // Only auto-focus the composer if this pane is actually the active one. A pane
    // spawned in the background (agent team / pipeline / delegation) is added
    // active-then-restored, so re-check isActive at fire time too — otherwise the
    // 50ms-later focus would yank the caret into a pane that's no longer active.
    if (api && !api.isActive) return
    const id = setTimeout(() => {
      if (api && !api.isActive) return
      inputRef.current?.focus()
    }, 50)
    return () => clearTimeout(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Fetch this workspace's REAL command list (built-ins + repo skills + MCP
  // prompts) and MCP server statuses up front, so "/" works accurately before the
  // first message. The pane's own init later refines it for this exact session.
  useEffect(() => {
    let alive = true
    window.api.chat.sessionInfo(pathOf(workspace)).then((info) => {
      if (!alive) return
      if (info.slashCommands.length) setSlashCommands(info.slashCommands)
    })
    return () => {
      alive = false
    }
  }, [workspace])

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    busyRef.current = busy
    // A running turn is the "delegator": teammates it spawns (group_add_agent /
    // pipeline via MCP) open beside THIS pane, not wherever the dock focus is.
    if (busy) setDelegator(chatKey)
    // Rich rail status: a running turn pulses (busy). Completion (done → idle) is
    // driven by the turnDone handler so the checkmark gets a moment to draw.
    if (busy) setAgentStatus(chatKey, 'busy')
    // Refresh the workspace-card agent roster's busy dots.
    useAgents.getState().bump()
    // Feed the workspace rail's activity rollup so a running native-chat agent
    // lights the workspace card busy (native parity: the card must reflect chat,
    // not just terminals). Keyed by chatKey so it never collides with a pane id.
    useWorkspaceStatus.getState().setPane(workspace, chatKey, { busy })
  }, [busy, chatKey, workspace])

  // Whenever this chat panel becomes the active tab, drop the caret into the
  // input so the user can type immediately (like native). Skip if focus is
  // already inside the panel (e.g. the user clicked a message to select text),
  // so we don't fight an intentional in-panel selection.
  useEffect(() => {
    if (!api) return
    const focusInput = (): void => {
      // Re-check at fire time: a background-spawned pane is briefly activated then
      // restored, so by the time this runs it may no longer be active — don't
      // steal the caret in that case.
      if (!api.isActive) return
      const el = inputRef.current
      if (!el) return
      if (el.ownerDocument.activeElement && rootRef.current?.contains(el.ownerDocument.activeElement)) {
        return
      }
      el.focus()
    }
    const d = api.onDidActiveChange((e) => {
      if (e.isActive) setTimeout(focusInput, 0)
    })
    return () => d.dispose()
  }, [api])

  const patchLast = useCallback((fn: (m: Msg) => Msg) => {
    setMsgs((all) => {
      // Patch the last ASSISTANT message (the running turn), not the literal last:
      // a mid-turn "steer" appends a queued USER message after the running
      // assistant, and patching the literal last then no-op'd — so streaming
      // updates AND the turnDone finalize were lost, leaving the assistant stuck
      // in the "generating" (shimmer) state forever (and pinning CPU).
      for (let i = all.length - 1; i >= 0; i--) {
        if (all[i].role === 'assistant') return all.map((m, j) => (j === i ? fn(m) : m))
      }
      return all
    })
  }, [])

  useEffect(() => {
    // Append a slice of text to the trailing text item (a run since the last tool),
    // else open a new one — preserving text↔tool ordering.
    const appendText = (delta: string): void => {
      if (!delta) return
      patchLast((m) => {
        const items = m.items.slice()
        const last = items[items.length - 1]
        if (last && last.type === 'text') items[items.length - 1] = { type: 'text', text: last.text + delta }
        else items.push({ type: 'text', text: delta })
        return { ...m, text: m.text + delta, items }
      })
    }
    // Typewriter drain: the CLI emits text in bursts, which looked choppy when
    // dumped whole per frame. Instead reveal a slice PROPORTIONAL to the backlog
    // each frame — small bursts trickle out smoothly, big ones catch up fast — so
    // the text flows steadily regardless of network/CLI timing.
    const drainTick = (): void => {
      const buf = pendingText.current
      if (!buf) {
        rafRef.current = null
        return
      }
      let n = Math.max(2, Math.ceil(buf.length / 5))
      // Don't cut mid-word if a space is very close (reduces markdown flicker).
      if (n < buf.length) {
        const sp = buf.indexOf(' ', n)
        if (sp >= 0 && sp - n <= 12) n = sp + 1
      }
      appendText(buf.slice(0, n))
      pendingText.current = buf.slice(n)
      rafRef.current = requestAnimationFrame(drainTick)
    }
    const startDrain = (): void => {
      if (rafRef.current == null) rafRef.current = requestAnimationFrame(drainTick)
    }
    // Reveal everything now (tool boundary / turn end) so nothing lags behind and
    // tool lines stay in order with the text.
    const flushText = (): void => {
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
      const delta = pendingText.current
      pendingText.current = ''
      appendText(delta)
    }
    const st = getSettings()
    const savedModel = pane0.model || st.defaultChatModel || 'default'
    // Resume the SAME Claude session across a restart so the agent keeps its full
    // context. Gate on the SESSION id existing (not on a non-empty transcript) —
    // otherwise a pane whose visible transcript was lost would fail to resume its
    // still-valid CLI session. Main falls back to a fresh session if the id is stale.
    const savedSession = pane0.session || undefined
    // Custom agent: prop on first mount, pane state after a reload/restore.
    const savedAgent = agent || pane0.agent || undefined
    void window.api.chat.start(chatKey, {
      cwd: pathOf(workspace),
      resume: savedSession,
      model: savedModel !== 'default' ? savedModel : undefined,
      permissionMode: pane0.mode || st.defaultPermissionMode || 'acceptEdits',
      mcpDisabled: st.mcpDisabledTools,
      globalPrompt: st.globalPrompt,
      agent: savedAgent
    })
    const off = window.api.chat.onEvent((e) => {
      if (e.key !== chatKey) return
      switch (e.kind) {
        case 'init':
          setModel(e.model)
          setPickedModel(modelAlias(e.model))
          if (e.slashCommands?.length) setSlashCommands(e.slashCommands)
          if (e.sessionId) savePane({ session: e.sessionId })
          break
        case 'text':
          pendingText.current += e.delta
          // Reveal it smoothly over frames (typewriter drain) instead of dumping
          // the whole burst at once, which read as choppy.
          startDrain()
          break
        case 'tool': {
          if (pendingText.current) flushText() // keep tool lines in order with text
          const tool: ToolLine = {
            name: e.name,
            detail: e.detail,
            code: e.code,
            path: e.path,
            toolId: e.toolId,
            parent: e.parent
          }
          patchLast((m) => ({ ...m, tools: [...m.tools, tool], items: [...m.items, { type: 'tool', tool }] }))
          break
        }
        case 'toolResult': {
          // Mark the finished tool (and its subagent card) done.
          const mark = (tl: ToolLine): ToolLine =>
            tl.toolId === e.toolId ? { ...tl, done: true, error: e.isError } : tl
          patchLast((m) => ({
            ...m,
            tools: m.tools.map(mark),
            items: m.items.map((it) => (it.type === 'tool' ? { type: 'tool', tool: mark(it.tool) } : it))
          }))
          break
        }
        case 'usage':
          patchLast((m) => ({
            ...m,
            tokensIn: e.input >= 0 ? e.input : m.tokensIn,
            tokensOut: e.output >= 0 ? e.output : m.tokensOut
          }))
          break
        case 'turnDone': {
          flushText()
          if (e.sessionId) savePane({ session: e.sessionId })
          // A steer-interrupt ends the turn with an error subtype — that's expected,
          // not a real failure, so don't surface it or mark the bubble "stopped".
          const steering = steerRef.current
          const stopped = stoppedRef.current
          steerRef.current = false
          stoppedRef.current = false
          // Only a genuine failure (not a steer, not a user Stop) shows the banner.
          if (e.error && !steering && !stopped) setError(e.error)
          patchLast((m) => {
            // Resolve any delegation waiters (riven_ask_agent) with this reply.
            if (waitersRef.current.length) {
              const reply = m.text
              const ws = waitersRef.current
              waitersRef.current = []
              setTimeout(() => ws.forEach((r) => r(reply)), 0)
            }
            // Mark any tool still awaiting a result as done — the turn is over, so a
            // missing toolResult mustn't leave a tool shimmering "running" forever.
            const finish = (tl: (typeof m.tools)[number]): typeof tl => (tl.done ? tl : { ...tl, done: true })
            return {
              ...m,
              done: true,
              interrupted: !!e.error && !steering,
              tools: m.tools.map(finish),
              items: m.items.map((it) => (it.type === 'tool' ? { type: 'tool', tool: finish(it.tool) } : it)),
              durationMs: Date.now() - m.startedAt,
              completedAt: Date.now()
            }
          })
          // If the user queued messages mid-turn, run the next one now (stays
          // busy). Otherwise the turn is truly done: settle status + notify.
          const drained = drainQueue()
          if (!drained) {
            setBusy(false)
            // Rail status: draw the done checkmark, then settle back to idle.
            setAgentStatus(chatKey, e.error ? 'idle' : 'done')
            setTimeout(() => setAgentStatus(chatKey, 'idle'), 2600)
            // Desktop notification when a turn finishes AND the user isn't already
            // looking at this pane (background workspace/pane, or app unfocused).
            // Routed through MAIN (electron Notification is reliable; the web one
            // isn't). Clicking it focuses + navigates to this chat.
            try {
              const looking =
                document.hasFocus() &&
                useSession.getState().activeWorkspace === workspace &&
                getActiveApi()?.activePanel?.id === chatKey
              if (getSettings().notifications && !looking)
                window.api.notify.show(titleRef.current || 'Claude', t('chat.done'), {
                  force: true,
                  paneId: chatKey
                })
            } catch {
              /* notifications unavailable */
            }
          }
          break
        }
        case 'exit':
          setBusy(false)
          setAgentStatus(chatKey, 'idle')
          break
        default:
          break
      }
    })
    return () => {
      off()
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatKey, workspace, patchLast])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [msgs])

  // Persist the transcript (capped) so ⌘R keeps the visible history — debounced
  // so a streaming turn doesn't JSON-stringify the whole log every frame.
  useEffect(() => {
    // Never overwrite a saved transcript with an EMPTY one. On restore a pane can
    // momentarily mount before its log loads; writing [] then would wipe the real
    // history. /clear removes the key explicitly, so skipping empty writes is safe.
    if (msgs.length === 0) return
    const id = setTimeout(() => {
      savePane({ log: msgs.slice(-120) })
      // When the turn has finished, force the transcript to disk synchronously so a
      // quit/reload right after can never lose it (the debounced full-store save may
      // not have fired yet). During streaming we let the debounce coalesce writes.
      if (msgs[msgs.length - 1]?.done) flushSessionSaveSync()
    }, 800)
    return () => clearTimeout(id)
  }, [msgs, savePane])

  // If the transcript was restored, the panel already has its title — don't let
  // the next first-message override it — and show a "continued" marker on top.
  const restoredRef = useRef(msgs.length > 0)
  // A pinned title (agent-group member name · group) comes via prop on first mount
  // and via localStorage after a reload. When pinned, the pane never auto-retitles.
  const pinned = pinnedTitle || pane0.title || ''
  const titleSet = useRef(msgs.length > 0 || !!pinned)
  // Live title/busy/reply-waiters so this chat can act as a delegatable agent
  // (riven_ask_agent). titleRef tracks the tab's short title.
  const titleRef = useRef(
    pinned || msgs.find((m) => m.role === 'user')?.text.split('\n')[0].slice(0, 40) || 'Claude'
  )
  const busyRef = useRef(false)
  const waitersRef = useRef<Array<(reply: string) => void>>([])
  // Messages typed while a turn was running, sent one-by-one as turns finish.
  const queuedRef = useRef<string[]>([])
  // True when we interrupted the current turn to steer it with a new message —
  // suppresses the "stopped" note so it reads as a re-ask, not a user cancel.
  const steerRef = useRef(false)
  // True when the user pressed Stop, so the turn's non-success end subtype isn't
  // surfaced as a red "error…" banner (a manual interrupt is expected, not a fault).
  const stoppedRef = useRef(false)
  const blankAssistant = (): Msg => ({
    role: 'assistant',
    text: '',
    tools: [],
    items: [],
    done: false,
    interrupted: false,
    startedAt: Date.now(),
    durationMs: 0,
    tokensIn: 0,
    tokensOut: 0
  })
  // Start the next queued message (if any) as a fresh turn: un-dim its bubble and
  // add the assistant placeholder. Returns true if a turn was started.
  const drainQueue = (): boolean => {
    const next = queuedRef.current.shift()
    if (next == null) return false
    setMsgs((all) => {
      const i = all.findIndex((m) => m.queued && m.role === 'user')
      const copy = i >= 0 ? all.map((m, j) => (j === i ? { ...m, queued: false } : m)) : all
      return [...copy, blankAssistant()]
    })
    setBusy(true)
    setAgentStatus(chatKey, 'busy')
    window.api.chat.send(chatKey, next)
    return true
  }
  // Stop means stop: interrupt the current turn AND drop anything queued.
  const stopTurn = (): void => {
    queuedRef.current = []
    stoppedRef.current = true
    setMsgs((all) => all.filter((m) => !m.queued))
    window.api.chat.interrupt(chatKey)
  }
  const sendMessage = useCallback(
    (text: string): void => {
      const clean = text.trim()
      if (!clean) return
      setError(null)
      // /clear resets the CLI's context AND the visible transcript, matching
      // Claude's own behaviour (no lingering history bubbles).
      if (clean === '/clear') {
        window.api.chat.send(chatKey, clean)
        setMsgs([])
        restoredRef.current = false
        savePane({ log: [] })
        return
      }
      // Title the tab from the first message (CLI-style short title), like native.
      if (!titleSet.current) {
        titleSet.current = true
        const first = clean.split('\n')[0].trim()
        const short = first.length > 40 ? first.slice(0, 40) + '…' : first
        titleRef.current = short
        setTitle?.(short)
        useAgents.getState().bump() // refresh the workspace rail (it reads getTitle)
        // Then upgrade to an AI-generated summary title (native refreshAITitle).
        void window.api.chat.title(clean).then((ai) => {
          if (ai) {
            titleRef.current = ai
            setTitle?.(ai)
            useAgents.getState().bump()
          }
        })
      }
      setMsgs((all) => [
        ...all,
        { role: 'user', text: clean, tools: [], items: [], done: true, interrupted: false, startedAt: 0, durationMs: 0, tokensIn: 0, tokensOut: 0 },
        { role: 'assistant', text: '', tools: [], items: [], done: false, interrupted: false, startedAt: Date.now(), durationMs: 0, tokensIn: 0, tokensOut: 0 }
      ])
      setBusy(true)
      window.api.chat.send(chatKey, clean)
    },
    [chatKey, setTitle, savePane]
  )

  // Drop this chat's activity from the workspace rail when the pane closes, so a
  // busy card doesn't get stuck lit after the agent pane is gone.
  useEffect(() => {
    return () => useWorkspaceStatus.getState().clearPane(workspace, chatKey)
  }, [workspace, chatKey])

  // Keep a pinned tab title applied (survives reload / restore) so an agent-group
  // member's name doesn't fall back to the generic "채팅" label.
  useEffect(() => {
    if (pinned) setTitle?.(pinned)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Expose this chat as a delegatable agent (riven_agents / riven_ask_agent).
  useEffect(() => {
    return registerAgent({
      chatKey,
      workspace,
      getTitle: () => titleRef.current,
      isBusy: () => busyRef.current,
      send: (text) => sendMessage(text),
      // Append context to the composer (not auto-send) so the user can add a note
      // before sending — used by the browser's "send to chat" actions.
      attach: (text) => {
        const el = inputRef.current
        const cur = el?.value ?? ''
        const next = (cur ? cur.replace(/\s*$/, '') + '\n' : '') + text + ' '
        setInput(next)
        if (el) {
          el.value = next
          el.style.height = 'auto'
          el.style.height = Math.min(el.scrollHeight, 200) + 'px'
          el.focus()
        }
      },
      waitNext: () => new Promise<string>((resolve) => waitersRef.current.push(resolve))
    })
  }, [chatKey, workspace, sendMessage])

  // Read the textarea's live DOM value, not React state: during Korean IME
  // composition the committed char lands in the DOM before React's onChange, so
  // the DOM is the authoritative source when we send on composition end.
  const submit = (): void => {
    const text = (inputRef.current?.value ?? input).trim()
    if (!text) return
    // A bare native command opens riven UI. Anything else — including skills and
    // commands with args — is sent to the CLI so it runs inline in the answer.
    if (runNativeCommand(text)) return
    setInput('')
    if (inputRef.current) {
      inputRef.current.value = ''
      inputRef.current.style.height = 'auto'
    }
    // "@teammate message" delegates to that agent instead of answering here.
    if (delegateMentions(text)) return
    // Mid-turn: STEER. Interrupt the running turn and re-ask with this message —
    // the CLI session context is retained, so the model reconsiders with the prior
    // content combined (native behaviour). The queued message fires from turnDone.
    if (busy) {
      queuedRef.current.push(text)
      setMsgs((all) => [
        ...all,
        { role: 'user', text, tools: [], items: [], done: true, interrupted: false, startedAt: 0, durationMs: 0, tokensIn: 0, tokensOut: 0, queued: true }
      ])
      steerRef.current = true
      window.api.chat.interrupt(chatKey)
      return
    }
    sendMessage(text)
  }
  // IME state: while composing, Enter must commit the syllable first, then send
  // once — otherwise the committing keystroke leaves its last char behind (the
  // old !isComposing guard required a second Enter to actually send).
  const composingRef = useRef(false)
  const pendingEnterRef = useRef(false)

  // First-message priming: consumed ONE-SHOT from the registry (not from params),
  // so a restored pane never re-sends it. Only fresh panes have pending text.
  const initSent = useRef(false)
  useEffect(() => {
    if (initSent.current) return
    initSent.current = true
    const initial = takeInitialText(chatKey)
    if (!initial) return
    const id = setTimeout(() => sendMessage(initial), 300)
    return () => clearTimeout(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const MODELS = ['default', 'fable', 'sonnet', 'opus', 'haiku']
  const MODES: Array<[string, string]> = [
    ['plan', t('chat.mode.plan')],
    ['acceptEdits', t('chat.mode.acceptEdits')],
    ['default', t('chat.mode.ask')]
  ]

  // Apply a model choice (shared by the composer chip + the /model card): respawn
  // with --model before any turn (spawn defaults to the account model otherwise),
  // else switch live via the control channel.
  const applyModel = (m: string): void => {
    setPickedModel(m)
    savePane({ model: m })
    if (msgs.length === 0) {
      window.api.chat.stop(chatKey)
      const st = getSettings()
      void window.api.chat.start(chatKey, {
        cwd: pathOf(workspace),
        model: m,
        mcpDisabled: st.mcpDisabledTools,
        globalPrompt: st.globalPrompt
      })
    } else {
      window.api.chat.setModel(chatKey, m)
    }
  }

  // Drag files (from the explorer or the OS) onto the chat to attach their paths
  // to the message — the agent can then Read them.
  const onDropFiles = (e: React.DragEvent): void => {
    e.preventDefault()
    setDragOver(false)
    const paths: string[] = []
    for (const f of Array.from(e.dataTransfer.files)) {
      const p = (f as unknown as { path?: string }).path
      if (p) paths.push(p)
    }
    if (paths.length === 0) {
      const txt = e.dataTransfer.getData('text/plain') || e.dataTransfer.getData('text/uri-list')
      for (const line of txt.split('\n')) {
        const p = line.trim().replace(/^file:\/\//, '')
        if (p) paths.push(decodeURI(p))
      }
    }
    if (paths.length === 0) return
    const add = paths.join(' ')
    const el = inputRef.current
    const next = (el?.value ? el.value + (el.value.endsWith(' ') ? '' : ' ') : '') + add + ' '
    setInput(next)
    if (el) {
      el.value = next
      el.focus()
    }
  }

  // Slash-command menu: open while the input is a bare "/query" (no whitespace).
  // Native commands (resume/mcp/config) always lead the list and take precedence
  // over any same-named CLI command; the rest are this session's real commands.
  const lang = getSettings().language
  const menuCommands = [...NATIVE_SLASH, ...slashCommands.filter((c) => !(NATIVE_SLASH as readonly string[]).includes(c))]
  const slashQuery = /^\/[^\s]*$/.test(input) ? input.slice(1).toLowerCase() : null
  const slashMatches =
    slashQuery !== null
      ? menuCommands.filter((c) => c.toLowerCase().startsWith(slashQuery)).slice(0, 40)
      : []
  const slashOpen = slashMatches.length > 0
  const slashDesc = (name: string): string => {
    const d = SLASH_DESC[name]
    return d ? (lang === 'ko' ? d.ko : d.en) : ''
  }
  // Scroll a command into view ONLY on keyboard nav. Doing it on every slashIndex
  // change fought with hover: scrollIntoView moved items under the cursor, which
  // fired mouseEnter, which changed the index again — the highlight jittered.
  const scrollSlashIntoView = (i: number): void => {
    slashItemRefs.current[i]?.scrollIntoView({ block: 'nearest' })
  }

  // @mention: teammates in this workspace (exclude self). Menu opens on a trailing
  // "@query" token; picking inserts "@name ", and sending delegates to them.
  const peers = agentsForWorkspace(workspace).filter((a) => a.id !== chatKey)
  // A mention handle is the member's name only (drop the " · group" suffix) — short
  // and stable, so "@리드 팀 붙이자" doesn't leak the group name into the token.
  const mentionQ = /(?:^|\s)@([^@]*)$/.exec(input)
  const mentionQuery = mentionQ ? mentionQ[1].toLowerCase().trimStart() : null
  const mentionMatches =
    mentionQuery !== null
      ? peers.filter((p) => mentionHandle(p.title).toLowerCase().includes(mentionQuery)).slice(0, 20)
      : []
  const mentionOpen = mentionMatches.length > 0
  const pickMention = (title: string): void => {
    const handle = mentionHandle(title)
    const next = input.replace(/(?:^|\s)@[^@]*$/, (m) =>
      (m.startsWith(' ') ? ' ' : '') + '@' + handle + ' '
    )
    setInput(next)
    setMentionIndex(0)
    if (inputRef.current) {
      inputRef.current.value = next
      inputRef.current.focus()
    }
  }
  // Parse leading @mentions and delegate the rest to them. Peer titles can contain
  // spaces ("Claude Code", "리드 · 팀"), so a whitespace-delimited token is wrong —
  // match each "@..." against the known peer handles by longest prefix instead.
  const delegateMentions = (text: string): boolean => {
    const handles = peers
      .map((p) => ({ id: p.id, handle: mentionHandle(p.title) }))
      .filter((p) => p.handle)
      .sort((a, b) => b.handle.length - a.handle.length) // longest first (specificity)
    let rest = text.replace(/^\s+/, '')
    const targetIds: string[] = []
    for (;;) {
      if (!rest.startsWith('@')) break
      const after = rest.slice(1)
      const lc = after.toLowerCase()
      const hit = handles.find((p) => lc.startsWith(p.handle.toLowerCase()))
      if (!hit) break
      if (!targetIds.includes(hit.id)) targetIds.push(hit.id)
      rest = after.slice(hit.handle.length).replace(/^\s+/, '')
    }
    const body = rest.trim()
    if (targetIds.length === 0 || !body) return false
    const targets = targetIds
      .map((id) => resolveAgent(id, chatKey))
      .filter((a): a is NonNullable<typeof a> => !!a)
    if (targets.length === 0) return false
    for (const tgt of targets) tgt.send(body)
    setMsgs((all) => [
      ...all,
      { role: 'user', text, tools: [], items: [], done: true, interrupted: false, startedAt: 0, durationMs: 0, tokensIn: 0, tokensOut: 0 }
    ])
    return true
  }

  const clearComposer = (): void => {
    setInput('')
    setSlashIndex(0)
    setMentionIndex(0)
    if (inputRef.current) {
      inputRef.current.value = ''
      inputRef.current.style.height = 'auto'
    }
  }

  // Schedule the current composer text to auto-send to this pane at fireAt.
  const doSchedule = (fireAt: number): void => {
    const text = (inputRef.current?.value ?? input).trim()
    if (!text || fireAt <= Date.now()) return
    useScheduled.getState().add({
      workspace,
      chatKey,
      targetTitle: titleRef.current || 'Claude',
      text,
      fireAt,
      repeat: schedRepeat
    })
    setScheduleOpen(false)
    setSchedRepeat('none')
    clearComposer()
  }
  const pendingSchedules = schedulesFor(workspace, chatKey)

  // Load a past session INTO this pane: resume its CLI context and show its
  // reconstructed transcript (native /resume).
  const resumeSession = async (id: string): Promise<void> => {
    const cwd = pathOf(workspace)
    window.api.chat.stop(chatKey)
    const transcript = await window.api.chat.sessionTranscript(cwd, id)
    setMsgs(
      transcript.map((m) => {
        const tools = m.tools.map((tl) => ({ name: tl.name, detail: tl.detail }))
        const items: MsgItem[] = []
        if (m.text) items.push({ type: 'text', text: m.text })
        for (const tool of tools) items.push({ type: 'tool', tool })
        return {
          role: m.role,
          text: m.text,
          tools,
          items,
          done: true,
          interrupted: false,
          startedAt: 0,
          durationMs: 0,
          tokensIn: 0,
          tokensOut: 0
        }
      })
    )
    restoredRef.current = true
    savePane({ session: id })
    const st = getSettings()
    const savedModel = pickedModel || st.defaultChatModel || 'default'
    setTimeout(
      () =>
        void window.api.chat.start(chatKey, {
          cwd,
          resume: id,
          model: savedModel !== 'default' ? savedModel : undefined,
          permissionMode: mode || st.defaultPermissionMode || 'acceptEdits',
          mcpDisabled: st.mcpDisabledTools,
          globalPrompt: st.globalPrompt
        }),
      120
    )
  }

  // A special inline card message (native /mcp, /resume) appended to the transcript.
  const pushCard = (card: 'mcp' | 'resume' | 'model'): void => {
    const cardId = `${card}-${Date.now()}`
    setMsgs((m) => [
      ...m,
      {
        role: 'assistant',
        text: '',
        tools: [],
        items: [],
        card,
        cardId,
        done: true,
        interrupted: false,
        startedAt: 0,
        durationMs: 0,
        tokensIn: 0,
        tokensOut: 0
      }
    ])
  }

  // Remove a card (Esc) and hand focus back to the composer.
  const dismissCard = (cardId?: string): void => {
    setMsgs((m) => m.filter((x) => x.cardId !== cardId))
    setTimeout(() => inputRef.current?.focus(), 0)
  }

  // Pick a command from the menu: just FILL the composer with "/name " (never run
  // immediately). The user confirms with Enter — like every other message.
  const pickSlash = (name: string): void => {
    const next = `/${name} `
    setInput(next)
    setSlashIndex(0)
    if (inputRef.current) {
      inputRef.current.value = next
      inputRef.current.focus()
    }
  }

  // Execute a bare native command ("/resume", "/mcp", "/model", "/config") when
  // Enter is pressed. Returns true if handled natively; false = send to the CLI
  // (so skills / commands-with-args run inline within the streaming answer).
  const runNativeCommand = (text: string): boolean => {
    const m = text.match(/^\/([\w-]+)$/)
    const cmd = m?.[1]
    if (!cmd || !(NATIVE_SLASH as readonly string[]).includes(cmd)) return false
    clearComposer()
    if (cmd === 'config') useUI.getState().openSettings('ai')
    else pushCard(cmd as 'mcp' | 'resume' | 'model')
    return true
  }

  // Render the transcript once per (msgs / now / model) change — NOT on every
  // composer keystroke. Callbacks go through a ref so the memoised element tree
  // stays referentially stable; React then skips reconciling all N turns while
  // typing. This is the fix for typing/interaction lag on long chats (a long
  // transcript is thousands of DOM nodes; re-diffing them per keystroke stalled).
  const handlers = useRef({ applyModel, dismissCard, resumeSession })
  handlers.current = { applyModel, dismissCard, resumeSession }
  const messageList = useMemo(
    () =>
      msgs.map((msg, i) =>
        msg.card === 'mcp' ? (
          <McpCard
            key={msg.cardId ?? i}
            cwd={pathOf(workspace)}
            onDismiss={() => handlers.current.dismissCard(msg.cardId)}
          />
        ) : msg.card === 'resume' ? (
          <ResumeCard
            key={msg.cardId ?? i}
            cwd={pathOf(workspace)}
            now={now}
            onResume={(id) => void handlers.current.resumeSession(id)}
            onDismiss={() => handlers.current.dismissCard(msg.cardId)}
          />
        ) : msg.card === 'model' ? (
          <ModelCard
            key={msg.cardId ?? i}
            models={MODELS}
            current={pickedModel}
            onPick={(m) => {
              handlers.current.applyModel(m)
              handlers.current.dismissCard(msg.cardId)
            }}
            onDismiss={() => handlers.current.dismissCard(msg.cardId)}
          />
        ) : (
          <ChatMessage key={i} msg={msg} now={now} />
        )
      ),
    [msgs, now, pickedModel, workspace]
  )

  return (
    <div
      className={`chat-panel${dragOver ? ' drop-active' : ''}`}
      ref={rootRef}
      // Explicitly activate this pane on a real click. dockview's default
      // "focusin activates the group" is unreliable once split groups exist (e.g.
      // after the agent-group panel spawns panes beside this one), which made
      // clicking a chat pane intermittently NOT take focus. Capture-phase so inner
      // elements that stopPropagation can't swallow it; user-click only, so it
      // doesn't violate the no-auto-focus rule.
      onPointerDownCapture={() => {
        if (api && !api.isActive) api.setActive()
      }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files') || e.dataTransfer.types.includes('text/plain')) {
          e.preventDefault()
          if (!dragOver) setDragOver(true)
        }
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragOver(false)
      }}
      onDrop={onDropFiles}
    >
      <div className="chat-scroll" ref={scrollRef}>
        {restoredRef.current && <div className="chat-resumed">{t('chat.resumed')}</div>}
        {messageList}
        {error && <div className="chat-error">{error}</div>}
      </div>

      <div className={`chat-composer${input.trim().startsWith('/') ? ' is-command' : ''}`}>
        {mentionOpen && (
          <div className="slash-menu">
            {mentionMatches.map((p, i) => (
              <button
                key={p.id}
                className={`slash-item${i === Math.min(mentionIndex, mentionMatches.length - 1) ? ' active' : ''}`}
                onMouseMove={() => mentionIndex !== i && setMentionIndex(i)}
                onMouseDown={(e) => {
                  e.preventDefault()
                  pickMention(p.title)
                }}
              >
                <span className="slash-name">@{mentionHandle(p.title)}</span>
                <span className="slash-desc">{p.busy ? t('chat.tools.run') : ''}</span>
              </button>
            ))}
          </div>
        )}
        {slashOpen && (
          <div className="slash-menu">
            {slashMatches.map((c, i) => (
              <button
                key={c}
                ref={(el) => (slashItemRefs.current[i] = el)}
                className={`slash-item${i === Math.min(slashIndex, slashMatches.length - 1) ? ' active' : ''}`}
                onMouseMove={() => slashIndex !== i && setSlashIndex(i)}
                onMouseDown={(e) => {
                  e.preventDefault()
                  pickSlash(c)
                }}
              >
                <span className="slash-name">/{c}</span>
                <span className="slash-desc">{slashDesc(c)}</span>
              </button>
            ))}
          </div>
        )}
        <textarea
          ref={inputRef}
          className="chat-input"
          value={input}
          placeholder={t('chat.placeholder')}
          onChange={(e) => {
            setInput(e.target.value)
            // Auto-grow with content (Shift+Enter) instead of hiding text upward.
            const el = e.target
            el.style.height = 'auto'
            el.style.height = `${Math.min(el.scrollHeight, 168)}px`
          }}
          onCompositionStart={() => {
            composingRef.current = true
          }}
          onCompositionEnd={() => {
            composingRef.current = false
            // Enter pressed mid-composition committed the syllable; now send once,
            // after the browser has flushed the committed char into the textarea.
            if (pendingEnterRef.current) {
              pendingEnterRef.current = false
              setTimeout(submit, 0)
            }
          }}
          onKeyDown={(e) => {
            // @mention menu navigation takes priority while it's open.
            if (mentionOpen) {
              const len = mentionMatches.length
              const mi = Math.min(mentionIndex, len - 1)
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setMentionIndex((mi + 1) % len)
                return
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault()
                setMentionIndex((mi - 1 + len) % len)
                return
              }
              if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault()
                pickMention(mentionMatches[mi].title)
                return
              }
              if (e.key === 'Escape') {
                e.preventDefault()
                const next = input.replace(/(?:^|\s)@[^@]*$/, '')
                setInput(next)
                if (inputRef.current) inputRef.current.value = next
                return
              }
            }
            // Slash-command menu navigation takes priority while it's open.
            if (slashOpen) {
              const len = slashMatches.length
              const si = Math.min(slashIndex, len - 1)
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                const ni = (si + 1) % len
                setSlashIndex(ni)
                scrollSlashIntoView(ni)
                return
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault()
                const ni = (si - 1 + len) % len
                setSlashIndex(ni)
                scrollSlashIntoView(ni)
                return
              }
              if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault()
                pickSlash(slashMatches[si])
                return
              }
              if (e.key === 'Escape') {
                e.preventDefault()
                setInput('')
                if (inputRef.current) inputRef.current.value = ''
                return
              }
            }
            // Esc interrupts the running turn (native behaviour).
            if (e.key === 'Escape' && busy) {
              e.preventDefault()
              stopTurn()
              return
            }
            if (e.key !== 'Enter' || e.shiftKey) return
            const composing = composingRef.current || e.nativeEvent.isComposing
            if (composing) {
              // Let the IME commit the in-progress syllable; defer the send to
              // compositionend so nothing is left behind and it sends on one Enter.
              pendingEnterRef.current = true
              return
            }
            e.preventDefault()
            submit()
          }}
          rows={1}
        />
        <div className="chat-actions">
          <select
            className="chat-chip"
            value={mode}
            onChange={(e) => {
              setMode(e.target.value)
              savePane({ mode: e.target.value })
              window.api.chat.setMode(chatKey, e.target.value)
            }}
          >
            {MODES.map(([v, label]) => (
              <option key={v} value={v}>
                {label}
              </option>
            ))}
          </select>
          <select
            className="chat-chip"
            value={pickedModel}
            onChange={(e) => applyModel(e.target.value)}
          >
            {MODELS.map((m) => (
              <option key={m} value={m}>
                {m === 'default'
                  ? 'default'
                  : model && modelAlias(model) === m
                    ? fmtModel(model)
                    : m}
              </option>
            ))}
          </select>
          <div className="chat-actions-spacer" />
          <button
            className={`chat-sched-btn${scheduleOpen ? ' on' : ''}${pendingSchedules.length ? ' has' : ''}`}
            onClick={() => setScheduleOpen((o) => !o)}
            title={t('chat.schedule.title')}
          >
            <Clock size={14} />
            {pendingSchedules.length > 0 && (
              <span className="chat-sched-count">{pendingSchedules.length}</span>
            )}
          </button>
          {busy ? (
            <button className="chat-send stop" onClick={stopTurn} title={t('chat.stop')}>
              <Square size={11} fill="currentColor" />
            </button>
          ) : (
            <button className="chat-send" onClick={submit} title={t('chat.send')}>
              <ArrowUp size={15} strokeWidth={2.5} />
            </button>
          )}
        </div>
        {scheduleOpen && (
          <SchedulePopover
            hasText={(input || inputRef.current?.value || '').trim().length > 0}
            repeat={schedRepeat}
            setRepeat={setSchedRepeat}
            onSchedule={doSchedule}
            pending={pendingSchedules}
            onCancel={(id) => useScheduled.getState().remove(id)}
            onClose={() => setScheduleOpen(false)}
          />
        )}
      </div>
    </div>
  )
}
