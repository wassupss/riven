import type { DockviewApi } from 'dockview'
import { t } from '../i18n'
import { isPaneBusy } from '../state/workspaceStatus'
import { focusPane, focusEditor } from '../keybindings/focus'
import { getSettings } from '../state/settings'
import { useSession, setPaneState, clearPaneState, widForPane, flushSessionSaveSync } from '../state/session'
import { splitPrimaryRight } from '../state/editorSplit'

// Confirm before closing a terminal whose agent is actively running (busy).
// Returns true when it's OK to proceed with the close.
export function confirmTerminalClose(panelId: string): boolean {
  if (!panelId.startsWith('term-')) return true
  const paneId = Number(panelId.slice('term-'.length))
  if (!Number.isFinite(paneId) || !isPaneBusy(paneId)) return true
  return window.confirm(t('term.closeBusyConfirm'))
}

// Points at the active workspace's dockview instance so global toolbar buttons
// and keybindings can add terminals / focus singleton panels.

let activeApi: DockviewApi | null = null
export function setActiveApi(api: DockviewApi | null): void {
  activeApi = api
}
export function getActiveApi(): DockviewApi | null {
  return activeApi
}

// Which workspace a dockview instance belongs to, so a tab header (which only has
// its containerApi) can resolve its own workspace — needed to store per-tab colour
// under the correct workspace (singleton panel ids like 'git' repeat per workspace).
const apiWorkspace = new WeakMap<DockviewApi, string>()
export function registerApiWorkspace(api: DockviewApi, wid: string): void {
  apiWorkspace.set(api, wid)
}
export function widForApi(api: DockviewApi | null | undefined): string | null {
  return (api && apiWorkspace.get(api)) ?? null
}

// Set a tab's colour override (any panel, not just chat). Persisted in the pane
// tree under the panel's workspace; a null/AVATAR_NONE spec clears/greys it.
export function setTabColor(wid: string, panelId: string, spec: string | null): void {
  setPaneState(wid, panelId, { avatar: spec })
  window.dispatchEvent(new CustomEvent('riven:chatavatar', { detail: panelId }))
}

// Pane ids (term-N / chat-N) double as GLOBAL localStorage keys (chatlog:, chatsession:,
// chatagent:, …) and main-process session keys. They must therefore be unique across
// EVERY pane, every workspace, and every restart — otherwise a new pane inherits a dead
// pane's transcript/session (e.g. an agent-group member showing a pipeline stage's
// content). So the counter is PERSISTED and only ever grows; ids are never reused.
const SEQ_KEY = 'paneSeq:v1'
let seq = (() => {
  try {
    const n = Number(localStorage.getItem(SEQ_KEY))
    if (Number.isFinite(n) && n >= 1) return n
    // First run under the persisted scheme: seed the counter ABOVE every id that
    // already has persisted state (chatlog:/chatsession:/… keys), so a fresh pane
    // can never be handed an id whose old transcript/session is still around.
    let max = 0
    for (let i = 0; i < localStorage.length; i++) {
      const m = /(?:term|chat)-(\d+)/.exec(localStorage.key(i) || '')
      if (m) max = Math.max(max, Number(m[1]))
    }
    return max + 1
  } catch {
    return 1
  }
})()
function persistSeq(): void {
  try {
    localStorage.setItem(SEQ_KEY, String(seq))
  } catch {
    /* ignore */
  }
}
export function nextPaneId(): number {
  const n = seq++
  persistSeq()
  return n
}

// First-message text for a freshly created chat pane, delivered ONE-SHOT so it is
// never serialized into the dock layout (which caused the priming message to be
// re-sent on every restart). ChatPanel consumes+clears it on mount.
const pendingInitial = new Map<string, string>()
export function takeInitialText(chatKey: string): string | undefined {
  const v = pendingInitial.get(chatKey)
  if (v !== undefined) pendingInitial.delete(chatKey)
  return v
}
// Guard against a restored/imported layout whose ids are >= the current counter
// (e.g. paneSeq was cleared but layouts survived, or a layout came from elsewhere).
export function bumpPaneSeq(ids: string[]): void {
  let changed = false
  for (const id of ids) {
    const m = /(?:term|chat)-(\d+)/.exec(id)
    if (m && Number(m[1]) + 1 > seq) {
      seq = Number(m[1]) + 1
      changed = true
    }
  }
  if (changed) persistSeq()
}

