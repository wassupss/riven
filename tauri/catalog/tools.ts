// riven's MCP tool catalog: the tool definitions, their schemas and the prompt the
// agent is given. The Rust MCP server (src-tauri/src/services/mcp) serves them;
// tauri/build.mjs writes this into catalog.json. Nothing here runs at app time.

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
// `advertised: false` keeps a tool callable (a session that learned it still
// works) while no longer listing it to new ones — for a tool another one covers.
export const MCP_TOOLS: Array<McpToolDef & { implemented: boolean; advertised?: boolean }> = [
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
      "Open a panel. kind: editor|terminal|chat|search|git|preview|changes|db. For an agent use kind=chat: `agent` claude|codex, `model` (claude: opus|sonnet|haiku|fable; codex: gpt-5.6-terra|gpt-5.6-luna|gpt-5.5), `title`. `message` is sent as its first prompt without waiting; for an answer, omit it and call riven_ask_agent. Use kind=terminal with `command` only for non-agent commands or on user request. `dir`: right|below|left|above. Returns pane id.",
    inputSchema: obj({ kind: str, command: str, dir: str, agent: str, model: str, message: str, title: str }, ['kind']),
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
    implemented: true,
    // riven_browser_open does the same and more; listing both cost every
    // Codex request its schema for nothing.
    advertised: false
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
      "List this workspace's agents — chat panes and terminals running a CLI agent: id, title, kind, cli (claude|codex), busy, replies (whether riven_ask_agent returns its answer). Check before delegating.",
    inputSchema: obj({}),
    implemented: true
  },
  {
    name: 'riven_ask_agent',
    ko: '에이전트에 위임',
    en: 'Delegate to an agent',
    description:
      "Delegate to another agent (`agent` = title or id from riven_agents). Returns its answer to THIS message (if it is mid-turn, after that turn). wait=false runs it in the background: returns at once and the answer reaches you as a new turn when done — don't poll. A terminal agent is typed into; its answer returns only if riven_agents shows replies=true. A busy one is refused — retry when idle.",
    inputSchema: obj({ agent: str, message: str, wait: bool }, ['agent', 'message']),
    implemented: true
  },
  {
    name: 'riven_ask_agents',
    ko: '여러 에이전트에 위임',
    en: 'Delegate to agents',
    description:
      'Delegate to SEVERAL agents at once (parallel). By default waits and returns every reply; wait=false runs them in the background, each answer delivered to you as it lands.',
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
      "Open a new agent pane and record it in `group` (created if new). `agent` claude|codex (teams may mix), `model`, `persona`, `name` = nickname, `parent` = the member it reports to. To add an agent that is already open (incl. a CLI in a riven terminal) instead of spawning one, pass `pane` (id from riven_agents); it keeps its conversation.",
    inputSchema: obj(
      { group: str, name: str, persona: str, model: str, parent: str, agent: str, pane: str },
      ['group']
    ),
    implemented: true
  },
  {
    name: 'riven_group_remove_agent',
    ko: '그룹에서 에이전트 제거',
    en: 'Remove agent from group',
    description:
      "Close one of the group's agent panes and drop it from that group's roster (the group is " +
      'searched first, so two groups may both have a "reviewer"). Asks the user to confirm first ' +
      '(destructive).',
    inputSchema: obj({ group: str, name: str }, ['group', 'name']),
    implemented: true
  },
  {
    name: 'riven_group_delete',
    ko: '그룹 삭제',
    en: 'Delete group',
    description:
      "Close the panes of THIS group's members and remove the group. Other agents and the user's own " +
      'conversations are left alone. Asks the user to confirm first (destructive).',
    inputSchema: obj({ group: str }, ['group']),
    implemented: true
  },
  {
    name: 'riven_group_broadcast',
    ko: '그룹 전체에 전달',
    en: 'Broadcast to group',
    description:
      "Send one message to every other member of `group` and return all answers together (wait=false: in the background, each answer delivered to you when it lands). Each is asked in its own turn, so nobody is interrupted.",
    inputSchema: obj({ group: str, message: str, wait: bool }, ['group', 'message']),
    implemented: true
  },
  {
    name: 'riven_goal_start',
    ko: '목표 시작',
    en: 'Start a goal',
    description:
      "Open a goal board for `group`: one shared place the team works a problem out. `done_when` = what finished looks like, in plain words (you decide when it holds). `artifact` = optional file the conclusion is written to. Returns the goal id.",
    inputSchema: obj({ group: str, goal: str, done_when: str, artifact: str }, [
      'group',
      'goal',
      'done_when'
    ]),
    implemented: true
  },
  {
    name: 'riven_goal_state',
    ko: '목표판 읽기',
    en: 'Read the goal board',
    description:
      'The whole board: the goal, what finished looks like, every post so far (who, which round, ' +
      'what kind) and the members. This is how a member catches up — nobody has to be told what the ' +
      'others said.',
    inputSchema: obj({ goal_id: str }, ['goal_id']),
    implemented: true
  },
  {
    name: 'riven_goal_post',
    ko: '목표판에 올리기',
    en: 'Post to the goal board',
    description:
      'Add your own entry to the board outside a round. kind: proposal | critique | revision | vote | note.',
    inputSchema: obj({ goal_id: str, kind: str, text: str }, ['goal_id', 'text']),
    implemented: true
  },
  {
    name: 'riven_goal_round',
    ko: '목표 라운드 실행',
    en: 'Run a goal round',
    description:
      "Ask every member ONE question with the board as context; each answer is posted to the board. kind: proposal (independent) | critique (attacks what is posted; set exclude_author=true) | revision | vote. Costs one turn per member.",
    inputSchema: obj({ goal_id: str, ask: str, kind: str, exclude_author: bool }, ['goal_id', 'ask']),
    implemented: true
  },
  {
    name: 'riven_goal_finish',
    ko: '목표 종료',
    en: 'Close the goal',
    description:
      'Declare it settled: `summary` is the conclusion, and it goes on the board (and into the ' +
      "goal's `artifact` file, if it was given one). Close it when done_when holds — nothing else " +
      'ends a goal except the user stopping it.',
    inputSchema: obj({ goal_id: str, summary: str }, ['goal_id', 'summary']),
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
  },
  {
    name: 'riven_db_connections',
    ko: 'DB: 데이터 소스 목록',
    en: 'DB: data sources',
    description: "List the user's saved database connections (name, kind, host, database, read-only). Use a name with the other riven_db_* tools.",
    inputSchema: obj({}),
    implemented: true
  },
  {
    name: 'riven_db_browse',
    ko: 'DB: 스키마/객체 탐색',
    en: 'DB: browse',
    description:
      'Browse a data source. Without schema: its schemas and the databases on the server. With schema: tables, views, sequences and routines (with row estimates and comments).',
    inputSchema: obj({ connection: str, database: str, schema: str }, ['connection']),
    implemented: true
  },
  {
    name: 'riven_db_describe',
    ko: 'DB: 테이블 구조',
    en: 'DB: describe',
    description:
      'Columns (type, null, default, PK, comment), constraints and indexes of a table or view. table may be schema-qualified. ddl=true returns the CREATE statement (also works for views, sequences, functions).',
    inputSchema: obj({ connection: str, table: str, schema: str, database: str, ddl: bool }, ['connection', 'table']),
    implemented: true
  },
  {
    name: 'riven_db_query',
    ko: 'DB: 읽기 쿼리',
    en: 'DB: read query',
    description:
      'Run ONE read-only SQL statement (SELECT/WITH/EXPLAIN/SHOW) in a read-only transaction with a 30s timeout. Returns a text table; limit defaults to 100 rows (max 1000). Writes and side-effect functions are refused.',
    inputSchema: obj({ connection: str, sql: str, database: str, limit: num }, ['connection', 'sql']),
    implemented: true
  },
  {
    name: 'riven_db_execute',
    ko: 'DB: 변경 실행(확인 필요)',
    en: 'DB: execute (confirmed)',
    description:
      'Run data/schema changes (INSERT/UPDATE/DELETE/DDL) in one transaction, all or nothing. The user sees the SQL and must approve it first; refused on read-only data sources.',
    inputSchema: obj({ connection: str, statements: { type: 'array', items: str }, database: str }, [
      'connection',
      'statements'
    ]),
    implemented: true
  }
]

