import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchRiven, openPanel } from './app'

// The app around the panels: the keys that open and move between things, the
// composer's own scheduling (merged into the scheduler, so a message put off
// from a chat has to end up as a job like any other), the pet window, and the
// status bar.

test.describe('the app shell', () => {
  test('⌘T opens terminals, and each is its own tab', async () => {
    const r = await launchRiven({ files: { 'README.md': '# s\n' } })
    await r.page.keyboard.press('Meta+t')
    await expect(r.page.locator('.xterm')).toHaveCount(1, { timeout: 20_000 })
    await r.page.keyboard.press('Meta+t')
    await expect(r.page.locator('.xterm')).toHaveCount(2, { timeout: 20_000 })
    await r.app.close()
  })

  test('focus moves between the editor and the terminal by key', async () => {
    const r = await launchRiven({ files: { 'a.ts': 'const x = 1\n' } })
    await r.page.keyboard.press('Meta+p')
    await r.page.locator('.palette-input').fill('a.ts')
    await r.page.locator('.palette-list .palette-label').filter({ hasText: 'a.ts' }).first().click()
    await r.page.keyboard.press('Meta+t')
    await expect(r.page.locator('.xterm')).toHaveCount(1, { timeout: 20_000 })

    // The terminal opened as a tab over the editor, which is the case ⌘E is for:
    // it has to bring the editor forward before it can hand it the caret.
    await r.page.keyboard.press('Meta+e')
    await expect
      .poll(() => r.page.evaluate(() => !!document.querySelector('.monaco-editor')?.contains(document.activeElement)))
      .toBe(true)
    await r.page.keyboard.press('Meta+j') // and back to the terminal
    await expect
      .poll(() => r.page.evaluate(() => !!document.querySelector('.xterm')?.contains(document.activeElement)))
      .toBe(true)
    await r.app.close()
  })

  test('a message put off from the composer becomes a scheduled job', async () => {
    const r = await launchRiven({ files: { 'README.md': '# s\n' } })
    await r.page.keyboard.press('Meta+Shift+a')
    await r.page.locator('textarea.chat-input').fill('나중에 보낼 메시지')
    await r.page.locator('.chat-sched-btn').click()
    await expect(r.page.locator('.chat-sched-pop')).toBeVisible()
    await r.page.locator('.chat-sched-preset').first().click()

    // The two schedulers were merged, so this is not a private queue in the
    // chat pane any more: it has to be the same job the rail manages.
    await r.page.locator('.ws-sched-row').click()
    await r.page.getByRole('button', { name: '예약 관리' }).click()
    await expect(r.page.locator('.sched-list')).toContainText('나중에 보낼 메시지')
    await expect
      .poll(
        () => {
          const data = JSON.parse(readFileSync(join(r.userDataDir, 'sessions.json'), 'utf8'))
          return (data.sessions?.[r.workspace]?.jobs ?? []).length
        },
        { timeout: 8000 }
      )
      .toBe(1)
    await r.app.close()
  })

  test('the pet has a window of its own, which can be sent away and called back', async () => {
    const r = await launchRiven({ files: { 'README.md': '# s\n' } })
    // The pet is on by default, so it is already a second window at startup.
    await expect.poll(() => r.app.windows().length, { timeout: 15_000 }).toBe(2)
    await openPanel(r.page, '리븐펫 숨기기')
    await expect.poll(() => r.app.windows().length, { timeout: 15_000 }).toBe(1)
    await openPanel(r.page, '리븐펫 보이기')
    await expect.poll(() => r.app.windows().length, { timeout: 15_000 }).toBe(2)
    await r.app.close()
  })

  test('the layout can be tidied without losing what is open', async () => {
    const r = await launchRiven({ files: { 'README.md': '# s\n' } })
    await openPanel(r.page, '메모')
    await openPanel(r.page, '검색')
    await openPanel(r.page, '패널 정리')
    await expect(r.page.locator('.no-head')).toHaveCount(1)
    await expect(r.page.locator('.search-panel')).toHaveCount(1)
    await r.app.close()
  })

  test('the current panel can be popped out into its own window', async () => {
    const r = await launchRiven({ files: { 'README.md': '# s\n' } })
    await openPanel(r.page, '메모')
    const before = r.app.windows().length
    await r.page.keyboard.press('Meta+Shift+o')
    await expect.poll(() => r.app.windows().length, { timeout: 15_000 }).toBe(before + 1)
    await r.app.close()
  })
})
