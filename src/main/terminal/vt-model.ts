// The worker's terminal MODEL: one libghostty-vt terminal per PTY, all in one
// wasm instance (src/shared/ghostty, the same build the renderer draws with).
//
// It exists for three things only: restoring a pane on reveal/reattach (binary
// snapshot, decoded by the renderer into an identical terminal), the parsed
// bell/title, and the notification preview tail. It never answers queries
// (no WRITE_PTY callback): the renderer's terminal is the one that talks back
// to the shell, and two answers would corrupt the input stream.

import { readFileSync } from 'fs'
import wasmPath from '../../shared/ghostty/ghostty-vt.wasm?asset'
import { instantiateVt, TERM_DATA, TERM_OPT, type Vt } from '../../shared/ghostty/vt'

export interface VtModelEvents {
  bell(): void
  title(title: string): void
}

// libghostty calls back into JS mid-write. Bell and title are only RECORDED
// there and reported after the write returns: the title can only be read once
// the callback has returned, and reporting after the chunk keeps them behind
// output that is already queued (the order the old async parser gave).
interface Pending {
  bell: boolean
  title: boolean
}

interface Shared {
  vt: Vt
  scratch: number
  writeBuf: number
  writeCap: number
  byUd: Map<number, Pending>
  bell: number
  title: number
}

let shared: Shared | null = null
let loading: Promise<Shared> | null = null

export function loadVtModel(): Promise<void> {
  loading ??= instantiateVt(readFileSync(wasmPath)).then((vt) => {
    const byUd = new Map<number, Pending>()
    const mark = (key: keyof Pending) => (_t: number, ud: number) => {
      const p = byUd.get(ud)
      if (p) p[key] = true
    }
    shared = {
      vt,
      scratch: vt.alloc(64),
      writeBuf: 0,
      writeCap: 0,
      byUd,
      bell: vt.callback({ params: 2, result: false }, mark('bell')),
      title: vt.callback({ params: 2, result: false }, mark('title'))
    }
    return shared
  })
  return loading.then(() => undefined)
}

let nextUd = 1

// Plain-text formatter options (GhosttyFormatterTerminalOptions, wasm32):
// size@0, emit@4 (0 = plain), unwrap@8, trim@9, extra@12 (sized struct, 24
// bytes) whose screen sub-struct sits at @24 (12 bytes).
const FMT_OPTS_SIZE = 40

export class VtModel {
  private readonly sh: Shared
  private readonly t: number
  private readonly ud: number
  private readonly pending: Pending = { bell: false, title: false }
  private disposed = false

  constructor(
    cols: number,
    rows: number,
    scrollback: number,
    private readonly events: VtModelEvents
  ) {
    if (!shared) throw new Error('vt model not loaded')
    this.sh = shared
    const { vt } = shared
    const x = vt.x
    this.t = vt.create('ghostty_terminal_new', cols, rows)
    this.ud = nextUd++
    shared.byUd.set(this.ud, this.pending)
    x.ghostty_terminal_set(this.t, TERM_OPT.USERDATA, this.ud)
    x.ghostty_terminal_set(this.t, TERM_OPT.BELL, shared.bell)
    x.ghostty_terminal_set(this.t, TERM_OPT.TITLE_CHANGED, shared.title)
    // Line-bounded scrollback only: the default BYTE cap keeps far fewer lines
    // than asked for.
    x.ghostty_terminal_set(this.t, TERM_OPT.SCROLLBACK_MAX_BYTES, 0)
    vt.dv().setUint32(shared.scratch, scrollback, true)
    x.ghostty_terminal_set(this.t, TERM_OPT.SCROLLBACK_MAX_LINES, shared.scratch)
  }

