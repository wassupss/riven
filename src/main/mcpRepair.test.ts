import { describe, it, expect, afterEach } from 'vitest'
import { findPastedAddServers, claudeStateFile } from './mcpRepair'
import * as os from 'os'
import * as path from 'path'

const P = '/Users/me/workspace/app'

// The exact shape `claude mcp add devhub -- claude mcp add --transport http …`
// writes, reproduced byte for byte from a real ~/.claude.json.
const brokenDevhub = {
  type: 'stdio',
  command: 'claude',
  args: ['mcp', 'add', '--transport', 'http', 'devhub', 'http://host/api/mcp', '--header', 'Authorization: Bearer X'],
  env: {}
}

describe('findPastedAddServers', () => {
  it('finds a server whose command is its own add line', () => {
    const cfg = { projects: { [P]: { mcpServers: { devhub: brokenDevhub } } } }
    expect(findPastedAddServers(cfg, [P])).toEqual([{ name: 'devhub', args: brokenDevhub.args }])
  })

  it('leaves a correct http server alone', () => {
    const cfg = {
      projects: { [P]: { mcpServers: { devhub: { type: 'http', url: 'http://host/api/mcp' } } } }
    }
    expect(findPastedAddServers(cfg, [P])).toEqual([])
  })

  it('leaves a real stdio server alone — even one that runs claude for something else', () => {
    const cfg = {
      projects: {
        [P]: {
          mcpServers: {
            sentry: { type: 'stdio', command: 'npx', args: ['-y', '@sentry/mcp'] },
            nested: { type: 'stdio', command: 'claude', args: ['mcp', 'serve'] }
          }
        }
      }
    }
    expect(findPastedAddServers(cfg, [P])).toEqual([])
  })

  it('recognises an absolute path to claude', () => {
    const cfg = {
      projects: { [P]: { mcpServers: { devhub: { ...brokenDevhub, command: '/Users/me/.local/bin/claude' } } } }
    }
    expect(findPastedAddServers(cfg, [P]).map((b) => b.name)).toEqual(['devhub'])
  })

  it('only looks at THIS project', () => {
    const cfg = { projects: { '/other': { mcpServers: { devhub: brokenDevhub } } } }
    expect(findPastedAddServers(cfg, [P])).toEqual([])
  })

  it('checks the symlink-resolved spelling of the project path too, without duplicates', () => {
    const cfg = {
      projects: {
        '/tmp/app': { mcpServers: { devhub: brokenDevhub } },
        '/private/tmp/app': { mcpServers: { devhub: brokenDevhub } }
      }
    }
    expect(findPastedAddServers(cfg, ['/tmp/app', '/private/tmp/app'])).toHaveLength(1)
  })

  it('refuses args that are not all strings rather than replaying them', () => {
    const cfg = {
      projects: { [P]: { mcpServers: { devhub: { ...brokenDevhub, args: ['mcp', 'add', 42] } } } }
    }
    expect(findPastedAddServers(cfg, [P])).toEqual([])
  })
})

describe('claudeStateFile', () => {
  // The answer depends on the inherited environment, so every case pins it —
  // otherwise this suite passes or fails depending on the shell that ran it.
  const saved = process.env.CLAUDE_CONFIG_DIR
  afterEach(() => {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = saved
  })

  it('is <dir>/.claude.json for an explicit profile', () => {
    process.env.CLAUDE_CONFIG_DIR = '/elsewhere'
    expect(claudeStateFile('/profiles/a')).toBe('/profiles/a/.claude.json')
  })

  it('is ~/.claude.json at the home root with no profile and nothing inherited — not ~/.claude/.claude.json', () => {
    delete process.env.CLAUDE_CONFIG_DIR
    expect(claudeStateFile()).toBe(path.join(os.homedir(), '.claude.json'))
  })

  // The bug this guards: spawns copy process.env and only ever SET the variable,
  // so with no profile the CLI still runs against an inherited directory. Reading
  // ~/.claude.json there meant repairing a file the CLI was not looking at — its
  // `mcp remove` then failed with "no server named devhub".
  it('follows an inherited CLAUDE_CONFIG_DIR when no profile is given', () => {
    process.env.CLAUDE_CONFIG_DIR = '/inherited/profile'
    expect(claudeStateFile()).toBe('/inherited/profile/.claude.json')
  })
})
