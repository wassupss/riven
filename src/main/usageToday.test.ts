import { afterEach, describe, expect, it, vi } from 'vitest'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), on: vi.fn() } }))
const { usageToday } = await import('./usage')

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function account(): { cfg: string; file: string } {
  const cfg = mkdtempSync(join(tmpdir(), 'riven-usage-'))
  dirs.push(cfg)
  mkdirSync(join(cfg, 'projects', 'p'), { recursive: true })
  return { cfg, file: join(cfg, 'projects', 'p', 's.jsonl') }
}

const line = (id: string, input: number, when = new Date()): string =>
  JSON.stringify({
    timestamp: when.toISOString(),
    requestId: `r-${id}`,
    message: { id, model: 'claude-sonnet-5', usage: { input_tokens: input, output_tokens: 1 } }
  })

describe('usageToday', () => {
  it('counts what was appended since the last look, and nothing twice', async () => {
    const { cfg, file } = account()
    writeFileSync(file, [line('m1', 100), line('m2', 200)].join('\n') + '\n')
    expect((await usageToday(cfg)).totalTokens).toBe(302)

    // The same message written again (the CLI does, once per content block) and
    // a genuinely new one.
    appendFileSync(file, [line('m2', 200), line('m3', 50)].join('\n') + '\n')
    expect((await usageToday(cfg)).totalTokens).toBe(353)
  })

  it('leaves out yesterday', async () => {
    const { cfg, file } = account()
    const yesterday = new Date(Date.now() - 86_400_000)
    writeFileSync(file, [line('old', 999, yesterday), line('new', 10)].join('\n') + '\n')
    expect((await usageToday(cfg)).totalTokens).toBe(11)
  })
})
