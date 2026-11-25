import { qualify } from './ddl'
import { quoteIdent } from './sqlText'

// CSV import: a streaming RFC 4180 parser, delimiter/type guessing and the
// batched INSERT builder. Pure; shared with the renderer (preview, mapping).

export const DELIMITERS = [',', '\t', ';', '|'] as const
export const ENCODINGS = ['utf-8', 'euc-kr', 'utf-16le', 'shift_jis', 'gb18030', 'windows-1252'] as const
export type CsvEncoding = (typeof ENCODINGS)[number]

/**
 * Incremental parser: push() text chunks, get back the records completed so
 * far; end() flushes the last one. Quotes may span chunks and lines; "" is an
 * escaped quote. CRLF, LF and lone CR end a record. Blank lines are skipped.
 */
export class CsvParser {
  private field = ''
  private record: string[] = []
  private quoted = false
  // The previous chunk ended right after a quote inside a quoted field.
  private quoteEnd = false
  // The field had a quote (so "" is an empty string, not a blank line).
  private touched = false
  private lastCR = false

  constructor(private readonly delim = ',') {}

  push(text: string): string[][] {
    const out: string[][] = []
    const d = this.delim
    let i = 0
    const n = text.length
    if (this.lastCR && text[0] === '\n') i = 1
    this.lastCR = false
    while (i < n) {
      if (this.quoted) {
        if (this.quoteEnd) {
          this.quoteEnd = false
          if (text[i] === '"') {
            this.field += '"'
            i++
            continue
          }
          this.quoted = false
          continue
        }
        const q = text.indexOf('"', i)
        if (q < 0) {
          this.field += text.slice(i)
          break
        }
        this.field += text.slice(i, q)
        i = q + 1
        if (i >= n) {
          this.quoteEnd = true
          break
        }
        if (text[i] === '"') {
          this.field += '"'
          i++
        } else this.quoted = false
        continue
      }
      const c = text[i]
      if (c === '"' && this.field === '' && !this.touched) {
        this.quoted = true
        this.touched = true
        i++
      } else if (c === d) {
        this.endField()
        i++
      } else if (c === '\n' || c === '\r') {
        this.endRecord(out)
        if (c === '\r') {
          if (i + 1 >= n) this.lastCR = true
          else if (text[i + 1] === '\n') i++
        }
        i++
      } else {
        // Plain run up to the next special character.
        let j = i + 1
        while (j < n) {
          const x = text[j]
          if (x === d || x === '\n' || x === '\r') break
          j++
        }
        this.field += text.slice(i, j)
        i = j
      }
    }
    return out
  }

  end(): string[][] {
    const out: string[][] = []
    if (this.quoteEnd) {
      this.quoteEnd = false
      this.quoted = false
    }
    this.endRecord(out)
    return out
  }

  private endField(): void {
    this.record.push(this.field)
    this.field = ''
    this.touched = false
  }

  private endRecord(out: string[][]): void {
    if (this.record.length === 0 && this.field === '' && !this.touched) return
    this.endField()
    out.push(this.record)
    this.record = []
  }
}

export function parseCsv(text: string, delim = ','): string[][] {
  const p = new CsvParser(delim)
  return [...p.push(text), ...p.end()]
}

/** The delimiter that splits the first lines into the most equal, widest columns. */
export function detectDelimiter(sample: string): string {
  const lines = sample.split(/\r\n|\n|\r/).slice(0, 20)
  if (lines.length > 1) lines.pop() // likely cut mid-record
  let best: string = ','
  let bestScore = 0
  for (const d of DELIMITERS) {
    const rows = parseCsv(lines.join('\n'), d)
    if (!rows.length) continue
    const widths = rows.map((r) => r.length)
    const w = widths[0]
    if (w < 2) continue
    const same = widths.filter((x) => x === w).length / widths.length
    const score = same * 10 + Math.min(w, 50) / 50
    if (score > bestScore) {
      bestScore = score
      best = d
    }
  }
  return best
}

/** Strips a UTF-8 byte order mark. */
export const stripBom = (s: string): string => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s)

// ---- type guessing (for "create a new table") ------------------------------------

