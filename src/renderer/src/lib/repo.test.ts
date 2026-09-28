import { describe, expect, it } from 'vitest'
import { avatarUrl, parseRemote, repoLabel } from './repo'

describe('parseRemote', () => {
  it('reads the scp-style remote git hands out by default', () => {
    expect(parseRemote('git@github.com:wassupss/riven.git')).toEqual({
      host: 'github.com',
      owner: 'wassupss',
      repo: 'riven'
    })
  })

  it('reads an https remote, with or without .git', () => {
    expect(parseRemote('https://github.com/wassupss/riven.git')?.repo).toBe('riven')
    expect(parseRemote('https://github.com/wassupss/riven')?.repo).toBe('riven')
  })

  it('reads ssh:// with a user and a port', () => {
    expect(parseRemote('ssh://git@github.com:22/wassupss/riven.git')).toEqual({
      host: 'github.com',
      owner: 'wassupss',
      repo: 'riven'
    })
  })

  it('keeps a nested group as the owner, the way the web UI addresses it', () => {
    expect(parseRemote('git@gitlab.com:team/sub/app.git')).toEqual({
      host: 'gitlab.com',
      owner: 'team/sub',
      repo: 'app'
    })
  })

  it('says nothing for a remote nobody has a picture of', () => {
    expect(parseRemote('/srv/git/thing.git')).toBeNull()
    expect(parseRemote('../sibling')).toBeNull()
    expect(parseRemote('')).toBeNull()
    expect(parseRemote(null)).toBeNull()
  })
})

describe('avatarUrl', () => {
  it('points at the owner, no token required', () => {
    expect(avatarUrl(parseRemote('git@github.com:wassupss/riven.git'))).toBe(
      'https://github.com/wassupss.png?size=64'
    )
  })

  it('declines to guess for hosts that have no such URL', () => {
    expect(avatarUrl(parseRemote('git@gitlab.com:team/app.git'))).toBeNull()
    expect(avatarUrl(parseRemote('git@bitbucket.org:team/app.git'))).toBeNull()
    expect(avatarUrl(null)).toBeNull()
  })

  it('escapes an owner rather than pasting it into a URL', () => {
    expect(avatarUrl({ host: 'github.com', owner: 'a b', repo: 'r' })).toBe(
      'https://github.com/a%20b.png?size=64'
    )
  })
})

describe('repoLabel', () => {
  it('names the repository, not the folder it happens to sit in', () => {
    expect(repoLabel(parseRemote('git@github.com:wassupss/riven.git'))).toBe('wassupss/riven')
    expect(repoLabel(null)).toBeNull()
  })
})