  // Synchronous: once this returns the model reflects `data`.
  write(data: string): void {
    if (this.disposed) return
    const sh = this.sh
    const { vt } = sh
    // UTF-8 is at most 3 bytes per UTF-16 code unit.
    const need = data.length * 3
    if (need > sh.writeCap) {
      vt.free(sh.writeBuf, sh.writeCap)
      sh.writeCap = Math.max(need, 64 * 1024)
      sh.writeBuf = vt.alloc(sh.writeCap)
    }
    const { written } = vt.enc.encodeInto(data, vt.u8().subarray(sh.writeBuf, sh.writeBuf + sh.writeCap))
    vt.x.ghostty_terminal_vt_write(this.t, sh.writeBuf, written)
    // A 1MB burst must not pin a 3MB buffer for the life of the worker.
    if (sh.writeCap > 1024 * 1024) {
      vt.free(sh.writeBuf, sh.writeCap)
      sh.writeBuf = 0
      sh.writeCap = 0
    }
    if (this.pending.bell) {
      this.pending.bell = false
      this.events.bell()
    }
    if (this.pending.title) {
      this.pending.title = false
      this.events.title(this.readTitle())
    }
  }

  resize(cols: number, rows: number): void {
    if (this.disposed) return
    // Pixel size only feeds XTWINOPS replies, which this model never sends.
    this.sh.vt.x.ghostty_terminal_resize(this.t, cols, rows, 1, 1)
  }

  // The whole terminal (both screens, scrollback, modes, cursor, title) in
  // libghostty's own snapshot format. Exact where a VT re-encoding is not:
  // that loses the primary screen while an alt-screen app is running.
  snapshot(): Uint8Array {
    if (this.disposed) return new Uint8Array(0)
    const { vt, scratch } = this.sh
    vt.check('ghostty_snapshot_encode_alloc', vt.x.ghostty_snapshot_encode_alloc(this.t, 0, scratch, scratch + 4))
    const d = vt.dv()
    const p = d.getUint32(scratch, true)
    const l = d.getUint32(scratch + 4, true)
    const out = vt.u8().slice(p, p + l)
    vt.x.ghostty_free(0, p, l)
    return out
  }

  // The last few content lines, for a notification preview. Reading the parsed
  // grid beats scraping ANSI out of the raw stream: box drawing and cursor
  // games are already resolved.
  tail(lines: number): string {
    if (this.disposed) return ''
    const out: string[] = []
    const all = this.plain().split('\n')
    for (let y = all.length - 1; y >= 0 && out.length < lines; y--) {
      const line = all[y]
        .replace(/[─-╿▀-▟]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
      if (line) out.unshift(line)
    }
    const tail = out.join('\n')
    return tail.length > 240 ? '…' + tail.slice(-240) : tail
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.sh.byUd.delete(this.ud)
    this.sh.vt.x.ghostty_terminal_free(this.t)
  }

  private plain(): string {
    const { vt, scratch } = this.sh
    const x = vt.x
    const o = vt.alloc(FMT_OPTS_SIZE)
    try {
      vt.u8().fill(0, o, o + FMT_OPTS_SIZE)
      const d = vt.dv()
      d.setUint32(o, FMT_OPTS_SIZE, true)
      d.setUint32(o + 12, 24, true)
      d.setUint32(o + 24, 12, true)
      const f = vt.create('ghostty_formatter_terminal_new', this.t, o)
      try {
        vt.check('ghostty_formatter_format_alloc', x.ghostty_formatter_format_alloc(f, 0, scratch, scratch + 4))
        const d2 = vt.dv()
        const p = d2.getUint32(scratch, true)
        const l = d2.getUint32(scratch + 4, true)
        const s = vt.dec.decode(vt.u8().subarray(p, p + l))
        x.ghostty_free(0, p, l)
        return s
      } finally {
        x.ghostty_formatter_free(f)
      }
    } finally {
      vt.free(o, FMT_OPTS_SIZE)
    }
  }

  private readTitle(): string {
    const { vt, scratch } = this.sh
    const d = vt.dv()
    d.setUint32(scratch, 0, true)
    d.setUint32(scratch + 4, 0, true)
    if (vt.x.ghostty_terminal_get(this.t, TERM_DATA.TITLE, scratch) !== 0) return ''
    const d2 = vt.dv()
    const p = d2.getUint32(scratch, true)
    const l = d2.getUint32(scratch + 4, true)
    return p && l ? vt.dec.decode(vt.u8().subarray(p, p + l)) : ''
  }
}
