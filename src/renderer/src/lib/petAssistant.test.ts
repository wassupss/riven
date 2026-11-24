import { describe, it, expect } from 'vitest'
import {
  ROLE_MAX,
  actingWorkspace,
  balloonText,
  bornAtOfKey,
  defaultAssistant,
  folderOf,
  isAssistant,
  isPetChatKey,
  launchChange,
  personaPrompt,
  petChatKey,
  resolveScope,
  sanitizeAssistant,
  sanitizeSessions,
  type Launch
} from './petAssistant'

describe('sanitizeAssistant', () => {
  it('is null for nothing, so an old save has no assistant', () => {
    expect(sanitizeAssistant(undefined)).toBeNull()
    expect(sanitizeAssistant(null)).toBeNull()
    expect(sanitizeAssistant('on')).toBeNull()
    expect(sanitizeAssistant([1, 2])).toBeNull()
  })

  it('keeps a good config as it is', () => {
    const cfg = { ...defaultAssistant(), role: 'git 정리', model: 'haiku', allWorkspaces: false, workspaces: ['/a', '/b'], permission: 'plan' as const }
    expect(sanitizeAssistant(cfg)).toEqual(cfg)
  })

  it('reads every field defensively', () => {
    const s = sanitizeAssistant({
      on: 'yes',
      role: 'x'.repeat(ROLE_MAX + 50),
      model: 'opus; rm -rf ~',
      allWorkspaces: false,
      workspaces: ['/a', '/a', 3, '', '/b'],
      permission: 'bypassPermissions'
    })!
    expect(s.on).toBe(false)
    expect(s.role).toHaveLength(ROLE_MAX)
    expect(s.model).toBe('default')
    expect(s.workspaces).toEqual(['/a', '/b'])
    expect(s.allWorkspaces).toBe(false)
    // Never a mode that skips the permission cards.
    expect(s.permission).toBe('default')
  })

  it('reads an empty pick as every workspace', () => {
    expect(sanitizeAssistant({ on: true, allWorkspaces: false, workspaces: [] })!.allWorkspaces).toBe(true)
  })

  it('keeps a pinned model id', () => {
    expect(sanitizeAssistant({ model: 'claude-opus-5-5[1m]' })!.model).toBe('claude-opus-5-5[1m]')
  })

  it('is an assistant only when switched on', () => {
    expect(isAssistant(null)).toBe(false)
    expect(isAssistant({ ...defaultAssistant(), on: false })).toBe(false)
    expect(isAssistant(defaultAssistant())).toBe(true)
  })
})

describe('session keys', () => {
  it('round-trip a birthday and are not pane keys', () => {
    const k = petChatKey(1_700_000_000_123.7)
    expect(k).toBe('petchat-1700000000123')
    expect(isPetChatKey(k)).toBe(true)
    expect(bornAtOfKey(k)).toBe(1_700_000_000_123)
    expect(k.startsWith('chat-') || k.startsWith('clichat-')).toBe(false)
    expect(bornAtOfKey('chat-1')).toBeNull()
    expect(bornAtOfKey('petchat-x')).toBeNull()
  })
})

describe('scope', () => {
  const sep = String.fromCharCode(1)
  it('all workspaces: every open one, run from no workspace folder', () => {
    expect(resolveScope(defaultAssistant(), ['/a', '/b'])).toEqual({ workspaces: ['/a', '/b'], cwd: null })
  })
  it('one workspace: runs in its folder (a second instance too)', () => {
    const cfg = { ...defaultAssistant(), allWorkspaces: false, workspaces: [`/a${sep}2`] }
    expect(resolveScope(cfg, [])).toEqual({ workspaces: [`/a${sep}2`], cwd: '/a' })
    expect(folderOf(`/a${sep}2`)).toBe('/a')
  })
  it('several: no single folder', () => {
    const cfg = { ...defaultAssistant(), allWorkspaces: false, workspaces: ['/a', '/b'] }
    expect(resolveScope(cfg, ['/a'])).toEqual({ workspaces: ['/a', '/b'], cwd: null })
  })
  it('acts on the one on screen when in scope, else the first open one in scope', () => {
    const cfg = { ...defaultAssistant(), allWorkspaces: false, workspaces: ['/b', '/c'] }
    expect(actingWorkspace(cfg, '/c', ['/a', '/b', '/c'])).toBe('/c')
    expect(actingWorkspace(cfg, '/a', ['/a', '/b', '/c'])).toBe('/b')
    expect(actingWorkspace(cfg, '/a', ['/a'])).toBeNull()
    expect(actingWorkspace(defaultAssistant(), '/a', ['/a', '/b'])).toBe('/a')
    expect(actingWorkspace(defaultAssistant(), null, ['/a', '/b'])).toBe('/a')
  })
})

describe('launchChange', () => {
  const l: Launch = { cwd: '/h', prompt: 'p', model: 'haiku', permission: 'default' }
  it('says what a settings change needs', () => {
    expect(launchChange(null, l)).toBe('none')
    expect(launchChange(l, { ...l })).toBe('none')
    expect(launchChange(l, { ...l, model: 'opus' })).toBe('flags')
    expect(launchChange(l, { ...l, permission: 'plan' })).toBe('flags')
    expect(launchChange(l, { ...l, prompt: 'q', model: 'opus' })).toBe('restart')
    expect(launchChange(l, { ...l, cwd: '/w', prompt: 'q' })).toBe('newSession')
  })
})

describe('personaPrompt', () => {
  it('names the pet, its role and its workspaces', () => {
    const p = personaPrompt({ name: '보리', species: 'cat', role: 'PR 리뷰 담당', workspaces: ['api (/w/api)'] })
    expect(p).toContain('You are 보리, a cat')
    expect(p).toContain('riven_workspaces')
    expect(p).toContain('PR 리뷰 담당')
    expect(p).toContain('- api (/w/api)')
    expect(p).toContain('ONLY')
  })
  it('says every workspace when not limited, and leaves out an empty role', () => {
    const p = personaPrompt({ name: '', species: 'dog', role: '  ', workspaces: null })
    expect(p).toContain('You are a dog')
    expect(p).toContain('any workspace')
    expect(p).not.toContain('## Your role')
  })
  it('never uses an em dash', () => {
    const p = personaPrompt({ name: 'a', species: 'b', role: 'c', workspaces: [] })
    expect(p).not.toContain(String.fromCharCode(0x2014))
  })
})

describe('balloonText', () => {
  it('keeps prose on one line, without code or markdown', () => {
    expect(balloonText('**Done.**\n\n```ts\nconst a = 1\n```\nAll `tests` pass.')).toBe('Done. All tests pass.')
  })
  it('cuts a long reply', () => {
    const s = balloonText('word '.repeat(100), 40)
    expect(s.length).toBeLessThanOrEqual(40)
    expect(s.endsWith('…')).toBe(true)
  })
})

describe('sanitizeSessions', () => {
  it('keeps only well formed entries', () => {
    const id = '0f8b5c1e-1d2a-4c3b-9e8f-1234567890ab'
    expect(
      sanitizeSessions({
        version: 1,
        pets: {
          '1700': { sessionId: id, cwd: '/Users/x' },
          '1800': { sessionId: 'nope', cwd: '/x' },
          '1900': { sessionId: id, cwd: 'relative' },
          abc: { sessionId: id, cwd: '/x' }
        }
      })
    ).toEqual({ '1700': { sessionId: id, cwd: '/Users/x' } })
    expect(sanitizeSessions(null)).toEqual({})
    expect(sanitizeSessions({ pets: [1] })).toEqual({})
  })
})