const TOOL_BY_NAME = new Map(MCP_TOOLS.map((t) => [t.name, t]))

// Tool names this port can actually service (advertised to the agent).
export function implementedToolNames(): string[] {
  return MCP_TOOLS.filter((t) => t.implemented && t.advertised !== false).map((t) => t.name)
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

export const MCP_TOOL_PREFIX = 'mcp__riven'

// Documents the tools for the agent (--append-system-prompt), mirroring native.
// One line per area, each shown only when at least one of its tools is being
// advertised to this pane. It used to describe every tool unconditionally, so a
// user who switched the browser tools off still paid for — and the agent still
// read about — tools it could not call.
export const PROMPT_LINES: Array<[string[], string]> = [
  [['ask_user'], "- 사용자에게 선택지를 물을 땐 번호 목록을 쓰지 말고 ask_user(question, options)를 호출하세요(방향키로 고른 값을 돌려줍니다)."],
  [['riven_open_file'], "- 코드/파일을 사용자와 함께 볼 땐 riven_open_file(path, line?)로 riven 에디터에 엽니다."],
  [['riven_panels', 'riven_open_panel', 'riven_close_panel', 'riven_workspaces', 'riven_open_workspace'], "- riven의 패널/워크스페이스를 파악·조작할 수 있습니다: riven_panels(현재 패널 목록), riven_open_panel(kind, command?, dir?), riven_close_panel(id), riven_workspaces, riven_open_workspace(path). 에이전트(Claude Code·Codex)를 새로 띄울 땐 터미널이 아니라 채팅 패널로 엽니다: riven_open_panel(kind='chat', agent='codex', message='첫 지시', dir='right') — 돌려받은 패널 id로 riven_ask_agent를 쓸 수 있습니다. 터미널(kind='terminal', command=...)은 사용자가 터미널/CLI를 원할 때나 에이전트가 아닌 명령에만 씁니다."],
  [['riven_api_request'], "- HTTP/API 테스트는 riven_api_request(method, url, headers?, body?)로 실행하고 상태/본문을 돌려받습니다."],
  [['riven_db_connections', 'riven_db_browse', 'riven_db_describe', 'riven_db_query', 'riven_db_execute'], "- 사용자가 riven에 등록한 DB를 직접 볼 수 있습니다: riven_db_connections로 데이터 소스를 확인하고, riven_db_browse(connection, schema?)·riven_db_describe(connection, table)로 구조를 파악한 뒤 riven_db_query(connection, sql)로 읽기 쿼리를 실행합니다. 데이터·스키마 변경은 riven_db_execute(connection, statements)만 쓰며, 사용자가 SQL을 보고 승인해야 실행됩니다."],
  [['riven_browser_open', 'riven_browser_state', 'riven_browser_read', 'riven_browser_click', 'riven_screenshot'], "- riven 브라우저를 직접 운전할 수 있습니다: riven_browser_open(url, new_tab?), riven_browser_state(), riven_browser_read(selector?, html?), riven_browser_click/fill/wait/scroll, riven_browser_go(action), riven_screenshot(url?). 페이지는 쿠키·세션을 유지합니다."],
  [['riven_note_write', 'riven_note_append', 'riven_note_read', 'riven_note_list', 'riven_doc_write'], "- 긴 결과(요약·계획·조사)는 대화에 쏟지 말고 riven_note_write(title, body, note?)로 메모에 남기세요(note 주면 갈아끼움). 이어쓰기 riven_note_append, 읽기 riven_note_read, 목록 riven_note_list. 문서로 저장소에 남길 땐 riven_doc_write(path, body)(.claude/docs 기준), 메모를 파일로는 riven_note_save_file."],
  [['riven_agents', 'riven_ask_agent', 'riven_ask_agents', 'riven_group_add_agent', 'riven_start_pipeline'], "- 다른 에이전트와 협업: riven_agents로 열린 동료(채팅·터미널의 Claude Code, Codex 등 — cli 필드로 구분)를 확인하고, riven_ask_agent(agent, message)로 위임한 뒤 답을 받습니다. 다른 모델에게 검토·반론을 맡기면 서로의 결과를 교차 확인할 수 있습니다. 여러 명에 동시에는 riven_ask_agents(tasks=[{agent,message}…]). 새 동료는 riven_group_add_agent(group, name, persona?). 여러 단계를 순서대로 거칠 일은 riven_start_pipeline(name, task, stages=[{name, instruction}…])로 직렬 파이프라인을 돌립니다."]
]

export const PROMPT_HEAD = '이 세션에는 riven이 제공하는 도구가 있습니다. 적절할 때 사용하세요:'

