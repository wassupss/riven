import { describe, expect, it } from 'vitest'
import {
  buildTurns,
  canSendQueued,
  lineDiff,
  toolCode,
  compose,
  initialModel,
  isImagePath,
  lastModel,
  mention,
  modeValue,
  outgoing,
  questionAnswers,
  questionsOf,
  recordOf,
  reduce,
  tokens,
  toolSummary,
  userParts,
  type Attachment,
  type CliEvent,
  type CliItem
} from './cliChat'

const K = 'clichat-1'

// The items services/clichat sends for one turn with a tool (hand-written in
// the shape transcript.rs produces).
const turn: CliItem[] = [
  { kind: 'user', key: 'u1:0', text: 'make a note', command: null, images: 0 },
  { kind: 'thinking', key: 'm1:0', text: '' },
  { kind: 'usage', key: 'm1:1', msgId: 'msg_1', model: 'haiku', input: 2, cacheWrite: 100, cacheRead: 900, output: 30 },
  { kind: 'tool', key: 'm2:0', toolId: 't1', name: 'Write', input: { file_path: '/w/note.txt', content: 'hi' } },
  { kind: 'toolResult', key: 'r1:0', toolId: 't1', text: 'File created', isError: false },
  { kind: 'text', key: 'm3:0', msgId: 'msg_2', text: 'written' },
  { kind: 'usage', key: 'm3:1', msgId: 'msg_2', model: 'haiku', input: 2, cacheWrite: 5, cacheRead: 1000, output: 3 },
  { kind: 'turnEnd', key: 'd1:0', durationMs: 1200 }
]

describe('cliChat reduce', () => {
  it('appends, dedupes and resets items', () => {
    let m = initialModel()
    m = reduce(m, { key: K, kind: 'items', reset: false, items: turn.slice(0, 3) })
    m = reduce(m, { key: K, kind: 'items', reset: false, items: turn.slice(2) })
    expect(m.items.map((i) => i.key)).toEqual(turn.map((i) => i.key))
    m = reduce(m, { key: K, kind: 'items', reset: true, items: [turn[0]] })
    expect(m.items).toHaveLength(1)
  })

  it('drops the preview when a turn ends, keeps it while busy', () => {
    const state = (busy: boolean): CliEvent => ({
      key: K,
      kind: 'state',
      busy,
      waiting: false,
      ready: true,
      blocked: null,
      sessionId: 's',
      dead: false,
      terminal: false
    })
    let m = reduce(initialModel(), state(true))
    m = reduce(m, { key: K, kind: 'preview', text: 'one\ntwo' })
    m = reduce(m, state(true))
    expect(m.preview).toBe('one\ntwo')
    m = reduce(m, state(false))
    expect(m.preview).toBeNull()
  })

  it('tracks permission cards until answered or the session dies', () => {
    let m = reduce(initialModel(), { key: K, kind: 'permission', id: 'p1', tool: 'Bash', input: { command: 'ls' } })
    m = reduce(m, { key: K, kind: 'permission', id: 'p1', tool: 'Bash', input: {} })
    expect(m.permissions).toHaveLength(1)
    m = reduce(m, { key: K, kind: 'permissionDone', id: 'p1', decision: 'allow' })
    expect(m.permissions).toHaveLength(0)
    m = reduce(m, { key: K, kind: 'permission', id: 'p2', tool: null, input: null })
    m = reduce(m, { key: K, kind: 'exit', code: 0 })
    expect(m.permissions).toHaveLength(0)
    expect(m.state.dead).toBe(true)
  })
})

