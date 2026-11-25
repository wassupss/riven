// ---------------------------------------------------------------------------
// 펫 비서: a pet that is also a real Claude assistant. The config lives on the
// pet's save (PetSave.assistant, optional, so old saves need no migration);
// the session runs in riven's main window (state/petAssistants.ts) on the CLI
// chat engine (services/clichat), and the pet talks to it over a
// BroadcastChannel (lib/petAssistBus.ts).
//
// No leader: every pet that is an assistant does what its own settings say
// (role, model, workspaces, permission) and nothing else.
//
// Everything here is PURE (no window, no stores), so it is unit-tested and
// safe to import from the pet window.
// ---------------------------------------------------------------------------

export const ASSISTANT_VERSION = 1
/** The longest role text kept. */
export const ROLE_MAX = 2000

/**
 * How much the assistant may do without asking, as the CLI's
 * --permission-mode: plan (looks and proposes, changes nothing), default
 * (asks before each change), acceptEdits (edits files without asking, still
 * asks for commands).
 */
export type AssistantPermission = 'plan' | 'default' | 'acceptEdits'
export const ASSISTANT_PERMISSIONS: AssistantPermission[] = ['plan', 'default', 'acceptEdits']

export interface AssistantConfig {
  version: typeof ASSISTANT_VERSION
  /** Talking to it goes to Claude (else the keyword answers of petTalk). */
  on: boolean
  /** Free text: who it is and what it looks after. */
  role: string
  /** A model alias or pinned id the chat offers ('default': the account's). */
  model: string
  /** Every workspace riven has open, or only `workspaces`. */
  allWorkspaces: boolean
  /** Workspace ids (wids) it may act on when not all. */
  workspaces: string[]
  permission: AssistantPermission
}

export function defaultAssistant(): AssistantConfig {
  return {
    version: ASSISTANT_VERSION,
    on: true,
    role: '',
    model: 'default',
    allWorkspaces: true,
    workspaces: [],
    permission: 'default'
  }
}

const MODEL_RE = /^[A-Za-z0-9._:[\]-]{1,80}$/

/**
 * Read a saved assistant config defensively. Null when there is none (or it is
 * not an object): the pet is not an assistant. A picked list that ends up
 * empty means every workspace.
 */
export function sanitizeAssistant(raw: unknown): AssistantConfig | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  const d = defaultAssistant()
  const workspaces = Array.isArray(o.workspaces)
    ? [...new Set(o.workspaces.filter((w): w is string => typeof w === 'string' && w.trim().length > 0 && w.length <= 4096))].slice(0, 64)
    : []
  const model = typeof o.model === 'string' && MODEL_RE.test(o.model.trim()) ? o.model.trim() : d.model
  return {
    version: ASSISTANT_VERSION,
    on: o.on === true,
    role: typeof o.role === 'string' ? o.role.slice(0, ROLE_MAX) : '',
    model,
    allWorkspaces: o.allWorkspaces === false && workspaces.length > 0 ? false : true,
    workspaces,
    permission: ASSISTANT_PERMISSIONS.includes(o.permission as AssistantPermission)
      ? (o.permission as AssistantPermission)
      : d.permission
  }
}

/** Whether talking to this pet goes to Claude. */
export function isAssistant(cfg: AssistantConfig | null | undefined): cfg is AssistantConfig {
  return !!cfg && cfg.on
}

// ---- sessions ---------------------------------------------------------------

const KEY_PREFIX = 'petchat-'

/**
 * The CLI chat key a pet's assistant session runs under. Deliberately not
 * "chat-" / "clichat-": it is no dock pane (the Workbench and the MCP tools
 * tell panes by those prefixes).
 */
export function petChatKey(bornAt: number): string {
  return `${KEY_PREFIX}${Math.floor(bornAt)}`
}

export function isPetChatKey(key: string): boolean {
  return key.startsWith(KEY_PREFIX)
}

