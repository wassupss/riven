// End-to-end encryption for remote control.
//
// The phone and this app share one secret, handed over by the QR code (in the
// URL fragment, which a browser never sends to any server). Everything that
// crosses the relay is sealed with it (AES-256-GCM), so the relay: Supabase
// Realtime: carries ciphertext it cannot read or forge. Each message also
// carries its time and a random nonce, and the receiver drops anything stale
// or already seen, so a captured message cannot be replayed later.
//
// landing/remote.html implements the same envelope in plain JS; the two must
// stay in step (see the "envelope" comment there).

const enc = new TextEncoder()
const dec = new TextDecoder()

export function toB64u(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function fromB64u(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

const random = (n: number): Uint8Array<ArrayBuffer> => crypto.getRandomValues(new Uint8Array(n))

/** A fresh 256-bit key, base64url. */
export const newRemoteKey = (): string => toB64u(random(32))
/** A fresh, unguessable channel id (128 bits), base64url. */
export const newChannelId = (): string => toB64u(random(16))

export function importRemoteKey(key: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', fromB64u(key), 'AES-GCM', false, ['encrypt', 'decrypt'])
}

export interface Envelope {
  iv: string
  ct: string
}

/** Seal a message. The channel id is bound in as associated data, so a message
 *  lifted from one pairing cannot be dropped into another. */
export async function seal(key: CryptoKey, channel: string, msg: object): Promise<Envelope> {
  const iv = random(12)
  const body = enc.encode(JSON.stringify({ ...msg, ts: Date.now(), n: toB64u(random(9)) }))
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(channel) }, key, body)
  return { iv: toB64u(iv), ct: toB64u(new Uint8Array(ct)) }
}

/** Open a sealed message, or null if it was not sealed with this key/channel. */
export async function open(key: CryptoKey, channel: string, env: unknown): Promise<Record<string, unknown> | null> {
  const e = env as Partial<Envelope> | null
  if (!e || typeof e.iv !== 'string' || typeof e.ct !== 'string') return null
  try {
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromB64u(e.iv), additionalData: enc.encode(channel) },
      key,
      fromB64u(e.ct)
    )
    const obj = JSON.parse(dec.decode(pt))
    return obj && typeof obj === 'object' ? (obj as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** How far a message's clock may be from ours. Phones drift; a minute or two is normal. */
export const REPLAY_WINDOW_MS = 3 * 60_000

/** Rejects messages that are stale or were already seen. */
export class ReplayGuard {
  private seen = new Map<string, number>()
  accept(ts: unknown, n: unknown, now = Date.now()): boolean {
    if (typeof ts !== 'number' || typeof n !== 'string' || !n) return false
    if (Math.abs(now - ts) > REPLAY_WINDOW_MS) return false
    if (this.seen.has(n)) return false
    this.seen.set(n, ts)
    // Anything older than the window can no longer be accepted anyway.
    if (this.seen.size > 500) for (const [k, t] of this.seen) if (now - t > REPLAY_WINDOW_MS) this.seen.delete(k)
    return true
  }
}