describe('buildTurns', () => {
  it('groups a turn, attaches the tool result and sums usage once per item', () => {
    const [t] = buildTurns(turn)
    expect(t.user?.text).toBe('make a note')
    expect(t.blocks.map((b) => b.kind)).toEqual(['thinking', 'tool', 'text'])
    const tool = t.blocks[1]
    expect(tool.kind === 'tool' && tool.tool.result?.text).toBe('File created')
    expect(t.usage).toEqual({ requests: 2, input: 4, cacheWrite: 105, cacheRead: 1900, output: 33 })
    expect(t.durationMs).toBe(1200)
  })

  it('starts a new stretch at a compaction and tolerates items before any prompt', () => {
    const turns = buildTurns([
      { kind: 'note', key: 'n:0', level: 'command', text: 'Set model' },
      ...turn,
      { kind: 'compact', key: 'c:0', trigger: 'manual', preTokens: 5000 },
      { kind: 'note', key: 's:0', level: 'summary', text: 'summary' },
      { kind: 'toolResult', key: 'x:0', toolId: 'missing', text: 'orphan', isError: true }
    ])
    expect(turns).toHaveLength(3)
    expect(turns[0].user).toBeNull()
    expect(turns[2].blocks.map((b) => b.kind)).toEqual(['compact', 'note'])
  })
})

describe('helpers', () => {
  it('summarises tools by their recognisable argument', () => {
    expect(toolSummary('Bash', { command: 'npm test\n--watch' })).toBe('npm test')
    expect(toolSummary('Read', { file_path: '/a/b.ts' })).toBe('/a/b.ts')
    expect(toolSummary('X', null)).toBe('')
    expect(toolSummary('Grep', { pattern: 'x'.repeat(200) }).length).toBe(141)
  })

  it('formats tokens and cleans outgoing text', () => {
    expect(tokens(999)).toBe('999')
    expect(tokens(46698)).toBe('46.7k')
    expect(tokens(205272)).toBe('205k')
    expect(outgoing('  hi  \n')).toBe('  hi')
    expect(outgoing(' / ')).toBeNull()
    expect(outgoing('/compact')).toBe('/compact')
  })
})

describe('attachments', () => {
  it('mentions files the way the CLI reads them', () => {
    expect(mention('/w/src/a.ts')).toBe('@/w/src/a.ts')
    // As sent in the live probe: a path with a space, quoted.
    expect(mention('/t/att/notes file.txt')).toBe('@"/t/att/notes file.txt"')
    expect(mention('/t/say "hi".md')).toBe('@"/t/say \\"hi\\".md"')
    expect(isImagePath('/a/Shot.PNG') && isImagePath('x.jpeg') && !isImagePath('x.heic')).toBe(true)
  })

  it('composes text, file mentions and image pastes', () => {
    const atts: Attachment[] = [
      { id: '1', name: 'red square.png', path: '/t/red square.png', image: true },
      { id: '2', name: 'notes file.txt', path: '/t/notes file.txt', image: false },
      { id: '3', name: 'b.rs', path: '/w/b.rs', image: false }
    ]
    expect(compose('look at these  \n', atts)).toEqual({
      text: 'look at these @"/t/notes file.txt" @/w/b.rs',
      images: ['/t/red square.png']
    })
    expect(compose('', [atts[0]])).toEqual({ text: '', images: ['/t/red square.png'] })
  })

  it('draws a sent message: image markers out, mentions as chips', () => {
    // The text 2.1.330 recorded for the probe's two messages.
    expect(userParts('What color is this image? One word.[Image #1]')).toEqual([
      { kind: 'text', text: 'What color is this image? One word.' }
    ])
    expect(userParts('Tell me the secret word in @"/t/att/notes file.txt" in one word.')).toEqual([
      { kind: 'text', text: 'Tell me the secret word in ' },
      { kind: 'file', path: '/t/att/notes file.txt', name: 'notes file.txt' },
      { kind: 'text', text: ' in one word.' }
    ])
    expect(userParts('ask @alice about @src/x.ts')).toEqual([
      { kind: 'text', text: 'ask @alice about ' },
      { kind: 'file', path: 'src/x.ts', name: 'x.ts' }
    ])
    expect(userParts('[Image #1][Image #2]')).toEqual([])
    expect(recordOf('b344ddc7-0072-4798-8816-d43ba2c73323:0')).toBe('b344ddc7-0072-4798-8816-d43ba2c73323')
  })
})

