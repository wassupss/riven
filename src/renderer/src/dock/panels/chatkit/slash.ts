// The slash-command menu of a chat composer: labels for Claude Code's own
// commands, the starter list before a session reports its real one, and the
// commands riven answers with its own UI. Shared by the chat panes.

// Descriptions for the built-in slash commands (Claude Code's own set). The live
// list comes from the session's init `slash_commands`; this only labels the ones
// we recognise, unknown entries (user skills / MCP prompts) show name-only.
export const SLASH_DESC: Record<string, { ko: string; en: string }> = {
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
// headless session, commands that need an interactive terminal are excluded.
export const DEFAULT_SLASH = [
  'clear', 'compact', 'context', 'usage', 'model', 'agents',
  'list-agents', 'init', 'code-review', 'security-review', 'verify', 'doctor',
  'insights', 'recap', 'deep-research'
]
// Commands riven handles with its OWN native UI (the CLI's versions are
// interactive-terminal-only, so forwarding them headless does nothing). These are
// always offered and take precedence over any same-named CLI command.
export const NATIVE_SLASH = ['resume', 'mcp', 'model', 'config'] as const


/** The menu's commands: riven's own first, then the session's (deduped). */
export function menuCommands(session: string[], native: readonly string[] = NATIVE_SLASH): string[] {
  return [...native, ...session.filter((c) => !native.includes(c))]
}

/** The commands matching a bare "/query" input (no space yet), else []. */
export function slashMatches(input: string, commands: string[], max = 40): string[] {
  if (!/^\/[^\s]*$/.test(input)) return []
  const q = input.slice(1).toLowerCase()
  return commands.filter((c) => c.toLowerCase().startsWith(q)).slice(0, max)
}

/** A bare "/name" that riven answers itself, else null. */
export function nativeCommand(text: string, native: readonly string[] = NATIVE_SLASH): string | null {
  const cmd = text.trim().match(/^\/([\w-]+)$/)?.[1]
  return cmd && native.includes(cmd) ? cmd : null
}

/** A command's description in the UI language ('' for one riven does not know). */
export function slashDesc(name: string, lang: string): string {
  const d = SLASH_DESC[name]
  return d ? (lang === 'ko' ? d.ko : d.en) : ''
}

/**
 * "/model" with or without a name. The CLI chat never lets one through to
 * the CLI: Claude Code saves a /model pick as the person's global default.
 * undefined: not a /model command; null: bare; else the name asked for.
 */
export function modelCommand(text: string): string | null | undefined {
  const m = text.trim().match(/^\/model(?:\s+(\S.*))?$/)
  if (!m) return undefined
  return m[1]?.trim() || null
}
