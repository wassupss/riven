import { execFileSync } from 'child_process'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import { openExport } from './export'
import type { ExportOptions } from './mask'

const dir = mkdtempSync(join(tmpdir(), 'riven-export-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const rows = [
  [1, 'alice@example.com', '010-1234-5678', null],
  [2, 'bo,b@x.io', '010-9999-0000', 'a "quote"']
]
const base: ExportOptions = {
  format: 'csv',
  columns: [
    { index: 0, name: 'id', type: 'int4', mask: 'none' },
    { index: 1, name: 'email', type: 'text', mask: 'email' },
    { index: 3, name: 'note', type: 'text', mask: 'none' }
  ],
  header: true,
  nullText: 'NULL',
  bom: false,
  table: 'public.t'
}

async function write(o: ExportOptions, file: string): Promise<{ path: string; n: number }> {
  const path = join(dir, file)
  const w = await openExport(path, o)
  await w.rows(rows)
  return { path, n: await w.close() }
}

let hasUnzip = true
try {
  execFileSync('unzip', ['-v'], { stdio: 'ignore' })
} catch {
  hasUnzip = false
}

describe('openExport', () => {
  it('writes masked, picked columns as CSV', async () => {
    const { path, n } = await write(base, 'a.csv')
    expect(n).toBe(2)
    expect(readFileSync(path, 'utf8')).toBe(
      'id,email,note\r\n1,al***@example.com,NULL\r\n2,"bo,*@x.io","a ""quote"""\r\n'
    )
  })

  it('writes INSERTs', async () => {
    const { path } = await write({ ...base, format: 'sql' }, 'a.sql')
    expect(readFileSync(path, 'utf8').split('\n')[1]).toBe(
      `insert into public.t (id, email, note) values (2, 'bo,*@x.io', 'a "quote"');`
    )
  })

  it.skipIf(!hasUnzip)('writes an xlsx sheet', async () => {
    const { path } = await write({ ...base, format: 'xlsx' }, 'a.xlsx')
    const sheet = execFileSync('unzip', ['-p', path, 'xl/worksheets/sheet1.xml'], { encoding: 'utf8' })
    expect(sheet).toContain('al***@example.com')
    expect(sheet).not.toContain('alice')
    expect(sheet).toContain('a &quot;quote&quot;')
  })
})