describe('header, questions, agents', () => {
  it('reads the model of the last reply and folds modes', () => {
    expect(lastModel(turn)).toBe('haiku')
    expect(lastModel([])).toBeNull()
    expect(modeValue('manual')).toBe('default')
    expect(modeValue(null)).toBe('default')
    expect(modeValue('plan')).toBe('plan')
  })

  it('builds AskUserQuestion answers from the card', () => {
    // The input 2.1.330 sent with its PermissionRequest (plus a multi-select).
    const qs = questionsOf({
      questions: [
        { question: 'Which fruit do you prefer?', header: 'Fruit', multiSelect: false, options: [{ label: 'Apple' }, { label: 'Banana' }] },
        { question: 'Sides?', multiSelect: true, options: [{ label: 'A' }, { label: 'B' }, { bad: 1 }] }
      ]
    })
    expect(qs[1].options).toHaveLength(2)
    expect(questionAnswers(qs, { 0: ['Banana'] }, {})).toBeNull()
    expect(questionAnswers(qs, { 0: ['Banana'], 1: ['A', 'B'] }, {})).toEqual({
      'Which fruit do you prefer?': 'Banana',
      'Sides?': ['A', 'B']
    })
    expect(questionAnswers(qs, { 1: ['A'] }, { 0: ' Kiwi ', 1: 'C' })).toEqual({
      'Which fruit do you prefer?': 'Kiwi',
      'Sides?': ['A', 'C']
    })
    expect(questionsOf(null)).toEqual([])
  })

  it('keeps questions apart from permissions and indexes agents by their call', () => {
    let m = reduce(initialModel(), { key: K, kind: 'question', id: 'q1', tool: 'AskUserQuestion', input: { questions: [] } })
    m = reduce(m, { key: K, kind: 'permission', id: 'p1', tool: 'Bash', input: {} })
    expect([m.questions.length, m.permissions.length]).toEqual([1, 1])
    m = reduce(m, { key: K, kind: 'permissionDone', id: 'q1', decision: 'terminal' })
    expect([m.questions.length, m.permissions.length]).toEqual([0, 1])
    m = reduce(m, {
      key: K,
      kind: 'agents',
      agents: [
        { agentId: 'a1', toolId: 'toolu_1', description: 'Run echo', agentType: 'general-purpose', tools: 1, lastTool: 'Bash: echo', lastText: null, done: false }
      ]
    })
    expect(m.agents.toolu_1.tools).toBe(1)
    m = reduce(m, { key: K, kind: 'meta', title: 'Image color question' })
    expect(m.title).toBe('Image color question')
  })
})

describe('tool code', () => {
  it('diffs an edit by lines', () => {
    expect(lineDiff('a\nb\nc', 'a\nx\nc')).toBe(' a\n-b\n+x\n c')
    expect(lineDiff('', 'x')).toBe('+x')
  })
  it('picks what a tool row shows', () => {
    expect(toolCode('Edit', { file_path: '/a', old_string: 'x', new_string: 'y' })).toEqual({ code: '-x\n+y', diff: true, path: '/a' })
    expect(toolCode('Bash', { command: 'ls' })).toEqual({ code: 'ls', diff: false, path: null })
    expect(toolCode('MultiEdit', { file_path: '/a', edits: [{ old_string: 'a', new_string: 'b' }] })?.code).toBe('-a\n+b')
    expect(toolCode('Read', { file_path: '/a' })).toBeNull()
  })
})

describe('queue', () => {
  const idle = initialModel().state
  it('sends the next queued message only into a free CLI', () => {
    expect(canSendQueued({ ...idle, ready: true })).toBe(true)
    expect(canSendQueued({ ...idle, ready: true, busy: true })).toBe(false)
    expect(canSendQueued({ ...idle, ready: true, waiting: true })).toBe(false)
    expect(canSendQueued({ ...idle, ready: true, menu: { title: '', options: [], selected: 0 } })).toBe(false)
    expect(canSendQueued({ ...idle, ready: false })).toBe(false)
    expect(canSendQueued({ ...idle, parked: true })).toBe(true)
    expect(canSendQueued({ ...idle, ready: true, dead: true })).toBe(false)
    expect(canSendQueued({ ...idle, ready: true, terminal: true })).toBe(false)
  })
})