const INT = /^[-+]?\d+$/
const NUM = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/
const BOOL = /^(true|false|t|f|yes|no|y|n)$/i
const DATE = /^\d{4}-\d{2}-\d{2}$/
const TS = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/
const TSTZ = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[-+]\d{2}(:?\d{2})?)$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The narrowest PostgreSQL type every non-empty sample value fits; text when none. */
export function guessType(values: string[]): string {
  const vs = values.map((v) => v.trim()).filter((v) => v !== '')
  if (!vs.length) return 'text'
  const all = (re: RegExp): boolean => vs.every((v) => re.test(v))
  if (all(INT)) {
    // A leading zero (zip codes, phone numbers) is data, not a number.
    if (vs.some((v) => /^[-+]?0\d/.test(v))) return 'text'
    return vs.every((v) => Math.abs(Number(v)) <= 2147483647) ? 'integer' : 'bigint'
  }
  if (all(NUM)) return 'numeric'
  if (all(BOOL)) return 'boolean'
  if (all(DATE)) return 'date'
  if (all(TSTZ)) return 'timestamptz'
  if (vs.every((v) => TS.test(v) || DATE.test(v))) return 'timestamp'
  if (all(UUID)) return 'uuid'
  return 'text'
}

/** Header cells as column names: trimmed, unique, never empty. */
export function columnNames(header: string[] | null, width: number): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (let i = 0; i < width; i++) {
    const base = (header?.[i] ?? '').trim() || `column${i + 1}`
    let name = base
    for (let k = 2; seen.has(name.toLowerCase()); k++) name = `${base}_${k}`
    seen.add(name.toLowerCase())
    out.push(name)
  }
  return out
}

// ---- the load ----------------------------------------------------------------

export interface ImportColumn {
  /** Target column name. */
  name: string
  /** Source field (0-based), or null to leave the column to its default. */
  source: number | null
  /** New table only: column type. */
  type?: string
}

export interface ImportOptions {
  path: string
  encoding: CsvEncoding
  delimiter: string
  header: boolean
  /** Data rows to skip after the header. */
  skip?: number
  schema: string
  table: string
  /** Create the table first (with these columns' types). */
  create?: boolean
  /** Empty the table first. */
  truncate?: boolean
  columns: ImportColumn[]
  /** An empty field becomes NULL (otherwise an empty string). */
  emptyAsNull: boolean
  /** Fields equal to this become NULL too (e.g. "NULL", "\N"). */
  nullText?: string
  /** Stop at the first bad row (default) or skip it and go on. */
  onError?: 'abort' | 'skip'
}

export interface ImportPreview {
  path: string
  size: number
  delimiter: string
  /** First records (header included); `more` when the file holds more. */
  rows: string[][]
  more: boolean
}

export interface ImportResult {
  rows: number
  skipped: number
  /** First few rejected rows (line number in the file's records, message). */
  errors: Array<{ record: number; message: string }>
}

/** Parameters per INSERT stay well under PostgreSQL's 65535 limit. */
export const batchRows = (cols: number): number => Math.max(1, Math.min(1000, Math.floor(30000 / Math.max(1, cols))))

export function createTableForImport(o: Pick<ImportOptions, 'schema' | 'table' | 'columns'>): string {
  const cols = o.columns.map((c) => `  ${quoteIdent('postgres', c.name)} ${c.type?.trim() || 'text'}`)
  return `CREATE TABLE ${qualify(o.schema, o.table)} (\n${cols.join(',\n')}\n)`
}

/** INSERT ... VALUES ($1, $2), ($3, $4) ... for `rows` rows of the mapped columns. */
export function insertSql(schema: string, table: string, names: string[], rows: number): string {
  const cols = names.map((n) => quoteIdent('postgres', n)).join(', ')
  const groups: string[] = []
  let p = 1
  for (let r = 0; r < rows; r++) {
    const g: string[] = []
    for (let c = 0; c < names.length; c++) g.push(`$${p++}`)
    groups.push(`(${g.join(', ')})`)
  }
  return `INSERT INTO ${qualify(schema, table)} (${cols}) VALUES ${groups.join(', ')}`
}

/** One record's parameter values for the mapped columns. */
export function rowValues(rec: string[], sources: number[], emptyAsNull: boolean, nullText?: string): Array<string | null> {
  return sources.map((s) => {
    const v = rec[s]
    if (v === undefined) return null
    if (emptyAsNull && v === '') return null
    if (nullText && v === nullText) return null
    return v
  })
}
