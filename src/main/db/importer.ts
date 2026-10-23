import { createReadStream } from 'fs'
import { open, stat } from 'fs/promises'
import { truncateSql } from './ddl'
import { batchRows, CsvParser, createTableForImport, detectDelimiter, ENCODINGS, insertSql, rowValues, stripBom, type ImportOptions, type ImportPreview, type ImportResult } from './csv'
import { pgTransaction } from './pg'
import type { ConnectionConfig } from './types'

// Loads a CSV file into a table: streamed from disk, parsed incrementally and
// inserted in parameterized batches, all in one transaction.

const PREVIEW_BYTES = 256 * 1024
const PREVIEW_ROWS = 200

const encodingOf = (e: string): string => ((ENCODINGS as readonly string[]).includes(e) ? e : 'utf-8')

export async function previewCsv(path: string, encoding: string, delimiter?: string): Promise<ImportPreview> {
  const { size } = await stat(path)
  const fh = await open(path, 'r')
  let text: string
  try {
    const buf = Buffer.alloc(Math.min(size, PREVIEW_BYTES))
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0)
    text = stripBom(new TextDecoder(encodingOf(encoding)).decode(buf.subarray(0, bytesRead), { stream: true }))
  } finally {
    await fh.close()
  }
  const delim = delimiter || detectDelimiter(text)
  const p = new CsvParser(delim)
  let rows = p.push(text)
  // A cut-off last record is only complete when the whole file was read.
  if (size <= PREVIEW_BYTES) rows.push(...p.end())
  const more = size > PREVIEW_BYTES || rows.length > PREVIEW_ROWS
  rows = rows.slice(0, PREVIEW_ROWS)
  return { path, size, delimiter: delim, rows, more }
}

const cancelled = new Set<string>()
export const cancelImport = (queryId: string): void => {
  cancelled.add(queryId)
}

export async function runImport(
  cfg: ConnectionConfig,
  db: string | undefined,
  o: ImportOptions,
  queryId: string | undefined,
  progress: (rows: number, bytes: number, size: number) => void
): Promise<ImportResult> {
  const mapped = o.columns.filter((c) => c.source !== null && c.name.trim())
  if (!mapped.length) throw new Error('No columns mapped')
  if (!o.schema || !o.table) throw new Error('No target table')
  const names = mapped.map((c) => c.name)
  const sources = mapped.map((c) => c.source as number)
  const per = batchRows(names.length)
  const fullSql = insertSql(o.schema, o.table, names, per)
  const { size } = await stat(o.path)
  const skipErrors = o.onError === 'skip'
  const result: ImportResult = { rows: 0, skipped: 0, errors: [] }

  try {
    return await pgTransaction(cfg, db, queryId, async (q) => {
      if (o.create) await q(createTableForImport({ schema: o.schema, table: o.table, columns: mapped }))
      else if (o.truncate) for (const s of truncateSql(o.schema, o.table).stmts) await q(s)

      let batch: string[][] = []
      let batchStart = 0
      const insert = async (recs: string[][], sql: string): Promise<void> => {
        const params: Array<string | null> = []
        for (const r of recs) params.push(...rowValues(r, sources, o.emptyAsNull, o.nullText))
        await q(sql, params)
      }
      const flush = async (): Promise<void> => {
        if (!batch.length) return
        if (queryId && cancelled.has(queryId)) throw new Error('Cancelled')
        const sql = batch.length === per ? fullSql : insertSql(o.schema, o.table, names, batch.length)
        if (!skipErrors) {
          await insert(batch, sql)
          result.rows += batch.length
        } else {
          // Batch first; on failure retry it row by row and drop the bad ones.
          await q('savepoint riven_imp')
          try {
            await insert(batch, sql)
            result.rows += batch.length
          } catch {
            await q('rollback to savepoint riven_imp')
            const one = insertSql(o.schema, o.table, names, 1)
            for (let i = 0; i < batch.length; i++) {
              try {
                await insert([batch[i]], one)
                await q('release savepoint riven_imp')
                await q('savepoint riven_imp')
                result.rows++
              } catch (err) {
                if (queryId && cancelled.has(queryId)) throw err
                await q('rollback to savepoint riven_imp')
                result.skipped++
                if (result.errors.length < 20)
                  result.errors.push({ record: batchStart + i + 1, message: err instanceof Error ? err.message : String(err) })
              }
            }
          }
          await q('release savepoint riven_imp')
        }
        batch = []
      }

      const parser = new CsvParser(o.delimiter)
      const decoder = new TextDecoder(encodingOf(o.encoding))
      let header = o.header
      let skip = Math.max(0, Math.floor(o.skip ?? 0))
      let record = 0
      let bytes = 0
      let first = true
      const take = async (recs: string[][]): Promise<void> => {
        for (const r of recs) {
          if (header) {
            header = false
            continue
          }
          if (skip > 0) {
            skip--
            continue
          }
          if (!batch.length) batchStart = record
          record++
          batch.push(r)
          if (batch.length >= per) {
            await flush()
            progress(result.rows, bytes, size)
          }
        }
      }
      const stream = createReadStream(o.path, { highWaterMark: 256 * 1024 })
      try {
        for await (const chunk of stream as AsyncIterable<Buffer>) {
          bytes += chunk.length
          let text = decoder.decode(chunk, { stream: true })
          if (first) {
            text = stripBom(text)
            first = false
          }
          await take(parser.push(text))
        }
      } finally {
        stream.destroy()
      }
      await take(parser.push(decoder.decode()))
      await take(parser.end())
      await flush()
      progress(result.rows, size, size)
      return result
    })
  } catch (err) {
    if (queryId && cancelled.has(queryId)) throw new Error('Cancelled')
    throw err
  } finally {
    if (queryId) cancelled.delete(queryId)
  }
}