/** The pet a session key belongs to (its birthday), or null. */
export function bornAtOfKey(key: string): number | null {
  if (!isPetChatKey(key)) return null
  const n = Number(key.slice(KEY_PREFIX.length))
  return Number.isFinite(n) ? n : null
}

// A wid is a folder path, with "\x01<n>" for a second instance of it (see
// state/session pathOf; repeated here so this module stays store-free).
const WID_SEP = String.fromCharCode(1)
export function folderOf(wid: string): string {
  const i = wid.indexOf(WID_SEP)
  return i < 0 ? wid : wid.slice(0, i)
}

export interface Scope {
  /** The workspaces it may act on (wids), in the order given; all open ones for "all". */
  workspaces: string[]
  /**
   * Where its CLI runs: the one workspace's folder when it has exactly one,
   * else null (the caller uses riven's own folder for pet assistants: a
   * session spanning several workspaces belongs to none of them).
   */
  cwd: string | null
}

/** What a config covers, given the workspaces riven has open. */
export function resolveScope(cfg: AssistantConfig, open: readonly string[]): Scope {
  if (cfg.allWorkspaces || !cfg.workspaces.length) return { workspaces: [...open], cwd: null }
  const list = cfg.workspaces
  return { workspaces: [...list], cwd: list.length === 1 ? folderOf(list[0]) : null }
}

/**
 * The workspace a tool call of this pet acts on when the call names none
 * (opening a panel, a file, the browser): the one on screen if it is in
 * scope, else the first open one in scope. Null when none of them is open.
 */
export function actingWorkspace(cfg: AssistantConfig, active: string | null, open: readonly string[]): string | null {
  const inScope = (w: string): boolean => cfg.allWorkspaces || !cfg.workspaces.length || cfg.workspaces.includes(w)
  if (active && open.includes(active) && inScope(active)) return active
  return open.find(inScope) ?? null
}

/**
 * What the CLI is started with, as one comparable value: a change of any of
 * these needs a new process (the model and the permission mode can switch at
 * a turn boundary; the prompt and the folder only with a restart).
 */
export interface Launch {
  cwd: string
  prompt: string
  model: string
  permission: AssistantPermission
}

export type LaunchChange = 'none' | 'flags' | 'restart' | 'newSession'

/**
 * How to get from the running launch to the wanted one: nothing, a flags
 * switch (model/mode, at the turn boundary), a restart of the same
 * conversation (a new prompt), or a new conversation (another folder: the
 * CLI only resumes a session in the folder it was started in).
 */
export function launchChange(was: Launch | null, want: Launch): LaunchChange {
  if (!was) return 'none'
  if (was.cwd !== want.cwd) return 'newSession'
  if (was.prompt !== want.prompt) return 'restart'
  if (was.model !== want.model || was.permission !== want.permission) return 'flags'
  return 'none'
}

// ---- persona ------------------------------------------------------------------

export interface PersonaInput {
  name: string
  /** What kind of animal it is, in the keeper's language. */
  species: string
  role: string
  /** The workspaces in scope, as "name (folder)"; null for every workspace. */
  workspaces: string[] | null
}

/**
 * The system prompt appended for a pet assistant (with riven's own tool guide
 * and the keeper's global prompt before it). English, because the model reads
 * it; it answers in the language it is spoken to.
 */
