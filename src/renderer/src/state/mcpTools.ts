import { useSession, pathOf } from './session'
import { useNav } from './nav'
import { useAskUser } from './askUser'
import { useBrowser, activeTab, activeTabId } from './browser'
import { listAgents, resolveAgent } from './agents'
import {
  getActiveApi,
  ensureEditor,
  addTerminal,
  addChat,
  togglePanel,
  getDelegator
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

type Args = Record<string, unknown>
const s = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v))

async function askUser(args: Args): Promise<string> {
  const question = s(args.question)
  const options = Array.isArray(args.options) ? (args.options as unknown[]).map(s) : []
  if (!options.length) return 'error: options is required'
  return new Promise<string>((resolve) => {
    useAskUser.getState().enqueue({
      id: Math.random().toString(36).slice(2),
      question,
      options,
      resolve
    })
  })
}

function openFile(args: Args): string {
  const p = s(args.path)
  if (!p) return 'error: path is required'
  useSession.getState().openFile(p)
  ensureEditor()
  const line = typeof args.line === 'number' ? args.line : undefined
  if (line) useNav.getState().requestReveal(p, line, 1)
  return `opened ${p}${line ? `:${line}` : ''}`
}

function listPanels(): string {
  const api = getActiveApi()
  if (!api) return 'no panels'
  const panels = api.panels.map((p) => ({
    id: p.id,
    kind: (p as { component?: string }).component ?? p.id.replace(/-\d+$/, ''),
    title: p.title
  }))
  return JSON.stringify(panels)
}

const PANEL_KINDS = new Set(['editor', 'search', 'git', 'changes', 'preview', 'notes', 'api'])
function openPanel(args: Args): string {
  const kind = s(args.kind)
  if (kind === 'terminal') {
    addTerminal()
    return 'opened terminal'
  }
  if (kind === 'chat') {
    addChat()
    return 'opened chat'
  }
  if (PANEL_KINDS.has(kind)) {
    togglePanel(kind as 'editor' | 'search' | 'git' | 'changes' | 'preview' | 'notes' | 'api')
    return `opened ${kind}`
  }
  return `error: unknown panel kind "${kind}"`
}

// ---- notes / docs tools ----
function notesChanged(): void {
  window.dispatchEvent(new Event('riven:notes-changed'))
}
async function noteList(): Promise<string> {
  const ws = useSession.getState().activeWorkspace
  if (!ws) return 'error: no active workspace'
  const list = await window.api.notes.list(pathOf(ws))
  return JSON.stringify(list.map((n) => ({ note: n.name, title: n.title })))
}
async function noteRead(args: Args): Promise<string> {
  const ws = useSession.getState().activeWorkspace
  if (!ws) return 'error: no active workspace'
  const content = await window.api.notes.read(pathOf(ws), s(args.note))
  return content ?? 'error: note not found'
}
async function noteWrite(args: Args): Promise<string> {
  const ws = useSession.getState().activeWorkspace
  if (!ws) return 'error: no active workspace'
  const name = await window.api.notes.write(
    pathOf(ws),
    args.note ? s(args.note) : null,
    s(args.title),
    s(args.body)
  )
  togglePanel('notes')
  notesChanged()
  return `wrote note "${name}"`
}
async function noteAppend(args: Args): Promise<string> {
  const ws = useSession.getState().activeWorkspace
  if (!ws) return 'error: no active workspace'
  const name = await window.api.notes.append(pathOf(ws), s(args.note), s(args.body))
  if (!name) return 'error: note not found'
  notesChanged()
  return `appended to "${name}"`
}
async function docWrite(args: Args): Promise<string> {
  const ws = useSession.getState().activeWorkspace
  if (!ws) return 'error: no active workspace'
  const res = await window.api.notes.writeFile(pathOf(ws), s(args.path), s(args.body), !!args.overwrite)
  if (!res.ok) return `error: ${res.error}`
  if (res.path) {
    useSession.getState().openFile(res.path)
    ensureEditor()
  }
  return `wrote ${res.path}`
}
async function noteSaveFile(args: Args): Promise<string> {
  const ws = useSession.getState().activeWorkspace
  if (!ws) return 'error: no active workspace'
  const res = await window.api.notes.saveToFile(
    pathOf(ws),
    s(args.note),
    s(args.path),
    !!args.overwrite
  )
  return res.ok ? `saved to ${res.path}` : `error: ${res.error}`
}

