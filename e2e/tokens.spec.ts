import { expect, test } from '@playwright/test'
import { execSync } from 'node:child_process'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchRiven } from './app'

// The token count beside a working turn is the turn's, and only grows. A turn
// is several model calls — one per tool round — and each call reports its own
// usage from zero; shown as-is, the count fell every time the agent used a tool.

test('the running token count adds up the turn, it does not restart per model call', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'riven-fakecli-'))
  const claude = join(dir, 'claude')
  const ev = (o: unknown): string => `echo '${JSON.stringify(o)}'`
  const start = (input: number): string =>
    ev({ type: 'stream_event', event: { type: 'message_start', message: { usage: { input_tokens: input } } } })
  const delta = (output: number): string =>
    ev({ type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: output } } })
  writeFileSync(
    claude,
    `#!/bin/sh
[ "$1" = "--version" ] && { echo "2.1.280 (Claude Code)"; exit 0; }
# Only the chat pane (started with --permission-mode) answers; the probes and
# the title generator run this same binary and get nothing.
case "$*" in *--permission-mode*) ;; *) exit 0;; esac
echo '{"type":"system","subtype":"init","session_id":"00000000-0000-0000-0000-000000000001","model":"claude-opus-5-5"}'
while read -r line; do
  case "$line" in *'"type":"user"'*) ;; *) continue;; esac
  ${start(1000)}
  ${delta(100)}
  ${delta(300)}
  ${start(200)}
  ${delta(50)}
  sleep 4
  echo '{"type":"result","subtype":"success","is_error":false,"result":"ok","session_id":"00000000-0000-0000-0000-000000000001"}'
done
`
  )
  chmodSync(claude, 0o755)
  const shell = join(dir, 'login-shell')
  writeFileSync(shell, `#!/bin/sh\necho "${dir}:/usr/bin:/bin"\n`)
  chmodSync(shell, 0o755)

  const r = await launchRiven({ files: { 'README.md': '# s\n' }, fakeAgents: true, env: { SHELL: shell } })
  await r.page.keyboard.press('Meta+Shift+a')
  const running = (): number => {
    try {
      return execSync(`pgrep -f '${claude} -p.*--permission-mode'`).toString().trim().split('\n').length
    } catch {
      return 0
    }
  }
  await expect.poll(running, { timeout: 20_000 }).toBe(1)
  await r.page.locator('textarea.chat-input').fill('go')
  await r.page.locator('textarea.chat-input').press('Enter')
  // Two calls: 1000 + 200 in, 300 + 50 out — not the second call's 200 / 50.
  await expect(r.page.locator('.chat-foot-live')).toContainText('↑1.2k ↓350', { timeout: 20_000 })
  await expect(r.page.locator('.chat-foot-done')).toContainText('↑1.2k ↓350', { timeout: 20_000 })
  await r.app.close()
})
