// A terminal built on our own build of libghostty-vt (see ./vt.ts): Ghostty
// parses the byte stream and owns the screen, scrollback, selection and input
// encoding; this file draws its render state onto a canvas and exposes the
// small, xterm-shaped API that TerminalPane drives.
//
// Drawing is on demand only: a write, a resize or an input change schedules
// one animation frame, and a frame repaints just the rows Ghostty marks dirty
// (plus the old and new cursor rows). Nothing ticks while idle except the
// cursor blink, and that only while focused.

import {
  AUTOSCROLL,
  CELL_DATA,
  CURSOR_STYLE,
  DIRTY,
  GESTURE,
  GESTURE_DATA,
  GESTURE_OPT,
  KEY_ACTION,
  MODE,
  MODS,
  MOUSE_ACTION,
  MOUSE_BUTTON,
  MOUSE_ENC_OPT,
  POINT,
  RESULT,
  ROW_DATA,
  RS_DATA,
  SCROLL,
  SIZEOF,
  STYLE_COLOR,
  TERM_DATA,
  TERM_OPT,
  type Vt
} from '../../../../shared/ghostty/vt'

export interface GhosttyTheme {
  background?: string
  foreground?: string
  cursor?: string
  cursorAccent?: string
  selectionBackground?: string
  black?: string
  red?: string
  green?: string
  yellow?: string
  blue?: string
  magenta?: string
  cyan?: string
  white?: string
  brightBlack?: string
  brightRed?: string
  brightGreen?: string
  brightYellow?: string
  brightBlue?: string
  brightMagenta?: string
  brightCyan?: string
  brightWhite?: string
}

export interface GhosttyTermOptions {
  fontFamily: string
  fontSize: number
  cursorBlink: boolean
  cursorStyle: 'block' | 'bar' | 'underline'
  scrollback: number
  theme: GhosttyTheme
}

interface Disposable {
  dispose(): void
}

type Listener<T> = (v: T) => void

const ANSI_KEYS: Array<keyof GhosttyTheme> = [
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'
]

// Scratch layout inside each terminal's fixed wasm block. Every struct the
// hot paths pass to libghostty lives here, so drawing allocates nothing.
const S = {
  SLOT: 0,
  OUTLEN: 4,
  TMP: 8,
  CURSOR: 24,
  ROWSEL: 48,
  SCROLLBAR: 56,
  MODE: 80,
  POINT: 88,
  REF: 112,
  SCROLL: 128,
  STYLE: 152,
  RGB: 224,
  SEL: 232,
  FMT: 264,
  MSIZE: 280,
  POS: 320,
  GEOM: 336,
  VIEWPORT: 352,
  GBUF: 360,
  OUT: 384,
  OUT_LEN: 128,
  UTF8: 512,
  UTF8_LEN: 16,
  GBYTES: 544,
  GBYTES_LEN: 64,
  CELL: 608,
  SIZE: 1024
}

// Mouse geometry is handed to Ghostty in 1/16 CSS px so cell edges stay exact
// for fractional cell widths (its fields are integers).
const K = 16

// ---- shared per-wasm callbacks ----------------------------------------------

interface Shared {
  terms: Map<number, GhosttyTerm>
  nextUd: number
  write: number
  size: number
  da: number
  hold: number
  bell: number
}

const shared = new WeakMap<Vt, Shared>()

function sharedFor(vt: Vt): Shared {
  let s = shared.get(vt)
  if (s) return s
  const terms = new Map<number, GhosttyTerm>()
  s = {
    terms,
    nextUd: 1,
    write: vt.callback({ params: 4, result: false }, (_t: number, ud: number, p: number, l: number) =>
      terms.get(ud)?._onPty(p, l)
    ),
    size: vt.callback({ params: 3, result: true }, (_t: number, ud: number, out: number) =>
      terms.get(ud)?._onSize(out) ? 1 : 0
    ),
    da: vt.callback({ params: 3, result: true }, (_t: number, _ud: number, o: number) => {
      // VT220-class with ANSI color, the same answer Ghostty itself gives.
      const d = vt.dv()
      d.setUint16(o, 62, true)
      d.setUint16(o + 2, 22, true)
      d.setUint32(o + 132, 1, true)
      d.setUint16(o + 136, 1, true)
      d.setUint16(o + 138, 10, true)
      return 1
    }),
    hold: vt.callback({ params: 3, result: false }, (_t: number, ud: number, held: number) =>
      terms.get(ud)?._onHold(!!held)
    ),
    bell: vt.callback({ params: 2, result: false }, () => {})
  }
  shared.set(vt, s)
  return s
}

// ---- colors -------------------------------------------------------------------

let colorCtx: CanvasRenderingContext2D | null = null

function parseColor(c: string | undefined): [number, number, number] | null {
  if (!c) return null
  colorCtx ??= document.createElement('canvas').getContext('2d')
  if (!colorCtx) return null
  colorCtx.fillStyle = '#000'
  colorCtx.fillStyle = c
  const s = String(colorCtx.fillStyle)
  if (s.startsWith('#')) return [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)]
  const m = s.match(/\d+(\.\d+)?/g)
  return m && m.length >= 3 ? [+m[0], +m[1], +m[2]] : null
}

const cssCache = new Map<number, string>()

function css(r: number, g: number, b: number): string {
  const k = (r << 16) | (g << 8) | b
  let s = cssCache.get(k)
  if (!s) {
    if (cssCache.size > 4096) cssCache.clear()
    s = `rgb(${r},${g},${b})`
    cssCache.set(k, s)
  }
  return s
}

// ---- keyboard tables ----------------------------------------------------------

const KEY_CODES: Record<string, number> = {
  Backquote: 1, Backslash: 2, BracketLeft: 3, BracketRight: 4, Comma: 5, Equal: 16,
  Minus: 46, Period: 47, Quote: 48, Semicolon: 49, Slash: 50,
  Backspace: 53, Enter: 58, Space: 63, Tab: 64, Delete: 68, End: 69, Home: 71, Insert: 72,
  PageDown: 73, PageUp: 74, ArrowDown: 75, ArrowLeft: 76, ArrowRight: 77, ArrowUp: 78,
  NumpadAdd: 90, NumpadDecimal: 95, NumpadDivide: 96, NumpadEnter: 97, NumpadMultiply: 104,
  NumpadSubtract: 107, Escape: 120
}
for (let i = 0; i < 10; i++) {
  KEY_CODES[`Digit${i}`] = 6 + i
  KEY_CODES[`Numpad${i}`] = 80 + i
}
for (let i = 0; i < 26; i++) KEY_CODES[`Key${String.fromCharCode(65 + i)}`] = 20 + i
for (let i = 1; i <= 25; i++) KEY_CODES[`F${i}`] = 120 + i

// The US-layout base character of each physical key, which is what the
// kitty keyboard protocol and ctrl combos are defined against.
const UNSHIFTED: Record<string, string> = {
  Backquote: '`', Backslash: '\\', BracketLeft: '[', BracketRight: ']', Comma: ',', Equal: '=',
  Minus: '-', Period: '.', Quote: "'", Semicolon: ';', Slash: '/', Space: ' '
}
for (let i = 0; i < 10; i++) UNSHIFTED[`Digit${i}`] = String(i)
for (let i = 0; i < 26; i++) UNSHIFTED[`Key${String.fromCharCode(65 + i)}`] = String.fromCharCode(97 + i)

// ---- box drawing ----------------------------------------------------------------

// [up, right, down, left]: 1 light, 2 heavy, 3 double. Drawn as geometry so
// lines join across cells regardless of the font's own glyph metrics.
const BOX: Record<number, [number, number, number, number]> = {
  0x2500: [0, 1, 0, 1], 0x2501: [0, 2, 0, 2], 0x2502: [1, 0, 1, 0], 0x2503: [2, 0, 2, 0],
  0x250c: [0, 1, 1, 0], 0x250f: [0, 2, 2, 0], 0x2510: [0, 0, 1, 1], 0x2513: [0, 0, 2, 2],
  0x2514: [1, 1, 0, 0], 0x2517: [2, 2, 0, 0], 0x2518: [1, 0, 0, 1], 0x251b: [2, 0, 0, 2],
  0x251c: [1, 1, 1, 0], 0x2523: [2, 2, 2, 0], 0x2524: [1, 0, 1, 1], 0x252b: [2, 0, 2, 2],
  0x252c: [0, 1, 1, 1], 0x2533: [0, 2, 2, 2], 0x2534: [1, 1, 0, 1], 0x253b: [2, 2, 0, 2],
  0x253c: [1, 1, 1, 1], 0x254b: [2, 2, 2, 2],
  0x2574: [0, 0, 0, 1], 0x2575: [1, 0, 0, 0], 0x2576: [0, 1, 0, 0], 0x2577: [0, 0, 1, 0],
  0x2578: [0, 0, 0, 2], 0x2579: [2, 0, 0, 0], 0x257a: [0, 2, 0, 0], 0x257b: [0, 0, 2, 0],
  0x2550: [0, 3, 0, 3], 0x2551: [3, 0, 3, 0], 0x2554: [0, 3, 3, 0], 0x2557: [0, 0, 3, 3],
  0x255a: [3, 3, 0, 0], 0x255d: [3, 0, 0, 3], 0x2560: [3, 3, 3, 0], 0x2563: [3, 0, 3, 3],
  0x2566: [0, 3, 3, 3], 0x2569: [3, 3, 0, 3], 0x256c: [3, 3, 3, 3]
}
// dashed lines -> [dashes per cell, horizontal, heavy]
const DASHED: Record<number, [number, boolean, boolean]> = {
  0x2504: [3, true, false], 0x2505: [3, true, true], 0x2506: [3, false, false], 0x2507: [3, false, true],
  0x2508: [4, true, false], 0x2509: [4, true, true], 0x250a: [4, false, false], 0x250b: [4, false, true],
  0x254c: [2, true, false], 0x254d: [2, true, true], 0x254e: [2, false, false], 0x254f: [2, false, true]
}

const ROUNDED: Record<number, [number, number]> = {
  // corner -> [horizontal direction, vertical direction] (+1 right/down)
  0x256d: [1, 1], 0x256e: [-1, 1], 0x256f: [-1, -1], 0x2570: [1, -1]
}

interface CellStyle {
  fg: string
  bg: string | null
  bold: boolean
  italic: boolean
  faint: boolean
  invisible: boolean
  strike: boolean
  overline: boolean
  underline: number
  ul: string | null
}

const DEFAULT_STYLE_KEY = -1

export class GhosttyTerm {
  // ---- xterm-compatible surface ----
  cols = 80
  rows = 24
  readonly options: GhosttyTermOptions
  readonly _core: { _charSizeService: { width: number; height: number; measure(): void } }

