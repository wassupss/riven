import { useSession, pathOf, widForPane } from './session'
import { useNav } from './nav'
import { useAskUser } from './askUser'
import { useBrowser, activeTab, activeTabId } from './browser'
import { listAgents, resolveAgent } from './agents'
import { contextBus } from '../bridge/contextBus'
import {
  ensureEditorIn,
  addTerminal,
  addChat,
  togglePanel,
  getApiFor
} from '../dock/registry'

// Executes a riven MCP tool call forwarded from the main process and returns a
// result string. UI actions run against the active workspace's dock. Mirrors the
// native ChatAskServer dispatch (main.swift), scoped to what the port supports.

// Implemented riven MCP tools with labels, for the settings toggle list. Keep in
// sync with MCP_TOOLS (implemented: true) in src/main/mcpServer.ts.
export const MCP_TOOL_LABELS: Array<{ name: string; ko: string; en: string }> = [
  { name: 'ask_user', ko: '답변 선택 팝업', en: 'Ask-user popup' },
  { name: 'riven_open_file', ko: '에디터에 파일 열기', en: 'Open file in editor' },
  { name: 'riven_panels', ko: '패널 목록', en: 'List panels' },
  { name: 'riven_open_panel', ko: '패널 열기', en: 'Open panel' },
  { name: 'riven_close_panel', ko: '패널 닫기', en: 'Close panel' },
  { name: 'riven_workspaces', ko: '워크스페이스 목록', en: 'List workspaces' },
  { name: 'riven_open_workspace', ko: '워크스페이스 열기', en: 'Open workspace' },
  { name: 'riven_api_request', ko: 'HTTP 요청 실행', en: 'HTTP request' },
  { name: 'riven_open_browser', ko: '브라우저에 URL 열기', en: 'Open URL in browser' },
  { name: 'riven_screenshot', ko: '브라우저 스크린샷', en: 'Browser screenshot' },
  { name: 'riven_browser_open', ko: '브라우저: 열기', en: 'Browser: open' },
  { name: 'riven_browser_tab', ko: '브라우저: 탭 전환/닫기', en: 'Browser: tabs' },
  { name: 'riven_browser_state', ko: '브라우저: 상태 읽기', en: 'Browser: state' },
  { name: 'riven_browser_go', ko: '브라우저: 뒤로/앞으로/새로고침', en: 'Browser: navigate' },
  { name: 'riven_browser_read', ko: '브라우저: 페이지 내용 읽기', en: 'Browser: read page' },
  { name: 'riven_browser_click', ko: '브라우저: 클릭', en: 'Browser: click' },
  { name: 'riven_browser_fill', ko: '브라우저: 입력/제출', en: 'Browser: fill' },
  { name: 'riven_browser_wait', ko: '브라우저: 대기', en: 'Browser: wait' },
  { name: 'riven_browser_scroll', ko: '브라우저: 스크롤', en: 'Browser: scroll' },
  { name: 'riven_browser_eval', ko: '브라우저: JS 실행', en: 'Browser: eval JS' },
  { name: 'riven_agents', ko: '에이전트 목록', en: 'List agents' },
  { name: 'riven_ask_agent', ko: '에이전트에 위임', en: 'Delegate to an agent' },
  { name: 'riven_ask_agents', ko: '여러 에이전트에 위임', en: 'Delegate to agents' },
  { name: 'riven_group_add_agent', ko: '그룹에 에이전트 추가', en: 'Add agent to group' },
  { name: 'riven_group_remove_agent', ko: '그룹에서 제거', en: 'Remove agent' },
  { name: 'riven_group_delete', ko: '그룹 삭제', en: 'Delete group' },
  { name: 'riven_start_pipeline', ko: '파이프라인 실행', en: 'Start pipeline' },
  { name: 'riven_note_list', ko: '메모 목록', en: 'List notes' },
  { name: 'riven_note_read', ko: '메모 읽기', en: 'Read note' },
  { name: 'riven_note_write', ko: '메모 쓰기', en: 'Write note' },
  { name: 'riven_note_append', ko: '메모 이어쓰기', en: 'Append note' },
  { name: 'riven_doc_write', ko: '문서(.md) 쓰기', en: 'Write doc' },
  { name: 'riven_note_save_file', ko: '메모를 파일로 저장', en: 'Save note to file' }
]

