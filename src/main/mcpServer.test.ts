import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({ ipcMain: { on: vi.fn(), handle: vi.fn() } }))

const { rpcKey, mcpSystemPrompt, implementedToolNames, MCP_TOOLS } = await import('./mcpServer')

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

describe('what riven tells an agent about its tools', () => {
  it('describes only the areas whose tools the pane actually has', () => {
    const all = mcpSystemPrompt()
    expect(all).toContain('riven_browser_open')
    expect(all).toContain('riven_ask_agent')

    // Browser tools switched off: the browser line goes, the rest stays.
    const noBrowser = implementedToolNames().filter((n) => !/browser|screenshot/.test(n))
    const p = mcpSystemPrompt(noBrowser)
    expect(p).not.toContain('riven_browser_open')
    expect(p).toContain('riven_ask_agent')
    expect(p.length).toBeLessThan(all.length)
  })

  it('says nothing when there are no tools at all', () => {
    expect(mcpSystemPrompt([])).toBe('')
  })

  it('stops listing a tool another one covers, without making it uncallable', () => {
    expect(implementedToolNames()).not.toContain('riven_open_browser')
    expect(MCP_TOOLS.find((t) => t.name === 'riven_open_browser')?.implemented).toBe(true)
  })

  it('keeps every description short enough to be read, not skimmed', () => {
    // The long ones were 660–718 characters; the rules they carried are kept,
    // the repetition is not.
    for (const t of MCP_TOOLS.filter((x) => x.implemented)) expect(t.description.length).toBeLessThanOrEqual(460)
  })
})
