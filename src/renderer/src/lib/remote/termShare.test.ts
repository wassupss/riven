import { describe, expect, it } from 'vitest'
import { RateLimiter, SCREEN_LINES, redactSecrets, safeLabel, screenForPhone } from './termShare'

// Fake credentials, built so no scanner mistakes this file for a leak.
const fake = (prefix: string, n: number, ch = 'a'): string => prefix + ch.repeat(n)

describe('redactSecrets', () => {
  it('hides provider tokens wherever they appear', () => {
    const cases = [
      fake('sk-ant-api03-', 40),
      fake('sk-proj-', 40),
      fake('sk-', 32),
      fake('sk_live_', 24),
      fake('ghp_', 36),
      fake('gho_', 36),
      fake('github_pat_', 40),
      fake('glpat-', 20),
      'xoxb-' + '1234567890-abcdefghij',
      'xoxp-' + '1234567890-abcdefghij',
      'AKIA' + 'ABCDEFGHIJKLMNOP',
      'AIza' + 'b'.repeat(35),
      fake('npm_', 36)
    ]
    for (const tok of cases) {
      const out = redactSecrets(`export X=1; echo ${tok} done`)
      expect(out, tok).not.toContain(tok)
      expect(out).toContain('[redacted]')
      expect(out).toContain('done')
    }
  })

  it('hides JWTs, whole or cut off', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9' + '.' + 'eyJzdWIiOiIxMjM0In0' + '.' + 'c2lnbmF0dXJlc2lnbmF0dXJl'
    expect(redactSecrets(`token ${jwt} ok`)).toBe('token [redacted] ok')
    expect(redactSecrets('eyJhbGciOiJIUzI1NiJ9')).toBe('[redacted]')
  })

  it('hides private key blocks, including ones cut at either edge', () => {
    const begin = '-----BEGIN OPENSSH PRIVATE KEY-----'
    const end = '-----END OPENSSH PRIVATE KEY-----'
    const block = `before\n${begin}\nAAAABBBB\nCCCCDDDD\n${end}\nafter`
    expect(redactSecrets(block)).toBe('before\n[redacted]\nafter')
    // The end is below the cut.
    expect(redactSecrets(`x\n${begin}\nAAAABBBB\nCCCC`)).toBe('x\n[redacted]')
    // The beginning scrolled off the top.
    expect(redactSecrets(`AAAABBBB\nCCCC\n${end}\nnext`)).toBe('[redacted]\nnext')
    expect(redactSecrets('-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----')).toBe('[redacted]')
  })

  it('keeps the name of an assigned secret and drops its value', () => {
    expect(redactSecrets('OPENAI_API_KEY=abcdef0123456789abcdef')).toBe('OPENAI_API_KEY=[redacted]')
    expect(redactSecrets('password: hunter22!')).toBe('password: [redacted]')
    expect(redactSecrets('"access_token": "0a1b2c3d4e5f6a7b8c9d"')).toBe('"access_token": "[redacted]"')
    expect(redactSecrets('db_passwd=s3cr3tpw')).toBe('db_passwd=[redacted]')
    expect(redactSecrets('curl -H "Authorization: Bearer abcdefghijklmnopqrstuvwxyz"')).not.toContain('abcdefghijklmnop')
    expect(redactSecrets('Bearer abcdefghijklmnopqrstuvwxyz0123')).toBe('Bearer [redacted]')
    expect(redactSecrets('psql postgres://admin:topsecret@db.local/app')).toBe('psql postgres://admin:[redacted]@db.local/app')
  })

  it('leaves ordinary terminal text alone', () => {
    const plain = [
      '> fix the login bug',
      '⏺ Read(src/auth/login.ts)',
      '  ⎿  Read 120 lines',
      'Do you want to proceed?',
      '❯ 1. Yes',
      '  2. No, and tell Claude what to do differently (esc)',
      'commit 3f2a9c1d0b7e6f5a4c3b2a1908f7e6d5c4b3a291',
      'Author: someone <a@b.c>',
      '12.3k tokens · esc to interrupt'
    ].join('\n')
    expect(redactSecrets(plain)).toBe(plain)
  })
})

describe('screenForPhone', () => {
  it('keeps only the last lines, clipped, within the budget', () => {
    const raw = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n')
    const out = screenForPhone(raw).split('\n')
    expect(out).toHaveLength(SCREEN_LINES)
    expect(out[out.length - 1]).toBe('line 499')
    const wide = screenForPhone(Array.from({ length: 200 }, () => 'x'.repeat(1000)).join('\n'))
    expect(wide.length).toBeLessThanOrEqual(40_000)
    expect(wide.split('\n')[0].length).toBeLessThan(410)
  })

  it('strips control and direction characters, and redacts', () => {
    const out = screenForPhone(`a\x1b[31mb\u202ec\u200bd\x07 ${fake('ghp_', 36)}`)
    expect(out).toBe('a[31mbcd [redacted]')
  })

  it('redacts a secret that a long line would otherwise split', () => {
    const tok = fake('sk-ant-api03-', 500)
    expect(screenForPhone(`key: ${tok}`)).not.toContain('aaaaaaaaaaaaaaaaaaaa')
  })
})

describe('safeLabel', () => {
  it('cleans and clips a title', () => {
    expect(safeLabel('claude\u202e evil\n')).toBe('claude evil')
    expect(safeLabel('x'.repeat(300)).length).toBe(101)
  })
})

describe('RateLimiter', () => {
  it('allows a burst up to the limit, then refuses until the window passes', () => {
    const r = new RateLimiter(3, 1000)
    expect([r.take('a', 0), r.take('a', 10), r.take('a', 20), r.take('a', 30)]).toEqual([true, true, true, false])
    expect(r.take('b', 30)).toBe(true)
    expect(r.take('a', 1005)).toBe(true)
  })
})