// EVERY tool acts on the workspace of the agent that called it, never on the one
// the user happens to be looking at.
//
// The attribution is resolved ONCE, synchronously, when the call arrives, and
// then carried explicitly as `Ctx` through every helper. It used to live in a
// module-level "current caller" that helpers re-read on demand — which held only
// until the first `await`. Any tool that resolved its workspace after awaiting
// (browserOpen/browserGo re-reading state for their reply, and worst of all
// group_remove_agent / group_delete resolving their dock AFTER a confirmation
// the human might sit on for minutes) would pick up whichever agent had called
// in since, and act on that workspace instead. group_delete closing every chat
// pane in an unrelated workspace was the sharpest edge of it.
interface Caller {
  key: string | null // the chat pane the agent IS (RIVEN_CHAT_KEY), when riven spawned it
  cwd: string | null // the directory it runs in, used when there is no key
  // Register a callback for "the agent hung up". Only blocking tools need it.
  onCancel?: (fn: () => void) => void
}

interface Ctx {
  // The calling pane, ONLY if it is still open, and ONLY if it is a chat pane.
  chatPane: string | null
  // The calling pane whatever its kind (chat or terminal), for attribution.
  pane: string | null
  // The workspace that owns this call; null when it cannot be established.
  ws: string | null
  cwd: string | null
  onCancel?: (fn: () => void) => void
}

// The pane the call came from, if it is still open. Unlike getDelegator() this
// does not care which workspace is on screen: the key came with the call itself.
function livePane(key: string | null): string | null {
  if (!key) return null
  const st = useSession.getState()
  for (const s of Object.values(st.sessions)) if (s.panes?.[key]) return key
  return null
}

// Resolve a call's workspace. There is deliberately NO fallback to the active
// workspace. That fallback is what made a background agent's browser tab, file
// or panel appear in whatever workspace the user was looking at: attribution
// failed silently and the visible workspace absorbed the action. Null is the
// honest answer, and the tools below report it instead of acting on the wrong
// workspace.
function resolveCtx(caller: Caller): Ctx {
  const pane = livePane(caller.key)
  // Only a chat pane can host a blocking prompt or receive a delegation. A pane
  // key that is a TERMINAL must not be treated as one: `panes` holds any pane the
  // user has customised (colouring a terminal tab puts term-N in it), so a
  // "is it in panes" test alone let ask_user queue against a terminal, where
  // nothing renders it and the call simply blocked until it timed out.
  const chatPane = pane && pane.startsWith('chat-') ? pane : null
  const ws = ((): string | null => {
    // widForPane falls back to the active workspace for an unknown pane; go
    // direct so attribution can fail honestly instead of hitting the screen.
    if (pane) {
      const st = useSession.getState()
      for (const [wid, s] of Object.entries(st.sessions)) if (s.panes?.[pane]) return wid
    }
    // A CLI typed into a riven terminal: its key names the terminal pane, whose
    // sink knows the workspace. Beats cwd — the user may have cd'd anywhere.
    const term = caller.key?.match(/^term-(\d+)$/)
    if (term) {
      const w = contextBus.workspaceOfPane(Number(term[1]))
      if (w) return w
    }
    // No pane (a terminal agent, or a CLI riven did not spawn): attribute by the
    // directory it runs in. riven always spawns an agent with cwd = its workspace,
    // so this covers everything the key doesn't.
    const cwd = caller.cwd
    if (!cwd) return null
    const open = useSession.getState().openWorkspaces
    const exact = open.find((w) => pathOf(w) === cwd)
    if (exact) return exact
    // A subdirectory of an open workspace still belongs to it; prefer the deepest
    // match so nested workspaces resolve to the closest one.
    const inside = open
      .filter((w) => cwd.startsWith(pathOf(w).replace(/\/?$/, '/')))
      .sort((a, b) => pathOf(b).length - pathOf(a).length)
    return inside[0] ?? null
  })()
  return { chatPane, pane, ws, cwd: caller.cwd }
}