  private readonly vt: Vt
  private readonly sh: Shared
  private readonly ud: number
  private t: number
  private readonly rs: number
  private readonly it: number
  private readonly cells: number
  private readonly keyEnc: number
  private readonly keyEv: number
  private readonly mouseEnc: number
  private readonly mouseEv: number
  private readonly gesture: number
  private readonly gEvents: number[]
  private readonly mem: number
  private readonly colorsPtr: number
  private readonly palettePtr: number
  private writeBuf = 0
  private writeCap = 0
  private disposed = false
  // current find match: lowercased query, screen row, string index in row
  private lastFind: { q: string; y: number; i: number } | null = null
  // Rows read for find, kept until the content changes: reading a row costs
  // a wasm call per cell, too slow to repeat over the scrollback per keystroke.
  private findRows: ({ text: string; hay: string; cols: Uint16Array } | undefined)[] | null = null

  private readonly opts: GhosttyTermOptions
  private readonly dataListeners = new Set<Listener<string>>()
  private readonly selListeners = new Set<Listener<void>>()
  private customKey: ((e: KeyboardEvent) => boolean) | null = null
  private ptyOut: Uint8Array[] = []
  private readonly ptyDec = new TextDecoder()

  // DOM
  private root: HTMLDivElement | null = null
  private canvas: HTMLCanvasElement | null = null
  private ctx: CanvasRenderingContext2D | null = null
  private input: HTMLTextAreaElement | null = null
  private compo: HTMLDivElement | null = null
  private ro: ResizeObserver | null = null
  private readonly cleanup: Array<() => void> = []

  // metrics
  private dpr = 1
  private cellW = 8
  private cellH = 16
  private baseline = 12
  private fonts = ['', '', '', '']
  private wideFonts = ['', '', '', '']
  // Whether the last refChar() cell spans two columns.
  private refWide = false

  // frame state
  private raf = 0
  private full = true
  private readonly forceRows = new Set<number>()
  private lastColors = new Uint8Array(SIZEOF.RS_COLORS)
  private defFg = '#fff'
  private defBg = '#000'
  private cursorCss = '#fff'
  private palette: string[] = []
  private paletteRgb = new Uint8Array(768)
  private prevCursorRow = -1
  private lastScroll = ''
  private holdSince = 0
  private holdTimer: ReturnType<typeof setTimeout> | null = null

  // focus / cursor
  private focused = false
  private blinkOn = true
  private blinkTimer: ReturnType<typeof setInterval> | null = null
  private cursorBlinking = false
  private cursorCol = 0
  private cursorRow = 0
  private composing = false

  // mouse
  private selecting = false
  private dragged = false
  private autoTimer: ReturnType<typeof setInterval> | null = null
  private lastMouse = { x: 0, y: 0 }
  private buttonsDown = 0
  private wheelAcc = 0

  constructor(vt: Vt, options: GhosttyTermOptions) {
    this.vt = vt
    this.sh = sharedFor(vt)
    this.opts = { ...options, theme: { ...options.theme } }
    this.t = vt.create('ghostty_terminal_new', this.cols, this.rows)
    this.ud = this.sh.nextUd++
    this.sh.terms.set(this.ud, this)
    this.bindCallbacks()

    this.mem = vt.alloc(S.SIZE)
    vt.u8().fill(0, this.mem, this.mem + S.SIZE)
    this.colorsPtr = vt.alloc(SIZEOF.RS_COLORS)
    this.palettePtr = vt.alloc(768)

    this.rs = vt.create('ghostty_render_state_new')
    this.it = vt.create('ghostty_render_state_row_iterator_new')
    this.cells = vt.create('ghostty_render_state_row_cells_new')
    this.keyEnc = vt.create('ghostty_key_encoder_new')
    this.keyEv = vt.create('ghostty_key_event_new')
    this.mouseEnc = vt.create('ghostty_mouse_encoder_new')
    this.mouseEv = vt.create('ghostty_mouse_event_new')
    this.gesture = vt.create('ghostty_selection_gesture_new')
    this.gEvents = [GESTURE.PRESS, GESTURE.RELEASE, GESTURE.DRAG, GESTURE.AUTOSCROLL_TICK].map((type) =>
      vt.create('ghostty_selection_gesture_event_new', type)
    )

    this.applyTheme()
    this.applyCursor()
    this.applyScrollback()

    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this
    this.options = new Proxy(this.opts, {
      set(target, key, value): boolean {
        const k = key as keyof GhosttyTermOptions
        if (target[k] === value && k !== 'theme') return true
        ;(target as unknown as Record<string, unknown>)[k] = value
        self.optionChanged(k)
        return true
      }
    })
    this._core = {
      _charSizeService: {
        get width(): number {
          return self.cellW
        },
        get height(): number {
          return self.cellH
        },
        measure: (): void => this.measure()
      }
    }
  }

  // ---- public API ------------------------------------------------------------

  open(parent: HTMLElement): void {
    if (this.root || this.disposed) return
    const root = document.createElement('div')
    root.className = 'ghostty-term'
    const canvas = document.createElement('canvas')
    canvas.className = 'ghostty-term-canvas'
    const input = document.createElement('textarea')
    input.className = 'ghostty-term-input'
    input.setAttribute('autocorrect', 'off')
    input.setAttribute('autocapitalize', 'off')
    input.setAttribute('spellcheck', 'false')
    input.setAttribute('aria-label', 'Terminal input')
    input.tabIndex = 0
    const compo = document.createElement('div')
    compo.className = 'ghostty-term-composition'
    root.append(canvas, input, compo)
    parent.appendChild(root)
    this.root = root
    this.canvas = canvas
    this.ctx = canvas.getContext('2d', { alpha: false })
    this.input = input
    this.compo = compo

    this.measure()
    this.sizeCanvas()
    this.ro = new ResizeObserver(() => {
      this.sizeCanvas()
      this.invalidate()
    })
    this.ro.observe(root)
    this.bindInput()
    this.bindMouse()
    this.invalidate()
  }

  write(data: string | Uint8Array, cb?: () => void): void {
    if (this.disposed) {
      if (cb) queueMicrotask(cb)
      return
    }
    const vt = this.vt
    let len: number
    if (typeof data === 'string') {
      // UTF-8 is at most 3 bytes per UTF-16 unit.
      this.ensureWriteBuf(data.length * 3)
      len = vt.enc.encodeInto(data, vt.u8().subarray(this.writeBuf, this.writeBuf + this.writeCap)).written
    } else {
      this.ensureWriteBuf(data.length)
      vt.u8().set(data, this.writeBuf)
      len = data.length
    }
    if (len) {
      vt.x.ghostty_terminal_vt_write(this.t, this.writeBuf, len)
      this.findRows = null
    }
    this.flushPty()
    this.schedule()
    if (cb) queueMicrotask(cb)
  }

  onData(fn: Listener<string>): Disposable {
    this.dataListeners.add(fn)
    return { dispose: () => this.dataListeners.delete(fn) }
  }

  onSelectionChange(fn: Listener<void>): Disposable {
    this.selListeners.add(fn)
    return { dispose: () => this.selListeners.delete(fn) }
  }

  attachCustomKeyEventHandler(fn: (e: KeyboardEvent) => boolean): void {
    this.customKey = fn
  }

  proposeDimensions(): { cols: number; rows: number } | undefined {
    if (!this.root) return undefined
    const w = this.root.clientWidth
    const h = this.root.clientHeight
    if (!w || !h) return undefined
    return { cols: Math.max(1, Math.floor(w / this.cellW)), rows: Math.max(1, Math.floor(h / this.cellH)) }
  }

  resize(cols: number, rows: number): void {
    if (this.disposed) return
    cols = Math.max(1, Math.min(0xffff, cols | 0))
    rows = Math.max(1, Math.min(0xffff, rows | 0))
    if (cols === this.cols && rows === this.rows) return
    this.vt.check(
      'ghostty_terminal_resize',
      this.vt.x.ghostty_terminal_resize(
        this.t,
        cols,
        rows,
        Math.round(this.cellW * this.dpr),
        Math.round(this.cellH * this.dpr)
      )
    )
    this.cols = cols
    this.rows = rows
    this.findRows = null
    this.flushPty()
    this.invalidate()
  }

  reset(): void {
    if (this.disposed) return
    this.vt.x.ghostty_selection_gesture_reset(this.gesture, this.t)
    this.vt.x.ghostty_terminal_reset(this.t)
    this.applyTheme()
    this.applyCursor()
    this.ptyOut = []
    this.findRows = null
    this.invalidate()
  }

  // Replaces the whole terminal with a libghostty snapshot (the worker model's
  // state: both screens, scrollback, modes, cursor). False if the bytes do not
  // decode; the current terminal is then left untouched.
  restore(bytes: Uint8Array): boolean {
    if (this.disposed || !bytes.length) return false
    const vt = this.vt
    const x = vt.x
    const buf = vt.alloc(bytes.length)
    let next = 0
    try {
      vt.u8().set(bytes, buf)
      const dec = vt.create('ghostty_snapshot_decoder_new_buf', buf, bytes.length)
      const slot = x.ghostty_wasm_alloc_opaque() as number
      try {
        if (x.ghostty_snapshot_decoder_decode(dec, slot) === 0) next = x.ghostty_wasm_take_opaque(slot) as number
      } finally {
        x.ghostty_wasm_free_opaque(slot)
        x.ghostty_snapshot_decoder_free(dec)
      }
    } catch (e) {
      console.warn('[ghostty] snapshot decode failed', e)
    } finally {
      vt.free(buf, bytes.length)
    }
    if (!next) return false

    x.ghostty_selection_gesture_reset(this.gesture, this.t)
    x.ghostty_terminal_free(this.t)
    this.t = next
    this.bindCallbacks()
    this.applyTheme()
    this.applyCursor()
    this.applyScrollback()
    // The snapshot carries the model's size; the pane's own size wins.
    x.ghostty_terminal_get(this.t, TERM_DATA.COLS, this.mem + S.TMP)
    const cols = this.vt.dv().getUint16(this.mem + S.TMP, true)
    x.ghostty_terminal_get(this.t, TERM_DATA.ROWS, this.mem + S.TMP)
    const rows = this.vt.dv().getUint16(this.mem + S.TMP, true)
    if (cols !== this.cols || rows !== this.rows) {
      x.ghostty_terminal_resize(
        this.t,
        this.cols,
        this.rows,
        Math.round(this.cellW * this.dpr),
        Math.round(this.cellH * this.dpr)
      )
    }
    this.ptyOut = []
    this.findRows = null
    this.lastFind = null
    this.full = true
    this.flushPty()
    this.invalidate()
    this.scrollToBottom()
    return true
  }

  clear(): void {
    if (this.disposed) return
    // Push the screen into scrollback, home the cursor on the current line's
    // content, then drop the scrollback: what xterm's clear() leaves behind.
    const y = this.cursorY()
    const x = this.cursorX()
    this.write(`\x1b[${y}S\x1b[1;${x + 1}H\x1b[3J`)
  }

  scrollToBottom(): void {
    this.scrollViewport(SCROLL.BOTTOM, 0)
  }

  scrollToLine(line: number): void {
    const sb = this.scrollbar()
    this.scrollViewport(SCROLL.DELTA, Math.round(line - sb.offset))
  }

  scrollLines(n: number): void {
    this.scrollViewport(SCROLL.DELTA, n)
  }

  focus(): void {
    this.input?.focus({ preventScroll: true })
  }

  blur(): void {
    this.input?.blur()
  }

