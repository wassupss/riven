// Raw bindings to Ghostty's own libghostty-vt, compiled to wasm from the
// upstream source by scripts/build-ghostty-vt.sh (no third-party wrapper).
//
// Everything here mirrors the C headers in ghostty/include/ghostty/vt/*.h for
// the wasm32 ABI: pointers and size_t are 4 bytes, little endian, structs are
// passed by pointer. Struct offsets come from `ghostty_type_json()` of the
// pinned build; re-check them whenever the wasm is rebuilt from a new commit.
//
// Linear memory can grow during any export call, so never hold a DataView or
// typed array across a call: use dv()/u8() right before each access.

/* eslint-disable @typescript-eslint/no-explicit-any */
type Fn = (...args: any[]) => any

export const RESULT = { SUCCESS: 0, OUT_OF_MEMORY: -1, INVALID_VALUE: -2, OUT_OF_SPACE: -3, NO_VALUE: -4 }

export const TERM_OPT = {
  USERDATA: 0,
  WRITE_PTY: 1,
  BELL: 2,
  SIZE: 6,
  DEVICE_ATTRIBUTES: 8,
  COLOR_FG: 11,
  COLOR_BG: 12,
  COLOR_CURSOR: 13,
  COLOR_PALETTE: 14,
  SELECTION: 21,
  DEFAULT_CURSOR_STYLE: 22,
  DEFAULT_CURSOR_BLINK: 23,
  SCROLLBACK_MAX_BYTES: 27,
  SCROLLBACK_MAX_LINES: 28,
  MODE: 34,
  RENDER_HOLD: 41
}

export const TERM_DATA = {
  COLS: 1,
  ROWS: 2,
  CURSOR_X: 3,
  CURSOR_Y: 4,
  ACTIVE_SCREEN: 6,
  SCROLLBAR: 9,
  MOUSE_TRACKING: 11,
  TOTAL_ROWS: 14,
  SCROLLBACK_ROWS: 15,
  SELECTION: 31,
  MODE: 37
}

export const MODE = {
  DECCKM: 1,
  CURSOR_VISIBLE: 25,
  FOCUS_EVENT: 1004,
  ALT_SCREEN: 1049,
  BRACKETED_PASTE: 2004,
  SYNC: 2026
}

export const RS_DATA = { COLS: 1, ROWS: 2, DIRTY: 3, ROW_ITERATOR: 4, CURSOR: 18, COLORS: 19 }
export const ROW_DATA = { DIRTY: 1, CELLS: 3, SELECTION: 4, CELLS_RAW: 5, VIEWPORT_Y: 6 }
export const CELL_DATA = { STYLE: 2, GRAPHEMES_LEN: 3, GRAPHEMES_BUF: 4, BG: 5, FG: 6, SELECTED: 7, GRAPHEMES_UTF8: 9 }
export const DIRTY = { FALSE: 0, PARTIAL: 1, FULL: 2 }

export const SCROLL = { TOP: 0, BOTTOM: 1, DELTA: 2 }
export const POINT = { ACTIVE: 0, VIEWPORT: 1, SCREEN: 2 }

export const MODS = { SHIFT: 1, CTRL: 2, ALT: 4, SUPER: 8 }
export const KEY_ACTION = { RELEASE: 0, PRESS: 1, REPEAT: 2 }
export const KEY_ENC_OPT = { MACOS_OPTION_AS_ALT: 6 }
export const CURSOR_STYLE = { BAR: 0, BLOCK: 1, UNDERLINE: 2, BLOCK_HOLLOW: 3 }
export const STYLE_COLOR = { NONE: 0, PALETTE: 1, RGB: 2 }

export const MOUSE_ACTION = { PRESS: 0, RELEASE: 1, MOTION: 2 }
export const MOUSE_BUTTON = { LEFT: 1, RIGHT: 2, MIDDLE: 3, FOUR: 4, FIVE: 5 }
export const MOUSE_ENC_OPT = { SIZE: 2, ANY_BUTTON_PRESSED: 3, TRACK_LAST_CELL: 4 }