// Message used whenever a UI action cannot be attributed to a workspace. Naming
// the cwd makes the fix obvious (open that folder as a workspace).
function unattributed(c: Ctx): string {
  return `error: riven could not tell which workspace this call belongs to (cwd: ${c.cwd ?? 'unknown'}), so it refused to act on the one on screen. Run the agent from a riven chat pane, or from a directory inside an open workspace.`
}
// The caller's dock. Null when that workspace isn't mounted right now (LRU), in
// which case dock-manipulating tools report it instead of acting on the wrong one.
function callerApi(c: Ctx): ReturnType<typeof getApiFor> {
  return getApiFor(c.ws)
}

type Args = Record<string, unknown>
const s = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v))

async function askUser(args: Args, c: Ctx): Promise<string> {
  const question = s(args.question)
  const options = Array.isArray(args.options) ? (args.options as unknown[]).map(s) : []
  if (!options.length) return 'error: options is required'
  // A blocking prompt may ONLY appear in the conversation that asked it. If the
  // caller is not a riven chat pane there is nowhere it can render without
  // interrupting an unrelated workspace, so refuse rather than guess: the agent
  // asks in plain text instead.
  const pane = c.chatPane
  if (!pane)
    return 'riven: ask_user is only available to riven chat panes. Ask your question in plain text, listing the options, and let the user reply normally.'
  return new Promise<string>((resolve) => {
    const id = Math.random().toString(36).slice(2)
    useAskUser.getState().enqueue({ id, chatKey: pane, question, options, resolve })
    // If the agent gives up first, the prompt must stop pretending it can still
    // be answered — the click would go nowhere.
    c.onCancel?.(() => useAskUser.getState().expire(id))
  })
}

function openFile(args: Args, c: Ctx): string {
  const p = s(args.path)
  if (!p) return 'error: path is required'
  const ws = c.ws
  if (!ws) return unattributed(c)
  // Open the tab and the editor panel in the CALLER's workspace. Previously both
  // went to the active workspace, so a background agent's file opened on top of
  // whatever the user was doing.
  useSession.getState().openFileIn(ws, p)
  ensureEditorIn(getApiFor(ws))
  const line = typeof args.line === 'number' ? args.line : undefined
  if (line) useNav.getState().requestReveal(p, line, 1)
  return `opened ${p}${line ? `:${line}` : ''} in ${pathOf(ws)}`
}

function listPanels(c: Ctx): string {
  const api = callerApi(c)
  if (!api) return 'no panels'
  const panels = api.panels.map((p) => ({
    id: p.id,
    kind: (p as { component?: string }).component ?? p.id.replace(/-\d+$/, ''),
    title: p.title
  }))
  return JSON.stringify(panels)
}

const PANEL_KINDS = new Set(['editor', 'search', 'git', 'changes', 'preview', 'notes', 'api'])
function openPanel(args: Args, c: Ctx): string {
  const kind = s(args.kind)
  // Every open names the caller's workspace. Without it these three went to the
  // dock on screen, so a background agent's terminal/chat/panel appeared on top
  // of whatever the user was doing in a different workspace.
  const ws = c.ws
  if (!ws) return unattributed(c)
  if (!callerApi(c)) return notMounted(c)
  if (kind === 'terminal') {
    addTerminal(undefined, undefined, undefined, ws)
    return 'opened terminal'
  }
  if (kind === 'chat') {
    addChat(undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, ws)
    return 'opened chat'
  }
  if (PANEL_KINDS.has(kind)) {
    togglePanel(kind as 'editor' | 'search' | 'git' | 'changes' | 'preview' | 'notes' | 'api', ws)
    return `opened ${kind}`
  }
  return `error: unknown panel kind "${kind}"`
}

// The caller's workspace is known but isn't mounted right now (the mounted set is
// LRU-bounded), so its dock cannot be manipulated. Say so rather than acting on
// the mounted one.
function notMounted(c: Ctx): string {
  return `error: workspace ${c.ws ? pathOf(c.ws) : '?'} is not currently mounted in riven, so its panels can't be changed. Switch to it and try again.`
}

