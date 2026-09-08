import { ipcMain, WebContents } from 'electron'
import * as http from 'http'
import { randomUUID } from 'crypto'

// riven's OWN tools, exposed to the Claude CLI over MCP — things the CLI can't do
// itself or that should run inside riven's UI. The CLI talks Streamable-HTTP MCP
// to a loopback server in THIS main process (see registerMcpServer); a tools/call
// is performed here (usually by asking the renderer) and the result string goes
// back to the agent.

export interface McpToolDef {
  name: string
  ko: string
  en: string
  description: string
  inputSchema: Record<string, unknown>
}

const obj = (
  props: Record<string, unknown>,
  required?: string[]
): Record<string, unknown> => ({
  type: 'object',
  properties: props,
  ...(required ? { required } : {})
})
const str = { type: 'string' }
const num = { type: 'number' }
const bool = { type: 'boolean' }

// The full tool catalog (labels drive the settings toggles). `implemented` marks
// the tools this port can actually service today; the rest stay listed in
// settings but are not advertised to the agent until their panel lands.
export const MCP_TOOLS: Array<McpToolDef & { implemented: boolean }> = [
  {
    name: 'ask_user',
    ko: '답변 선택 팝업',
    en: 'Ask-user popup',
    description:
      'Ask the user to choose one option via a native UI. Use instead of writing a numbered list.',
    inputSchema: obj({ question: str, options: { type: 'array', items: str } }, [
      'question',
      'options'
    ]),
    implemented: true
  },
  {
    name: 'riven_open_file',
    ko: '에디터에 파일 열기',
    en: 'Open file in editor',
    description:
      "Open a file in riven's code editor (optionally at a line) so the user can review it with you.",
    inputSchema: obj({ path: str, line: num }, ['path']),
    implemented: true
  },
  {
    name: 'riven_panels',
    ko: '패널 목록',
    en: 'List panels',
    description:
      "List riven's current panels (dock panes): id, kind and title, so you understand the workspace layout.",
    inputSchema: obj({}),
    implemented: true
  },
  {
    name: 'riven_open_panel',
    ko: '패널 열기',
    en: 'Open panel',
    description:
      'Open a riven panel. kind: editor | terminal | chat | search | git | preview | changes.',
    inputSchema: obj({ kind: str }, ['kind']),
    implemented: true
  },
  {
    name: 'riven_close_panel',
    ko: '패널 닫기',
    en: 'Close panel',
    description: 'Close a panel by its id (from riven_panels).',
    inputSchema: obj({ id: str }, ['id']),
    implemented: true
  },
  {
    name: 'riven_workspaces',
    ko: '워크스페이스 목록',
    en: 'List workspaces',
    description: 'List open workspaces (folders) and which one is active.',
    inputSchema: obj({}),
    implemented: true
  },
  {
    name: 'riven_open_workspace',
    ko: '워크스페이스 열기',
    en: 'Open workspace',
    description: 'Open/switch to a workspace folder by path.',
    inputSchema: obj({ path: str }, ['path']),
    implemented: true
  },
  {
    name: 'riven_open_browser',
    ko: '브라우저에 URL 열기',
    en: 'Open URL in browser',
    description:
      "Open a URL in riven's browser panel so the user can see it. Same as riven_browser_open.",
    inputSchema: obj({ url: str }, ['url']),
    implemented: true
  },
  {
    name: 'riven_screenshot',
    ko: '브라우저 스크린샷',
    en: 'Browser screenshot',
    description:
      'Capture the browser panel (optionally navigating first). Returns a PNG file path; read it with the Read tool to see the page.',
    inputSchema: obj({ url: str }),
    implemented: true
  },
  {
    name: 'riven_browser_open',
    ko: '브라우저: 열기',
    en: 'Browser: open',
    description:
      'Open a URL in the browser panel. Set new_tab=true to keep the current page. The panel keeps cookies/session.',
    inputSchema: obj({ url: str, new_tab: bool }, ['url']),
    implemented: true
  },
  {
    name: 'riven_browser_tab',
    ko: '브라우저: 탭 전환/닫기',
    en: 'Browser: tabs',
    description:
      'Switch to or close a browser tab by index (see the tabs list in riven_browser_state). action: select | close.',
    inputSchema: obj({ action: str, index: num }, ['action']),
    implemented: true
  },
  {
    name: 'riven_browser_state',
    ko: '브라우저: 상태 읽기',
    en: 'Browser: state',
    description:
      'Current browser state: URL, page title, loading, back/forward availability and the open tabs.',
    inputSchema: obj({}),
    implemented: true
  },
  {
    name: 'riven_browser_go',
    ko: '브라우저: 뒤로/앞으로/새로고침',
    en: 'Browser: navigate',
    description: 'History/loading control. action: back | forward | reload | stop.',
    inputSchema: obj({ action: str }, ['action']),
    implemented: true
  },
  {
    name: 'riven_browser_read',
    ko: '브라우저: 페이지 내용 읽기',
    en: 'Browser: read page',
    description:
      "Read the current page. Without a selector you get the page's visible text; with a CSS selector you get just that element. Set html=true for markup. Long output is truncated.",
    inputSchema: obj({ selector: str, html: bool }),
    implemented: true
  },
  {
    name: 'riven_browser_click',
    ko: '브라우저: 클릭',
    en: 'Browser: click',
    description: 'Click the first element matching a CSS selector (scrolls it into view first).',
    inputSchema: obj({ selector: str }, ['selector']),
    implemented: true
  },
  {
    name: 'riven_browser_fill',
    ko: '브라우저: 입력/제출',
    en: 'Browser: fill',
    description:
      'Type a value into an input/textarea/select matching a CSS selector (fires input+change). Set submit=true to submit the form.',
    inputSchema: obj({ selector: str, value: str, submit: bool }, ['selector', 'value']),
    implemented: true
  },
  {
    name: 'riven_browser_wait',
    ko: '브라우저: 대기',
    en: 'Browser: wait',
    description:
      'Wait until a CSS selector matches (for pages that render after load). timeout_ms defaults to 5000, max 60000.',
    inputSchema: obj({ selector: str, timeout_ms: num }, ['selector']),
    implemented: true
  },
  {
    name: 'riven_browser_scroll',
    ko: '브라우저: 스크롤',
    en: 'Browser: scroll',
    description:
      'Scroll the page: pass a selector to scroll it into view, y for an absolute position, or neither to jump to the bottom.',
    inputSchema: obj({ selector: str, y: num }),
    implemented: true
  },
  {
    name: 'riven_browser_eval',
    ko: '브라우저: 자바스크립트 실행',
    en: 'Browser: eval JS',
    description:
      'Run JavaScript in the current page and return its value. Prefer the specific tools above; use this only when they cannot express what you need.',
    inputSchema: obj({ js: str }, ['js']),
    implemented: true
  },
  {
    name: 'riven_agents',
    ko: '에이전트 목록',
    en: 'List agents',
    description:
      'List the other agent chat panes open in riven (id, title, busy). Use before delegating.',
    inputSchema: obj({}),
    implemented: true
  },
  {
    name: 'riven_ask_agent',
    ko: '에이전트에 위임',
    en: 'Delegate to an agent',
    description:
      "Delegate work to ANOTHER agent pane. `agent` is a title or id from riven_agents; the message appears in that agent's chat. By default WAITS for the reply and returns it; pass wait=false to return at once.",
    inputSchema: obj({ agent: str, message: str, wait: bool }, ['agent', 'message']),
    implemented: true
  },
  {
    name: 'riven_ask_agents',
    ko: '여러 에이전트에 위임',
    en: 'Delegate to agents',
    description:
      'Delegate to SEVERAL agents at once (parallel). By default waits and returns every reply; pass wait=false to return immediately.',
    inputSchema: obj(
      {
        tasks: {
          type: 'array',
          items: obj({ agent: str, message: str }, ['agent', 'message'])
        },
        wait: bool
      },
      ['tasks']
    ),
    implemented: true
  },
  {
    name: 'riven_group_add_agent',
    ko: '그룹에 에이전트 추가',
    en: 'Add agent to group',
    description:
      'Open a new agent chat pane, optionally primed with a persona and nickname.',
    inputSchema: obj({ group: str, name: str, persona: str, model: str, parent: str }, [
      'group',
      'name'
    ]),
    implemented: true
  },
  {
    name: 'riven_group_remove_agent',
    ko: '그룹에서 에이전트 제거',
    en: 'Remove agent from group',
    description:
      'Close an agent pane and drop it from the roster. Asks the user to confirm first (destructive).',
    inputSchema: obj({ group: str, name: str }, ['group', 'name']),
    implemented: true
  },
  {
    name: 'riven_group_delete',
    ko: '그룹 삭제',
    en: 'Delete group',
    description:
      'Close every agent pane in the group. Asks the user to confirm first (destructive).',
    inputSchema: obj({ group: str }, ['group']),
    implemented: true
  },
  {
    name: 'riven_start_pipeline',
    ko: '직렬 파이프라인 실행',
    en: 'Start pipeline',
    description:
      "Run a task through a SERIAL agent pipeline. `stages` is an ordered list; each stage is a fresh agent pane and its output feeds the next. Returns the combined result when the last stage finishes.",
    inputSchema: obj(
      {
        name: str,
        task: str,
        stages: {
          type: 'array',
          items: obj({ name: str, agent: str, model: str, instruction: str }, ['name'])
        }
      },
      ['name', 'task', 'stages']
    ),
    implemented: true
  },
  {
    name: 'riven_note_list',
    ko: '메모 목록',
    en: 'List notes',
    description:
      "List the user's scratch markdown notes in riven's Notes panel. Returns note id and title.",
    inputSchema: obj({ scope: str }),
    implemented: true
  },
  {
    name: 'riven_note_read',
    ko: '메모 읽기',
    en: 'Read note',
    description: 'Read one note as markdown. `note` is a note id or title (from riven_note_list).',
    inputSchema: obj({ note: str }, ['note']),
    implemented: true
  },
  {
    name: 'riven_note_write',
    ko: '메모 쓰기',
    en: 'Write note',
    description:
      'Write a SCRATCH note (Notes panel, NOT a repo file) so the user can see it. Creates a new note, or replaces `note` if given. For working notes/summaries. To document into the repo, use riven_doc_write.',
    inputSchema: obj({ title: str, body: str, note: str }, ['title', 'body']),
    implemented: true
  },
  {
    name: 'riven_note_append',
    ko: '메모 이어쓰기',
    en: 'Append note',
    description: 'Append markdown to the end of an existing note (nothing is overwritten).',
    inputSchema: obj({ note: str, body: str }, ['note', 'body']),
    implemented: true
  },
  {
    name: 'riven_doc_write',
    ko: '문서(.md) 쓰기',
    en: 'Write doc',
    description:
      'Write a markdown DOCUMENT as a real file in the workspace and open it. Bare names go under .claude/docs/. Refuses to clobber unless overwrite is true; never writes outside the workspace.',
    inputSchema: obj({ path: str, body: str, overwrite: bool }, ['path', 'body']),
    implemented: true
  },
  {
    name: 'riven_note_save_file',
    ko: '메모를 파일로 저장',
    en: 'Save note to file',
    description:
      'Save a note as a real .md file in the workspace. Refuses to clobber unless overwrite is true.',
    inputSchema: obj({ note: str, path: str, overwrite: bool }, ['note', 'path']),
    implemented: true
  },
  {
    name: 'riven_api_request',
    ko: 'HTTP 요청 실행',
    en: 'HTTP request',
    description: 'Run an HTTP request and return status/headers/body.',
    inputSchema: obj({ method: str, url: str, headers: { type: 'object' }, body: str }, [
      'method',
      'url'
    ]),
    implemented: true
  }
]

