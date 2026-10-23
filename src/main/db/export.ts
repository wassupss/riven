import { createWriteStream, unlinkSync, type WriteStream } from 'fs'
import { once } from 'events'
import zlib from 'zlib'
import { literal, quoteIdent } from './sqlText'
import { projectRow, XLSX_MAX_ROWS, type ExportOptions } from './mask'

// Result export writers. Rows arrive in batches (a streamed cursor or the rows
// the grid already holds) and go straight to the file, so exporting a large
// table never holds it in memory. XLSX is written by hand: a zip of a few XML
// parts with the sheet deflated as it streams.

type Cell = string | number | boolean | null

export { XLSX_MAX_ROWS }

class Out {
  private s: WriteStream
  bytes = 0
  constructor(path: string) {
    this.s = createWriteStream(path)
    this.s.on('error', () => {}) // surfaced by write/close
  }
  async write(b: Buffer | string): Promise<void> {
    const buf = typeof b === 'string' ? Buffer.from(b, 'utf8') : b
    this.bytes += buf.length
    if (!this.s.write(buf)) await once(this.s, 'drain')
  }
  /** Write without waiting (deflate output); returns false when the stream is full. */
  push(buf: Buffer): boolean {
    this.bytes += buf.length
    return this.s.write(buf)
  }
  get stream(): WriteStream {
    return this.s
  }
  async close(): Promise<void> {
    this.s.end()
    await once(this.s, 'finish')
  }
}

// ---- zip ------------------------------------------------------------------------

function dosTime(d: Date): { time: number; date: number } {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  }
}

interface ZipEntry {
  name: Buffer
  crc: number
  csize: number
  usize: number
  offset: number
}

class Zip {
  private entries: ZipEntry[] = []
  /** Entries whose sizes follow in a data descriptor (general purpose flag bit 3). */
  private streamed = new WeakSet<ZipEntry>()
  private t = dosTime(new Date())
  constructor(private out: Out) {}

  private header(name: Buffer, flags: number, crc: number, csize: number, usize: number): Buffer {
    const h = Buffer.alloc(30)
    h.writeUInt32LE(0x04034b50, 0)
    h.writeUInt16LE(20, 4)
    h.writeUInt16LE(flags, 6)
    h.writeUInt16LE(8, 8)
    h.writeUInt16LE(this.t.time, 10)
    h.writeUInt16LE(this.t.date, 12)
    h.writeUInt32LE(crc, 14)
    h.writeUInt32LE(csize, 18)
    h.writeUInt32LE(usize, 22)
    h.writeUInt16LE(name.length, 26)
    return Buffer.concat([h, name])
  }

  async file(path: string, text: string): Promise<void> {
    const name = Buffer.from(path)
    const data = Buffer.from(text, 'utf8')
    const z = zlib.deflateRawSync(data)
    const e = { name, crc: zlib.crc32(data), csize: z.length, usize: data.length, offset: this.out.bytes }
    await this.out.write(this.header(name, 0, e.crc, e.csize, e.usize))
    await this.out.write(z)
    this.entries.push(e)
  }

