import { describe, expect, it } from 'vitest'
import {
  PROTOCOL,
  ReplayGuard,
  deviceIdOf,
  fromB64u,
  newKeyPair,
  offerToUrl,
  openPair,
  openWire,
  parseOffer,
  parsePhoneMsg,
  seal,
  sealPair,
  sharedKey,
  toB64u
} from './core'

const offer = {
  v: PROTOCOL,
  channel: 'ch',
  desk: newKeyPair().publicKey,
  invite: 'inv',
  url: 'https://x.supabase.co',
  anon: 'sb_publishable_x',
  name: 'office mac'
}

describe('encoding', () => {
  it('round-trips base64url without padding or +/', () => {
    const b = new Uint8Array([0, 1, 250, 251, 252, 253, 254, 255])
    expect(fromB64u(toB64u(b))).toEqual(b)
    expect(toB64u(b)).not.toMatch(/[+/=]/)
  })
})

describe('pairing offer', () => {
  it('round-trips through the QR url', () => {
    expect(parseOffer(offerToUrl(offer))).toEqual(offer)
  })

  it('rejects other versions, missing fields and non-https relays', () => {
    expect(parseOffer(offerToUrl({ ...offer, v: 1 }))).toBeNull()
    expect(parseOffer(offerToUrl({ ...offer, invite: '' }))).toBeNull()
    expect(parseOffer(offerToUrl({ ...offer, url: 'http://x.supabase.co' }))).toBeNull()
    expect(parseOffer('garbage')).toBeNull()
  })
})

describe('pair request', () => {
  it('opens with the desk secret and names the phone key', () => {
    const desk = newKeyPair()
    const phone = newKeyPair()
    const w = sealPair({ invite: 'inv', name: 'Pixel', platform: 'android' }, desk.publicKey, phone)
    const got = openPair(w, desk.secretKey)
    expect(got?.publicKey).toBe(phone.publicKey)
    expect(got?.req).toEqual({ invite: 'inv', name: 'Pixel', platform: 'android' })
  })

  it('cannot be opened by another desk', () => {
    const desk = newKeyPair()
    const w = sealPair({ invite: 'inv', name: 'x', platform: 'ios' }, desk.publicKey, newKeyPair())
    expect(openPair(w, newKeyPair().secretKey)).toBeNull()
    expect(openPair({ pk: 'nope' }, desk.secretKey)).toBeNull()
  })
})

describe('sealed messages', () => {
  it('both sides derive the same key; a third party cannot read', () => {
    const desk = newKeyPair()
    const phone = newKeyPair()
    const fromPhone = seal(sharedKey(desk.publicKey, phone.secretKey), 'dev1', { t: 'hello' })
    expect(openWire(sharedKey(phone.publicKey, desk.secretKey), fromPhone)?.t).toBe('hello')
    const other = newKeyPair()
    expect(openWire(sharedKey(other.publicKey, desk.secretKey), fromPhone)).toBeNull()
  })

  it('detects tampering', () => {
    const a = newKeyPair()
    const b = newKeyPair()
    const w = seal(sharedKey(b.publicKey, a.secretKey), 'd', { t: 'hello' })
    const box = fromB64u(w.box)
    box[0] ^= 1
    expect(openWire(sharedKey(a.publicKey, b.secretKey), { ...w, box: toB64u(box) })).toBeNull()
  })

  it('gives each device a stable short id', () => {
    const k = newKeyPair().publicKey
    expect(deviceIdOf(k)).toBe(deviceIdOf(k))
    expect(deviceIdOf(k)).not.toBe(deviceIdOf(newKeyPair().publicKey))
  })
})

describe('ReplayGuard', () => {
  it('accepts a fresh message once and refuses stale ones', () => {
    const g = new ReplayGuard()
    expect(g.accept(1000, 'n', 1000)).toBe(true)
    expect(g.accept(1000, 'n', 1000)).toBe(false)
    expect(g.accept(0, 'm', 10 * 60_000)).toBe(false)
    expect(g.accept('1', 'o', 1)).toBe(false)
  })
})

describe('parsePhoneMsg', () => {
  it('accepts the known kinds and drops the rest', () => {
    expect(parsePhoneMsg({ t: 'hello' })).toEqual({ t: 'hello' })
    expect(parsePhoneMsg({ t: 'send', reqId: 'r', chatKey: 'chat-1', text: 'hi' })?.t).toBe('send')
    expect(parsePhoneMsg({ t: 'answer', id: 'q', choice: 'yes' })?.t).toBe('answer')
    expect(parsePhoneMsg({ t: 'push', token: 'ExponentPushToken[x]' })?.t).toBe('push')
    expect(parsePhoneMsg({ t: 'push', token: null })).toEqual({ t: 'push', token: null })
    expect(parsePhoneMsg({ t: 'exec', cmd: 'rm -rf /' })).toBeNull()
    expect(parsePhoneMsg({ t: 'send', reqId: 'r', chatKey: 'c', text: '   ' })).toBeNull()
  })
})
