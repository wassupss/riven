// Export settings shared by the export dialog (preview) and main (the writer).
// Pure: the renderer imports it too.

type Cell = string | number | boolean | null

/** Excel's sheet limit, header row included. */
export const XLSX_MAX_ROWS = 1_048_575

export type ExportFormat = 'xlsx' | 'csv' | 'tsv' | 'json' | 'sql'

/**
 * How a column's values are hidden. Only letters and digits are replaced, so
 * separators survive: 010-1234-5678 -> 010-****-5678 with 'middle'.
 */
export type MaskMode = 'none' | 'full' | 'start' | 'end' | 'middle' | 'email' | 'empty'

export interface ExportColumn {
  /** Index into the result row. */
  index: number
  name: string
  type: string
  mask: MaskMode
  /** Characters kept by 'start' / 'end'. */
  keep?: number
}

export interface ExportOptions {
  format: ExportFormat
  columns: ExportColumn[]
  header: boolean
  /** CSV/TSV: written for NULL. */
  nullText: string
  /** CSV/TSV: UTF-8 byte order mark, so Excel reads non-ASCII text right. */
  bom: boolean
  /** SQL INSERT target. */
  table: string
}

const ALNUM = /[\p{L}\p{N}]/u

/** Replace letters/digits outside [keepStart, n - keepEnd) of the alnum sequence. */
function hide(s: string, keepStart: number, keepEnd: number): string {
  let n = 0
  for (const ch of s) if (ALNUM.test(ch)) n++
  let i = 0
  let out = ''
  for (const ch of s) {
    if (!ALNUM.test(ch)) {
      out += ch
      continue
    }
    out += i < keepStart || i >= n - keepEnd ? ch : '*'
    i++
  }
  return out
}

function middle(s: string): string {
  let n = 0
  for (const ch of s) if (ALNUM.test(ch)) n++
  const start = Math.max(1, Math.floor(n / 3))
  let end = Math.ceil(n / 3)
  if (start + end >= n) end = Math.max(0, n - start - 1)
  return hide(s, start, end)
}

export function maskValue(v: Cell, mode: MaskMode, keep?: number): Cell {
  if (mode === 'none' || v === null) return v
  if (mode === 'empty') return null
  const s = String(v)
  switch (mode) {
    case 'full':
      return hide(s, 0, 0)
    case 'start':
      return hide(s, Math.max(0, keep ?? 1), 0)
    case 'end':
      return hide(s, 0, Math.max(0, keep ?? 4))
    case 'middle':
      return middle(s)
    case 'email': {
      const at = s.lastIndexOf('@')
      if (at <= 0) return middle(s)
      const local = s.slice(0, at)
      return hide(local, Math.min(2, Math.max(1, local.length - 1)), 0) + s.slice(at)
    }
  }
  return v
}

/** The chosen columns of a row, masked. */
export function projectRow(row: Cell[], cols: ExportColumn[]): Cell[] {
  return cols.map((c) => maskValue(row[c.index] ?? null, c.mask, c.keep))
}

/** Default mask for a column name that looks personal. */
export function suggestMask(name: string): MaskMode {
  const n = name.toLowerCase()
  if (/e_?mail/.test(n)) return 'email'
  if (/pass(word)?|pwd|secret|token/.test(n)) return 'full'
  if (/phone|mobile|tel|cell/.test(n)) return 'middle'
  if (/ssn|rrn|jumin|resident|card_?no|account_?no/.test(n)) return 'end'
  return 'none'
}
