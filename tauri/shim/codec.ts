// What Electron's structured clone carried that JSON does not: bytes and dates.
// Shared by server.ts (Node) and the preload (page), so both ends agree.
type Tagged = { __u8?: string; __date?: number }

function b64(u8: Uint8Array): string {
  if (typeof Buffer !== 'undefined') return Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength).toString('base64')
  let s = ''
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000))
  return btoa(s)
}
function unb64(s: string): Uint8Array {
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(s, 'base64'))
  const bin = atob(s)
  const u8 = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i)
  return u8
}

export function encode(v: unknown): string {
  // `this[k]` is the value before toJSON ran (Buffer and Date both have one).
  return JSON.stringify(v, function (this: Record<string, unknown>, k: string, val: unknown) {
    const raw = this[k]
    if (raw instanceof Uint8Array) return { __u8: b64(raw) }
    if (raw instanceof ArrayBuffer) return { __u8: b64(new Uint8Array(raw)) }
    if (raw instanceof Date) return { __date: raw.getTime() }
    if (raw instanceof Map) return Object.fromEntries(raw)
    if (raw instanceof Set) return [...raw]
    if (raw instanceof Error) return { message: raw.message, name: raw.name, stack: raw.stack }
    return val
  })
}

export function decode(s: string): unknown {
  return JSON.parse(s, (_k, val: unknown) => {
    if (val && typeof val === 'object') {
      const t = val as Tagged
      if (typeof t.__u8 === 'string') {
        const u8 = unb64(t.__u8)
        return typeof Buffer !== 'undefined' ? Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength) : u8
      }
      if (typeof t.__date === 'number') return new Date(t.__date)
    }
    return val
  })
}
