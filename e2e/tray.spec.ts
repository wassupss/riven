import { expect, test } from '@playwright/test'
import { execSync } from 'node:child_process'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchRiven } from './app'

// The menu bar icon: the count of agents that want you beside it, and a menu
// listing them. Under the suite nothing is put in the real menu bar of the
// machine running it; main keeps what it WOULD draw, and that is what is read.

const NODE = process.execPath

test('an agent that finished while you looked elsewhere is counted in the menu bar, until you look', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'riven-fakecli-'))
  const claude = join(dir, 'claude')
  writeFileSync(
    claude,
    `#!${NODE}
const args = process.argv.slice(2)
if (args[0] === '--version') { console.log('2.1.280 (Claude Code)'); process.exit(0) }
if (!args.includes('--permission-mode')) process.exit(0)
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
const sid = '00000000-0000-0000-0000-' + String(process.pid).padStart(12, '0')
out({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-opus-5-5' })
let buf = ''
process.stdin.on('data', (d) => {
  buf += d
  let i
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1)
    let m; try { m = JSON.parse(line) } catch { continue }
    if (m.type !== 'user') continue
    setTimeout(() => {
      out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'finished it' } } })
      out({ type: 'result', subtype: 'success', is_error: false, result: 'finished it', session_id: sid })
    }, 2500)
  }
})
`
  )
  chmodSync(claude, 0o755)
  const shell = join(dir, 'login-shell')
  writeFileSync(shell, `#!/bin/sh\necho "${dir}:/usr/bin:/bin"\n`)
  chmodSync(shell, 0o755)

  const r = await launchRiven({ files: { 'README.md': '# s\n' }, fakeAgents: true, env: { SHELL: shell } })
  const diag = (): Promise<{ title: string; labels: string[] }> =>
    r.page.evaluate(() => (window as unknown as { api: { tray: { diag: () => Promise<{ title: string; labels: string[] }> } } }).api.tray.diag())

  await r.page.keyboard.press('Meta+Shift+a')
  await expect(r.page.locator('.chat-composer')).toHaveCount(1, { timeout: 15_000 })
  await r.page.keyboard.press('Meta+Shift+a')
  await expect(r.page.locator('.chat-composer')).toHaveCount(2, { timeout: 15_000 })
  const running = (): number => {
    try {
      return execSync(`pgrep -f '${claude} .*--permission-mode'`).toString().trim().split('\n').length
    } catch {
      return 0
    }
  }
  await expect.poll(running, { timeout: 20_000 }).toBe(2)
  await expect.poll(async () => (await diag()).labels).toContain('새 알림 없음')

  // Ask the first pane, then go and look at the second while it works.
  const inputs = r.page.locator('textarea.chat-input')
  await inputs.nth(0).fill('long job')
  await inputs.nth(0).press('Enter')
  await inputs.nth(1).click()

  await expect.poll(async () => (await diag()).title, { timeout: 15_000 }).toBe('1')
  const labels = (await diag()).labels
  expect(labels).toContain('끝남 · 아직 안 봄')
  expect(labels.some((l) => l.startsWith('long job'))).toBe(true)

  // Looking at it is what clears it.
  await inputs.nth(0).click()
  await expect.poll(async () => (await diag()).title, { timeout: 10_000 }).toBe('')

  // And the setting takes it out of the menu bar altogether.
  await r.page.keyboard.press('Meta+,')
  await r.page.locator('.settings-nav-item').filter({ hasText: '알림' }).click()
  await r.page.locator('.set-row').filter({ hasText: '메뉴 막대 아이콘' }).locator('button, [role="switch"], input').first().click()
  await expect.poll(async () => (await diag()).labels, { timeout: 5000 }).toEqual([])
  await r.app.close()
})