const TOOL_BY_NAME = new Map(MCP_TOOLS.map((t) => [t.name, t]))

// Tool names this port can actually service (advertised to the agent).
export function implementedToolNames(): string[] {
  return MCP_TOOLS.filter((t) => t.implemented).map((t) => t.name)
}

// ---- one loopback HTTP MCP server for the whole app ---------------------------
//
// Streamable-HTTP MCP, hand-rolled (JSON responses only — the CLI never needs
// the SSE leg for a tools-only server). Verified against the real CLI: a
// `{type:"http", url, headers:{Authorization}}` entry in --mcp-config reports
// `connected` and lists the tools, and the CLI echoes our Mcp-Session-Id back.
//
// Why HTTP and not the old stdio relay + unix socket: the relay design needed a
// script on disk, a socket file per launch (which piled up after every crash /
// hot restart), a config that went stale the moment the socket uid changed, and
// a ZDOTDIR shim to smuggle the config into hand-typed CLIs. A loopback port +
// a per-run capability token has none of that state: nothing on disk, nothing
// to sweep, and a stale config simply fails to connect instead of pointing at a
// dead socket. Same shape paseo uses (`/mcp/agents` + randomUUID token).
let server: http.Server | null = null
let baseUrl: string | null = null
let getWebContents: (() => WebContents | null) | null = null
// Random per run and only ever handed to processes riven spawns (or shells riven
// opens), so a config copied elsewhere cannot drive this app after a restart.
const authToken = randomUUID()
const sessionId = randomUUID()