function closePanel(args: Args): string {
  const id = s(args.id)
  const api = getActiveApi()
  if (!api) return 'error: no active workspace'
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
async function ensureBrowser(url?: string): Promise<{ ws: string; tabId: string } | string> {
  const ws = useSession.getState().activeWorkspace
  if (!ws) return 'error: no active workspace'
  const api = getActiveApi()
  if (api && !api.getPanel('preview')) togglePanel('preview')
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

async function browserEval(code: string): Promise<string> {
  const b = await ensureBrowser()
  if (typeof b === 'string') return b
  return clip(await window.api.browser.execJs(b.tabId, code))
}

function browserStateText(): string {
  const ws = useSession.getState().activeWorkspace
  if (!ws) return 'error: no active workspace'
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

async function browserOpen(args: Args): Promise<string> {
  const url = s(args.url)
  if (!url) return 'error: url is required'
  const full = /^https?:\/\//i.test(url) ? url : 'http://' + url
  if (args.new_tab) {
    const ws = useSession.getState().activeWorkspace
    if (!ws) return 'error: no active workspace'
    const api = getActiveApi()
    if (api && !api.getPanel('preview')) togglePanel('preview')
    useBrowser.getState().ensureWs(ws)
    useBrowser.getState().newTab(ws, full)
    await sleep(150)
  } else {
    const b = await ensureBrowser(full)
    if (typeof b === 'string') return b
    await sleep(150)
  }
  return browserStateText()
}

async function browserTab(args: Args): Promise<string> {
  const ws = useSession.getState().activeWorkspace
  if (!ws) return 'error: no active workspace'
  const cur = useBrowser.getState().byWs[ws]
  const idx = typeof args.index === 'number' ? args.index : -1
  const tab = cur?.tabs[idx]
  if (!tab) return `error: no tab at index ${idx}`
  if (s(args.action) === 'close') useBrowser.getState().closeTab(ws, tab.id)
  else useBrowser.getState().selectTab(ws, tab.id)
  return browserStateText()
}

async function browserGo(args: Args): Promise<string> {
  const b = await ensureBrowser()
  if (typeof b === 'string') return b
  const a = s(args.action)
  if (!['back', 'forward', 'reload', 'stop'].includes(a)) return `error: unknown action "${a}"`
  await window.api.browser.go(b.tabId, a as 'back' | 'forward' | 'reload' | 'stop')
  await sleep(300)
  return browserStateText()
}

async function browserWait(args: Args): Promise<string> {
  const sel = s(args.selector)
  if (!sel) return 'error: selector is required'
  const timeout = Math.min(60000, typeof args.timeout_ms === 'number' ? args.timeout_ms : 5000)
  const b = await ensureBrowser()
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
async function askOneAgent(ref: string, message: string, wait: boolean): Promise<string> {
  const target = resolveAgent(ref)
  if (!target) return `error: no agent matching "${ref}" (see riven_agents)`
  const replyP = target.waitNext()
  target.send(message)
  if (!wait) return `delegated to "${target.getTitle()}" (async)`
  const reply = await Promise.race([
    replyP,
    new Promise<string>((r) => setTimeout(() => r('(no reply within 5 min)'), ASK_TIMEOUT_MS))
  ])
  return `[${target.getTitle()}] ${reply}`
}
async function askAgent(args: Args): Promise<string> {
  return askOneAgent(s(args.agent), s(args.message), args.wait !== false)
}
async function askAgents(args: Args): Promise<string> {
  const tasks = Array.isArray(args.tasks) ? (args.tasks as Array<Record<string, unknown>>) : []
  if (!tasks.length) return 'error: tasks is required'
  const wait = args.wait !== false
  const results = await Promise.all(
    tasks.map((tk) => askOneAgent(s(tk.agent), s(tk.message), wait))
  )
  return results.join('\n\n')
}
function groupAddAgent(args: Args): string {
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
  // Open the teammate BESIDE the delegating agent's pane (getDelegator), not
  // wherever dock focus happens to be. `inactive` so the delegating agent's pane
  // (where the user may be typing) keeps focus.
  addChat(initial, 'right', model || undefined, getDelegator() ?? undefined, name || undefined, true)
  return `added agent "${name || persona || 'chat'}"${model && model !== 'default' ? ` · ${model}` : ''}`
}
async function confirmAsk(question: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    useAskUser.getState().enqueue({
      id: Math.random().toString(36).slice(2),
      question,
      options: ['예', '아니오'],
      resolve: (choice) => resolve(choice === '예')
    })
  })
}
async function groupRemoveAgent(args: Args): Promise<string> {
  const name = s(args.name)
  const target = resolveAgent(name)
  if (!target) return `error: no agent matching "${name}"`
  if (!(await confirmAsk(`"${target.getTitle()}" 에이전트를 닫을까요?`)))
    return 'the user declined'
  const api = getActiveApi()
  const panel = api?.getPanel(target.chatKey)
  if (panel && api) api.removePanel(panel)
  return `removed "${target.getTitle()}"`
}
async function groupDelete(args: Args): Promise<string> {
  const group = s(args.group)
  if (!(await confirmAsk(`그룹 "${group}"의 모든 에이전트 패널을 닫을까요?`)))
    return 'the user declined'
  const api = getActiveApi()
  if (!api) return 'error: no active workspace'
  let n = 0
  for (const p of api.panels.filter((p) => p.id.startsWith('chat-'))) {
    api.removePanel(p)
    n++
  }
  return `deleted group "${group}" (${n} agents closed)`
}
async function startPipeline(args: Args): Promise<string> {
  const name = s(args.name)
  const task = s(args.task)
  const stages = Array.isArray(args.stages) ? (args.stages as Array<Record<string, unknown>>) : []
  if (!stages.length) return 'error: stages is required'
  let carry = task
  const out: string[] = []
  // Lay stage panes out in a row beside the delegator, each next to the previous.
  let ref = getDelegator() ?? undefined
  for (const st of stages) {
    const stageName = s(st.name)
    const instruction = s(st.instruction)
    const stageAgent = s(st.agent)
    const stageModel = s(st.model)
    // Reuse an existing agent if the stage names one; otherwise spawn a fresh pane
    // for the stage (on its own model if given).
    let target = stageAgent ? resolveAgent(stageAgent) : null
    if (!target) {
      const id = addChat(undefined, 'right', stageModel || undefined, ref, stageName || undefined, true)
      ref = id // next stage opens beside this one
      await sleep(400) // let the new pane register as an agent
      target = resolveAgent(id) ?? resolveAgent(listAgents()[listAgents().length - 1]?.id ?? '')
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

async function dispatch(tool: string, args: Args): Promise<string> {
  switch (tool) {
    case 'ask_user':
      return askUser(args)
    case 'riven_open_file':
      return openFile(args)
    case 'riven_panels':
      return listPanels()
    case 'riven_open_panel':
      return openPanel(args)
    case 'riven_close_panel':
      return closePanel(args)
    case 'riven_workspaces':
      return listWorkspaces()
    case 'riven_open_workspace':
      return openWorkspace(args)
    case 'riven_open_browser':
      return browserOpen({ url: args.url })
    case 'riven_browser_open':
      return browserOpen(args)
    case 'riven_browser_state':
      return browserStateText()
    case 'riven_browser_tab':
      return browserTab(args)
    case 'riven_browser_go':
      return browserGo(args)
    case 'riven_browser_wait':
      return browserWait(args)
    case 'riven_browser_read': {
      const sel = s(args.selector)
      const html = !!args.html
      const code = sel
        ? `(()=>{const el=document.querySelector(${JSON.stringify(sel)});return el?(${html}?el.outerHTML:el.innerText):'(no match)'})()`
        : `(${html}?document.documentElement.outerHTML:document.body.innerText)`
      return browserEval(code)
    }
    case 'riven_browser_click': {
      const sel = s(args.selector)
      if (!sel) return 'error: selector is required'
      return browserEval(
        `(()=>{const el=document.querySelector(${JSON.stringify(sel)});if(!el)return'(no match)';el.scrollIntoView({block:'center'});el.click();return'clicked'})()`
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
        `(()=>{const el=document.querySelector(${JSON.stringify(sel)});if(!el)return'(no match)';el.focus();el.value=${JSON.stringify(val)};el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));${submit}return'filled'})()`
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
      return browserEval(code)
    }
    case 'riven_browser_eval':
      return browserEval(s(args.js))
    case 'riven_note_list':
      return noteList()
    case 'riven_note_read':
      return noteRead(args)
    case 'riven_note_write':
      return noteWrite(args)
    case 'riven_note_append':
      return noteAppend(args)
    case 'riven_doc_write':
      return docWrite(args)
    case 'riven_note_save_file':
      return noteSaveFile(args)
    case 'riven_agents':
      return JSON.stringify(listAgents())
    case 'riven_ask_agent':
      return askAgent(args)
    case 'riven_ask_agents':
      return askAgents(args)
    case 'riven_group_add_agent':
      return groupAddAgent(args)
    case 'riven_group_remove_agent':
      return groupRemoveAgent(args)
    case 'riven_group_delete':
      return groupDelete(args)
    case 'riven_start_pipeline':
      return startPipeline(args)
    case 'riven_screenshot': {
      const b = await ensureBrowser(args.url ? s(args.url) : undefined)
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
  return window.api.mcp.onInvoke((e) => {
    dispatch(e.tool, e.args)
      .then((result) => window.api.mcp.result(e.id, result))
      .catch((err) =>
        window.api.mcp.result(e.id, `error: ${err instanceof Error ? err.message : String(err)}`)
      )
  })
}
