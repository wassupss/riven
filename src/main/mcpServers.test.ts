import { describe, it, expect } from 'vitest'
import { serverNames, allowedToolsValue, parseMcpList, toolPrefix } from './mcpServers'

// Copied verbatim from a real `claude mcp list` run: connectors, a plugin
// server and a project server, which is exactly the mix that was failing.
const REAL_LIST = `Checking MCP server health…

claude.ai Notion: https://mcp.notion.com/mcp - ✔ Connected
claude.ai Google Drive: https://drivemcp.googleapis.com/mcp/v1 - ✔ Connected
plugin:figma:figma: https://mcp.figma.com/mcp (HTTP) - ! Needs authentication
devhub: http://192.168.219.71/api/mcp (HTTP) - ✔ Connected
`

describe('parseMcpList', () => {
  it('reads every server the CLI reports, whatever its origin', () => {
    expect(parseMcpList(REAL_LIST)).toEqual([
      'claude.ai Notion',
      'claude.ai Google Drive',
      'plugin:figma:figma',
      'devhub'
    ])
  })

  // The name itself contains colons; only the first ": " separates it.
  it('keeps a plugin name with colons intact', () => {
    expect(parseMcpList('plugin:figma:figma: https://x (HTTP) - ✔ Connected')).toEqual([
      'plugin:figma:figma'
    ])
  })

  it('ignores the health-check banner and blank lines', () => {
    expect(parseMcpList('Checking MCP server health…\n\n')).toEqual([])
  })

  it('ignores prose that happens to contain a colon', () => {
    expect(parseMcpList('No MCP servers configured: run claude mcp add')).toEqual([])
  })
})

describe('toolPrefix', () => {
  // Verified against a live session: the "claude.ai Notion" server's tools
  // arrive as mcp__claude_ai_Notion__notion-search.
  it('spells a connector the way its tools are named', () => {
    expect(toolPrefix('claude.ai Notion')).toBe('mcp__claude_ai_Notion')
  })

  it('folds every non-identifier character, so a plugin name still matches', () => {
    expect(toolPrefix('plugin:figma:figma')).toBe('mcp__plugin_figma_figma')
  })

  it('leaves a plain name alone', () => {
    expect(toolPrefix('devhub')).toBe('mcp__devhub')
  })
})

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

  it('allows connectors and plugin servers under the names their tools use', () => {
    expect(allowedToolsValue('Read', 'mcp__riven', ['claude.ai Notion', 'plugin:figma:figma'])).toBe(
      'Read,mcp__riven,mcp__claude_ai_Notion,mcp__plugin_figma_figma'
    )
  })

  // riven's own server is already in the list; naming it twice is noise.
  it('does not repeat riven itself', () => {
    expect(allowedToolsValue('Read', 'mcp__riven', ['riven', 'devhub'])).toBe(
      'Read,mcp__riven,mcp__devhub'
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