  refresh(_start?: number, _end?: number): void {
    this.invalidate()
  }

  clearTextureAtlas(): void {
    this.invalidate()
  }

  hasSelection(): boolean {
    return this.vt.x.ghostty_terminal_get(this.t, TERM_DATA.SELECTION, this.mem + S.SEL) === RESULT.SUCCESS
  }

  getSelection(): string {
    const vt = this.vt
    const f = this.mem + S.FMT
    const d = vt.dv()
    for (let i = 0; i < SIZEOF.SELECTION_FORMAT; i++) d.setUint8(f + i, 0)
    d.setUint32(f, SIZEOF.SELECTION_FORMAT, true)
    d.setUint8(f + 8, 1) // unwrap soft-wrapped lines
    d.setUint8(f + 9, 1) // trim trailing whitespace
    const pp = this.mem + S.TMP
    const lp = this.mem + S.TMP + 4
    if (vt.x.ghostty_terminal_selection_format_alloc(this.t, 0, f, pp, lp) !== RESULT.SUCCESS) return ''
    const dv = vt.dv()
    const ptr = dv.getUint32(pp, true)
    const len = dv.getUint32(lp, true)
    const s = len ? vt.dec.decode(vt.u8().slice(ptr, ptr + len)) : ''
    if (ptr) vt.x.ghostty_free(0, ptr, len)
    return s
  }

  clearSelection(): void {
    if (!this.hasSelection()) return
    this.vt.x.ghostty_terminal_set(this.t, TERM_OPT.SELECTION, 0)
    this.invalidate()
    this.selListeners.forEach((f) => f())
  }

  // ---- find (the slice of xterm's SearchAddon that TerminalPane uses) -------
  // A match is shown as the selection, like SearchAddon without decorations.
  // Case-insensitive; matches don't span soft-wrapped rows.

  findNext(query: string): boolean {
    return this.find(query, false)
  }

  findPrevious(query: string): boolean {
    return this.find(query, true)
  }

  clearDecorations(): void {
    this.lastFind = null
    this.findRows = null
    this.clearSelection()
  }

  private findRow(y: number): { text: string; hay: string; cols: Uint16Array } {
    const rows = (this.findRows ??= [])
    let r = rows[y]
    if (!r) {
      const { text, cols } = this.lineCells(y)
      r = rows[y] = { text, hay: text.toLowerCase(), cols: Uint16Array.from(cols) }
    }
    return r
  }

  private find(query: string, back: boolean): boolean {
    if (this.disposed || !query) return false
    const q = query.toLowerCase()
    const sb = this.scrollbar()
    const total = sb.total
    const last = this.lastFind && this.lastFind.y < total ? this.lastFind : null
    // Typing more of the same query keeps the current match if it still fits
    // (SearchAddon's incremental behaviour); otherwise step past it.
    const extend = !back && last != null && q !== last.q && q.startsWith(last.q)
    let y = last ? last.y : back ? sb.offset + sb.len - 1 : sb.offset
    let from = last ? (extend ? last.i : back ? last.i - 1 : last.i + 1) : back ? Infinity : 0
    for (let n = 0; n <= total; n++) {
      const { text, hay, cols } = this.findRow(y)
      const lower = hay.length === text.length
      const h = lower ? hay : text
      const needle = lower ? q : query
      const i = back
        ? from < 0
          ? -1
          : h.lastIndexOf(needle, from)
        : h.indexOf(needle, from)
      if (i >= 0) {
        const end = i + needle.length
        this.selectCells(y, cols[i], end < cols.length ? cols[end] - 1 : this.cols - 1)
        this.lastFind = { q, y, i }
        if (y < sb.offset || y >= sb.offset + sb.len) this.scrollToLine(y - (sb.len >> 1))
        return true
      }
      y = back ? (y - 1 + total) % total : (y + 1) % total
      from = back ? Infinity : 0
    }
    this.lastFind = null
    this.clearSelection()
    return false
  }

  // Selects screen row `y` from column a to b inclusive.
  private selectCells(y: number, a: number, b: number): void {
    const vt = this.vt
    const sel = this.mem + S.SEL
    const p = this.mem + S.POINT
    const d = vt.dv()
    for (let i = 0; i < SIZEOF.SELECTION; i++) d.setUint8(sel + i, 0)
    d.setUint32(sel, SIZEOF.SELECTION, true)
    for (const [off, col] of [
      [4, a],
      [16, b]
    ]) {
      const dv = vt.dv()
      for (let i = 0; i < SIZEOF.POINT; i++) dv.setUint8(p + i, 0)
      dv.setInt32(p, POINT.SCREEN, true)
      dv.setUint16(p + 8, col, true)
      dv.setUint32(p + 12, y, true)
      dv.setUint32(sel + off, SIZEOF.GRID_REF, true)
      if (vt.x.ghostty_terminal_grid_ref(this.t, p, sel + off) !== RESULT.SUCCESS) return
    }
    vt.x.ghostty_terminal_set(this.t, TERM_OPT.SELECTION, sel)
    this.invalidate()
    this.selListeners.forEach((f) => f())
  }

  get buffer(): {
    active: {
      type: 'normal' | 'alternate'
      viewportY: number
      baseY: number
      length: number
      cursorX: number
      cursorY: number
      getLine(y: number): { translateToString(trim?: boolean): string } | undefined
    }
  } {
    const sb = this.scrollbar()
    const term = this
    return {
      active: {
        type: this.flag(TERM_DATA.ACTIVE_SCREEN) ? 'alternate' : 'normal',
        viewportY: sb.offset,
        baseY: Math.max(0, sb.total - sb.len),
        length: sb.total,
        cursorX: this.cursorX(),
        cursorY: this.cursorY(),
        getLine: (y: number) => (y < 0 || y >= sb.total ? undefined : { translateToString: (trim?: boolean) => term.lineText(y, !!trim) })
      }
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    cancelAnimationFrame(this.raf)
    if (this.holdTimer) clearTimeout(this.holdTimer)
    this.stopBlink()
    this.stopAutoscroll()
    this.ro?.disconnect()
    this.cleanup.forEach((f) => f())
    this.root?.remove()
    this.root = this.canvas = this.ctx = this.input = this.compo = null
    this.dataListeners.clear()
    this.selListeners.clear()
    const vt = this.vt
    const x = vt.x
    this.sh.terms.delete(this.ud)
    x.ghostty_selection_gesture_free(this.gesture, this.t)
    this.gEvents.forEach((e) => x.ghostty_selection_gesture_event_free(e))
    x.ghostty_key_encoder_free(this.keyEnc)
    x.ghostty_key_event_free(this.keyEv)
    x.ghostty_mouse_encoder_free(this.mouseEnc)
    x.ghostty_mouse_event_free(this.mouseEv)
    x.ghostty_render_state_row_cells_free(this.cells)
    x.ghostty_render_state_row_iterator_free(this.it)
    x.ghostty_render_state_free(this.rs)
    x.ghostty_terminal_free(this.t)
    vt.free(this.mem, S.SIZE)
    vt.free(this.colorsPtr, SIZEOF.RS_COLORS)
    vt.free(this.palettePtr, 768)
    if (this.writeBuf) vt.free(this.writeBuf, this.writeCap)
    this.writeBuf = 0
  }

  // ---- callbacks from wasm (synchronous, inside vt_write) ---------------------

  _onPty(ptr: number, len: number): void {
    this.ptyOut.push(this.vt.u8().slice(ptr, ptr + len))
  }

  _onSize(out: number): boolean {
    const d = this.vt.dv()
    d.setUint16(out, this.rows, true)
    d.setUint16(out + 2, this.cols, true)
    d.setUint32(out + 4, Math.round(this.cellW * this.dpr), true)
    d.setUint32(out + 8, Math.round(this.cellH * this.dpr), true)
    return true
  }

  _onHold(held: boolean): void {
    if (held) {
      // Capture the last complete frame before the program starts its
      // synchronized update; draws keep showing it until the release.
      this.vt.x.ghostty_render_state_update(this.rs, this.t)
      this.holdSince = performance.now()
    } else {
      this.holdSince = 0
      if (this.holdTimer) clearTimeout(this.holdTimer)
      this.holdTimer = null
      this.schedule()
    }
  }

  // ---- options ---------------------------------------------------------------

  private optionChanged(k: keyof GhosttyTermOptions): void {
    if (this.disposed) return
    switch (k) {
      case 'fontFamily':
      case 'fontSize':
        this.measure()
        break
      case 'theme':
        this.applyTheme()
        this.invalidate()
        break
      case 'cursorStyle':
      case 'cursorBlink':
        this.applyCursor()
        this.syncBlink()
        this.invalidate()
        break
      case 'scrollback':
        this.applyScrollback()
        break
    }
  }

  // Per-terminal callbacks: set on construction and again on the terminal a
  // snapshot decodes into.
  private bindCallbacks(): void {
    const x = this.vt.x
    x.ghostty_terminal_set(this.t, TERM_OPT.USERDATA, this.ud)
    x.ghostty_terminal_set(this.t, TERM_OPT.WRITE_PTY, this.sh.write)
    x.ghostty_terminal_set(this.t, TERM_OPT.SIZE, this.sh.size)
    x.ghostty_terminal_set(this.t, TERM_OPT.DEVICE_ATTRIBUTES, this.sh.da)
    x.ghostty_terminal_set(this.t, TERM_OPT.RENDER_HOLD, this.sh.hold)
    x.ghostty_terminal_set(this.t, TERM_OPT.BELL, this.sh.bell)
  }

  private applyTheme(): void {
    const vt = this.vt
    const x = vt.x
    const th = this.opts.theme
    x.ghostty_color_palette_default(this.palettePtr)
    const u8 = vt.u8()
    ANSI_KEYS.forEach((key, i) => {
      const c = parseColor(th[key])
      if (c) u8.set(c, this.palettePtr + i * 3)
    })
    x.ghostty_terminal_set(this.t, TERM_OPT.COLOR_PALETTE, this.palettePtr)
    const setRgb = (opt: number, c: string | undefined): void => {
      const rgb = parseColor(c)
      if (!rgb) return
      vt.u8().set(rgb, this.mem + S.RGB)
      x.ghostty_terminal_set(this.t, opt, this.mem + S.RGB)
    }
    setRgb(TERM_OPT.COLOR_FG, th.foreground)
    setRgb(TERM_OPT.COLOR_BG, th.background)
    setRgb(TERM_OPT.COLOR_CURSOR, th.cursor)
    this.full = true
  }

  private applyCursor(): void {
    const d = this.vt.dv()
    const style =
      this.opts.cursorStyle === 'bar'
        ? CURSOR_STYLE.BAR
        : this.opts.cursorStyle === 'underline'
          ? CURSOR_STYLE.UNDERLINE
          : CURSOR_STYLE.BLOCK
    d.setInt32(this.mem + S.TMP, style, true)
    this.vt.x.ghostty_terminal_set(this.t, TERM_OPT.DEFAULT_CURSOR_STYLE, this.mem + S.TMP)
    this.vt.dv().setUint8(this.mem + S.TMP, this.opts.cursorBlink ? 1 : 0)
    this.vt.x.ghostty_terminal_set(this.t, TERM_OPT.DEFAULT_CURSOR_BLINK, this.mem + S.TMP)
  }

  private applyScrollback(): void {
    // Like xterm, the limit is lines only. Ghostty also starts with a default
    // byte cap that kept just a few hundred lines; NULL removes it.
    this.vt.x.ghostty_terminal_set(this.t, TERM_OPT.SCROLLBACK_MAX_BYTES, 0)
    this.vt.dv().setUint32(this.mem + S.TMP, Math.max(0, this.opts.scrollback | 0), true)
    this.vt.x.ghostty_terminal_set(this.t, TERM_OPT.SCROLLBACK_MAX_LINES, this.mem + S.TMP)
  }

  // ---- metrics -----------------------------------------------------------------

  private measure(): void {
    const ctx = this.ctx ?? document.createElement('canvas').getContext('2d')
    if (!ctx) return
    this.dpr = window.devicePixelRatio || 1
    const { fontFamily, fontSize } = this.opts
    this.fonts = [
      `${fontSize}px ${fontFamily}`,
      `bold ${fontSize}px ${fontFamily}`,
      `italic ${fontSize}px ${fontFamily}`,
      `italic bold ${fontSize}px ${fontFamily}`
    ]
    ctx.save()
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.font = this.fonts[0]
    const m = ctx.measureText('MMMMMMMMMM')
    // Grow the CJK fallback face toward its two-cell slot (Apple SD Gothic
    // Neo's 가 is 0.87em, which left 한 글 gaps), capped so Hangul stays near
    // the Latin size: filling the slot fully meant 16.6px glyphs next to 12px.
    const ic = ctx.measureText('가').width
    ctx.restore()
    const icScale = ic > 0 ? Math.max(1, Math.min((2 * (m.width / 10)) / ic, 1.15)) : 1
    const wideSize = Math.round(fontSize * icScale * 10) / 10
    this.wideFonts = this.fonts.map((f) => f.replace(`${fontSize}px`, `${wideSize}px`))
    // Fractional advance like xterm.js: rounding to whole device pixels made
    // cells ~4% wider (7.5 vs 7.2 css at dpr 1.2), so lines wrapped at other
    // columns than the xterm engine. Fills snap to device pixels in px().
    const w = m.width / 10
    const asc = m.fontBoundingBoxAscent || fontSize * 0.8
    const desc = m.fontBoundingBoxDescent || fontSize * 0.2
    // Native ghostty's rule (adjust-cell-height unset): the cell is the font's
    // natural line height, so powerline/box glyphs hug the text like cmux.
    // xterm's lineHeight 1.25 left prompt segments visibly taller than glyphs.
    const h = Math.ceil((asc + desc) * this.dpr) / this.dpr
    const changed = w !== this.cellW || h !== this.cellH
    this.cellW = w || 8
    this.cellH = h || 16
    this.baseline = Math.round(((this.cellH - (asc + desc)) / 2 + asc) * this.dpr) / this.dpr
    if (this.compo) {
      // IME preedit is Hangul, so it uses the CJK size the committed text gets.
      this.compo.style.font = this.wideFonts[0]
      this.compo.style.lineHeight = `${this.cellH}px`
    }
    if (changed && this.root) this.sizeCanvas()
    this.invalidate()
  }

  private sizeCanvas(): void {
    const root = this.root
    const canvas = this.canvas
    if (!root || !canvas) return
    const dpr = window.devicePixelRatio || 1
    if (dpr !== this.dpr) {
      this.dpr = dpr
      this.measure()
      return
    }
    const w = Math.round(root.clientWidth * dpr)
    const h = Math.round(root.clientHeight * dpr)
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w
      canvas.height = h
      canvas.style.width = `${w / dpr}px`
      canvas.style.height = `${h / dpr}px`
    }
    this.full = true
  }

