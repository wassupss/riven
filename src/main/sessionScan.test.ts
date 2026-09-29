import { afterEach, describe, expect, it } from 'vitest'
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanSessionFile } from './sessionScan'
import { scanTitles } from './sessionTitle'

const dirs: string[] = []
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'riven-scan-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const user = (text: string): string => JSON.stringify({ type: 'user', message: { role: 'user', content: text } })
const asst = (text: string): string =>
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } })

describe('scanSessionFile', () => {
  it('counts exactly what reading the whole file counts', async () => {
    const file = join(tmp(), 's.jsonl')
    const lines = [user('첫 질문'), asst('답'), '{"type":"queue-operation"}', user('둘째'), asst('답 — 한글 ✓')]
    writeFileSync(file, lines.join('\n') + '\n')
    const { scan } = await scanSessionFile(file)
    expect(scan).toEqual(scanTitles(lines))
    expect(scan.messages).toBe(4)
    expect(scan.firstUser).toBe('첫 질문')
  })

  it('reads only what was appended, and keeps the count exact', async () => {
    const file = join(tmp(), 's.jsonl')
    writeFileSync(file, [user('시작'), asst('a')].join('\n') + '\n')
    expect((await scanSessionFile(file)).scan.messages).toBe(2)
    // A rename is one more line, appended — as the CLI's /rename writes it.
    appendFileSync(file, [user('더'), JSON.stringify({ type: 'custom-title', customTitle: '새 이름' })].join('\n') + '\n')
    const { scan } = await scanSessionFile(file)
    expect(scan.messages).toBe(3)
    expect(scan.custom).toBe('새 이름')
  })

  it('leaves a half-written last line for the next look instead of losing it', async () => {
    const file = join(tmp(), 's.jsonl')
    const whole = asst('끝까지 쓴 줄')
    writeFileSync(file, user('q') + '\n' + whole.slice(0, 10)) // mid-write
    expect((await scanSessionFile(file)).scan.messages).toBe(1)
    appendFileSync(file, whole.slice(10) + '\n')
    expect((await scanSessionFile(file)).scan.messages).toBe(2)
  })

  it('starts over when the file was replaced by a shorter one', async () => {
    const file = join(tmp(), 's.jsonl')
    writeFileSync(file, [user('a'), asst('b'), user('c'), asst('d')].join('\n') + '\n')
    expect((await scanSessionFile(file)).scan.messages).toBe(4)
    writeFileSync(file, user('only') + '\n')
    expect((await scanSessionFile(file)).scan.messages).toBe(1)
  })
})
