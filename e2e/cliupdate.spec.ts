import { expect, test } from '@playwright/test'
import { execSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchRiven } from './app'

// Updating a CLI from settings: in the background, with the row showing it,
// and never a terminal panel dropped into the layout.
//
// The CLI here is a stand-in. riven finds CLIs on the login shell's PATH, so
// SHELL points at a script whose PATH holds only a fake `claude` — the real one
// is never reachable, and nothing is billed or actually updated.

function fakeClaude(): { shell: string; versionFile: string; bin: string } {
  const dir = mkdtempSync(join(tmpdir(), 'riven-fakecli-'))
  const versionFile = join(dir, 'version')
  writeFileSync(versionFile, '2.1.280')
  const claude = join(dir, 'claude')
  writeFileSync(
    claude,
    `#!/bin/sh
case "$1" in
  --version) echo "$(cat '${versionFile}') (Claude Code)";;
  update) sleep 2; echo "Updating…"; echo 2.1.290 > '${versionFile}'; echo "Updated to 2.1.290";;
  *) while read -r _; do :; done;;
esac
`
  )
  chmodSync(claude, 0o755)
  const shell = join(dir, 'login-shell')
  writeFileSync(shell, `#!/bin/sh\necho "${dir}:/usr/bin:/bin"\n`)
  chmodSync(shell, 0o755)
  return { shell, versionFile, bin: claude }
}

test('a CLI update runs in the background and says how it went', async () => {
  const fake = fakeClaude()
  const r = await launchRiven({ files: { 'README.md': '# s\n' }, fakeAgents: true, env: { SHELL: fake.shell } })
  await r.page.keyboard.press('Meta+,')
  await r.page.locator('.settings-nav-item').filter({ hasText: 'AI' }).first().click()
  const row = r.page.locator('.set-row').filter({ hasText: 'Claude Code' }).first()
  await expect(row.locator('.cli-chip')).toHaveText('v2.1.280', { timeout: 20_000 })

  const terminalsBefore = await r.page.locator('.xterm').count()
  await row.getByRole('button', { name: '업데이트' }).click()
  await expect(row.getByRole('button', { name: /업데이트 중/ })).toBeDisabled()

  await expect(r.page.getByText('v2.1.280 → v2.1.290 업데이트 완료')).toBeVisible({ timeout: 20_000 })
  await expect(row.locator('.cli-chip')).toHaveText('v2.1.290')
  expect(readFileSync(fake.versionFile, 'utf8').trim()).toBe('2.1.290')
  // No terminal panel was opened to do it.
  expect(await r.page.locator('.xterm').count()).toBe(terminalsBefore)
  await r.app.close()
})

test('closing settings mid-update does not lose it', async () => {
  const fake = fakeClaude()
  const r = await launchRiven({ files: { 'README.md': '# s\n' }, fakeAgents: true, env: { SHELL: fake.shell } })
  await r.page.keyboard.press('Meta+,')
  await r.page.locator('.settings-nav-item').filter({ hasText: 'AI' }).first().click()
  const row = r.page.locator('.set-row').filter({ hasText: 'Claude Code' }).first()
  await expect(row.locator('.cli-chip')).toHaveText('v2.1.280', { timeout: 20_000 })
  await row.getByRole('button', { name: '업데이트' }).click()
  await r.page.keyboard.press('Escape')

  await r.page.keyboard.press('Meta+,')
  await r.page.locator('.settings-nav-item').filter({ hasText: 'AI' }).first().click()
  await expect(r.page.getByText('v2.1.280 → v2.1.290 업데이트 완료')).toBeVisible({ timeout: 20_000 })
  await r.app.close()
})

// The pids of stand-in chat processes (the fake CLI kept alive as a chat pane's
// agent). A different pid for the same pane = the process was replaced.
const agentPids = (bin: string): string[] => {
  try {
    // --permission-mode: only a chat pane's agent is started with it — the
    // environment and model probes are the same binary, and are not panes.
    return execSync(`pgrep -f '${bin} -p.*--permission-mode'`).toString().trim().split('\n').filter(Boolean).sort()
  } catch {
    return []
  }
}

test('after an update, open chat panes get the new build in place', async () => {
  const fake = fakeClaude()
  const r = await launchRiven({ files: { 'README.md': '# s\n' }, fakeAgents: true, env: { SHELL: fake.shell } })
  await r.page.keyboard.press('Meta+Shift+a')
  await expect.poll(() => agentPids(fake.bin).length, { timeout: 20_000 }).toBe(1)
  const before = agentPids(fake.bin)
  const panelsBefore = await r.page.locator('.chat-composer').count()

  await r.page.keyboard.press('Meta+,')
  await r.page.locator('.settings-nav-item').filter({ hasText: 'AI' }).first().click()
  const row = r.page.locator('.set-row').filter({ hasText: 'Claude Code' }).first()
  await row.getByRole('button', { name: '업데이트' }).click()
  await expect(r.page.getByText(/채팅 1개를 새 프로세스로 다시 시작했어요/)).toBeVisible({ timeout: 20_000 })

  // A new process behind the same pane: nothing was closed or reopened.
  await expect.poll(() => agentPids(fake.bin), { timeout: 10_000 }).not.toEqual(before)
  expect(agentPids(fake.bin)).toHaveLength(1)
  await r.page.keyboard.press('Escape')
  expect(await r.page.locator('.chat-composer').count()).toBe(panelsBefore)
  await r.app.close()
})

test('a pane that reattaches after the CLI changed underneath it gets the new build', async () => {
  // What "closing and reopening riven did nothing" was: on macOS the app lives
  // on when its window closes, and a reopened (or reloaded) pane reattached to
  // the process it already had — the old build.
  const fake = fakeClaude()
  const r = await launchRiven({ files: { 'README.md': '# s\n' }, fakeAgents: true, env: { SHELL: fake.shell } })
  await r.page.keyboard.press('Meta+Shift+a')
  await expect.poll(() => agentPids(fake.bin).length, { timeout: 20_000 }).toBe(1)
  const before = agentPids(fake.bin)

  // An update outside riven: the binary is rewritten.
  const later = new Date(Date.now() + 60_000)
  utimesSync(fake.bin, later, later)
  await r.page.reload()
  await r.page.waitForSelector('.ws-card', { timeout: 60_000 })

  await expect.poll(() => agentPids(fake.bin), { timeout: 20_000 }).not.toEqual(before)
  expect(agentPids(fake.bin)).toHaveLength(1)
  await r.app.close()
})
