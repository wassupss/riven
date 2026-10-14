import { describe, expect, it } from 'vitest'
import { ReplayGuard, fromB64u, importRemoteKey, newChannelId, newRemoteKey, open, seal, toB64u } from './remoteCrypto'
import { pairingUrl, parsePhoneMsg } from './remoteProtocol'

describe('remoteCrypto', () => {
  it('round-trips base64url', () => {
    const b = new Uint8Array([0, 1, 250, 251, 252, 253, 254, 255])
    expect(fromB64u(toB64u(b))).toEqual(b)
    expect(toB64u(b)).not.toMatch(/[+/=]/)
  })

  it('opens what it sealed, with the time and a nonce added', async () => {
    const key = await importRemoteKey(newRemoteKey())
    const env = await seal(key, 'ch', { t: 'hello' })
    const msg = await open(key, 'ch', env)
    expect(msg?.t).toBe('hello')
    expect(typeof msg?.ts).toBe('number')
    expect(typeof msg?.n).toBe('string')
  })

  it('rejects the wrong key, the wrong channel and tampering', async () => {
    const key = await importRemoteKey(newRemoteKey())
    const other = await importRemoteKey(newRemoteKey())
    const env = await seal(key, 'ch', { t: 'hello' })
    expect(await open(other, 'ch', env)).toBeNull()
    expect(await open(key, 'other-channel', env)).toBeNull()
    const ct = fromB64u(env.ct)
    ct[0] ^= 1
    expect(await open(key, 'ch', { iv: env.iv, ct: toB64u(ct) })).toBeNull()
    expect(await open(key, 'ch', { nope: 1 })).toBeNull()
  })

  it('makes distinct keys and channel ids', () => {
    expect(newRemoteKey()).not.toBe(newRemoteKey())
    expect(fromB64u(newRemoteKey()).length).toBe(32)
    expect(fromB64u(newChannelId()).length).toBe(16)
  })
})

describe('ReplayGuard', () => {
  it('accepts a fresh message once', () => {
    const g = new ReplayGuard()
    expect(g.accept(1000, 'a', 1000)).toBe(true)
    expect(g.accept(1000, 'a', 1000)).toBe(false)
  })

  it('rejects stale or future messages and bad fields', () => {
    const g = new ReplayGuard()
    expect(g.accept(0, 'a', 10 * 60_000)).toBe(false)
    expect(g.accept(10 * 60_000, 'b', 0)).toBe(false)
    expect(g.accept('1', 'c', 1)).toBe(false)
    expect(g.accept(1, '', 1)).toBe(false)
  })
})

describe('parsePhoneMsg', () => {
  it('accepts the three message kinds', () => {
    expect(parsePhoneMsg({ t: 'hello' })).toEqual({ t: 'hello' })
    expect(parsePhoneMsg({ t: 'send', reqId: 'r', chatKey: 'chat-1', text: 'hi' })).toEqual({
      t: 'send',
      reqId: 'r',
      chatKey: 'chat-1',
      text: 'hi'
    })
    expect(parsePhoneMsg({ t: 'answer', id: 'q', choice: 'yes' })).toEqual({ t: 'answer', id: 'q', choice: 'yes' })
  })

  it('drops malformed or empty messages', () => {
    expect(parsePhoneMsg(null)).toBeNull()
    expect(parsePhoneMsg({ t: 'exec', cmd: 'rm -rf /' })).toBeNull()
    expect(parsePhoneMsg({ t: 'send', reqId: 'r', chatKey: 'chat-1', text: '   ' })).toBeNull()
    expect(parsePhoneMsg({ t: 'send', reqId: 'r', chatKey: 'chat-1', text: 'x'.repeat(20_001) })).toBeNull()
    expect(parsePhoneMsg({ t: 'answer', id: 1, choice: 'yes' })).toBeNull()
  })
})

describe('pairingUrl', () => {
  it('puts every secret in the fragment', () => {
    const u = new URL(pairingUrl('https://x.app/remote.html', { channel: 'c1', key: 'k1', url: 'https://s.co', anon: 'a1' }))
    expect(u.search).toBe('')
    const p = new URLSearchParams(u.hash.slice(1))
    expect([p.get('c'), p.get('k'), p.get('u'), p.get('a')]).toEqual(['c1', 'k1', 'https://s.co', 'a1'])
  })
})