// Open a native agent-chat panel. Its id doubles as the chat session key.
// `initialText` (e.g. code sent to the LLM) is delivered as the first message.
export type SplitDir = 'right' | 'below' | 'left' | 'above' | 'within'
// Placement relative to a reference panel (an explicit id, else the active panel);
// defaults to a right-split like native.
function placement(
  api: DockviewApi,
  dir?: SplitDir,
  refId?: string
): { referencePanel: string; direction: SplitDir } | undefined {
  const ref = (refId && api.getPanel(refId)) || api.activePanel
  if (!ref) return undefined
  return { referencePanel: ref.id, direction: dir ?? 'right' }
}

// The chat pane whose turn is currently running — the "delegator". A spawned
// teammate (group_add_agent / pipeline) opens BESIDE this pane, not wherever the
// dock focus happens to be.
let delegator: string | null = null
export function setDelegator(chatKey: string | null): void {
  delegator = chatKey
}
export function getDelegator(): string | null {
  return delegator && activeApi?.getPanel(delegator) ? delegator : null
}

export function addChat(
  initialText?: string,
  dir?: SplitDir,
  model?: string,
  refId?: string,
  title?: string,
  // When true the pane opens WITHOUT stealing focus. Agent-driven spawns (team
  // creation, pipeline stages, delegation) pass this so the user's current pane
  // keeps focus — only a user directly creating a single pane should move focus.
  inactive?: boolean,
  // A custom agent (.claude/agents/<name>.md) to run this pane as `claude --agent`.
  agent?: string,
  // Role/persona sent as a SYSTEM prompt at spawn (never as a chat turn).
  persona?: string
): string {
  const api = activeApi
  if (!api) return ''
  const id = `chat-${nextPaneId()}`
  const wid = useSession.getState().activeWorkspace
  // A freshly minted pane MUST start empty. chatKeys are globally unique now, but
  // clear defensively, then seed the pane's model/title/agent into the workspace
  // tree (single source of truth) so ChatPanel reads them on mount.
  if (wid) {
    clearPaneState(wid, id)
    setPaneState(wid, id, {
      model: model && model !== 'default' ? model : undefined,
      title: title || undefined,
      agent: agent || undefined,
      persona: persona || undefined
    })
    flushSessionSaveSync() // durable immediately (survives quit/reload races)
  }
  // "inactive" = don't end up focused. We do NOT use dockview's `inactive` add
  // option for this: a panel added inactive is lazily rendered (its content stays
  // blank until first activated). Instead add it ACTIVE (so it renders eagerly),
  // then restore focus to whatever pane was active before. Net: content is live
  // AND the user's pane keeps focus. (ChatPanel's focus timers re-check isActive,
  // so the brief activation doesn't yank the caret into the new pane.)
  const prevActive = inactive ? api.activePanel?.id : undefined
  // initialText is delivered one-shot (not via params) so it never gets serialized
  // into the layout and re-sent on restart.
  if (initialText) pendingInitial.set(id, initialText)
  api.addPanel({
    id,
    component: 'chat',
    title: title || t('title.chat'), // else updated to the conversation's short title
    params: { chatKey: id, pinnedTitle: title || undefined, agent: agent || undefined },
    renderer: 'always',
    position: placement(api, dir, refId)
  })
  if (prevActive && prevActive !== id) api.getPanel(prevActive)?.api.setActive()
  return id
}

// Rename a live chat pane's tab (agent-group edit) and re-pin the title so it
// survives a reload and never gets clobbered by an auto-generated title.
export function setChatTitle(chatKey: string, title: string): void {
  const wid = widForPane(chatKey)
  if (wid) setPaneState(wid, chatKey, { title })
  activeApi?.getPanel(chatKey)?.api.setTitle(title)
}

// Set/clear a chat pane's avatar override ("glyph.color"). The tab reads this on
// a 'riven:chatavatar' event so its icon updates live.
export function setChatAvatar(chatKey: string, spec: string | null): void {
  const wid = widForPane(chatKey)
  if (wid) setPaneState(wid, chatKey, { avatar: spec })
  window.dispatchEvent(new CustomEvent('riven:chatavatar', { detail: chatKey }))
}