// ---- notes / docs tools ----
function notesChanged(): void {
  window.dispatchEvent(new Event('riven:notes-changed'))
}
async function noteList(c: Ctx): Promise<string> {
  const ws = c.ws
  if (!ws) return unattributed(c)
  const list = await window.api.notes.list(pathOf(ws))
  return JSON.stringify(list.map((n) => ({ note: n.name, title: n.title })))
}
async function noteRead(args: Args, c: Ctx): Promise<string> {
  const ws = c.ws
  if (!ws) return unattributed(c)
  const content = await window.api.notes.read(pathOf(ws), s(args.note))
  return content ?? 'error: note not found'
}
async function noteWrite(args: Args, c: Ctx): Promise<string> {
  const ws = c.ws
  if (!ws) return unattributed(c)
  const name = await window.api.notes.write(
    pathOf(ws),
    args.note ? s(args.note) : null,
    s(args.title),
    s(args.body)
  )
  togglePanel('notes', ws)
  notesChanged()
  return `wrote note "${name}"`
}
async function noteAppend(args: Args, c: Ctx): Promise<string> {
  const ws = c.ws
  if (!ws) return unattributed(c)
  const name = await window.api.notes.append(pathOf(ws), s(args.note), s(args.body))
  if (!name) return 'error: note not found'
  notesChanged()
  return `appended to "${name}"`
}
async function docWrite(args: Args, c: Ctx): Promise<string> {
  const ws = c.ws
  if (!ws) return unattributed(c)
  const res = await window.api.notes.writeFile(pathOf(ws), s(args.path), s(args.body), !!args.overwrite)
  if (!res.ok) return `error: ${res.error}`
  if (res.path) {
    // Show the written doc in the CALLER's workspace, not the visible one.
    useSession.getState().openFileIn(ws, res.path)
    ensureEditorIn(getApiFor(ws))
  }
  return `wrote ${res.path}`
}
async function noteSaveFile(args: Args, c: Ctx): Promise<string> {
  const ws = c.ws
  if (!ws) return unattributed(c)
  const res = await window.api.notes.saveToFile(
    pathOf(ws),
    s(args.note),
    s(args.path),
    !!args.overwrite
  )
  return res.ok ? `saved to ${res.path}` : `error: ${res.error}`
}

function closePanel(args: Args, c: Ctx): string {
  const id = s(args.id)
  const api = callerApi(c)
  if (!api) return c.ws ? notMounted(c) : unattributed(c)
  const panel = api.getPanel(id)
  if (!panel) return `error: no panel with id "${id}"`
  api.removePanel(panel)
  return `closed ${id}`
}

function listWorkspaces(): string {
  const st = useSession.getState()
  const list = st.openWorkspaces.map((wid) => ({
    path: pathOf(wid),
    active: wid === st.activeWorkspace
  }))
  return JSON.stringify(list)
}

function openWorkspace(args: Args): string {
  const p = s(args.path)
  if (!p) return 'error: path is required'
  useSession.getState().openWorkspace(p)
  return `opened workspace ${p}`
}

// ---- browser tools (riven_browser_*) ----
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const clip = (v: unknown): string => {
  const str = typeof v === 'string' ? v : JSON.stringify(v)
  return str && str.length > 8000 ? str.slice(0, 8000) + '\n… (truncated)' : (str ?? '')
}