const pending = new Map<string, (result: string) => void>()
const REQUEST_TIMEOUT_MS = 1_800_000 // 30 min — matches native (waits for the human)
const MAX_BODY_BYTES = 1024 * 1024

// Extra loopback routes (agent hooks post here too) share the port and token.
type RouteHandler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  body: string
) => void | Promise<void>
const routes = new Map<string, RouteHandler>()
export function registerHttpRoute(pathname: string, handler: RouteHandler): void {
  routes.set(pathname, handler)
}
export function mcpAuthToken(): string {
  return authToken
}
export function mcpBaseUrl(): string | null {
  return baseUrl
}

interface JsonRpcRequest {
  jsonrpc?: string
  id?: string | number | null
  method?: string
  params?: Record<string, unknown>
}

function toolDefs(enabled: Set<string> | null): Array<Record<string, unknown>> {
  return MCP_TOOLS.filter((t) => t.implemented && (!enabled || enabled.has(t.name))).map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema
  }))
}

// riven_api_request: run an HTTP request and return a compact status/headers/body
// summary. Body is truncated so a huge response doesn't flood the transcript.
async function runApiRequest(args: Record<string, unknown>): Promise<string> {
  const method = String(args.method ?? 'GET').toUpperCase()
  const url = String(args.url ?? '')
  if (!url) return 'error: url is required'
  const headers = (args.headers as Record<string, string>) ?? {}
  const body = args.body != null ? String(args.body) : undefined
  try {
    const res = await fetch(url, {
      method,
      headers,
      body: method === 'GET' || method === 'HEAD' ? undefined : body
    })
    const text = await res.text()
    const hdrs: string[] = []
    res.headers.forEach((v, k) => hdrs.push(`${k}: ${v}`))
    const clipped = text.length > 8000 ? text.slice(0, 8000) + '\n… (truncated)' : text
    return `HTTP ${res.status} ${res.statusText}\n${hdrs.join('\n')}\n\n${clipped}`
  } catch (e) {
    return `error: ${e instanceof Error ? e.message : String(e)}`
  }
}