// Open a new chat pane running a custom agent (.claude/agents/<name>.md). Titled
// by the agent name so the tab shows which agent it is; opens active since this is
// a direct user action.
export function openAgentChat(agent: string): string {
  return addChat(undefined, undefined, undefined, undefined, agent, false, agent)
}

// A single entry for launching an AI agent so every path (agent picker, quick
// panel profiles) behaves the SAME: native chat when enabled + the CLI has a
// native driver (Claude), otherwise a terminal running the command. This removes
// the "sometimes CLI, sometimes chat" inconsistency.
export function isNativeChatAgent(command: string): boolean {
  return /^claude(\s|$)/.test(command.trim())
}
export function launchAgent(command: string, initialText?: string): void {
  if (getSettings().agentChatUI && isNativeChatAgent(command)) addChat(initialText)
  else addTerminal(command)
}

export function addTerminal(initialCommand?: string, dir?: SplitDir, refId?: string): void {
  const api = activeApi
  if (!api) return
  const paneId = nextPaneId()
  api.addPanel({
    id: `term-${paneId}`,
    component: 'terminal',
    title: initialCommand ? `❯ ${initialCommand}` : `❯ ${t('title.terminal')}`,
    params: { paneId, initialCommand },
    renderer: 'always',
    position: dir ? placement(api, dir, refId) : undefined
  })
}

// Open ANY panel kind, optionally as a split beside the active panel. This is the
// single entry point the split picker (⌘D / ⌘⇧D) uses, so every panel — not just
// terminals — can be split. Singleton panels focus if already open.
export type NamedPanel =
  | 'terminal'
  | 'chat'
  | 'editor'
  | 'search'
  | 'git'
  | 'changes'
  | 'preview'
  | 'notes'
  | 'api'
  | 'agentgroup'
export function openNamedPanel(id: NamedPanel, dir?: SplitDir, refId?: string): void {
  const api = activeApi
  if (!api) return
  if (id === 'terminal') return addTerminal(undefined, dir, refId)
  if (id === 'chat') {
    addChat(undefined, dir, undefined, refId)
    return
  }
  const existing = api.getPanel(id)
  if (existing) {
    existing.api.setActive()
    return
  }
  const cfg = SINGLETONS[id]
  api.addPanel({
    id,
    component: id,
    title: t(cfg.titleKey),
    renderer: 'always',
    position: dir ? placement(api, dir, refId) : { direction: cfg.direction }
  })
}

// A "launcher" pane: an empty panel showing a picker of what to open. Used as the
// first panel of a new workspace and for ⌘D / ⌘⇧D splits — the panel appears
// first, then the user chooses its contents (instead of defaulting to a terminal).
export function openLauncher(dir?: SplitDir): string {
  const api = activeApi
  if (!api) return ''
  const id = `launcher-${nextPaneId()}`
  api.addPanel({
    id,
    component: 'launcher',
    title: t('title.launcher'),
    renderer: 'always',
    position: dir ? placement(api, dir) : undefined
  })
  return id
}

// The launcher's choice: open the picked kind IN the launcher's group, then remove
// the launcher so the new panel takes its place.
export function pickInLauncher(launcherId: string, kind: NamedPanel): void {
  const api = activeApi
  if (!api) return
  openNamedPanel(kind, 'within', launcherId)
  const l = api.getPanel(launcherId)
  if (l) api.removePanel(l)
}

// Open a custom agent (.claude/agents) chat inside a launcher, replacing it.
export function pickAgentInLauncher(launcherId: string, agent: string): void {
  const api = activeApi
  if (!api) return
  addChat(undefined, 'within', undefined, launcherId, agent, false, agent)
  const l = api.getPanel(launcherId)
  if (l) api.removePanel(l)
}

// Launch a detected AI CLI (Claude Code, Codex, …) inside a launcher: native chat
// when it has a driver (Claude) + the setting is on, else a terminal running it.
export function pickCliInLauncher(launcherId: string, cmd: string): void {
  const api = activeApi
  if (!api) return
  if (getSettings().agentChatUI && isNativeChatAgent(cmd)) {
    addChat(undefined, 'within', undefined, launcherId)
  } else {
    addTerminal(cmd, 'within', launcherId)
  }
  const l = api.getPanel(launcherId)
  if (l) api.removePanel(l)
}

