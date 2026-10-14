// Remote control: the protocol both ends speak. Shared, file for file, by this
// app (state/remote.ts) and the phone app (mobile/), so it imports nothing but
// tweetnacl and uses nothing but what both runtimes have (atob/btoa, and
// randomness through tweetnacl's PRNG, which the phone app wires to expo-crypto).
//
// Shape of it:
// - This machine has a long-term X25519 key pair. Its public key and a one-time
//   invite (valid 10 minutes) go to the phone in the QR code.
// - The phone makes its own key pair and asks to pair, boxed to this machine's
//   key. The user approves it HERE; only then does the device exist. A leaked
//   QR or an expired invite is worth nothing without that approval.
// - From then on every message is a NaCl box between this machine and THAT
//   device (X25519 + XSalsa20-Poly1305), so devices are separately revocable and
//   none can read another's traffic. Supabase Realtime only relays ciphertext.
// - Each message carries its time and is accepted once (random 24-byte nonce),
//   so a captured message cannot be replayed later.

import nacl from 'tweetnacl'

export const PROTOCOL = 2
export const INVITE_TTL_MS = 10 * 60_000
export const REPLAY_WINDOW_MS = 3 * 60_000

// UTF-8 by hand: TextEncoder/TextDecoder are not something every React Native
// engine can be counted on to have, and this file runs in both.
export function utf8(s: string): Uint8Array {
  const out: number[] = []
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i)
    if (c >= 0xd800 && c < 0xdc00 && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1)
      if (d >= 0xdc00 && d < 0xe000) {
        c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00)
        i++
      }
    }
    if (c < 0x80) out.push(c)
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63))
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
  }
  return new Uint8Array(out)
}

export function fromUtf8(b: Uint8Array): string {
  let s = ''
  for (let i = 0; i < b.length; ) {
    const c = b[i++]
    let cp: number
    if (c < 0x80) cp = c
    else if (c < 0xe0) cp = ((c & 31) << 6) | (b[i++] & 63)
    else if (c < 0xf0) cp = ((c & 15) << 12) | ((b[i++] & 63) << 6) | (b[i++] & 63)
    else cp = ((c & 7) << 18) | ((b[i++] & 63) << 12) | ((b[i++] & 63) << 6) | (b[i++] & 63)
    if (cp >= 0x10000) {
      cp -= 0x10000
      s += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 1023))
    } else s += String.fromCharCode(cp)
  }
  return s
}

