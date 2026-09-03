import { ipcMain, WebContents } from 'electron'
import * as net from 'net'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { randomUUID } from 'crypto'

// riven's OWN tools, exposed to the headless Claude CLI over MCP — things the CLI
// can't do itself or that should run inside riven's UI. Mirrors the native
// Agent/ChatAskServer.swift design: a tiny stdio MCP relay (Node, written to
// disk) is wired via --mcp-config; on a tools/call it forwards {tool,args,cwd}
// over a unix socket to THIS main process, which performs it (usually by asking
// the renderer) and returns the result string to the agent.
//
// Porting note vs native: native relayed to the Swift app over the socket; here
// the relay still uses a socket (the CLI spawns it as a separate process, so it
// can't call into Electron directly), but the main process owns everything and
// forwards UI work to the renderer via ipc instead of a second hop.

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

// ---- one shared socket server for the whole app ----
let sockPath: string | null = null
let relayPath: string | null = null
let toolsJsonPath: string | null = null
let configPath: string | null = null
let server: net.Server | null = null
let getWebContents: (() => WebContents | null) | null = null

const pending = new Map<string, (result: string) => void>()
const REQUEST_TIMEOUT_MS = 1_800_000 // 30 min — matches native (waits for the human)

function supportDir(): string {
  // A short base path: unix socket paths are capped at ~104 bytes on macOS, and
  // userData under "Application Support" is long — tmpdir keeps us well under.
  const d = path.join(os.tmpdir(), 'riven-mcp')
  try {
    fs.mkdirSync(d, { recursive: true })
  } catch {
    /* ignore */
  }
  return d
}

// The Node stdio MCP relay the CLI spawns. Reads the enabled tool defs from a
// json file (argv[3]) so schemas live in TS, and forwards each call over argv[2].
const RELAY_SOURCE = `
const net = require('net')
const fs = require('fs')
const SOCK = process.argv[2]
let TOOLS = []
try { TOOLS = JSON.parse(fs.readFileSync(process.argv[3], 'utf8')) } catch (e) { TOOLS = [] }
function send(m) { process.stdout.write(JSON.stringify(m) + '\\n') }
function call(tool, args) {
  return new Promise((resolve) => {
    const s = net.connect(SOCK)
    let buf = ''
    let done = false
    const finish = (v) => { if (!done) { done = true; resolve(v) } }
    // end() writes the request AND half-closes our write side (like native's
    // shutdown(SHUT_WR)) so the server sees 'end' and processes the call; the
    // read side stays open for the reply.
    s.on('connect', () => { s.end(JSON.stringify({ tool: tool, args: args, cwd: process.cwd() }) + '\\n') })
    s.on('data', (d) => { buf += d })
    s.on('close', () => finish(buf))
    s.on('error', () => finish('error: riven is not reachable'))
  })
}
let buffer = ''
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let nl
  while ((nl = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, nl).trim()
    buffer = buffer.slice(nl + 1)
    if (!line) continue
    let r
    try { r = JSON.parse(line) } catch (e) { continue }
    handle(r)
  }
})
async function handle(r) {
  const mid = r.id
  const m = r.method
  if (m === 'initialize') {
    send({ jsonrpc: '2.0', id: mid, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'riven', version: '1.0' } } })
  } else if (m === 'tools/list') {
    send({ jsonrpc: '2.0', id: mid, result: { tools: TOOLS } })
  } else if (m === 'tools/call') {
    const p = r.params || {}
    const out = await call(p.name || '', p.arguments || {})
    send({ jsonrpc: '2.0', id: mid, result: { content: [{ type: 'text', text: out || '(no result)' }] } })
  } else if (mid !== undefined && mid !== null) {
    send({ jsonrpc: '2.0', id: mid, error: { code: -32601, message: 'unknown method' } })
  }
}
`

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

function handleConnection(sock: net.Socket): void {
  let data = ''
  sock.setEncoding('utf8')
  sock.on('data', (d) => {
    data += d
  })
  sock.on('end', () => {
    let req: { tool?: string; args?: Record<string, unknown>; cwd?: string }
    try {
      req = JSON.parse(data)
    } catch {
      sock.end('')
      return
    }
    const tool = req.tool
    if (!tool) {
      sock.end('')
      return
    }
    // Tools that need no UI run right here in the main process (no CORS, works
    // even with no window focused).
    if (tool === 'riven_api_request') {
      void runApiRequest(req.args ?? {}).then((out) => sock.end(out))
      return
    }
    const wc = getWebContents?.()
    if (!wc || wc.isDestroyed()) {
      sock.end('riven: no window available')
      return
    }
    const id = randomUUID()
    const timer = setTimeout(() => {
      if (pending.delete(id)) sock.end('riven: timed out waiting for the user')
    }, REQUEST_TIMEOUT_MS)
    pending.set(id, (result) => {
      clearTimeout(timer)
      try {
        sock.end(result)
      } catch {
        /* client gone */
      }
    })
    wc.send('mcp:invoke', { id, tool, args: req.args ?? {}, cwd: req.cwd ?? null })
  })
  sock.on('error', () => {
    /* client vanished mid-call */
  })
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

  const dir = supportDir()
  const uid = randomUUID().slice(0, 8)
  sockPath = path.join(dir, `sock-${uid}.sock`)
  relayPath = path.join(dir, 'relay.cjs')
  toolsJsonPath = path.join(dir, 'tools.json')
  configPath = path.join(dir, 'config.json')

  try {
    fs.writeFileSync(relayPath, RELAY_SOURCE)
  } catch (e) {
    console.error('[mcp] failed to write relay', e)
    return
  }

  try {
    fs.rmSync(sockPath, { force: true })
  } catch {
    /* ignore */
  }
  // allowHalfOpen: the relay half-closes its write side (FIN) after sending the
  // request; without this Node would auto-close our side too, so we couldn't
  // write the (async) reply back after the renderer answers.
  server = net.createServer({ allowHalfOpen: true }, handleConnection)
  server.on('error', (e) => console.error('[mcp] socket error', e))
  server.listen(sockPath)
}

// Build the --mcp-config file for a session given the enabled tool names, and
// return its path. `enabled` comes from the renderer's settings; only tools that
// are BOTH implemented and enabled are advertised to the agent.
export function writeMcpConfig(enabled?: string[]): string | null {
  if (!sockPath || !relayPath || !toolsJsonPath || !configPath) return null
  const allow = enabled ? new Set(enabled) : null
  const defs = MCP_TOOLS.filter(
    (t) => t.implemented && (!allow || allow.has(t.name))
  ).map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }))
  try {
    fs.writeFileSync(toolsJsonPath, JSON.stringify(defs))
    // Run the relay as pure Node via the Electron binary (ELECTRON_RUN_AS_NODE),
    // so we don't depend on a `node` being on the CLI's PATH.
    const cfg = {
      mcpServers: {
        riven: {
          command: process.execPath,
          args: [relayPath, sockPath, toolsJsonPath],
          env: { ELECTRON_RUN_AS_NODE: '1' }
        }
      }
    }
    fs.writeFileSync(configPath, JSON.stringify(cfg))
    return configPath
  } catch (e) {
    console.error('[mcp] failed to write config', e)
    return null
  }
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
  if (sockPath) {
    try {
      fs.rmSync(sockPath, { force: true })
    } catch {
      /* ignore */
    }
  }
  pending.forEach((resolve) => resolve('riven: shutting down'))
  pending.clear()
}

export { TOOL_BY_NAME }