  // ---- drawing -----------------------------------------------------------------

  private invalidate(): void {
    this.full = true
    this.schedule()
  }

  private schedule(): void {
    if (this.raf || this.disposed || !this.ctx) return
    this.raf = requestAnimationFrame(() => {
      this.raf = 0
      this.draw()
    })
  }

  private draw(): void {
    const ctx = this.ctx
    const canvas = this.canvas
    if (!ctx || !canvas || this.disposed || !canvas.width) return
    if ((window.devicePixelRatio || 1) !== this.dpr) this.sizeCanvas()
    const vt = this.vt
    const x = vt.x

    if (this.holdSince) {
      const held = performance.now() - this.holdSince
      if (held >= 1000) {
        // A program that never ends its synchronized update must not freeze
        // the screen: Ghostty's own renderer gives up after a second too.
        const d = vt.dv()
        d.setUint16(this.mem + S.MODE, MODE.SYNC, true)
        d.setUint8(this.mem + S.MODE + 2, 0)
        x.ghostty_terminal_set(this.t, TERM_OPT.MODE, this.mem + S.MODE)
        this.holdSince = 0
        x.ghostty_render_state_update(this.rs, this.t)
      } else {
        this.holdTimer ??= setTimeout(() => {
          this.holdTimer = null
          this.schedule()
        }, 1000 - held)
        if (!this.full && !this.forceRows.size) return
      }
    } else {
      x.ghostty_render_state_update(this.rs, this.t)
    }

    // colors (OSC 10/11/4 can change them at any time)
    vt.dv().setUint32(this.colorsPtr, SIZEOF.RS_COLORS, true)
    x.ghostty_render_state_get(this.rs, RS_DATA.COLORS, this.colorsPtr)
    const colors = vt.u8().subarray(this.colorsPtr, this.colorsPtr + SIZEOF.RS_COLORS)
    if (!this.palette.length || !bytesEqual(colors, this.lastColors)) {
      this.lastColors.set(colors)
      const c = this.lastColors
      this.defBg = css(c[4], c[5], c[6])
      this.defFg = css(c[7], c[8], c[9])
      this.cursorCss = c[13] ? css(c[10], c[11], c[12]) : this.defFg
      this.paletteRgb = c.slice(14, 14 + 768)
      this.palette = []
      for (let i = 0; i < 256; i++)
        this.palette.push(css(this.paletteRgb[i * 3], this.paletteRgb[i * 3 + 1], this.paletteRgb[i * 3 + 2]))
      this.full = true
      if (this.root) this.root.style.background = this.defBg
    }

    // scrollbar position: a change repaints everything (the thumb overlays cells)
    const sb = this.scrollbar()
    const scrollKey = `${sb.total},${sb.offset},${sb.len}`
    if (scrollKey !== this.lastScroll) {
      this.lastScroll = scrollKey
      this.full = true
    }

    // cursor
    const cur = this.mem + S.CURSOR
    const d0 = vt.dv()
    for (let i = 0; i < SIZEOF.RS_CURSOR; i++) d0.setUint8(cur + i, 0)
    d0.setUint32(cur, SIZEOF.RS_CURSOR, true)
    x.ghostty_render_state_get(this.rs, RS_DATA.CURSOR, cur)
    const dc = vt.dv()
    const curHas = !!dc.getUint8(cur + 4)
    let curX = dc.getUint16(cur + 6, true)
    const curY = dc.getUint16(cur + 8, true)
    if (dc.getUint8(cur + 10) && curX > 0) curX--
    const curVisible = !!dc.getUint8(cur + 11)
    const blinking = !!dc.getUint8(cur + 12)
    const curStyle = dc.getInt32(cur + 16, true)
    if (blinking !== this.cursorBlinking) {
      this.cursorBlinking = blinking
      this.syncBlink()
    }
    const cursorRow = curHas ? curY : -1
    if (this.prevCursorRow !== cursorRow) {
      if (this.prevCursorRow >= 0) this.forceRows.add(this.prevCursorRow)
      if (cursorRow >= 0) this.forceRows.add(cursorRow)
    }
    if (curHas && (curX !== this.cursorCol || curY !== this.cursorRow)) {
      this.cursorCol = curX
      this.cursorRow = curY
      this.forceRows.add(curY)
      this.placeInput()
    }

    const dpr = this.dpr
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.textBaseline = 'alphabetic'

    // global dirty
    const dp = this.mem + S.TMP
    vt.dv().setInt32(dp, 0, true)
    x.ghostty_render_state_get(this.rs, RS_DATA.DIRTY, dp)
    const full = this.full || vt.dv().getInt32(dp, true) === DIRTY.FULL
    if (full) {
      ctx.fillStyle = this.defBg
      ctx.fillRect(0, 0, canvas.width / dpr, canvas.height / dpr)
    }

    // rows
    const slot = this.mem + S.SLOT
    vt.dv().setUint32(slot, this.it, true)
    x.ghostty_render_state_get(this.rs, RS_DATA.ROW_ITERATOR, slot)
    let y = 0
    while (x.ghostty_render_state_row_iterator_next(this.it)) {
      let paint = full || this.forceRows.has(y)
      if (!paint) {
        vt.dv().setUint8(dp, 0)
        x.ghostty_render_state_row_get(this.it, ROW_DATA.DIRTY, dp)
        paint = !!vt.dv().getUint8(dp)
      }
      if (paint) this.drawRow(ctx, y)
      y++
    }

    // cursor
    if (curHas && curVisible && cursorRow >= 0 && (!blinking || this.blinkOn || !this.focused)) {
      this.drawCursor(ctx, curX, curY, this.focused ? curStyle : CURSOR_STYLE.BLOCK_HOLLOW)
    }
    this.prevCursorRow = cursorRow

    if (sb.total > sb.len && sb.offset + sb.len < sb.total) this.drawScrollbar(ctx, sb)

    x.ghostty_render_state_clean(this.rs)
    this.full = false
    this.forceRows.clear()
  }

