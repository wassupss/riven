import { describe, it, expect, beforeEach } from 'vitest'
import { useAskUser } from './askUser'

const enqueue = (id: string, chatKey: string | null, resolve: (v: string) => void): void =>
  useAskUser.getState().enqueue({ id, chatKey, question: 'q?', options: ['a', 'b'], resolve })

describe('askUser store', () => {
  beforeEach(() => useAskUser.setState({ pending: [] }))

  it('answers and removes the request', () => {
    let got: string | null = null
    enqueue('1', 'chat-1', (v) => (got = v))
    useAskUser.getState().answer('1', 'a')
    expect(got).toBe('a')
    expect(useAskUser.getState().pending).toHaveLength(0)
  })

  it('expire unblocks the caller but keeps the card visible', () => {
    let got: string | null = null
    enqueue('1', 'chat-1', (v) => (got = v))
    useAskUser.getState().expire('1')
    expect(got).toMatch(/stopped waiting/)
    const req = useAskUser.getState().pending[0]
    expect(req.expired).toBe(true)
  })

  it('ignores an answer once expired, so a dead click cannot resolve twice', () => {
    const seen: string[] = []
    enqueue('1', 'chat-1', (v) => seen.push(v))
    useAskUser.getState().expire('1')
    useAskUser.getState().answer('1', 'a')
    expect(seen).toHaveLength(1)
    expect(seen[0]).not.toBe('a')
  })

  it('expire is idempotent', () => {
    const seen: string[] = []
    enqueue('1', 'chat-1', (v) => seen.push(v))
    useAskUser.getState().expire('1')
    useAskUser.getState().expire('1')
    expect(seen).toHaveLength(1)
  })

  it('dismiss removes an expired card without resolving again', () => {
    const seen: string[] = []
    enqueue('1', 'chat-1', (v) => seen.push(v))
    useAskUser.getState().expire('1')
    useAskUser.getState().dismiss('1')
    expect(useAskUser.getState().pending).toHaveLength(0)
    expect(seen).toHaveLength(1)
  })

  it('unattached only sees requests with no chat pane', () => {
    enqueue('1', 'chat-1', () => {})
    enqueue('2', null, () => {})
    expect(useAskUser.getState().unattached()?.id).toBe('2')
  })
})
