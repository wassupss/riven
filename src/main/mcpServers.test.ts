import { describe, it, expect } from 'vitest'
import { serverNames, allowedToolsValue } from './mcpServers'

const P = '/Users/me/workspace/app'

describe('serverNames', () => {
  it('finds servers the CLI stored for this project', () => {
    const state = { projects: { [P]: { mcpServers: { devhub: {}, sentry: {} } } } }
    expect(serverNames(state, [P], null)).toEqual(['devhub', 'sentry'])
  })

  it('finds servers checked into the repo as .mcp.json', () => {
    expect(serverNames(null, [P], { mcpServers: { shared: {} } })).toEqual(['shared'])
  })

  it('merges both without listing the same server twice', () => {
    const state = { projects: { [P]: { mcpServers: { devhub: {} } } } }
    expect(serverNames(state, [P], { mcpServers: { devhub: {}, shared: {} } })).toEqual([
      'devhub',
      'shared'
    ])
  })

  it('ignores servers belonging to other projects', () => {
    const state = { projects: { '/somewhere/else': { mcpServers: { other: {} } } } }
    expect(serverNames(state, [P], null)).toEqual([])
  })

  // The CLI keys a project by its symlink-resolved path (/tmp → /private/tmp),
  // so both spellings are checked — and neither may list a server twice.
  it('checks both spellings of the project path', () => {
    const state = {
      projects: {
        '/tmp/app': { mcpServers: { devhub: {} } },
        '/private/tmp/app': { mcpServers: { devhub: {}, extra: {} } }
      }
    }
    expect(serverNames(state, ['/tmp/app', '/private/tmp/app'], null)).toEqual(['devhub', 'extra'])
  })

  // These names are interpolated into an --allowedTools value on a command
  // line; anything that isn't a plain identifier has no business there.
  it('drops a name that could not be a tool prefix', () => {
    const state = {
      projects: { [P]: { mcpServers: { good: {}, 'bad name': {}, 'x,y': {}, 'a;b': {} } } }
    }
    expect(serverNames(state, [P], null)).toEqual(['good'])
  })

  it('copes with configs that are missing or empty', () => {
    expect(serverNames(null, [P], null)).toEqual([])
    expect(serverNames({ projects: {} }, [P], { mcpServers: {} })).toEqual([])
  })
})

describe('allowedToolsValue', () => {
  it("keeps riven's own tools and adds a prefix per server", () => {
    expect(allowedToolsValue('Read,Edit', 'mcp__riven', ['devhub', 'sentry'])).toBe(
      'Read,Edit,mcp__riven,mcp__devhub,mcp__sentry'
    )
  })

  // Allowing the whole server, not a list of its tools: a tool the server adds
  // next week would otherwise be refused with no sign of why.
  it('allows a server by prefix rather than tool by tool', () => {
    expect(allowedToolsValue('Read', 'mcp__riven', ['devhub'])).toContain('mcp__devhub')
  })

  it('leaves out a server the user switched off', () => {
    expect(allowedToolsValue('Read', 'mcp__riven', ['devhub', 'sentry'], ['sentry'])).toBe(
      'Read,mcp__riven,mcp__devhub'
    )
  })

  it('is just the built-ins when the project has no servers', () => {
    expect(allowedToolsValue('Read,Edit', 'mcp__riven', [])).toBe('Read,Edit,mcp__riven')
  })
})
