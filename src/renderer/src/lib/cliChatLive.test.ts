import { describe, expect, it } from 'vitest'
import type { CliEvent } from './cliChat'
import {
  finishedTasks,
  foldLive,
  liveWork,
  menuAsks,
  menuId,
  menuPick,
  notifyBody,
  permissionAsks,
  permissionDecision,
  questionAnswersFrom,
  questionAsks,
  rosterPatch,
  type CliLive
} from './cliChatLive'

const state = (p: Partial<Extract<CliEvent, { kind: 'state' }>> = {}): CliEvent => ({
  key: 'chat-1',
  kind: 'state',
  busy: false,
  waiting: false,
  ready: true,
  blocked: null,
  sessionId: 's-1',
  dead: false,
  terminal: false,
  ...p
})

const labels = { allow: 'Allow', deny: 'Deny', permTitle: (tool: string) => `Allow ${tool}?` }

describe('foldLive', () => {
  it('follows a turn from start to its answer', () => {
    let l: CliLive | undefined
    const step = (e: CliEvent, now: number): ReturnType<typeof foldLive> => {
      const r = foldLive(l, e, now)
      l = r.live
      return r
    }
    expect(step(state({ busy: true }), 10).done).toBeNull()
    expect(l?.busy).toBe(true)
    expect(rosterPatch(l!)).toEqual({ busy: true, attention: null })
    // A question: waiting on the person is not "working".
    step({ key: 'chat-1', kind: 'question', id: 'q', tool: 'AskUserQuestion', input: {} }, 20)
    expect(rosterPatch(l!)).toEqual({ busy: false, attention: 'needs_input' })
    step(state({ busy: true, waiting: false }), 30)
    const r = step({ key: 'chat-1', kind: 'turnDone', reply: 'hello', error: null, interrupted: false }, 40)
    expect(r.done).toEqual({ reply: 'hello', error: null, interrupted: false })
    expect(l?.busy).toBe(false)
    expect(l?.lastActivityAt).toBe(40)
    expect(l?.sessionId).toBe('s-1')
  })

  it('takes the title, the agents and an exit', () => {
    let l = foldLive(undefined, { key: 'k', kind: 'meta', title: 'Fix the build' }, 1).live
    expect(l.title).toBe('Fix the build')
    const agent = { agentId: 'a', toolId: 't', description: 'look', agentType: 'Explore', tools: 3, lastTool: null, lastText: null, done: false }
    l = foldLive(l, { key: 'k', kind: 'agents', agents: [agent] }, 2).live
    expect(liveWork(l, 5).agents).toEqual([{ id: 'a', label: 'look', since: 5, steps: 3, lastActivityAt: 5 }])
    l = foldLive(l, { key: 'k', kind: 'exit', code: 0 }, 3).live
    expect(l.dead && !l.busy).toBe(true)
  })

  it('a menu on screen is waiting on the person', () => {
    const menu = { title: 'Ready to code?', options: [{ label: 'Yes', input: false }], selected: 0 }
    const l = foldLive(undefined, state({ busy: true, menu }), 1).live
    expect(rosterPatch(l)).toEqual({ busy: false, attention: 'needs_input' })
  })

  it('background tasks are the pane work', () => {
    const l = foldLive(undefined, state({ background: [{ id: 'b1', type: 'bash', description: 'npm test' }] }), 1).live
    expect(liveWork(l, 1).bg).toEqual([{ id: 'b1', label: 'npm test' }])
  })
})

describe('the ask queue mirror', () => {
  it('a permission is one yes/no question', () => {
    const [a] = permissionAsks('Bash', { command: 'ls -la' }, labels)
    expect(a).toEqual({ question: 'Allow Bash?\nls -la', options: ['Allow', 'Deny'] })
    expect(permissionDecision('Allow', labels)).toBe('allow')
    expect(permissionDecision('no thanks', labels)).toBe('deny')
  })

  it('AskUserQuestion is one ask per question, answered when all are', () => {
    const input = {
      questions: [
        { question: 'Which fruit?', header: 'Fruit', options: [{ label: 'Apple' }, { label: 'Banana' }] },
        { question: 'Which sides?', multiSelect: true, options: [{ label: 'A' }, { label: 'B' }] }
      ]
    }
    expect(questionAsks(input)).toEqual([
      { question: 'Fruit: Which fruit?', options: ['Apple', 'Banana'] },
      { question: 'Which sides?', options: ['A', 'B'] }
    ])
    expect(questionAnswersFrom(input, ['Banana'])).toBeNull()
    expect(questionAnswersFrom(input, ['Banana', ' typed '])).toEqual({ 'Which fruit?': 'Banana', 'Which sides?': 'typed' })
    expect(questionAnswersFrom({}, [])).toBeNull()
  })

  it('a menu row by label, or typed text for its text row', () => {
    const menu = {
      title: 'Would you like to proceed?',
      options: [
        { label: 'Yes, and auto-accept edits', input: false },
        { label: 'Yes, manually approve edits', input: false },
        { label: 'Tell Claude what to change', input: true }
      ],
      selected: 0
    }
    expect(menuAsks(menu)[0].options).toHaveLength(3)
    expect(menuPick(menu, 'Yes, manually approve edits')).toEqual({ index: 1 })
    expect(menuPick(menu, 'use a smaller diff')).toEqual({ index: 2, text: 'use a smaller diff' })
    expect(menuPick(menu, 'Tell Claude what to change')).toEqual({ index: 2 })
    expect(menuPick({ ...menu, options: menu.options.slice(0, 2) }, 'other')).toBeNull()
    expect(menuId(menu)).toBe(menuId({ ...menu, selected: 2 }))
  })

  it('a notification body is prose on one line', () => {
    expect(notifyBody('Done.\n```ts\nx\n```\nAll   good', 'fallback')).toBe('Done. All good')
    expect(notifyBody('  ', 'fallback')).toBe('fallback')
    expect(notifyBody('x'.repeat(200), '').length).toBe(161)
  })
})

describe('finished background tasks', () => {
  it('reports what stopped running', () => {
    const a = { id: 'a', status: 'running', description: 'dev server' }
    const b = { id: 'b', status: 'running', type: 'shell' }
    expect(finishedTasks([a, b], [{ ...b, status: 'failed' }])).toEqual([
      { id: 'a', label: 'dev server', status: 'completed' },
      { id: 'b', label: 'shell', status: 'failed' }
    ])
    expect(finishedTasks([a], [a])).toEqual([])
    expect(finishedTasks([{ ...a, status: 'completed' }], [])).toEqual([])
  })
})