  private drawRow(ctx: CanvasRenderingContext2D, y: number): void {
    const vt = this.vt
    const x = vt.x
    const cw = this.cellW
    const ch = this.cellH
    const top = y * ch
    const m = this.mem

    // raw cells (copied: the view dies on the next render-state call)
    x.ghostty_render_state_row_get(this.it, ROW_DATA.CELLS_RAW, m + S.TMP)
    let d = vt.dv()
    const ptr = d.getUint32(m + S.TMP, true)
    const n = d.getUint32(m + S.TMP + 4, true)
    const raw = new Uint32Array(vt.u8().slice(ptr, ptr + n * 8).buffer)
    vt.dv().setUint32(m + S.SLOT, this.cells, true)
    x.ghostty_render_state_row_get(this.it, ROW_DATA.CELLS, m + S.SLOT)

    // selection
    let selA = -1
    let selB = -2
    d = vt.dv()
    d.setUint32(m + S.ROWSEL, SIZEOF.ROW_SELECTION, true)
    if (x.ghostty_render_state_row_get(this.it, ROW_DATA.SELECTION, m + S.ROWSEL) === RESULT.SUCCESS) {
      d = vt.dv()
      selA = d.getUint16(m + S.ROWSEL + 4, true)
      selB = d.getUint16(m + S.ROWSEL + 6, true)
    }

    ctx.save()
    ctx.beginPath()
    ctx.rect(0, top, this.canvas ? this.canvas.width / this.dpr : n * cw, ch)
    ctx.clip()
    ctx.fillStyle = this.defBg
    ctx.fillRect(0, top, (this.canvas?.width ?? 0) / this.dpr, ch)

    // pass 1: resolve styles + backgrounds
    const styles: Array<CellStyle | null> = new Array(n)
    const cache = new Map<number, CellStyle>()
    let runBg: string | null = null
    let runStart = 0
    const px = (col: number): number => Math.round(col * cw * this.dpr) / this.dpr
    const flushBg = (end: number): void => {
      if (runBg) {
        ctx.fillStyle = runBg
        ctx.fillRect(px(runStart), top, px(end) - px(runStart), ch)
      }
    }
    for (let i = 0; i < n; i++) {
      const lo = raw[i * 2]
      const hi = raw[i * 2 + 1]
      const tag = lo & 3
      let st: CellStyle | null = null
      let bg: string | null = null
      if (tag >= 2) {
        bg = this.cellRgb(i, CELL_DATA.BG)
      } else {
        const sid = (lo >>> 26) | ((hi & 0x3ff) << 6)
        if (sid) {
          st = cache.get(sid) ?? null
          if (!st) {
            st = this.resolveStyle(i)
            cache.set(sid, st)
          }
          bg = st.bg
        } else {
          st = cache.get(DEFAULT_STYLE_KEY) ?? null
          if (!st) {
            st = this.defaultStyle()
            cache.set(DEFAULT_STYLE_KEY, st)
          }
        }
      }
      styles[i] = st
      if (bg !== runBg) {
        flushBg(i)
        runBg = bg
        runStart = i
      }
    }
    flushBg(n)

    if (selA >= 0 && selB >= selA) {
      ctx.fillStyle = this.opts.theme.selectionBackground || 'rgba(255,255,255,0.2)'
      ctx.fillRect(px(selA), top, px(selB + 1) - px(selA), ch)
    }

    // pass 2: text + decorations
    let font = -1
    let fill = ''
    let alpha = 1
    const base = top + this.baseline
    for (let i = 0; i < n; i++) {
      const st = styles[i]
      if (!st || st.invisible) continue
      const lo = raw[i * 2]
      const hi = raw[i * 2 + 1]
      const tag = lo & 3
      const wide = (hi >>> 10) & 3
      if (wide >= 2) continue
      const cp = (lo >>> 2) & 0xffffff
      const cells = wide === 1 ? 2 : 1
      const fg = st.fg
      const a = st.faint ? 0.5 : 1
      if (a !== alpha) ctx.globalAlpha = alpha = a
      if (fg !== fill) ctx.fillStyle = fill = fg

      if (cp > 32) {
        if (!this.drawSpecial(ctx, cp, px(i), top, px(i + cells) - px(i), ch, fg)) {
          const f = (st.bold ? 1 : 0) | (st.italic ? 2 : 0)
          if (f !== font) ctx.font = this.fonts[(font = f)]
          const text = tag === 1 ? this.cellGraphemes(i) : String.fromCodePoint(cp)
          if (cells === 2) {
            // Center in the two-cell slot. CJK uses the scaled face, centered
            // vertically since it is taller than the primary font.
            ctx.textAlign = 'center'
            if (isCJK(cp)) {
              ctx.font = this.wideFonts[f]
              font = -1
              ctx.textBaseline = 'middle'
              ctx.fillText(text, (i + 1) * cw, top + ch / 2)
              ctx.textBaseline = 'alphabetic'
            } else {
              ctx.fillText(text, (i + 1) * cw, base)
            }
            ctx.textAlign = 'left'
          } else {
            ctx.fillText(text, i * cw, base)
          }
        }
      }
      if (st.underline || st.strike || st.overline) {
        ctx.strokeStyle = st.ul ?? fg
        this.drawDecorations(ctx, st, i * cw, top, cells * cw)
      }
    }
    if (alpha !== 1) ctx.globalAlpha = 1
    ctx.restore()
  }

  private defaultStyle(): CellStyle {
    return {
      fg: this.defFg,
      bg: null,
      bold: false,
      italic: false,
      faint: false,
      invisible: false,
      strike: false,
      overline: false,
      underline: 0,
      ul: null
    }
  }

  private resolveStyle(col: number): CellStyle {
    const vt = this.vt
    const x = vt.x
    const p = this.mem + S.STYLE
    x.ghostty_render_state_row_cells_select(this.cells, col)
    vt.dv().setUint32(p, SIZEOF.STYLE, true)
    x.ghostty_render_state_row_cells_get(this.cells, CELL_DATA.STYLE, p)
    const d = vt.dv()
    const bold = !!d.getUint8(p + 56)
    const italic = !!d.getUint8(p + 57)
    const faint = !!d.getUint8(p + 58)
    const inverse = !!d.getUint8(p + 60)
    const invisible = !!d.getUint8(p + 61)
    const strike = !!d.getUint8(p + 62)
    const overline = !!d.getUint8(p + 63)
    const underline = d.getInt32(p + 64, true)
    const fgTag = d.getInt32(p + 8, true)
    const fgIdx = d.getUint8(p + 16)
    const ulTag = d.getInt32(p + 40, true)
    let ul: string | null = null
    if (ulTag === STYLE_COLOR.RGB) ul = css(d.getUint8(p + 48), d.getUint8(p + 49), d.getUint8(p + 50))
    else if (ulTag === STYLE_COLOR.PALETTE) ul = this.palette[d.getUint8(p + 48)] ?? null

    let fg: string
    if (bold && fgTag === STYLE_COLOR.PALETTE && fgIdx < 8) fg = this.palette[fgIdx + 8]
    else fg = this.cellRgb(col, CELL_DATA.FG, false) ?? this.defFg
    let bg = this.cellRgb(col, CELL_DATA.BG, false)
    if (inverse) {
      const f = fg
      fg = bg ?? this.defBg
      bg = f
    }
    return { fg, bg, bold, italic, faint, invisible, strike, overline, underline, ul }
  }

  // FG/BG of a cell, null when it uses the default. `select` is false when
  // the caller already selected this column.
  private cellRgb(col: number, key: number, select = true): string | null {
    const vt = this.vt
    const x = vt.x
    if (select) x.ghostty_render_state_row_cells_select(this.cells, col)
    const p = this.mem + S.RGB
    if (x.ghostty_render_state_row_cells_get(this.cells, key, p) !== RESULT.SUCCESS) return null
    const u = vt.u8()
    return css(u[p], u[p + 1], u[p + 2])
  }

  private cellGraphemes(col: number): string {
    const vt = this.vt
    const x = vt.x
    const b = this.mem + S.GBUF
    x.ghostty_render_state_row_cells_select(this.cells, col)
    const d = vt.dv()
    d.setUint32(b, this.mem + S.GBYTES, true)
    d.setUint32(b + 4, S.GBYTES_LEN, true)
    d.setUint32(b + 8, 0, true)
    if (x.ghostty_render_state_row_cells_get(this.cells, CELL_DATA.GRAPHEMES_UTF8, b) !== RESULT.SUCCESS) return ''
    const len = vt.dv().getUint32(b + 8, true)
    return vt.dec.decode(vt.u8().slice(this.mem + S.GBYTES, this.mem + S.GBYTES + len))
  }

  private drawDecorations(ctx: CanvasRenderingContext2D, st: CellStyle, x0: number, top: number, w: number): void {
    const ch = this.cellH
    const lw = Math.max(1, Math.round(this.opts.fontSize / 14)) / this.dpr
    ctx.lineWidth = lw
    ctx.beginPath()
    const uy = top + Math.min(ch - lw, this.baseline + 2)
    switch (st.underline) {
      case 0:
        break
      case 2:
        ctx.moveTo(x0, uy - lw)
        ctx.lineTo(x0 + w, uy - lw)
        ctx.moveTo(x0, uy + lw)
        ctx.lineTo(x0 + w, uy + lw)
        break
      case 3: {
        const amp = Math.max(1, ch / 12)
        ctx.moveTo(x0, uy)
        for (let i = 0; i <= 4; i++) ctx.lineTo(x0 + (w * i) / 4, uy + (i % 2 ? amp : -amp) / 2)
        break
      }
      case 4:
      case 5:
        ctx.setLineDash(st.underline === 4 ? [lw, lw * 2] : [lw * 3, lw * 2])
        ctx.moveTo(x0, uy)
        ctx.lineTo(x0 + w, uy)
        break
      default:
        ctx.moveTo(x0, uy)
        ctx.lineTo(x0 + w, uy)
    }
    if (st.strike) {
      const sy = top + ch / 2
      ctx.moveTo(x0, sy)
      ctx.lineTo(x0 + w, sy)
    }
    if (st.overline) {
      ctx.moveTo(x0, top + lw / 2)
      ctx.lineTo(x0 + w, top + lw / 2)
    }
    ctx.stroke()
    ctx.setLineDash([])
  }

  // Box drawing and block elements as geometry. Returns false for anything
  // the font should draw.
  private drawSpecial(
    ctx: CanvasRenderingContext2D,
    cp: number,
    x0: number,
    y0: number,
    w: number,
    h: number,
    color: string
  ): boolean {
    if (cp < 0x2500 || cp > 0x259f) return false
    ctx.fillStyle = color
    if (cp >= 0x2580) return this.drawBlock(ctx, cp, x0, y0, w, h)
    const light = Math.max(1, Math.round(this.opts.fontSize / 12)) / this.dpr
    const heavy = light * 2
    const cx = Math.round((x0 + w / 2) * this.dpr) / this.dpr
    const cy = Math.round((y0 + h / 2) * this.dpr) / this.dpr
    const r = ROUNDED[cp]
    if (r) {
      ctx.strokeStyle = color
      ctx.lineWidth = light
      ctx.beginPath()
      const ex = r[0] > 0 ? x0 + w : x0
      const ey = r[1] > 0 ? y0 + h : y0
      const rad = Math.min(w, h) / 2
      ctx.moveTo(ex, cy)
      ctx.arcTo(cx, cy, cx, ey, rad)
      ctx.lineTo(cx, ey)
      ctx.stroke()
      return true
    }
    const dash = DASHED[cp]
    if (dash) {
      // n dashes per cell, each half a segment and centered in it, so the
      // gaps stay even across neighbouring cells (claude's ╌ divider).
      const [n, horiz, isHeavy] = dash
      const t = isHeavy ? heavy : light
      const seg = (horiz ? w : h) / n
      for (let k = 0; k < n; k++) {
        const s = (horiz ? x0 : y0) + k * seg + seg / 4
        if (horiz) ctx.fillRect(s, cy - t / 2, seg / 2, t)
        else ctx.fillRect(cx - t / 2, s, t, seg / 2)
      }
      return true
    }
    const b = BOX[cp]
    if (!b) return false
    const [up, right, down, left] = b
    const stroke = (kind: number, horiz: boolean, from: number, to: number): void => {
      if (!kind) return
      if (kind === 3) {
        const gap = light
        if (horiz) {
          ctx.fillRect(from, cy - gap - light / 2, to - from, light)
          ctx.fillRect(from, cy + gap - light / 2, to - from, light)
        } else {
          ctx.fillRect(cx - gap - light / 2, from, light, to - from)
          ctx.fillRect(cx + gap - light / 2, from, light, to - from)
        }
        return
      }
      const t = kind === 2 ? heavy : light
      if (horiz) ctx.fillRect(from, cy - t / 2, to - from, t)
      else ctx.fillRect(cx - t / 2, from, t, to - from)
    }
    const ext = Math.max(heavy, light * 3) / 2
    stroke(left, true, x0, cx + (left && (up || down) ? ext : 0))
    stroke(right, true, cx - (right && (up || down) ? ext : 0), x0 + w)
    stroke(up, false, y0, cy + (up && (left || right) ? ext : 0))
    stroke(down, false, cy - (down && (left || right) ? ext : 0), y0 + h)
    return true
  }

