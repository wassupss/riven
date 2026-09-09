import { beforeEach, describe, expect, it } from 'vitest'
import { listAgents, registerAgent, renameAgent, resolveAgent } from './agents'

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
