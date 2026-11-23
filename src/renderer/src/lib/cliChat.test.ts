import { describe, expect, it } from 'vitest'
import { buildTurns, initialModel, outgoing, reduce, tokens, toolSummary, type CliEvent, type CliItem } from './cliChat'

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