  private drawBlock(ctx: CanvasRenderingContext2D, cp: number, x0: number, y0: number, w: number, h: number): boolean {
    if (cp === 0x2580) ctx.fillRect(x0, y0, w, h / 2)
    else if (cp >= 0x2581 && cp <= 0x2588) {
      const f = (cp - 0x2580) / 8
      ctx.fillRect(x0, y0 + h * (1 - f), w, h * f)
    } else if (cp >= 0x2589 && cp <= 0x258f) {
      const f = (0x2590 - cp) / 8
      ctx.fillRect(x0, y0, w * f, h)
    } else if (cp === 0x2590) ctx.fillRect(x0 + w / 2, y0, w / 2, h)
    else if (cp >= 0x2591 && cp <= 0x2593) {
      const a = ctx.globalAlpha
      ctx.globalAlpha = a * (cp - 0x2590) * 0.25
      ctx.fillRect(x0, y0, w, h)
      ctx.globalAlpha = a
    } else if (cp === 0x2594) ctx.fillRect(x0, y0, w, h / 8)
    else if (cp === 0x2595) ctx.fillRect(x0 + (w * 7) / 8, y0, w / 8, h)
    else {
      // quadrants 0x2596-0x259f: bits UL, UR, LL, LR
      const q: Record<number, number> = {
        0x2596: 0b0010, 0x2597: 0b0001, 0x2598: 0b1000, 0x2599: 0b1011, 0x259a: 0b1001,
        0x259b: 0b1110, 0x259c: 0b1101, 0x259d: 0b0100, 0x259e: 0b0110, 0x259f: 0b0111
      }
      const bits = q[cp]
      if (bits === undefined) return false
      const hw = w / 2
      const hh = h / 2
      if (bits & 8) ctx.fillRect(x0, y0, hw, hh)
      if (bits & 4) ctx.fillRect(x0 + hw, y0, hw, hh)
      if (bits & 2) ctx.fillRect(x0, y0 + hh, hw, hh)
      if (bits & 1) ctx.fillRect(x0 + hw, y0 + hh, hw, hh)
    }
    return true
  }

  private drawCursor(ctx: CanvasRenderingContext2D, col: number, row: number, style: number): void {
    const ch = this.cellH
    // Same device-pixel snap as the cell backgrounds in drawRow.
    const x0 = Math.round(col * this.cellW * this.dpr) / this.dpr
    const cw = Math.round((col + 1) * this.cellW * this.dpr) / this.dpr - x0
    const y0 = row * ch
    const lw = Math.max(1, Math.round(this.dpr)) / this.dpr
    ctx.save()
    ctx.fillStyle = this.cursorCss
    ctx.strokeStyle = this.cursorCss
    switch (style) {
      case CURSOR_STYLE.BAR:
        ctx.fillRect(x0, y0, Math.max(lw, 2 / this.dpr), ch)
        break
      case CURSOR_STYLE.UNDERLINE:
        ctx.fillRect(x0, y0 + ch - Math.max(lw, 2 / this.dpr), cw, Math.max(lw, 2 / this.dpr))
        break
      case CURSOR_STYLE.BLOCK_HOLLOW: {
        const bw = this.charAt(col) && this.refWide ? this.wideCursorW(col, x0) : cw
        ctx.lineWidth = lw
        ctx.strokeRect(x0 + lw / 2, y0 + lw / 2, bw - lw, ch - lw)
        break
      }
      default: {
        // Redraw the character under the block in the accent color, with the
        // same layout drawRow uses: wide glyphs get a two-cell block, centered,
        // and CJK the scaled face.
        const ch0 = this.charAt(col)
        const wide = !!ch0 && this.refWide
        ctx.fillRect(x0, y0, wide ? this.wideCursorW(col, x0) : cw, ch)
        if (ch0) {
          ctx.fillStyle = this.opts.theme.cursorAccent || this.defBg
          if (wide) {
            ctx.textAlign = 'center'
            if (isCJK(ch0.codePointAt(0) ?? 0)) {
              ctx.font = this.wideFonts[0]
              ctx.textBaseline = 'middle'
              ctx.fillText(ch0, (col + 1) * this.cellW, y0 + ch / 2)
            } else {
              ctx.font = this.fonts[0]
              ctx.textBaseline = 'alphabetic'
              ctx.fillText(ch0, (col + 1) * this.cellW, y0 + this.baseline)
            }
          } else {
            ctx.font = this.fonts[0]
            ctx.textBaseline = 'alphabetic'
            ctx.fillText(ch0, x0, y0 + this.baseline)
          }
        }
      }
    }
    ctx.restore()
  }

  private wideCursorW(col: number, x0: number): number {
    return Math.round((col + 2) * this.cellW * this.dpr) / this.dpr - x0
  }

  // The character at a column of the cursor's row, read from the grid.
  private charAt(col: number): string {
    const vt = this.vt
    const x = vt.x
    const p = this.mem + S.POINT
    const d = vt.dv()
    for (let i = 0; i < SIZEOF.POINT; i++) d.setUint8(p + i, 0)
    d.setInt32(p, POINT.VIEWPORT, true)
    d.setUint16(p + 8, col, true)
    d.setUint32(p + 12, this.cursorRow, true)
    return this.refChar(p)
  }

  private refChar(point: number): string {
    const vt = this.vt
    const x = vt.x
    this.refWide = false
    const r = this.mem + S.REF
    vt.dv().setUint32(r, SIZEOF.GRID_REF, true)
    if (x.ghostty_terminal_grid_ref(this.t, point, r) !== RESULT.SUCCESS) return ''
    if (x.ghostty_grid_ref_cell(r, this.mem + S.CELL) !== RESULT.SUCCESS) return ''
    const d = vt.dv()
    const lo = d.getUint32(this.mem + S.CELL, true)
    const hi = d.getUint32(this.mem + S.CELL + 4, true)
    const tag = lo & 3
    if (tag >= 2 || ((hi >>> 10) & 3) >= 2) return ''
    this.refWide = ((hi >>> 10) & 3) === 1
    const cp = (lo >>> 2) & 0xffffff
    if (!cp) return ''
    if (tag === 1) {
      const b = this.mem + S.GBYTES
      const ol = this.mem + S.OUTLEN
      // graphemes beyond the base codepoint, as u32 codepoints
      if (x.ghostty_grid_ref_graphemes(r, b, S.GBYTES_LEN / 4, ol) === RESULT.SUCCESS) {
        const dd = vt.dv()
        const k = dd.getUint32(ol, true)
        let s = ''
        for (let i = 0; i < k; i++) s += String.fromCodePoint(dd.getUint32(b + i * 4, true))
        if (s) return s
      }
    }
    return String.fromCodePoint(cp)
  }

  private lineText(y: number, trim: boolean): string {
    const s = this.lineCells(y).text
    return trim ? s.replace(/\s+$/, '') : s
  }

  // Row text plus, per UTF-16 unit, the column its character starts in.
  private lineCells(y: number): { text: string; cols: number[] } {
    const vt = this.vt
    const p = this.mem + S.POINT
    let s = ''
    const cols: number[] = []
    for (let col = 0; col < this.cols; col++) {
      const d = vt.dv()
      for (let i = 0; i < SIZEOF.POINT; i++) d.setUint8(p + i, 0)
      d.setInt32(p, POINT.SCREEN, true)
      d.setUint16(p + 8, col, true)
      d.setUint32(p + 12, y, true)
      const c = this.refChar(p)
      if (c) {
        s += c
        for (let i = 0; i < c.length; i++) cols.push(col)
      } else {
        // wide-char spacer cells contribute nothing; blanks are spaces
        const lo = vt.dv().getUint32(this.mem + S.CELL, true)
        const hi = vt.dv().getUint32(this.mem + S.CELL + 4, true)
        if (((hi >>> 10) & 3) < 2 || (lo & 3) >= 2) {
          s += ' '
          cols.push(col)
        }
      }
    }
    return { text: s, cols }
  }

  private drawScrollbar(ctx: CanvasRenderingContext2D, sb: { total: number; offset: number; len: number }): void {
    const canvas = this.canvas
    if (!canvas) return
    const H = this.rows * this.cellH
    const W = canvas.width / this.dpr
    const thumbH = Math.max(16, (sb.len / sb.total) * H)
    const top = (sb.offset / Math.max(1, sb.total - sb.len)) * (H - thumbH)
    ctx.save()
    ctx.globalAlpha = 0.35
    ctx.fillStyle = this.defFg
    ctx.fillRect(W - 5, top, 3, thumbH)
    ctx.restore()
  }

  // ---- terminal queries ----------------------------------------------------

  private scrollbar(): { total: number; offset: number; len: number } {
    const vt = this.vt
    const p = this.mem + S.SCROLLBAR
    if (vt.x.ghostty_terminal_get(this.t, TERM_DATA.SCROLLBAR, p) !== RESULT.SUCCESS)
      return { total: this.rows, offset: 0, len: this.rows }
    const d = vt.dv()
    return {
      total: Number(d.getBigUint64(p, true)),
      offset: Number(d.getBigUint64(p + 8, true)),
      len: Number(d.getBigUint64(p + 16, true))
    }
  }

  private cursorX(): number {
    this.vt.x.ghostty_terminal_get(this.t, TERM_DATA.CURSOR_X, this.mem + S.TMP)
    return this.vt.dv().getUint16(this.mem + S.TMP, true)
  }

  private cursorY(): number {
    this.vt.x.ghostty_terminal_get(this.t, TERM_DATA.CURSOR_Y, this.mem + S.TMP)
    return this.vt.dv().getUint16(this.mem + S.TMP, true)
  }

  private mode(mode: number): boolean {
    const d = this.vt.dv()
    d.setUint16(this.mem + S.MODE, mode, true)
    d.setUint8(this.mem + S.MODE + 2, 0)
    if (this.vt.x.ghostty_terminal_get(this.t, TERM_DATA.MODE, this.mem + S.MODE) !== RESULT.SUCCESS) return false
    return !!this.vt.dv().getUint8(this.mem + S.MODE + 2)
  }

  private flag(key: number): boolean {
    this.vt.dv().setUint32(this.mem + S.TMP, 0, true)
    this.vt.x.ghostty_terminal_get(this.t, key, this.mem + S.TMP)
    return !!this.vt.dv().getUint8(this.mem + S.TMP)
  }