// Split: add a terminal beside/below the active panel (cmux-style pane splits).
export function splitTerminal(direction: 'right' | 'below'): void {
  const api = activeApi
  if (!api) return
  const paneId = nextPaneId()
  const ref = api.activePanel
  api.addPanel({
    id: `term-${paneId}`,
    component: 'terminal',
    title: '❯ 터미널',
    params: { paneId },
    renderer: 'always',
    position: ref ? { referencePanel: ref.id, direction } : undefined
  })
}

// Cycle tabs within the active group (next/prev terminal tab).
export function cycleGroupTab(delta: number): void {
  const api = activeApi
  const group = api?.activeGroup
  if (!api || !group) return
  const panels = group.panels
  if (panels.length < 2) return
  const i = panels.findIndex((p) => p.id === group.activePanel?.id)
  const next = panels[(((i < 0 ? 0 : i) + delta) % panels.length + panels.length) % panels.length]
  next.api.setActive()
}

// Focus the nth terminal (1-based) in the active workspace.
export function selectTerminal(n: number): void {
  const api = activeApi
  if (!api) return
  const terms = api.panels.filter((p) => p.id.startsWith('term-'))
  terms[n - 1]?.api.setActive()
}

// Select the Nth tab in the ACTIVE dock group (any panel kind) — VS Code-style
// Ctrl+1..9 tab switching, works regardless of which panel is focused.
export function selectPanelInGroup(n: number): void {
  const api = activeApi
  if (!api) return
  const group = api.activeGroup ?? api.groups[0]
  group?.panels[n - 1]?.api.setActive()
}

export type FocusDir = 'left' | 'right' | 'up' | 'down'

// Move focus to the split group spatially adjacent to the active one, in the
// given direction (Ctrl+Cmd+Arrow). Uses the groups' on-screen rects so it's
// truly directional (unlike cyclePanel's flat next/prev), matching how tiling
// window managers navigate splits.
export function focusGroupInDirection(dir: FocusDir): void {
  const api = activeApi
  if (!api) return
  const groups = api.groups
  if (groups.length < 2) return
  const active = api.activeGroup ?? groups[0]
  const from = active.element.getBoundingClientRect()
  const fx = from.left + from.width / 2
  const fy = from.top + from.height / 2
  const horizontal = dir === 'left' || dir === 'right'
  const sign = dir === 'left' || dir === 'up' ? -1 : 1

  let best: { g: (typeof groups)[number]; score: number } | null = null
  for (const g of groups) {
    if (g === active) continue
    const r = g.element.getBoundingClientRect()
    const cx = r.left + r.width / 2
    const cy = r.top + r.height / 2
    // Primary axis: how far in the requested direction; must be a real step.
    const primary = (horizontal ? cx - fx : cy - fy) * sign
    if (primary < 1) continue
    // Cross axis: penalize groups offset perpendicular to the direction so we
    // prefer the neighbor most directly in line with the current group.
    const cross = Math.abs(horizontal ? cy - fy : cx - fx)
    const score = primary + cross * 2
    if (!best || score < best.score) best = { g, score }
  }
  const target = best?.g
  const panel = target?.activePanel
  if (!panel) return
  // Activate the tab, then route to the real focuser so the caret actually
  // lands there — dockview's panel.focus() only calls setActive(), which shows
  // the pane but leaves keyboard focus in the group you came from.
  panel.api.setActive()
  if (panel.id.startsWith('term-')) {
    const paneId = Number(panel.id.slice('term-'.length))
    if (Number.isFinite(paneId)) focusPane(paneId)
  } else if (panel.id === 'editor') {
    focusEditor()
  } else {
    panel.focus()
  }
}

// Cycle the active dockview panel (keyboard navigation across the grid).
export function cyclePanel(delta: number): void {
  const api = activeApi
  if (!api) return
  const panels = api.panels
  if (panels.length < 2) return
  const i = panels.findIndex((p) => p.id === api.activePanel?.id)
  const next = panels[(((i < 0 ? 0 : i) + delta) % panels.length + panels.length) % panels.length]
  next.api.setActive()
}