export function toB64u(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function fromB64u(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export const randomId = (bytes = 16): string => toB64u(nacl.randomBytes(bytes))

export interface KeyPair {
  publicKey: string // base64url
  secretKey: string // base64url
}

export function newKeyPair(): KeyPair {
  const k = nacl.box.keyPair()
  return { publicKey: toB64u(k.publicKey), secretKey: toB64u(k.secretKey) }
}

/** A short, stable id for a device, derived from its public key. */
export const deviceIdOf = (publicKey: string): string => toB64u(nacl.hash(fromB64u(publicKey)).slice(0, 12))

/** The precomputed key for one pair of parties. */
export const sharedKey = (theirPublic: string, mySecret: string): Uint8Array =>
  nacl.box.before(fromB64u(theirPublic), fromB64u(mySecret))

// ---- pairing offer (the QR code) ---------------------------------------------

export interface PairingOffer {
  v: number
  channel: string // Realtime channel id
  desk: string // this machine's public key
  invite: string // one-time invite
  url: string // Supabase project URL
  anon: string // Supabase publishable key
  name: string // this machine's display name
}

export const OFFER_SCHEME = 'rivenremote://pair?o='

export function offerToUrl(o: PairingOffer): string {
  return OFFER_SCHEME + toB64u(utf8(JSON.stringify(o)))
}

export function parseOffer(text: string): PairingOffer | null {
  try {
    const raw = text.startsWith(OFFER_SCHEME) ? text.slice(OFFER_SCHEME.length) : text
    const o = JSON.parse(fromUtf8(fromB64u(raw)))
    const ok =
      o?.v === PROTOCOL &&
      [o.channel, o.desk, o.invite, o.url, o.anon].every((x) => typeof x === 'string' && x.length > 0) &&
      /^https:\/\//.test(o.url)
    return ok ? { ...o, name: typeof o.name === 'string' ? o.name : '' } : null
  } catch {
    return null
  }
}

// ---- sealed messages -----------------------------------------------------------

/** On the wire: who it is for/from, and the box. */
export interface Wire {
  d: string // device id: the sender for phone → desk, the recipient for desk → phone
  nonce: string
  box: string
}

export function seal(shared: Uint8Array, deviceId: string, msg: object): Wire {
  const nonce = nacl.randomBytes(nacl.box.nonceLength)
  const body = utf8(JSON.stringify({ ...msg, ts: Date.now() }))
  return { d: deviceId, nonce: toB64u(nonce), box: toB64u(nacl.box.after(body, nonce, shared)) }
}

export function openWire(shared: Uint8Array, w: Wire): Record<string, unknown> | null {
  try {
    const pt = nacl.box.open.after(fromB64u(w.box), fromB64u(w.nonce), shared)
    if (!pt) return null
    const obj = JSON.parse(fromUtf8(pt))
    return obj && typeof obj === 'object' ? obj : null
  } catch {
    return null
  }
}

export function isWire(x: unknown): x is Wire {
  const w = x as Partial<Wire> | null
  return !!w && typeof w.d === 'string' && typeof w.nonce === 'string' && typeof w.box === 'string'
}

/** Accepts each nonce once, and only from messages inside the time window. */
export class ReplayGuard {
  private seen = new Map<string, number>()
  accept(ts: unknown, nonce: string, now = Date.now()): boolean {
    if (typeof ts !== 'number' || !nonce) return false
    if (Math.abs(now - ts) > REPLAY_WINDOW_MS) return false
    if (this.seen.has(nonce)) return false
    this.seen.set(nonce, ts)
    if (this.seen.size > 1000) for (const [k, t] of this.seen) if (now - t > REPLAY_WINDOW_MS) this.seen.delete(k)
    return true
  }
}

// ---- pairing request (phone → desk, before the device exists) -------------------

export interface PairRequest {
  invite: string
  name: string // e.g. "Galaxy S24"
  platform: string // 'android' | 'ios'
}

/** Boxed with the phone's fresh key to the desk's long-term key. */
export interface PairWire {
  pk: string // the phone's public key
  nonce: string
  box: string
}

export function sealPair(req: PairRequest, deskPublic: string, phone: KeyPair): PairWire {
  return { pk: phone.publicKey, ...seal(sharedKey(deskPublic, phone.secretKey), '', req) }
}

export function openPair(w: unknown, deskSecret: string): { publicKey: string; req: PairRequest; ts: unknown } | null {
  const p = w as Partial<PairWire> | null
  if (!p || typeof p.pk !== 'string' || typeof p.nonce !== 'string' || typeof p.box !== 'string') return null
  let shared: Uint8Array
  try {
    shared = sharedKey(p.pk, deskSecret)
  } catch {
    return null
  }
  const m = openWire(shared, { d: '', nonce: p.nonce, box: p.box })
  if (!m || typeof m.invite !== 'string') return null
  return {
    publicKey: p.pk,
    req: {
      invite: m.invite,
      name: typeof m.name === 'string' ? m.name.slice(0, 60) : '',
      platform: typeof m.platform === 'string' ? m.platform.slice(0, 20) : ''
    },
    ts: m.ts
  }
}

// ---- messages ------------------------------------------------------------------

export type AgentStatus = 'idle' | 'busy' | 'waiting' | 'done'

export interface RemoteAgent {
  id: string // pane key
  workspace: string // display name
  kind: 'chat' | 'terminal'
  title: string
  status: AgentStatus
  /** A chat pane: it can take a message (its workspace is opened if need be). */
  canSend: boolean
}

/** Desk → phone. */
export type DeskMsg =
  | { t: 'paired'; name: string }
  | { t: 'denied' }
  | { t: 'revoked' }
  | { t: 'roster'; agents: RemoteAgent[] }
  | { t: 'ask'; id: string; title: string; question: string; options: string[] }
  | { t: 'askGone'; id: string }
  | { t: 'ack'; reqId: string; ok: boolean; error?: string }
  | { t: 'reply'; reqId: string; chatKey: string; text: string }
  | { t: 'event'; kind: 'done' | 'attention'; id: string; title: string }
  | { t: 'history'; chatKey: string; items: HistoryItem[] }

/** Phone → desk. */
export type PhoneMsg =
  | { t: 'hello' }
  | { t: 'send'; reqId: string; chatKey: string; text: string }
  | { t: 'answer'; id: string; choice: string }
  | { t: 'push'; token: string | null }
  | { t: 'history'; chatKey: string }

export const MAX_TEXT = 20_000
const str = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max

/** Validate what arrived from a phone. Anything malformed is dropped. */
export function parsePhoneMsg(m: Record<string, unknown> | null): PhoneMsg | null {
  if (!m) return null
  switch (m.t) {
    case 'hello':
      return { t: 'hello' }
    case 'send':
      return str(m.reqId, 64) && str(m.chatKey, 200) && str(m.text, MAX_TEXT) && m.text.trim()
        ? { t: 'send', reqId: m.reqId, chatKey: m.chatKey, text: m.text }
        : null
    case 'answer':
      return str(m.id, 200) && str(m.choice, MAX_TEXT) ? { t: 'answer', id: m.id, choice: m.choice } : null
    case 'history':
      return str(m.chatKey, 200) ? { t: 'history', chatKey: m.chatKey } : null
    case 'push':
      return m.token === null || str(m.token, 300) ? { t: 'push', token: m.token as string | null } : null
    default:
      return null
  }
}

/** One relay message tops out at 256KB; keep replies well under it. */
export const MAX_REPLY = 60_000
export const clipReply = (s: string): string => (s.length > MAX_REPLY ? s.slice(0, MAX_REPLY) + '\n…' : s)

/** One line of a chat's conversation, as the phone shows it. */
export interface HistoryItem {
  role: 'user' | 'assistant'
  text: string
  /** Tool calls the agent made in this message (shown as a count). */
  tools?: number
}

const HISTORY_ITEMS = 40
const HISTORY_ITEM_CHARS = 4_000
const HISTORY_BUDGET = 120_000

/**
 * The tail of a conversation, sized for one relay message: the most recent
 * items, each clipped, and the oldest dropped until the whole fits.
 */
export function clipHistory(items: HistoryItem[]): HistoryItem[] {
  const out = items
    .filter((m) => m.text.trim() || m.tools)
    .slice(-HISTORY_ITEMS)
    .map((m) => (m.text.length > HISTORY_ITEM_CHARS ? { ...m, text: m.text.slice(0, HISTORY_ITEM_CHARS) + '\n…' } : m))
  let size = out.reduce((n, m) => n + m.text.length, 0)
  while (out.length > 1 && size > HISTORY_BUDGET) size -= out.shift()!.text.length
  return out
}

/** Realtime channel name for a pairing channel id. */
export const channelName = (id: string): string => `riven-remote-${id}`