  private scrollViewport(tag: number, delta: number): void {
    if (this.disposed) return
    const d = this.vt.dv()
    const p = this.mem + S.SCROLL
    for (let i = 0; i < SIZEOF.SCROLL; i++) d.setUint8(p + i, 0)
    d.setInt32(p, tag, true)
    d.setInt32(p + 8, delta, true)
    this.vt.x.ghostty_terminal_scroll_viewport(this.t, p)
    this.schedule()
  }

  // ---- output to the pty -----------------------------------------------------

  private ensureWriteBuf(n: number): void {
    if (n <= this.writeCap) return
    if (this.writeBuf) this.vt.free(this.writeBuf, this.writeCap)
    this.writeCap = Math.max(4096, 1 << Math.ceil(Math.log2(n)))
    this.writeBuf = this.vt.alloc(this.writeCap)
  }

  private flushPty(): void {
    if (!this.ptyOut.length) return
    const parts = this.ptyOut
    this.ptyOut = []
    let s = ''
    for (const p of parts) s += this.ptyDec.decode(p, { stream: true })
    if (s) this.emit(s)
  }

  private emit(s: string): void {
    this.dataListeners.forEach((f) => f(s))
  }

  private emitOut(len: number): void {
    if (len <= 0) return
    const p = this.mem + S.OUT
    this.emit(this.vt.dec.decode(this.vt.u8().slice(p, p + len)))
  }

  // ---- keyboard / IME / clipboard / focus ---------------------------------

  private bindInput(): void {
    const input = this.input
    const root = this.root
    if (!input || !root) return
    const on = <K extends keyof HTMLElementEventMap>(
      el: HTMLElement,
      type: K,
      fn: (e: HTMLElementEventMap[K]) => void
    ): void => {
      el.addEventListener(type, fn as EventListener)
      this.cleanup.push(() => el.removeEventListener(type, fn as EventListener))
    }
    on(input, 'keydown', (e) => this.onKey(e, e.repeat ? KEY_ACTION.REPEAT : KEY_ACTION.PRESS))
    on(input, 'keyup', (e) => this.onKey(e, KEY_ACTION.RELEASE))
    on(input, 'compositionstart', () => {
      this.composing = true
      this.showComposition('')
    })
    on(input, 'compositionupdate', (e) => this.showComposition(e.data))
    on(input, 'compositionend', (e) => {
      this.composing = false
      this.showComposition(null)
      if (e.data) this.userInput(e.data)
      input.value = ''
    })
    on(input, 'input', (e) => {
      const ie = e as InputEvent
      if (this.composing || ie.isComposing) return
      if (ie.inputType === 'insertText' && ie.data) this.userInput(ie.data)
      input.value = ''
    })
    on(input, 'copy', (e) => {
      const s = this.getSelection()
      if (!s) return
      e.preventDefault()
      e.clipboardData?.setData('text/plain', s)
    })
    on(input, 'paste', (e) => {
      e.preventDefault()
      const text = e.clipboardData?.getData('text/plain')
      if (text) this.paste(text)
    })
    on(input, 'focus', () => {
      this.focused = true
      this.focusReport(true)
      this.blinkOn = true
      this.syncBlink()
      this.forceCursorRow()
    })
    on(input, 'blur', () => {
      this.focused = false
      this.focusReport(false)
      this.syncBlink()
      this.forceCursorRow()
    })
  }

  private onKey(e: KeyboardEvent, action: number): void {
    if (this.customKey && !this.customKey(e)) return
    if (e.isComposing || e.keyCode === 229 || this.composing) return
    if (e.key === 'Dead') return
    // ⌘ combos belong to the app menu (copy, paste, close, ...).
    if (e.metaKey) return
    const press = action !== KEY_ACTION.RELEASE
    const printable = [...e.key].length === 1

    if (press && e.altKey && !e.ctrlKey) {
      // Option is not Meta (Ghostty's macOS default): Option+letter types the
      // layout's character, and Option+arrows jump words like Terminal.app.
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault()
        this.userInput(e.key === 'ArrowLeft' ? '\x1bb' : '\x1bf')
        return
      }
      if (printable) {
        e.preventDefault()
        this.userInput(e.key)
        return
      }
    }