export function personaPrompt(p: PersonaInput): string {
  const who = p.name.trim() ? `${p.name.trim()}, a ${p.species}` : `a ${p.species}`
  const lines = [
    '# riven pet assistant',
    `You are ${who}: a 리븐펫 (riven pet) that lives on the user's desktop next to riven, their IDE, and works for them as an assistant.`,
    'The user talks to you through the pet: your replies appear in a small speech balloon, so keep them short (one to three sentences) unless they ask for detail. Reply in the language the user writes in.',
    "Act through riven's tools (riven_*): riven_workspaces lists the open workspaces, riven_agents and riven_ask_agent reach the agents working in them, and the panel, browser, note, database and API tools act inside riven. Prefer them over guessing.",
    'You are one of the keeper\'s pets. There is no leader among the pets: do only what your role and the user ask of you.'
  ]
  const role = p.role.trim()
  if (role) lines.push('', '## Your role', role)
  lines.push('', '## Workspaces')
  if (!p.workspaces) lines.push('You may act in any workspace riven has open.')
  else if (!p.workspaces.length) lines.push('No workspace is assigned to you: answer, but do not change anything in a workspace.')
  else
    lines.push(
      'You may act ONLY in these workspaces; for anything in another one, say it is outside your scope:',
      ...p.workspaces.map((w) => `- ${w}`)
    )
  return lines.join('\n')
}

// ---- the balloon -------------------------------------------------------------------

/** A reply cut to what fits a balloon: prose only, one line, at most `max` characters. */
export function balloonText(reply: string, max = 140): string {
  const s = reply
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/[*_#>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s
}

// ---- the saved sessions ---------------------------------------------------------

/** A conversation the keeper set aside: it can be picked up again from the history. */
export interface PastChat {
  sessionId: string
  cwd: string
  /** Its first message, cut short ('' when it had none). */
  title: string
  /** When it was last talked in (ms). */
  at: number
}

/**
 * Each pet's conversations, by its pet's birthday. `sessionId`/`cwd` are the current
 * one (resumed on the next start); `past` is the history it was set aside from.
 */
export interface SavedSession {
  sessionId?: string
  /** The folder it runs in: the CLI resumes a session only there. */
  cwd?: string
  title?: string
  at?: number
  past?: PastChat[]
}
export type SavedSessions = Record<string, SavedSession>

/** How many set-aside conversations a pet keeps. */
export const MAX_PAST_CHATS = 30

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A set-aside conversation, read defensively (null when malformed). */
function sanitizePast(v: unknown): PastChat | null {
  if (!v || typeof v !== 'object') return null
  const e = v as Record<string, unknown>
  if (typeof e.sessionId !== 'string' || !UUID_RE.test(e.sessionId)) return null
  if (typeof e.cwd !== 'string' || !e.cwd.startsWith('/')) return null
  const at = typeof e.at === 'number' && Number.isFinite(e.at) ? e.at : 0
  const title = typeof e.title === 'string' ? e.title.slice(0, 200) : ''
  return { sessionId: e.sessionId, cwd: e.cwd, title, at }
}

/** pet-assistants.json read defensively: only well formed entries survive. */
export function sanitizeSessions(raw: unknown): SavedSessions {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null
  const pets = o?.pets && typeof o.pets === 'object' && !Array.isArray(o.pets) ? (o.pets as Record<string, unknown>) : {}
  const out: SavedSessions = {}
  for (const [k, v] of Object.entries(pets)) {
    if (!/^\d+$/.test(k) || !v || typeof v !== 'object') continue
    const e = v as Record<string, unknown>
    const past = Array.isArray(e.past)
      ? e.past.map(sanitizePast).filter((p): p is PastChat => p !== null).slice(0, MAX_PAST_CHATS)
      : []
    const current =
      typeof e.sessionId === 'string' && UUID_RE.test(e.sessionId) && typeof e.cwd === 'string' && e.cwd.startsWith('/')
        ? { sessionId: e.sessionId, cwd: e.cwd }
        : null
    if (!current && past.length === 0) continue
    const title = typeof e.title === 'string' ? e.title.slice(0, 200) : undefined
    const at = typeof e.at === 'number' && Number.isFinite(e.at) ? e.at : undefined
    out[k] = { ...(current ?? {}), ...(title !== undefined ? { title } : {}), ...(at !== undefined ? { at } : {}), ...(past.length ? { past } : {}) }
  }
  return out
}