// Run one tool call. UI tools round-trip through the renderer (mcp:invoke →
// mcp:result); pure-network ones run right here so they work with no window.
function invokeTool(
  tool: string,
  args: Record<string, unknown>,
  cwd: string | null,
  key: string | null,
  onAbort: (cancel: () => void) => void
): Promise<string> {
  if (tool === 'riven_api_request') return runApiRequest(args)
  if (!TOOL_BY_NAME.get(tool)?.implemented) return Promise.resolve(`error: unknown tool ${tool}`)
  const wc = getWebContents?.()
  if (!wc || wc.isDestroyed()) return Promise.resolve('riven: no window available')
  return new Promise((resolve) => {
    const id = randomUUID()
    const timer = setTimeout(() => {
      if (pending.delete(id)) resolve('riven: timed out waiting for the user')
    }, REQUEST_TIMEOUT_MS)
    pending.set(id, (result) => {
      clearTimeout(timer)
      resolve(result)
    })
    // The agent hung up (killed, or its own timeout): stop waiting on the user.
    onAbort(() => {
      if (pending.delete(id)) clearTimeout(timer)
    })
    wc.send('mcp:invoke', { id, tool, args, cwd, key })
  })
}

function readBody(req: http.IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    let body = ''
    let over = false
    req.setEncoding('utf8')
    req.on('data', (d: string) => {
      if (over) return
      body += d
      if (body.length > MAX_BODY_BYTES) over = true
    })
    req.on('end', () => resolve(over ? null : body))
    req.on('error', () => resolve(null))
  })
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  const text = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
    'mcp-session-id': sessionId
  })
  res.end(text)
}