export const GESTURE = { PRESS: 0, RELEASE: 1, DRAG: 2, AUTOSCROLL_TICK: 3 }
export const GESTURE_OPT = { REF: 0, POSITION: 1, TIME_NS: 3, RECTANGLE: 7, GEOMETRY: 8, VIEWPORT: 9 }
export const GESTURE_DATA = { CLICK_COUNT: 0, DRAGGED: 1, AUTOSCROLL: 2 }
export const AUTOSCROLL = { NONE: 0, UP: 1, DOWN: 2 }

// Struct sizes (wasm32) that must be written into the leading `size` field.
export const SIZEOF = {
  GRID_REF: 12,
  SELECTION: 32,
  RS_CURSOR: 20,
  RS_COLORS: 784,
  STYLE: 72,
  ROW_SELECTION: 8,
  SELECTION_FORMAT: 16,
  MOUSE_ENC_SIZE: 36,
  SIZE_REPORT: 12,
  MODE: 4,
  POINT: 24,
  SCROLL: 24,
  SCROLLBAR: 24
}

export class VtError extends Error {
  readonly code: number

  constructor(fn: string, code: number) {
    super(`${fn} failed (${code})`)
    this.code = code
  }
}

// Wasm-side callback signatures we need. Each is a tiny generated module that
// imports a JS function and re-exports it, which turns it into a real wasm
// function that can live in libghostty's indirect function table.
type Sig = { params: number; result: boolean }

function trampolineBytes({ params, result }: Sig): Uint8Array {
  const type = [0x01, 0x60, params, ...new Array(params).fill(0x7f), result ? 1 : 0, ...(result ? [0x7f] : [])]
  const imp = [0x01, 0x01, 0x65, 0x01, 0x66, 0x00, 0x00]
  const exp = [0x01, 0x01, 0x66, 0x00, 0x00]
  return new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    0x01, type.length, ...type,
    0x02, imp.length, ...imp,
    0x07, exp.length, ...exp
  ])
}

export class Vt {
  readonly x: Record<string, Fn>
  readonly memory: WebAssembly.Memory
  private readonly table: WebAssembly.Table
  readonly enc = new TextEncoder()
  readonly dec = new TextDecoder()

  constructor(instance: WebAssembly.Instance) {
    this.x = instance.exports as unknown as Record<string, Fn>
    this.memory = instance.exports.memory as WebAssembly.Memory
    this.table = instance.exports.__indirect_function_table as WebAssembly.Table
  }

  dv(): DataView {
    return new DataView(this.memory.buffer)
  }

  u8(): Uint8Array {
    return new Uint8Array(this.memory.buffer)
  }

  alloc(len: number): number {
    const p = this.x.ghostty_wasm_alloc(len) as number
    if (!p) throw new VtError('ghostty_wasm_alloc', RESULT.OUT_OF_MEMORY)
    return p
  }

  free(ptr: number, len: number): void {
    if (ptr) this.x.ghostty_wasm_free(ptr, len)
  }

  check(fn: string, code: number): void {
    if (code !== RESULT.SUCCESS) throw new VtError(fn, code)
  }

  // `ghostty_*_new(allocator, out, ...rest)` returning the opaque handle.
  create(fn: string, ...rest: number[]): number {
    const slot = this.x.ghostty_wasm_alloc_opaque() as number
    try {
      this.check(fn, this.x[fn](0, slot, ...rest))
      return this.x.ghostty_wasm_take_opaque(slot) as number
    } finally {
      this.x.ghostty_wasm_free_opaque(slot)
    }
  }

  // Installs `fn` in the function table and returns its index (the value C
  // sees as a function pointer). Indexes are never freed: callers register a
  // fixed set once and route per terminal through userdata.
  callback(sig: Sig, fn: Fn): number {
    const mod = new WebAssembly.Module(trampolineBytes(sig) as BufferSource)
    const inst = new WebAssembly.Instance(mod, { e: { f: fn } })
    const idx = this.table.grow(1)
    this.table.set(idx, inst.exports.f as Fn)
    return idx
  }

  // Copies a JS string as UTF-8 into wasm memory: [ptr, len], caller frees.
  string(s: string): [number, number] {
    const bytes = this.enc.encode(s)
    const ptr = this.alloc(Math.max(1, bytes.length))
    this.u8().set(bytes, ptr)
    return [ptr, bytes.length]
  }
}

export async function instantiateVt(bytes: BufferSource): Promise<Vt> {
  const { instance } = await WebAssembly.instantiate(bytes, {})
  return new Vt(instance)
}