    const key = KEY_CODES[e.code]
    if (key === undefined && !printable) return
    const vt = this.vt
    const x = vt.x
    const ev = this.keyEv
    let mods = 0
    if (e.shiftKey) mods |= MODS.SHIFT
    if (e.ctrlKey) mods |= MODS.CTRL
    if (e.altKey) mods |= MODS.ALT
    x.ghostty_key_event_set_action(ev, action)
    x.ghostty_key_event_set_key(ev, key ?? 0)
    x.ghostty_key_event_set_mods(ev, mods)
    const utf8 = printable && !e.ctrlKey ? e.key : ''
    x.ghostty_key_event_set_consumed_mods(ev, utf8 && e.shiftKey ? MODS.SHIFT : 0)
    const u = UNSHIFTED[e.code]
    x.ghostty_key_event_set_unshifted_codepoint(ev, u ? u.codePointAt(0) : 0)
    if (utf8) {
      const r = vt.enc.encodeInto(utf8, vt.u8().subarray(this.mem + S.UTF8, this.mem + S.UTF8 + S.UTF8_LEN))
      x.ghostty_key_event_set_utf8(ev, this.mem + S.UTF8, r.written)
    } else {
      x.ghostty_key_event_set_utf8(ev, 0, 0)
    }
    x.ghostty_key_encoder_setopt_from_terminal(this.keyEnc, this.t)
    const ol = this.mem + S.OUTLEN
    vt.dv().setUint32(ol, 0, true)
    const res = x.ghostty_key_encoder_encode(this.keyEnc, ev, this.mem + S.OUT, S.OUT_LEN, ol)
    const len = res === RESULT.SUCCESS ? vt.dv().getUint32(ol, true) : 0
    if (!len) return
    e.preventDefault()
    this.emitOut(len)
    if (press) this.afterUserInput()
  }

  private userInput(s: string): void {
    this.emit(s)
    this.afterUserInput()
  }

  private afterUserInput(): void {
    this.clearSelection()
    const sb = this.scrollbar()
    if (sb.offset + sb.len < sb.total) this.scrollToBottom()
    this.blinkOn = true
    this.forceCursorRow()
  }

  paste(text: string): void {
    const vt = this.vt
    const x = vt.x
    const [ptr, len] = vt.string(text.replace(/\r?\n/g, '\r'))
    let cap = len * 2 + 32
    let out = vt.alloc(cap)
    try {
      const wp = this.mem + S.OUTLEN
      let r = x.ghostty_paste_encode(ptr, len, this.mode(MODE.BRACKETED_PASTE) ? 1 : 0, out, cap, wp)
      if (r === RESULT.OUT_OF_SPACE) {
        vt.free(out, cap)
        cap = vt.dv().getUint32(wp, true)
        out = vt.alloc(cap)
        r = x.ghostty_paste_encode(ptr, len, this.mode(MODE.BRACKETED_PASTE) ? 1 : 0, out, cap, wp)
      }
      if (r === RESULT.SUCCESS) {
        const n = vt.dv().getUint32(wp, true)
        this.userInput(vt.dec.decode(vt.u8().slice(out, out + n)))
      }
    } finally {
      vt.free(out, cap)
      vt.free(ptr, Math.max(1, len))
    }
  }

  private focusReport(gained: boolean): void {
    if (this.disposed || !this.mode(MODE.FOCUS_EVENT)) return
    const ol = this.mem + S.OUTLEN
    if (this.vt.x.ghostty_focus_encode(gained ? 0 : 1, this.mem + S.OUT, S.OUT_LEN, ol) === RESULT.SUCCESS)
      this.emitOut(this.vt.dv().getUint32(ol, true))
  }

  private showComposition(text: string | null): void {
    const c = this.compo
    if (!c) return
    if (text === null || text === '') {
      c.style.display = 'none'
      c.textContent = ''
      return
    }
    c.textContent = text
    c.style.display = 'block'
    c.style.left = `${this.cursorCol * this.cellW}px`
    c.style.top = `${this.cursorRow * this.cellH}px`
    c.style.color = this.defFg
    c.style.background = this.defBg
  }

  // Keep the hidden textarea at the cursor so the IME candidate window opens
  // next to it.
  private placeInput(): void {
    const i = this.input
    if (!i) return
    i.style.left = `${this.cursorCol * this.cellW}px`
    i.style.top = `${this.cursorRow * this.cellH}px`
    if (this.composing) this.showComposition(this.compo?.textContent ?? '')
  }

  private forceCursorRow(): void {
    this.forceRows.add(this.cursorRow)
    this.schedule()
  }

  private syncBlink(): void {
    const want = this.focused && this.cursorBlinking && !this.disposed
    if (want && !this.blinkTimer) {
      this.blinkTimer = setInterval(() => {
        this.blinkOn = !this.blinkOn
        this.forceCursorRow()
      }, 600)
    } else if (!want) {
      this.stopBlink()
      if (!this.blinkOn) {
        this.blinkOn = true
        this.forceCursorRow()
      }
    }
  }

  private stopBlink(): void {
    if (this.blinkTimer) clearInterval(this.blinkTimer)
    this.blinkTimer = null
  }

  // ---- mouse -------------------------------------------------------------------

  private bindMouse(): void {
    const canvas = this.canvas
    if (!canvas) return
    const onDown = (e: MouseEvent): void => this.onMouseDown(e)
    const onMove = (e: MouseEvent): void => this.onMouseMove(e)
    const onUp = (e: MouseEvent): void => this.onMouseUp(e)
    const onWheel = (e: WheelEvent): void => this.onWheel(e)
    canvas.addEventListener('mousedown', onDown)
    canvas.addEventListener('mousemove', onMove)
    canvas.addEventListener('wheel', onWheel, { passive: false })
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    this.cleanup.push(() => {
      canvas.removeEventListener('mousedown', onDown)
      canvas.removeEventListener('mousemove', onMove)
      canvas.removeEventListener('wheel', onWheel)
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    })
  }

  private local(e: MouseEvent): { x: number; y: number } {
    const r = this.canvas?.getBoundingClientRect()
    return r ? { x: e.clientX - r.left, y: e.clientY - r.top } : { x: 0, y: 0 }
  }

  private mods(e: MouseEvent | KeyboardEvent): number {
    return (e.shiftKey ? MODS.SHIFT : 0) | (e.ctrlKey ? MODS.CTRL : 0) | (e.altKey ? MODS.ALT : 0)
  }

  private tracking(e: MouseEvent): boolean {
    return !e.shiftKey && this.flag(TERM_DATA.MOUSE_TRACKING)
  }

  private onMouseDown(e: MouseEvent): void {
    // Let focus land first (the textarea is what takes input).
    e.preventDefault()
    this.focus()
    const p = this.local(e)
    this.lastMouse = p
    if (this.tracking(e)) {
      const btn = e.button === 1 ? MOUSE_BUTTON.MIDDLE : e.button === 2 ? MOUSE_BUTTON.RIGHT : MOUSE_BUTTON.LEFT
      this.buttonsDown |= 1 << e.button
      this.sendMouse(MOUSE_ACTION.PRESS, btn, p, this.mods(e))
      return
    }
    if (e.button !== 0) return
    this.selecting = true
    this.dragged = false
    const vt = this.vt
    const ev = this.gEvents[GESTURE.PRESS]
    const d = vt.dv()
    this.setGestureRef(ev, p)
    this.setGesturePos(ev, p)
    d.setBigUint64(this.mem + S.TMP, BigInt(Math.round(performance.now() * 1e6)), true)
    vt.x.ghostty_selection_gesture_event_set(ev, GESTURE_OPT.TIME_NS, this.mem + S.TMP)
    vt.dv().setUint8(this.mem + S.TMP, e.altKey ? 1 : 0)
    vt.x.ghostty_selection_gesture_event_set(ev, GESTURE_OPT.RECTANGLE, this.mem + S.TMP)
    if (this.gestureEvent(ev) === RESULT.NO_VALUE) vt.x.ghostty_terminal_set(this.t, TERM_OPT.SELECTION, 0)
    this.invalidate()
  }

  private onMouseMove(e: MouseEvent): void {
    const p = this.local(e)
    if (this.selecting) {
      if (e.currentTarget !== window) return
      this.lastMouse = p
      this.dragTo(p)
      return
    }
    if (e.currentTarget === window) {
      // outside the canvas only matters while a tracked button is held
      if (!this.buttonsDown) return
    }
    if (!this.root || !this.flag(TERM_DATA.MOUSE_TRACKING)) return
    if (p.x === this.lastMouse.x && p.y === this.lastMouse.y) return
    this.lastMouse = p
    const btn = this.buttonsDown & 1 ? MOUSE_BUTTON.LEFT : this.buttonsDown & 4 ? MOUSE_BUTTON.RIGHT : this.buttonsDown & 2 ? MOUSE_BUTTON.MIDDLE : 0
    this.sendMouse(MOUSE_ACTION.MOTION, btn, p, this.mods(e))
  }

  private onMouseUp(e: MouseEvent): void {
    const p = this.local(e)
    if (this.buttonsDown & (1 << e.button)) {
      this.buttonsDown &= ~(1 << e.button)
      const btn = e.button === 1 ? MOUSE_BUTTON.MIDDLE : e.button === 2 ? MOUSE_BUTTON.RIGHT : MOUSE_BUTTON.LEFT
      this.sendMouse(MOUSE_ACTION.RELEASE, btn, p, this.mods(e))
      return
    }
    if (!this.selecting || e.button !== 0) return
    this.selecting = false
    this.stopAutoscroll()
    const ev = this.gEvents[GESTURE.RELEASE]
    this.setGesturePos(ev, p)
    this.gestureEvent(ev)
    this.invalidate()
    this.selListeners.forEach((f) => f())
  }

  private dragTo(p: { x: number; y: number }): void {
    const vt = this.vt
    const ev = this.gEvents[GESTURE.DRAG]
    this.setGestureRef(ev, p)
    this.setGesturePos(ev, p)
    this.setGeometry(ev)
    this.gestureEvent(ev)
    this.dragged = true
    this.invalidate()
    vt.dv().setInt32(this.mem + S.TMP, 0, true)
    vt.x.ghostty_selection_gesture_get(this.gesture, this.t, GESTURE_DATA.AUTOSCROLL, this.mem + S.TMP)
    const dir = vt.dv().getInt32(this.mem + S.TMP, true)
    if (dir === AUTOSCROLL.NONE) this.stopAutoscroll()
    else if (!this.autoTimer) {
      this.autoTimer = setInterval(() => {
        const d2 = vt.dv()
        d2.setInt32(this.mem + S.TMP, 0, true)
        vt.x.ghostty_selection_gesture_get(this.gesture, this.t, GESTURE_DATA.AUTOSCROLL, this.mem + S.TMP)
        const dd = vt.dv().getInt32(this.mem + S.TMP, true)
        if (dd === AUTOSCROLL.NONE || !this.selecting) return this.stopAutoscroll()
        this.scrollViewport(SCROLL.DELTA, dd === AUTOSCROLL.UP ? -1 : 1)
        const tick = this.gEvents[GESTURE.AUTOSCROLL_TICK]
        this.setGeometry(tick)
        const v = this.mem + S.VIEWPORT
        const cell = this.cellAt(this.lastMouse)
        const dv = vt.dv()
        dv.setUint16(v, cell.col, true)
        dv.setUint32(v + 4, cell.row, true)
        vt.x.ghostty_selection_gesture_event_set(tick, GESTURE_OPT.VIEWPORT, v)
        this.gestureEvent(tick)
        this.invalidate()
      }, 50)
    }
  }

  private stopAutoscroll(): void {
    if (this.autoTimer) clearInterval(this.autoTimer)
    this.autoTimer = null
  }

  private cellAt(p: { x: number; y: number }): { col: number; row: number } {
    return {
      col: Math.max(0, Math.min(this.cols - 1, Math.floor(p.x / this.cellW))),
      row: Math.max(0, Math.min(this.rows - 1, Math.floor(p.y / this.cellH)))
    }
  }

  private setGestureRef(ev: number, p: { x: number; y: number }): void {
    const vt = this.vt
    const c = this.cellAt(p)
    const pt = this.mem + S.POINT
    const d = vt.dv()
    for (let i = 0; i < SIZEOF.POINT; i++) d.setUint8(pt + i, 0)
    d.setInt32(pt, POINT.VIEWPORT, true)
    d.setUint16(pt + 8, c.col, true)
    d.setUint32(pt + 12, c.row, true)
    const r = this.mem + S.REF
    vt.dv().setUint32(r, SIZEOF.GRID_REF, true)
    if (vt.x.ghostty_terminal_grid_ref(this.t, pt, r) === RESULT.SUCCESS)
      vt.x.ghostty_selection_gesture_event_set(ev, GESTURE_OPT.REF, r)
  }

  private setGesturePos(ev: number, p: { x: number; y: number }): void {
    const d = this.vt.dv()
    d.setFloat64(this.mem + S.POS, p.x * K, true)
    d.setFloat64(this.mem + S.POS + 8, p.y * K, true)
    this.vt.x.ghostty_selection_gesture_event_set(ev, GESTURE_OPT.POSITION, this.mem + S.POS)
  }

  private setGeometry(ev: number): void {
    const d = this.vt.dv()
    const g = this.mem + S.GEOM
    d.setUint32(g, this.cols, true)
    d.setUint32(g + 4, Math.round(this.cellW * K), true)
    d.setUint32(g + 8, 0, true)
    d.setUint32(g + 12, Math.round(this.rows * this.cellH * K), true)
    this.vt.x.ghostty_selection_gesture_event_set(ev, GESTURE_OPT.GEOMETRY, g)
  }

  private gestureEvent(ev: number): number {
    const vt = this.vt
    const sel = this.mem + S.SEL
    vt.dv().setUint32(sel, SIZEOF.SELECTION, true)
    const r = vt.x.ghostty_selection_gesture_event(this.gesture, this.t, ev, sel)
    if (r === RESULT.SUCCESS) vt.x.ghostty_terminal_set(this.t, TERM_OPT.SELECTION, sel)
    return r
  }

  private sendMouse(action: number, button: number, p: { x: number; y: number }, mods: number): void {
    const vt = this.vt
    const x = vt.x
    const ev = this.mouseEv
    x.ghostty_mouse_event_set_action(ev, action)
    if (button) x.ghostty_mouse_event_set_button(ev, button)
    else x.ghostty_mouse_event_clear_button(ev)
    x.ghostty_mouse_event_set_mods(ev, mods)
    const d = vt.dv()
    d.setFloat32(this.mem + S.POS, p.x * K, true)
    d.setFloat32(this.mem + S.POS + 4, p.y * K, true)
    x.ghostty_mouse_event_set_position(ev, this.mem + S.POS)
    x.ghostty_mouse_encoder_setopt_from_terminal(this.mouseEnc, this.t)
    const sz = this.mem + S.MSIZE
    const d2 = vt.dv()
    const W = Math.round((this.root?.clientWidth ?? this.cols * this.cellW) * K)
    const H = Math.round((this.root?.clientHeight ?? this.rows * this.cellH) * K)
    d2.setUint32(sz, SIZEOF.MOUSE_ENC_SIZE, true)
    d2.setUint32(sz + 4, W, true)
    d2.setUint32(sz + 8, H, true)
    d2.setUint32(sz + 12, Math.round(this.cellW * K), true)
    d2.setUint32(sz + 16, Math.round(this.cellH * K), true)
    for (let i = 20; i < 36; i += 4) d2.setUint32(sz + i, 0, true)
    x.ghostty_mouse_encoder_setopt(this.mouseEnc, MOUSE_ENC_OPT.SIZE, sz)
    vt.dv().setUint8(this.mem + S.TMP, this.buttonsDown ? 1 : 0)
    x.ghostty_mouse_encoder_setopt(this.mouseEnc, MOUSE_ENC_OPT.ANY_BUTTON_PRESSED, this.mem + S.TMP)
    const ol = this.mem + S.OUTLEN
    vt.dv().setUint32(ol, 0, true)
    if (x.ghostty_mouse_encoder_encode(this.mouseEnc, ev, this.mem + S.OUT, S.OUT_LEN, ol) === RESULT.SUCCESS)
      this.emitOut(vt.dv().getUint32(ol, true))
  }

  private onWheel(e: WheelEvent): void {
    if (e.ctrlKey) return
    e.preventDefault()
    const px = e.deltaMode === 1 ? e.deltaY * this.cellH : e.deltaMode === 2 ? e.deltaY * this.rows * this.cellH : e.deltaY
    this.wheelAcc += (px / this.cellH) * 1.15
    const lines = Math.trunc(this.wheelAcc)
    if (!lines) return
    this.wheelAcc -= lines
    if (this.tracking(e)) {
      // One report per wheel event like xterm.js: apps (vim, claude) already
      // scroll several lines per report, so a notch must not send five.
      this.sendMouse(MOUSE_ACTION.PRESS, lines < 0 ? MOUSE_BUTTON.FOUR : MOUSE_BUTTON.FIVE, this.local(e), this.mods(e))
      return
    }
    if (this.flag(TERM_DATA.ACTIVE_SCREEN)) {
      // Alternate screen without mouse reporting (less, man): scroll means arrows.
      const app = this.mode(MODE.DECCKM)
      const seq = (app ? '\x1bO' : '\x1b[') + (lines < 0 ? 'A' : 'B')
      this.emit(seq.repeat(Math.abs(lines)))
      return
    }
    this.scrollViewport(SCROLL.DELTA, lines)
  }
}

// Hangul, CJK ideographs/kana/punctuation and fullwidth forms: the glyphs the
// scaled CJK face draws. Emoji and other wide symbols keep the primary size.
function isCJK(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x11ff) ||
    (cp >= 0x2e80 && cp <= 0x9fff) ||
    (cp >= 0xa960 && cp <= 0xa97f) ||
    (cp >= 0xac00 && cp <= 0xd7ff) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xff00 && cp <= 0xffef)
  )
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}
