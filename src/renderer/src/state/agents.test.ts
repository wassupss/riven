import { beforeEach, describe, expect, it } from 'vitest'
import { askChatTurn, listAgents, registerAgent, renameAgent, resolveAgent, type AgentController } from './agents'

// The agent roster is what riven_agents / riven_ask_agent resolve against. It is
// GLOBAL (one map for every workspace), so the workspace filter is the only
// thing stopping a delegation from crossing into a workspace the caller cannot
// see. These tests pin that filter down.

let disposers: Array<() => void> = []

function agent(chatKey: string, workspace: string, title: string): void {
  let current = title
  disposers.push(
    registerAgent({
      chatKey,
      workspace,
      getTitle: () => current,
      setTitle: (t) => {
        current = t
      },
      isBusy: () => false,
      send: () => {},
      waitNext: () => Promise.resolve('')
    })
  )
}

beforeEach(() => {
  for (const d of disposers) d()
  disposers = []
})

describe('roster scoping', () => {
  it('listAgents returns only the given workspace', () => {
    agent('chat-1', 'ws-a', '코더')
    agent('chat-2', 'ws-b', '리뷰어')
    expect(listAgents('ws-a').map((a) => a.id)).toEqual(['chat-1'])
    expect(listAgents('ws-b').map((a) => a.id)).toEqual(['chat-2'])
    // No workspace = every agent (the settings/debug view, not a tool call).
    expect(listAgents().length).toBe(2)
  })

  it('a fuzzy title match cannot reach another workspace', () => {
    agent('chat-1', 'ws-a', '코더 · 백엔드')
    agent('chat-2', 'ws-b', '코더 · 프론트')
    // Unscoped, "코더" matches whichever pane happens to come first — that is the
    // bug: a delegation in ws-a landed on ws-b's pane.
    expect(resolveAgent('코더', undefined, 'ws-a')?.chatKey).toBe('chat-1')
    expect(resolveAgent('코더', undefined, 'ws-b')?.chatKey).toBe('chat-2')
  })

  it('a key from another workspace does not resolve', () => {
    agent('chat-1', 'ws-a', '코더')
    expect(resolveAgent('chat-1', undefined, 'ws-b')).toBeNull()
    expect(resolveAgent('chat-1', undefined, 'ws-a')?.chatKey).toBe('chat-1')
  })

  it('excludes the caller so an agent cannot delegate to itself', () => {
    agent('chat-1', 'ws-a', '코더')
    agent('chat-2', 'ws-a', '코더 보조')
    expect(resolveAgent('코더', 'chat-1', 'ws-a')?.chatKey).toBe('chat-2')
  })
})

describe('renameAgent', () => {
  it('a tab rename becomes the name delegation resolves by', () => {
    agent('chat-1', 'ws-a', '새 채팅')
    renameAgent('chat-1', '배포 담당')
    expect(listAgents('ws-a')[0].title).toBe('배포 담당')
    expect(resolveAgent('배포 담당', undefined, 'ws-a')?.chatKey).toBe('chat-1')
    // The name it was renamed away from must stop resolving, or two names point
    // at one pane and the agent cannot tell which is current.
    expect(resolveAgent('새 채팅', undefined, 'ws-a')).toBeNull()
  })

  it('is a no-op for a pane that is not a registered agent', () => {
    expect(() => renameAgent('term-9', 'whatever')).not.toThrow()
  })
})

// A fake chat pane: each sent message becomes a turn that takes `ms` and answers
// "re: <message>". Waiters resolve with whichever turn completes next.
function fakePane(opening?: string): { pane: AgentController; sent: string[] } {
  const sent: string[] = []
  let busy = false
  let queue: string[] = []
  let waiters: Array<(r: string) => void> = []
  let pending = opening
  const run = (): void => {
    const msg = queue.shift()
    if (msg === undefined) return
    busy = true
    setTimeout(() => {
      busy = false
      const ws = waiters
      waiters = []
      for (const w of ws) w(`re: ${msg}`)
      run()
    }, 40)
  }
  const pane: AgentController = {
    chatKey: 'chat-x',
    workspace: 'ws',
    getTitle: () => 'x',
    isBusy: () => busy,
    send: (t) => {
      sent.push(t)
      queue.push(t)
      if (!busy) run()
    },
    waitNext: () => new Promise((r) => waiters.push(r)),
    hasPendingOpening: () => pending !== undefined
  }
  if (opening !== undefined)
    setTimeout(() => {
      pending = undefined
      pane.send(opening)
    }, 30)
  return { pane, sent }
}

describe('askChatTurn', () => {
  it('returns the answer to its own message, not to a turn already running', async () => {
    const { pane, sent } = fakePane()
    pane.send('role priming')
    expect(await askChatTurn(pane, 'dinner?', 2000, 'timeout')).toBe('re: dinner?')
    expect(sent).toEqual(['role priming', 'dinner?'])
  })

  it('waits for the message a pane was opened with', async () => {
    const { pane, sent } = fakePane('opening')
    expect(await askChatTurn(pane, 'question', 2000, 'timeout')).toBe('re: question')
    expect(sent).toEqual(['opening', 'question'])
  })

  it('gives up at the deadline', async () => {
    const pane: AgentController = {
      chatKey: 'c',
      workspace: 'w',
      getTitle: () => 'c',
      isBusy: () => true,
      send: () => {},
      waitNext: () => new Promise(() => {})
    }
    expect(await askChatTurn(pane, 'q', 100, 'timeout')).toBe('timeout')
  })
})