  /** An entry whose content is pushed in pieces; sizes follow in a data descriptor. */
  async begin(path: string): Promise<{ add: (s: string) => Promise<void>; end: () => Promise<void> }> {
    const name = Buffer.from(path)
    const e: ZipEntry = { name, crc: 0, csize: 0, usize: 0, offset: this.out.bytes }
    this.streamed.add(e)
    await this.out.write(this.header(name, 0x08, 0, 0, 0))
    const z = zlib.createDeflateRaw({ level: 6 })
    z.on('data', (chunk: Buffer) => {
      e.csize += chunk.length
      if (!this.out.push(chunk)) {
        z.pause()
        this.out.stream.once('drain', () => z.resume())
      }
    })
    const done = once(z, 'end')
    let buf: string[] = []
    let len = 0
    const flush = async (): Promise<void> => {
      if (!buf.length) return
      const b = Buffer.from(buf.join(''), 'utf8')
      buf = []
      len = 0
      e.crc = zlib.crc32(b, e.crc)
      e.usize += b.length
      if (!z.write(b)) await once(z, 'drain')
    }
    return {
      add: async (s) => {
        buf.push(s)
        len += s.length
        if (len > 1 << 16) await flush()
      },
      end: async () => {
        await flush()
        z.end()
        await done
        const d = Buffer.alloc(16)
        d.writeUInt32LE(0x08074b50, 0)
        d.writeUInt32LE(e.crc >>> 0, 4)
        d.writeUInt32LE(e.csize, 8)
        d.writeUInt32LE(e.usize, 12)
        await this.out.write(d)
        this.entries.push(e)
      }
    }
  }

  async finish(): Promise<void> {
    const start = this.out.bytes
    for (const e of this.entries) {
      const c = Buffer.alloc(46)
      c.writeUInt32LE(0x02014b50, 0)
      c.writeUInt16LE(20, 4)
      c.writeUInt16LE(20, 6)
      c.writeUInt16LE(this.streamed.has(e) ? 0x08 : 0, 8)
      c.writeUInt16LE(8, 10)
      c.writeUInt16LE(this.t.time, 12)
      c.writeUInt16LE(this.t.date, 14)
      c.writeUInt32LE(e.crc >>> 0, 16)
      c.writeUInt32LE(e.csize, 20)
      c.writeUInt32LE(e.usize, 24)
      c.writeUInt16LE(e.name.length, 28)
      c.writeUInt32LE(e.offset, 42)
      await this.out.write(Buffer.concat([c, e.name]))
    }
    const end = Buffer.alloc(22)
    end.writeUInt32LE(0x06054b50, 0)
    end.writeUInt16LE(this.entries.length, 8)
    end.writeUInt16LE(this.entries.length, 10)
    end.writeUInt32LE(this.out.bytes - start, 12)
    end.writeUInt32LE(start, 16)
    await this.out.write(end)
  }
}

// ---- formats ----------------------------------------------------------------------

