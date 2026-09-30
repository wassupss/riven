import { expect, test } from '@playwright/test'
import { execSync } from 'node:child_process'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchRiven, openPanel } from './app'

// Agent tool calls are answered by riven's window. They used to be sent to "the
// first live window" — and Electron lists the NEWEST window first, so once the
// browser's address bar had opened its suggestion dropdown (a window of its
// own), every tool call from every agent went there and hung until restart.

const NODE = process.execPath

test("an agent's tool call is still answered after another window has opened", async () => {
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
const cfg = JSON.parse(args[args.indexOf('--mcp-config') + 1]).mcpServers.riven
const say = (text) => {
  out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } })
  out({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: sid })
}
let buf = ''
process.stdin.on('data', async (d) => {
  buf += d
  let i
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1)
    let m; try { m = JSON.parse(line) } catch { continue }
    if (m.type !== 'user') continue
    try {
      const r = await fetch(cfg.url, {
        method: 'POST',
        signal: AbortSignal.timeout(8000),
        headers: { ...cfg.headers, 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'riven_workspaces', arguments: {} } })
      })
      say((await r.text()).includes('"result"') ? 'TOOL-ANSWERED' : 'TOOL-ODD')
    } catch (e) {
      say('TOOL-HUNG ' + e.name)
    }
  }
})
`
  )
  chmodSync(claude, 0o755)
  const shell = join(dir, 'login-shell')
  writeFileSync(shell, `#!/bin/sh\necho "${dir}:/usr/bin:/bin"\n`)
  chmodSync(shell, 0o755)

  const r = await launchRiven({ files: { 'README.md': '# s\n' }, fakeAgents: true, env: { SHELL: shell } })
  // Another window: the browser address bar's suggestions.
  await openPanel(r.page, '브라우저')
  await r.page.locator('.browser-addr-wrap input').fill('exam')
  await expect
    .poll(() => r.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), { timeout: 10_000 })
    .toBeGreaterThan(1)

  await r.page.keyboard.press('Escape')
  await r.page.keyboard.press('Meta+Shift+a')
  await expect(r.page.locator('.chat-composer')).toHaveCount(1, { timeout: 15_000 })
  await expect
    .poll(() => {
      try {
        return execSync(`pgrep -f '${claude} .*--permission-mode'`).toString().trim().split('\n').length
      } catch {
        return 0
      }
    }, { timeout: 20_000 })
    .toBe(1)
  await r.page.locator('textarea.chat-input').fill('use a tool')
  await r.page.locator('textarea.chat-input').press('Enter')
  await expect(r.page.getByText(/TOOL-(ANSWERED|HUNG|ODD)/)).toHaveText('TOOL-ANSWERED', { timeout: 20_000 })
  await r.app.close()
})
