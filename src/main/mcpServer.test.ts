import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({ ipcMain: { on: vi.fn(), handle: vi.fn() } }))

const { rpcKey } = await import('./mcpServer')

describe('rpcKey', () => {
  it('ties a JSON-RPC id to the pane that sent it', () => {
    expect(rpcKey('chat-a', 7)).toBe(rpcKey('chat-a', 7))
    expect(rpcKey('chat-a', 7)).not.toBe(rpcKey('chat-b', 7))
  })

  it('treats a numeric id and its string form as the same request', () => {
    // The cancellation notice echoes the id the client chose; clients differ on
    // whether that is a number or a string.
    expect(rpcKey('chat-a', 7)).toBe(rpcKey('chat-a', '7'))
  })

  it('has no key without a request id', () => {
    expect(rpcKey('chat-a', undefined)).toBeNull()
    expect(rpcKey('chat-a', null)).toBeNull()
  })
})