// Ensure the active workspace has an open browser panel with a ready tab, and
// return its tab id. (v1 drives the active workspace's browser.)
async function ensureBrowser(c: Ctx, url?: string): Promise<{ ws: string; tabId: string } | string> {
  const ws = c.ws
  if (!ws) return unattributed(c)
  const api = callerApi(c)
  // Check AND open in the caller's dock. These disagreed: the check asked the
  // caller's dock whether it had a preview panel, then opened one in the dock on
  // screen — so a background agent's browsing surfaced in the visible workspace.
  if (api && !api.getPanel('preview')) togglePanel('preview', ws)
  useBrowser.getState().ensureWs(ws)
  const cur = useBrowser.getState().byWs[ws]
  if (!cur || cur.tabs.length === 0) {
    useBrowser.getState().newTab(ws, url ?? 'about:blank')
  } else if (url) {
    useBrowser.getState().navigate(ws, url)
  }
  for (let i = 0; i < 80; i++) {
    const id = activeTabId(ws)
    if (id) {
      // small settle so the WebContentsView exists before we drive it
      if (i === 0) await sleep(120)
      return { ws, tabId: id }
    }
    await sleep(50)
  }
  return 'error: browser did not become ready'
}

async function browserEval(code: string, c: Ctx): Promise<string> {
  const b = await ensureBrowser(c)
  if (typeof b === 'string') return b
  return clip(await window.api.browser.execJs(b.tabId, code))
}

function browserStateText(c: Ctx): string {
  const ws = c.ws
  if (!ws) return unattributed(c)
  const cur = useBrowser.getState().byWs[ws]
  const tab = activeTab(ws)
  return JSON.stringify({
    url: tab?.url ?? null,
    title: tab?.title ?? null,
    loading: tab?.loading ?? false,
    canGoBack: tab?.canBack ?? false,
    canGoForward: tab?.canForward ?? false,
    tabs: (cur?.tabs ?? []).map((tb, i) => ({ index: i, url: tb.url, title: tb.title }))
  })
}

async function browserOpen(args: Args, c: Ctx): Promise<string> {
  const url = s(args.url)
  if (!url) return 'error: url is required'
  const full = /^https?:\/\//i.test(url) ? url : 'http://' + url
  if (args.new_tab) {
    const ws = c.ws
    if (!ws) return unattributed(c)
    const api = callerApi(c)
    if (api && !api.getPanel('preview')) togglePanel('preview', ws)
    useBrowser.getState().ensureWs(ws)
    useBrowser.getState().newTab(ws, full)
    await sleep(150)
  } else {
    const b = await ensureBrowser(c, full)
    if (typeof b === 'string') return b
    await sleep(150)
  }
  return browserStateText(c)
}

async function browserTab(args: Args, c: Ctx): Promise<string> {
  const ws = c.ws
  if (!ws) return unattributed(c)
  const cur = useBrowser.getState().byWs[ws]
  // No index means "the one in front" — closing the current tab is the common
  // case, and it used to fail with "no tab at index -1".
  const tab =
    typeof args.index === 'number'
      ? cur?.tabs[args.index]
      : cur?.tabs.find((t) => t.id === cur.activeId)
  if (!tab)
    return typeof args.index === 'number'
      ? `error: no tab at index ${args.index}`
      : 'error: no open tab in this workspace'
  if (s(args.action) === 'close') useBrowser.getState().closeTab(ws, tab.id)
  else useBrowser.getState().selectTab(ws, tab.id)
  return browserStateText(c)
}

async function browserGo(args: Args, c: Ctx): Promise<string> {
  const b = await ensureBrowser(c)
  if (typeof b === 'string') return b
  const a = s(args.action)
  if (!['back', 'forward', 'reload', 'stop'].includes(a)) return `error: unknown action "${a}"`
  await window.api.browser.go(b.tabId, a as 'back' | 'forward' | 'reload' | 'stop')
  await sleep(300)
  return browserStateText(c)
}

async function browserWait(args: Args, c: Ctx): Promise<string> {
  const sel = s(args.selector)
  if (!sel) return 'error: selector is required'
  const timeout = Math.min(60000, typeof args.timeout_ms === 'number' ? args.timeout_ms : 5000)
  const b = await ensureBrowser(c)
  if (typeof b === 'string') return b
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const hit = await window.api.browser.execJs(
      b.tabId,
      `!!document.querySelector(${JSON.stringify(sel)})`
    )
    if (hit === true) return 'matched'
    await sleep(150)
  }
  return `timeout: "${sel}" did not appear in ${timeout}ms`
}