// Pop the active panel's group out into a separate OS window (useful when the
// screen is cramped or on a second monitor).
export function popoutActive(): void {
  const api = activeApi
  const panel = api?.activePanel
  if (!api || !panel) return
  try {
    api.addPopoutGroup(panel.group)
  } catch (e) {
    console.error('[dock] popout failed', e)
  }
}

// Ensure the editor panel exists (opened when a file is selected).
export function ensureEditor(): void {
  const api = activeApi
  if (!api) return
  const existing = api.getPanel('editor')
  if (existing) {
    existing.api.setActive()
    return
  }
  const term = api.panels.find((p) => p.id.startsWith('term-'))
  api.addPanel({
    id: 'editor',
    component: 'editor',
    title: t('title.editor'),
    renderer: 'always',
    position: term ? { referencePanel: term.id, direction: 'right' } : undefined
  })
}

// Split the editor (VS Code-style): open `path` in a SECOND editor group that
// renders side-by-side INSIDE the editor panel. With no path, splits the primary
// group's current file. Also makes sure the editor panel is open.
export function openEditorSplit(path?: string): void {
  const api = activeApi
  const ws = useSession.getState().activeWorkspace
  if (!api || !ws) return
  const file = path ?? useSession.getState().sessions[ws]?.activePath
  if (!file) return
  splitPrimaryRight(ws, file)
  if (!api.getPanel('editor')) ensureEditor()
  else api.getPanel('editor')?.api.setActive()
}

// Auto-open the changes timeline when an agent edit arrives (idempotent). Opens
// it on the left WITHOUT stealing focus from the terminal the user is typing in,
// so agent activity surfaces the summary without hijacking the cursor.
const CHANGES_WIDTH = 240

export function ensureChanges(): void {
  const api = activeApi
  if (!api) return
  const existing = api.getPanel('changes')
  if (existing) {
    // Already open (e.g. restored from a saved layout at a stale wide size) —
    // keep it pinned narrow.
    existing.group.api.setSize({ width: CHANGES_WIDTH })
    return
  }
  const prev = api.activePanel
  const panel = api.addPanel({
    id: 'changes',
    component: 'changes',
    title: t('title.changes'),
    renderer: 'always',
    // Open on the far right at a sidebar width — the Changes timeline is a narrow
    // summary list, not a half-split. (initialWidth alone is sometimes ignored on
    // a directional split, so also pin the group size explicitly.)
    initialWidth: CHANGES_WIDTH,
    position: { direction: 'right' }
  })
  panel.group.api.setSize({ width: CHANGES_WIDTH })
  prev?.api.setActive()
}

const SINGLETONS: Record<string, { titleKey: string; direction: 'left' | 'right' | 'below' }> = {
  editor: { titleKey: 'title.editor', direction: 'right' },
  preview: { titleKey: 'title.preview', direction: 'right' },
  search: { titleKey: 'title.search', direction: 'left' },
  git: { titleKey: 'title.git', direction: 'left' },
  changes: { titleKey: 'title.changes', direction: 'right' },
  notes: { titleKey: 'title.notes', direction: 'right' },
  api: { titleKey: 'title.api', direction: 'right' },
  agentgroup: { titleKey: 'title.agentgroup', direction: 'right' }
}

// Close a terminal panel by its pane id (used by the focus-aware ⌘W handler).
export function closeTerminalById(paneId: number): void {
  const api = activeApi
  if (!api) return
  const panel = api.getPanel(`term-${paneId}`)
  if (panel) api.removePanel(panel)
}

export function togglePanel(id: keyof typeof SINGLETONS): void {
  const api = activeApi
  if (!api) return
  const existing = api.getPanel(id)
  if (existing) {
    existing.api.setActive()
  } else {
    const cfg = SINGLETONS[id]
    // Open as a TAB in the focused panel's group (⌘O adds beside what you're
    // looking at). Only when nothing is focused do we fall back to the panel's
    // default edge, which is also what a brand-new workspace gets.
    const ref = api.activePanel?.id
    api.addPanel({
      id,
      component: id,
      title: t(cfg.titleKey),
      renderer: 'always',
      position: ref
        ? { referencePanel: ref, direction: 'within' }
        : { direction: cfg.direction }
    })
  }
}