const XML_BAD = /[\x00-\x08\x0B\x0C\x0E-\x1F￾￿]/g // eslint-disable-line no-control-regex
const xml = (s: string): string =>
  s.replace(XML_BAD, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const NUMERIC_TYPES = new Set(['bigint', 'numeric', 'smallint', 'integer', 'real', 'double precision', 'oid'])

function xlsxCell(v: Cell, numeric: boolean, style = ''): string {
  if (v === null) return '<c/>'
  if (typeof v === 'boolean') return `<c t="b"${style}><v>${v ? 1 : 0}</v></c>`
  if (typeof v === 'number' && Number.isFinite(v)) return `<c${style}><v>${v}</v></c>`
  const s = String(v)
  // int8/numeric arrive as text; a number cell only when Excel keeps every digit.
  if (numeric && /^-?\d+(\.\d+)?$/.test(s) && s.replace(/[-.]/g, '').replace(/^0+/, '').length <= 15)
    return `<c${style}><v>${s}</v></c>`
  const t = s.length > 32767 ? s.slice(0, 32767) : s
  return `<c t="inlineStr"${style}><is><t xml:space="preserve">${xml(t)}</t></is></c>`
}

const XLSX_PARTS: Record<string, string> = {
  '[Content_Types].xml':
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>',
  '_rels/.rels':
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
  'xl/workbook.xml':
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>',
  'xl/_rels/workbook.xml.rels':
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
  'xl/styles.xml':
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
    '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
    '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
    '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>' +
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>'
}

function delimField(v: Cell, sep: string, nullText: string): string {
  if (v === null) return nullText
  const s = String(v)
  return s.includes(sep) || s.includes('"') || s.includes('\n') || s.includes('\r') ? `"${s.replace(/"/g, '""')}"` : s
}

function sqlValue(v: Cell): string {
  if (v === null) return 'NULL'
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return literal('postgres', v)
}

export interface ExportWriter {
  rows: (batch: Cell[][]) => Promise<void>
  /** Finish the file; returns the data rows written. */
  close: () => Promise<number>
  /** Stop and delete the partial file. */
  abort: () => Promise<void>
}

/** Open a writer for `path`. Rows passed in are full result rows; the writer projects and masks them. */
export async function openExport(path: string, o: ExportOptions): Promise<ExportWriter> {
  const out = new Out(path)
  const cols = o.columns
  const names = cols.map((c) => c.name)
  let count = 0

  let rows: ExportWriter['rows']
  let finish: () => Promise<void>

  if (o.format === 'xlsx') {
    const zip = new Zip(out)
    for (const [p, text] of Object.entries(XLSX_PARTS)) await zip.file(p, text)
    const sheet = await zip.begin('xl/worksheets/sheet1.xml')
    const numeric = cols.map((c) => NUMERIC_TYPES.has(c.type))
    await sheet.add(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
        (o.header
          ? '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
          : '') +
        '<sheetData>'
    )
    if (o.header) await sheet.add(`<row>${names.map((n) => xlsxCell(n, false, ' s="1"')).join('')}</row>`)
    const max = XLSX_MAX_ROWS - (o.header ? 1 : 0)
    rows = async (batch) => {
      for (const r of batch) {
        if (count >= max) return
        const p = projectRow(r, cols)
        await sheet.add(`<row>${p.map((v, i) => xlsxCell(v, numeric[i] && cols[i].mask === 'none')).join('')}</row>`)
        count++
      }
    }
    finish = async () => {
      await sheet.add('</sheetData></worksheet>')
      await sheet.end()
      await zip.finish()
    }
  } else if (o.format === 'csv' || o.format === 'tsv') {
    const sep = o.format === 'csv' ? ',' : '\t'
    if (o.bom) await out.write('﻿')
    if (o.header) await out.write(names.map((n) => delimField(n, sep, '')).join(sep) + '\r\n')
    rows = async (batch) => {
      let s = ''
      for (const r of batch) s += projectRow(r, cols).map((v) => delimField(v, sep, o.nullText)).join(sep) + '\r\n'
      count += batch.length
      await out.write(s)
    }
    finish = async () => {}
  } else if (o.format === 'json') {
    // Duplicate names would collapse in an object: a_2, a_3, ...
    const seen = new Map<string, number>()
    const keys = names.map((n) => {
      const k = seen.get(n) ?? 0
      seen.set(n, k + 1)
      return k ? `${n}_${k + 1}` : n
    })
    await out.write('[')
    rows = async (batch) => {
      let s = ''
      for (const r of batch) {
        const p = projectRow(r, cols)
        const obj: Record<string, Cell> = {}
        keys.forEach((k, i) => (obj[k] = p[i]))
        s += (count++ ? ',\n' : '\n') + JSON.stringify(obj)
      }
      await out.write(s)
    }
    finish = async () => out.write('\n]\n')
  } else {
    const target = o.table
      .split('.')
      .map((p) => quoteIdent('postgres', p.replace(/^"|"$/g, '')))
      .join('.')
    const head = `insert into ${target || 'result'} (${names.map((n) => quoteIdent('postgres', n)).join(', ')}) values `
    rows = async (batch) => {
      let s = ''
      for (const r of batch) s += head + '(' + projectRow(r, cols).map(sqlValue).join(', ') + ');\n'
      count += batch.length
      await out.write(s)
    }
    finish = async () => {}
  }

  return {
    rows,
    close: async () => {
      await finish()
      await out.close()
      return count
    },
    abort: async () => {
      await out.close().catch(() => {})
      try {
        unlinkSync(path)
      } catch {
        // already gone
      }
    }
  }
}
