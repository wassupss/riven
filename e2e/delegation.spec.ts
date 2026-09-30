import { expect, test } from '@playwright/test'
import { execSync } from 'node:child_process'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchRiven } from './app'

// Work handed to another agent WITHOUT waiting (riven_ask_agent wait=false)
// shows in the caller's pane as a background task, and its answer comes back
// to the caller by itself when it lands. It used to go nowhere: the lead said
// it would report back and then never heard another word.
//
// Both panes run a stand-in CLI (node, no model): the lead calls riven's real
// MCP server the way the CLI does; the member takes a few seconds to answer.

const NODE = process.execPath

test('an answer to work handed off in the background comes back to the one who handed it off', async () => {
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
const call = async (name, a) => {
  const r = await fetch(cfg.url, {
    method: 'POST',
    headers: { ...cfg.headers, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: a } })
  })
  return r.text()
}
let buf = ''
const queue = []
let running = false
const next = async () => {
  if (running || !queue.length) return
  running = true
  const text = queue.shift()
  // The answer coming back quotes what was asked, so it is recognised first.
  if (text.includes('WORK-RESULT-42')) {
    say('lead got the result')
  } else if (text.includes('DELEGATE')) {
    const res = await call('riven_ask_agent', { agent: 'member-pane', message: 'do the work', wait: false })
    say('handed off: ' + (res.includes('background') ? 'background' : res))
  } else if (text.includes('do the work')) {
    await new Promise((r) => setTimeout(r, 3000))
    say('WORK-RESULT-42')
  } else say('ok')
  running = false
  void next()
}
process.stdin.on('data', (d) => {
  buf += d
  let i
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1)
    let m; try { m = JSON.parse(line) } catch { continue }
    if (m.type !== 'user') continue
    const c = m.message.content
    queue.push(typeof c === 'string' ? c : c.map((b) => b.text || '').join(''))
    void next()
  }
})
`
  )
  chmodSync(claude, 0o755)
  const shell = join(dir, 'login-shell')
  writeFileSync(shell, `#!/bin/sh\necho "${dir}:/usr/bin:/bin"\n`)
  chmodSync(shell, 0o755)

  const r = await launchRiven({ files: { 'README.md': '# s\n' }, fakeAgents: true, env: { SHELL: shell } })
  // Two panes; the second is the member, found by the title its first message gives it.
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
  const inputs = r.page.locator('textarea.chat-input')
  await inputs.nth(1).fill('member-pane')
  await inputs.nth(1).press('Enter')
  await expect(r.page.getByText('ok', { exact: true })).toBeVisible({ timeout: 20_000 })

  await inputs.nth(0).fill('DELEGATE please')
  await inputs.nth(0).press('Enter')
  await expect(r.page.getByText('handed off: background')).toBeVisible({ timeout: 20_000 })
  // While the member works: a background row in the lead's pane.
  await expect(r.page.locator('.chat-delegation')).toHaveCount(1)
  await expect(r.page.locator('.chat-delegation')).toContainText('member-pane')

  // The member answers; the lead is woken with it, without anyone asking.
  await expect(r.page.getByText('lead got the result')).toBeVisible({ timeout: 20_000 })
  await expect(r.page.locator('.chat-delegation')).toHaveCount(0)
  await expect(r.page.getByText(/위임한 일 완료 · member-pane/)).toBeVisible()
  await r.app.close()
})