// ---- agent delegation tools ----
const ASK_TIMEOUT_MS = 300_000 // 5 min per delegated turn
// Delegation NEVER crosses a workspace. Title matching is fuzzy, so an unscoped
// lookup let "ask the agent next to me" land on a same-named pane in a workspace
// the caller cannot see — and the caller had no way to tell it had happened.
async function askOneAgent(ref: string, message: string, wait: boolean, c: Ctx): Promise<string> {
  if (!c.ws) return unattributed(c)
  const target = resolveAgent(ref, c.chatPane ?? undefined, c.ws)
  if (!target)
    return `error: no agent matching "${ref}" in this workspace (see riven_agents)`
  const replyP = target.waitNext()
  target.send(message)
  if (!wait) return `delegated to "${target.getTitle()}" (async)`
  const reply = await Promise.race([
    replyP,
    new Promise<string>((r) => setTimeout(() => r('(no reply within 5 min)'), ASK_TIMEOUT_MS))
  ])
  return `[${target.getTitle()}] ${reply}`
}
async function askAgent(args: Args, c: Ctx): Promise<string> {
  return askOneAgent(s(args.agent), s(args.message), args.wait !== false, c)
}
async function askAgents(args: Args, c: Ctx): Promise<string> {
  const tasks = Array.isArray(args.tasks) ? (args.tasks as Array<Record<string, unknown>>) : []
  if (!tasks.length) return 'error: tasks is required'
  const wait = args.wait !== false
  const results = await Promise.all(
    tasks.map((tk) => askOneAgent(s(tk.agent), s(tk.message), wait, c))
  )
  return results.join('\n\n')
}
function groupAddAgent(args: Args, c: Ctx): string {
  const name = s(args.name)
  const persona = s(args.persona)
  const model = s(args.model)
  const parent = s(args.parent)
  // Prime the teammate with its role/persona as the first message, and spawn it on
  // the requested model so a team can mix models (engineering: opus architect +
  // sonnet coder). `parent` is recorded in the priming so the agent knows who it
  // reports to.
  const lines: string[] = []
  if (persona) lines.push(`[역할] ${persona}`)
  if (name) lines.push(`[이름] ${name}`)
  if (parent) lines.push(`[보고 대상] ${parent}`)
  const initial = lines.length ? `${lines.join('\n')}\n이 역할로 이후 작업을 수행하세요.` : undefined
  // Open the teammate BESIDE the pane that asked for it, IN the caller's
  // workspace — `refId` only picks a neighbour within a dock, so without naming
  // the workspace the pane still materialised in whichever dock was on screen.
  // `inactive` so the asking pane (where the user may be typing) keeps focus.
  if (!c.ws) return unattributed(c)
  if (!callerApi(c)) return notMounted(c)
  addChat(
    initial,
    'right',
    model || undefined,
    c.chatPane ?? undefined,
    name || undefined,
    true,
    undefined,
    undefined,
    c.ws
  )
  return `added agent "${name || persona || 'chat'}"${model && model !== 'default' ? ` · ${model}` : ''}`
}
async function confirmAsk(question: string, c: Ctx): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    useAskUser.getState().enqueue({
      id: Math.random().toString(36).slice(2),
      chatKey: c.chatPane,
      question,
      options: ['예', '아니오'],
      resolve: (choice) => resolve(choice === '예')
    })
  })
}
async function groupRemoveAgent(args: Args, c: Ctx): Promise<string> {
  const name = s(args.name)
  if (!c.ws) return unattributed(c)
  const target = resolveAgent(name, undefined, c.ws)
  if (!target) return `error: no agent matching "${name}" in this workspace`
  if (!(await confirmAsk(`"${target.getTitle()}" 에이전트를 닫을까요?`, c)))
    return 'the user declined'
  // Resolve the dock from the ctx captured at call time. Reading it here from a
  // shared "current caller" was the bug: the confirmation above can sit for
  // minutes, and any other agent's tool call in that window retagged it.
  const api = callerApi(c)
  if (!api) return notMounted(c)
  const panel = api.getPanel(target.chatKey)
  if (panel) api.removePanel(panel)
  return `removed "${target.getTitle()}"`
}
async function groupDelete(args: Args, c: Ctx): Promise<string> {
  const group = s(args.group)
  if (!c.ws) return unattributed(c)
  if (!(await confirmAsk(`그룹 "${group}"의 모든 에이전트 패널을 닫을까요?`, c)))
    return 'the user declined'
  const api = callerApi(c)
  if (!api) return notMounted(c)
  let n = 0
  for (const p of api.panels.filter((p) => p.id.startsWith('chat-'))) {
    api.removePanel(p)
    n++
  }
  return `deleted group "${group}" (${n} agents closed)`
}
async function startPipeline(args: Args, c: Ctx): Promise<string> {
  const name = s(args.name)
  const task = s(args.task)
  const stages = Array.isArray(args.stages) ? (args.stages as Array<Record<string, unknown>>) : []
  if (!stages.length) return 'error: stages is required'
  if (!c.ws) return unattributed(c)
  if (!callerApi(c)) return notMounted(c)
  let carry = task
  const out: string[] = []
  // Lay stage panes out in a row beside the pane that started the pipeline, each
  // next to the previous — and all of them in the CALLER's workspace, so a
  // pipeline started by a background agent doesn't build itself on screen.
  let ref = c.chatPane ?? undefined
  for (const st of stages) {
    const stageName = s(st.name)
    const instruction = s(st.instruction)
    const stageAgent = s(st.agent)
    const stageModel = s(st.model)
    // Reuse an existing agent if the stage names one; otherwise spawn a fresh pane
    // for the stage (on its own model if given).
    let target = stageAgent ? resolveAgent(stageAgent, undefined, c.ws) : null
    if (!target) {
      const id = addChat(
        undefined,
        'right',
        stageModel || undefined,
        ref,
        stageName || undefined,
        true,
        undefined,
        undefined,
        c.ws
      )
      ref = id // next stage opens beside this one
      await sleep(400) // let the new pane register as an agent
      const roster = listAgents(c.ws)
      target =
        resolveAgent(id, undefined, c.ws) ??
        resolveAgent(roster[roster.length - 1]?.id ?? '', undefined, c.ws)
    }
    if (!target) return `error: could not open a pane for stage "${stageName}"`
    const prompt = `${instruction ? instruction + '\n\n' : ''}[이전 단계 산출물]\n${carry}`
    const replyP = target.waitNext()
    target.send(prompt)
    carry = await Promise.race([
      replyP,
      new Promise<string>((r) => setTimeout(() => r('(stage timed out)'), ASK_TIMEOUT_MS))
    ])
    out.push(`## ${stageName}\n${carry}`)
  }
  return `pipeline "${name}" done:\n\n${out.join('\n\n')}`
}

