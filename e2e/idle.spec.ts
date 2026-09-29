import { expect, test } from '@playwright/test'
import { execSync } from 'node:child_process'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchRiven } from './app'

// What riven lets go of when nothing is using it — and what it must not.
// The real waits are 15 minutes (agents) and 10 (language servers); the tests
// shorten them through the same environment overrides the app reads.

const pids = (pattern: string): string[] => {
  try {
    return execSync(`pgrep -f '${pattern}'`).toString().trim().split('\n').filter(Boolean)
  } catch {
    return []
  }
}

test('a quiet agent is parked, but not one with work running in the background', async () => {
  // A stand-in CLI. The first one started reports a background task still
  // running (a dev server, say); the second reports nothing. Both are idle.
  const dir = mkdtempSync(join(tmpdir(), 'riven-fakecli-'))
  const claude = join(dir, 'claude')
  writeFileSync(
    claude,
    `#!/bin/sh
[ "$1" = "--version" ] && { echo "2.1.280 (Claude Code)"; exit 0; }
echo '{"type":"system","subtype":"init","session_id":"00000000-0000-0000-0000-00000000000'$$'","model":"claude-opus-5-5"}'
# Only chat panes take part (they are started with --permission-mode); the
# environment and model probes run this same binary at startup.
case "$*" in *--permission-mode*) pane=1;; *) pane=0;; esac
if [ "$pane" = 1 ] && mkdir '${dir}/first' 2>/dev/null; then
  echo '{"type":"system","subtype":"background_tasks_changed","tasks":[{"task_id":"t1","description":"npm run dev"}]}'
  echo bg > '${dir}/bg-pid-'$$
fi
while read -r _; do :; done
`
  )
  chmodSync(claude, 0o755)
  const shell = join(dir, 'login-shell')
  writeFileSync(shell, `#!/bin/sh\necho "${dir}:/usr/bin:/bin"\n`)
  chmodSync(shell, 0o755)

  const r = await launchRiven({
    files: { 'README.md': '# s\n' },
    fakeAgents: true,
    env: { SHELL: shell, RIVEN_CHAT_IDLE_PARK_MS: '3000' }
  })
  const agents = (): string[] => pids(`${claude} -p.*--permission-mode`)
  await r.page.keyboard.press('Meta+Shift+a')
  await expect.poll(() => agents().length, { timeout: 20_000 }).toBe(1)
  await r.page.keyboard.press('Meta+Shift+a')
  await expect.poll(() => agents().length, { timeout: 20_000 }).toBe(2)
  const withBg = execSync(`ls '${dir}'`).toString().match(/bg-pid-(\d+)/)?.[1]
  expect(withBg).toBeTruthy()

  // Past the (shortened) idle window: the quiet one is parked; the one with a
  // background task keeps its process — parking would have killed the task.
  await expect.poll(() => agents(), { timeout: 20_000 }).toEqual([withBg])
  await r.app.close()
})

test('a language server stops once no file of its language is open, and comes back', async () => {
  const r = await launchRiven({
    files: { 'a.ts': 'export const x: number = 1\n' },
    env: { RIVEN_LSP_IDLE_STOP_MS: '3000' }
  })
  const lsp = (): number => pids('typescript-language-server').length
  const open = async (): Promise<void> => {
    await r.page.keyboard.press('Meta+p')
    await r.page.locator('.palette-input').fill('a.ts')
    await r.page.locator('.palette-list .palette-label').filter({ hasText: 'a.ts' }).first().click()
  }
  await open()
  await expect.poll(lsp, { timeout: 30_000 }).toBeGreaterThan(0)

  // While the file is open it stays up, however quiet.
  await r.page.waitForTimeout(5000)
  expect(lsp()).toBeGreaterThan(0)

  // Close it: after the idle window the server goes.
  await r.page.locator('.file-tab').filter({ hasText: 'a.ts' }).hover()
  await r.page.locator('.file-tab').filter({ hasText: 'a.ts' }).locator('.file-tab-close, [title*="닫기"], button').first().click()
  await expect.poll(lsp, { timeout: 20_000 }).toBe(0)

  // Open it again: a fresh server, not a dead one.
  await open()
  await expect.poll(lsp, { timeout: 30_000 }).toBeGreaterThan(0)
  await r.app.close()
})