async function handleMcp(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  body: string
): Promise<void> {
  if (req.method === 'DELETE') {
    res.writeHead(200).end()
    return
  }
  if (req.method !== 'POST') {
    res.writeHead(405, { allow: 'POST, DELETE' }).end()
    return
  }
  let msg: JsonRpcRequest
  try {
    msg = JSON.parse(body) as JsonRpcRequest
  } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })
    return
  }
  const id = msg.id
  // Notifications (no id) are acknowledged and otherwise ignored.
  if (id === undefined || id === null) {
    res.writeHead(202).end()
    return
  }
  const pane = url.searchParams.get('pane')
  const toolsParam = url.searchParams.get('tools')
  const enabled = toolsParam ? new Set(toolsParam.split(',').filter(Boolean)) : null
  const params = msg.params ?? {}
  switch (msg.method) {
    case 'initialize':
      sendJson(res, 200, {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: (params.protocolVersion as string) || '2025-03-26',
          capabilities: { tools: {} },
          serverInfo: { name: 'riven', version: '2.0' }
        }
      })
      return
    case 'ping':
      sendJson(res, 200, { jsonrpc: '2.0', id, result: {} })
      return
    case 'tools/list':
      sendJson(res, 200, { jsonrpc: '2.0', id, result: { tools: toolDefs(enabled) } })
      return
    case 'tools/call': {
      const name = String(params.name ?? '')
      const args = (params.arguments as Record<string, unknown>) ?? {}
      // Every agent riven starts — chat pane or terminal shell — carries the key
      // of the pane it runs in on its URL, so the renderer routes the call to
      // that pane's workspace. `cwd` is only for a config built by hand.
      const cwd = url.searchParams.get('cwd')
      const text = await invokeTool(name, args, cwd, pane, (cancel) => res.on('close', cancel))
      if (res.destroyed) return
      sendJson(res, 200, {
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: text || '(no result)' }] }
      })
      return
    }
    default:
      sendJson(res, 200, {
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `unknown method ${msg.method}` }
      })
  }
}

function isAuthorized(req: http.IncomingMessage, url: URL): boolean {
  const header = req.headers.authorization
  if (header === `Bearer ${authToken}`) return true
  // Hook commands are shell one-liners; a query token keeps them dependency-free.
  return url.searchParams.get('token') === authToken
}

// Called once from index.ts with a getter for the main window's web contents.
export function registerMcpServer(webContentsGetter: () => WebContents | null): void {
  getWebContents = webContentsGetter

  ipcMain.on('mcp:result', (_e, payload: { id: string; result: string }) => {
    const resolve = pending.get(payload.id)
    if (resolve) {
      pending.delete(payload.id)
      resolve(payload.result ?? '')
    }
  })

  routes.set('/mcp', handleMcp)
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (!isAuthorized(req, url)) {
      res.writeHead(401).end()
      return
    }
    const handler = routes.get(url.pathname)
    if (!handler) {
      res.writeHead(404).end()
      return
    }
    void readBody(req).then((body) => {
      if (body === null) {
        res.writeHead(413).end()
        return
      }
      Promise.resolve(handler(req, res, url, body)).catch((e) => {
        console.error('[mcp] route failed', url.pathname, e)
        if (!res.headersSent) res.writeHead(500).end()
      })
    })
  })
  // A tools/call can legitimately sit for minutes while the user answers
  // ask_user; Node's default 5-minute requestTimeout would drop it mid-wait.
  server.requestTimeout = 0
  server.headersTimeout = 60_000
  server.keepAliveTimeout = 65_000
  server.on('error', (e) => console.error('[mcp] http error', e))
  server.listen(0, '127.0.0.1', () => {
    const addr = server?.address()
    if (addr && typeof addr === 'object') baseUrl = `http://127.0.0.1:${addr.port}`
  })
}