async function dispatch(tool: string, args: Args, caller: Caller): Promise<string> {
  // Resolved once, here, and passed down. Nothing below re-derives the caller,
  // so an await inside a tool cannot pick up a different agent's attribution.
  const c = { ...resolveCtx(caller), onCancel: caller.onCancel }
  switch (tool) {
    case 'ask_user':
      return askUser(args, c)
    case 'riven_open_file':
      return openFile(args, c)
    case 'riven_panels':
      return listPanels(c)
    case 'riven_open_panel':
      return openPanel(args, c)
    case 'riven_close_panel':
      return closePanel(args, c)
    case 'riven_workspaces':
      return listWorkspaces()
    case 'riven_open_workspace':
      return openWorkspace(args)
    case 'riven_open_browser':
      return browserOpen({ url: args.url }, c)
    case 'riven_browser_open':
      return browserOpen(args, c)
    case 'riven_browser_state':
      return browserStateText(c)
    case 'riven_browser_tab':
      return browserTab(args, c)
    case 'riven_browser_go':
      return browserGo(args, c)
    case 'riven_browser_wait':
      return browserWait(args, c)
    case 'riven_browser_read': {
      const sel = s(args.selector)
      const html = !!args.html
      const code = sel
        ? `(()=>{const el=document.querySelector(${JSON.stringify(sel)});return el?(${html}?el.outerHTML:el.innerText):'(no match)'})()`
        : `(${html}?document.documentElement.outerHTML:document.body.innerText)`
      return browserEval(code, c)
    }
    case 'riven_browser_click': {
      const sel = s(args.selector)
      if (!sel) return 'error: selector is required'
      return browserEval(
        `(()=>{const el=document.querySelector(${JSON.stringify(sel)});if(!el)return'(no match)';el.scrollIntoView({block:'center'});el.click();return'clicked'})()`,
        c
      )
    }
    case 'riven_browser_fill': {
      const sel = s(args.selector)
      const val = s(args.value)
      if (!sel) return 'error: selector is required'
      const submit = args.submit
        ? `if(el.form){el.form.requestSubmit?el.form.requestSubmit():el.form.submit();}`
        : ''
      return browserEval(
        `(()=>{const el=document.querySelector(${JSON.stringify(sel)});if(!el)return'(no match)';el.focus();el.value=${JSON.stringify(val)};el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));${submit}return'filled'})()`,
        c
      )
    }
    case 'riven_browser_scroll': {
      const sel = s(args.selector)
      const y = typeof args.y === 'number' ? args.y : null
      const code = sel
        ? `(()=>{const el=document.querySelector(${JSON.stringify(sel)});if(!el)return'(no match)';el.scrollIntoView({block:'center'});return'scrolled'})()`
        : y != null
          ? `(window.scrollTo(0,${y}),'scrolled')`
          : `(window.scrollTo(0,document.body.scrollHeight),'scrolled')`
      return browserEval(code, c)
    }
    case 'riven_browser_eval':
      return browserEval(s(args.js), c)
    case 'riven_note_list':
      return noteList(c)
    case 'riven_note_read':
      return noteRead(args, c)
    case 'riven_note_write':
      return noteWrite(args, c)
    case 'riven_note_append':
      return noteAppend(args, c)
    case 'riven_doc_write':
      return docWrite(args, c)
    case 'riven_note_save_file':
      return noteSaveFile(args, c)
    case 'riven_agents':
      // Only this workspace's agents: listing panes the caller must not delegate
      // to only invites it to try.
      return c.ws ? JSON.stringify(listAgents(c.ws)) : unattributed(c)
    case 'riven_ask_agent':
      return askAgent(args, c)
    case 'riven_ask_agents':
      return askAgents(args, c)
    case 'riven_group_add_agent':
      return groupAddAgent(args, c)
    case 'riven_group_remove_agent':
      return groupRemoveAgent(args, c)
    case 'riven_group_delete':
      return groupDelete(args, c)
    case 'riven_start_pipeline':
      return startPipeline(args, c)
    case 'riven_screenshot': {
      const b = await ensureBrowser(c, args.url ? s(args.url) : undefined)
      if (typeof b === 'string') return b
      await sleep(500)
      const dataUrl = await window.api.browser.capture(b.tabId)
      if (!dataUrl) return 'error: capture failed'
      return window.api.bridge.saveCapture(pathOf(b.ws), dataUrl)
    }
    default:
      return `error: riven tool "${tool}" is not available in this build yet`
  }
}

// Wire the main→renderer tool bridge. Call once at app start. Returns a disposer.
export function registerMcpToolHandler(): () => void {
  // Cancellers for calls still in flight, so main can tell the UI to stop
  // waiting when the agent behind a blocking tool hangs up.
  const cancels = new Map<string, () => void>()
  const offInvoke = window.api.mcp.onInvoke((e) => {
    dispatch(e.tool, e.args, {
      key: e.key,
      cwd: e.cwd,
      onCancel: (fn) => cancels.set(e.id, fn)
    })
      .then((result) => window.api.mcp.result(e.id, result))
      .catch((err) =>
        window.api.mcp.result(e.id, `error: ${err instanceof Error ? err.message : String(err)}`)
      )
      .finally(() => cancels.delete(e.id))
  })
  const offCancel = window.api.mcp.onCancel(({ id }) => {
    cancels.get(id)?.()
    cancels.delete(id)
  })
  return () => {
    offInvoke()
    offCancel()
  }
}