// The --mcp-config value for one agent: inline JSON (the CLI accepts it as the
// argument itself, so nothing is written to disk). `enabled` narrows the
// advertised tools to what the user left on; `pane` tags every call this agent
// makes with the chat pane it IS, so the renderer can route results back to
// that exact conversation instead of the one the user happens to be viewing.
export function mcpConfigJson(enabled?: string[], pane?: string | null): string | null {
  if (!baseUrl) return null
  const allow = enabled ? new Set(enabled) : null
  const defs = toolDefs(allow)
  if (defs.length === 0) return null
  const url = new URL('/mcp', baseUrl)
  if (pane) url.searchParams.set('pane', pane)
  if (allow) url.searchParams.set('tools', defs.map((d) => d.name as string).join(','))
  return JSON.stringify({
    mcpServers: {
      riven: {
        type: 'http',
        url: url.toString(),
        headers: { Authorization: `Bearer ${authToken}` }
      }
    }
  })
}

// allowedTools entry so every riven tool auto-approves (like native toolPrefix).
export const MCP_TOOL_PREFIX = 'mcp__riven'

// Documents the tools for the agent (--append-system-prompt), mirroring native.
export function mcpSystemPrompt(): string {
  return `이 세션에는 riven이 제공하는 도구가 있습니다. 적절할 때 사용하세요:
- 사용자에게 선택지를 물을 땐 번호 목록을 쓰지 말고 ask_user(question, options)를 호출하세요(방향키로 고른 값을 돌려줍니다).
- 코드/파일을 사용자와 함께 볼 땐 riven_open_file(path, line?)로 riven 에디터에 엽니다.
- riven의 패널/워크스페이스를 파악·조작할 수 있습니다: riven_panels(현재 패널 목록), riven_open_panel(kind), riven_close_panel(id), riven_workspaces, riven_open_workspace(path).
- HTTP/API 테스트는 riven_api_request(method, url, headers?, body?)로 실행하고 상태/본문을 돌려받습니다.
- riven 브라우저를 직접 운전할 수 있습니다: riven_browser_open(url, new_tab?), riven_browser_state(), riven_browser_read(selector?, html?), riven_browser_click/fill/wait/scroll, riven_browser_go(action), riven_screenshot(url?). 페이지는 쿠키·세션을 유지합니다.
- 긴 결과(요약·계획·조사)는 대화에 쏟지 말고 riven_note_write(title, body, note?)로 메모에 남기세요(note 주면 갈아끼움). 이어쓰기 riven_note_append, 읽기 riven_note_read, 목록 riven_note_list. 문서로 저장소에 남길 땐 riven_doc_write(path, body)(.claude/docs 기준), 메모를 파일로는 riven_note_save_file.
- 다른 에이전트와 협업: riven_agents로 열린 동료를 확인하고, riven_ask_agent(agent, message)로 위임한 뒤 답을 받습니다. 여러 명에 동시에는 riven_ask_agents(tasks=[{agent,message}…]). 새 동료는 riven_group_add_agent(group, name, persona?). 여러 단계를 순서대로 거칠 일은 riven_start_pipeline(name, task, stages=[{name, instruction}…])로 직렬 파이프라인을 돌립니다.`
}

export function stopMcpServer(): void {
  try {
    server?.close()
  } catch {
    /* ignore */
  }
  pending.forEach((resolve) => resolve('riven: shutting down'))
  pending.clear()
}

export { TOOL_BY_NAME }
