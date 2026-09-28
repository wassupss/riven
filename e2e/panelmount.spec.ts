import { expect, test } from '@playwright/test'
import { launchRiven, openPanel } from './app'

// The panels the rest of the suite does not drive: the editor's bottom drawer
// (problems / output / debug), the git panel's other tabs (graph, PRs), the
// split launcher, the browser and the scheduler's own panel.
//
// These are mount tests on purpose. Each of them renders something that only
// exists at runtime — a language server's diagnostics, a commit graph, GitHub —
// and a panel that throws on mount takes the whole dock group down with it, so
// "it came up, and it said what it has" is the assertion that pays for itself.

test.describe('every panel comes up', () => {
  test('the editor drawer opens on problems, and switches to output and debug', async () => {
    const r = await launchRiven({ files: { 'a.ts': 'const x: number = 1\n' } })
    await r.page.keyboard.press('Meta+p')
    await r.page.locator('.palette-input').fill('a.ts')
    await r.page.locator('.palette-list .palette-label').filter({ hasText: 'a.ts' }).first().click()
    await r.page.locator('.editor-statusbar .esb-item').first().click()
    await expect(r.page.locator('.ebd')).toBeVisible()
    await expect(r.page.locator('.ebd-tab.on')).toHaveText(/문제/)

    await r.page.locator('.ebd-tab').filter({ hasText: '출력' }).click()
    await expect(r.page.locator('.ebd-tab.on')).toHaveText('출력')
    await r.page.locator('.ebd-tab').filter({ hasText: '디버그' }).click()
    await expect(r.page.locator('.ebd-tab.on')).toHaveText('디버그')
    await expect(r.page.locator('.ebd-body')).toBeVisible()

    await r.page.locator('.ebd-close').click()
    await expect(r.page.locator('.ebd')).toHaveCount(0)
    await r.app.close()
  })

  test('the git graph draws the history the repository has', async () => {
    const r = await launchRiven({ files: { 'README.md': '# sample\n' }, git: true })
    await openPanel(r.page, 'Git')
    await r.page.locator('.git-tab').filter({ hasText: '그래프' }).click()
    await expect(r.page.getByText('seed').first()).toBeVisible({ timeout: 20_000 })
    await r.app.close()
  })

  test('the PR tab comes up for a repository with a GitHub remote', async () => {
    const r = await launchRiven({ files: { 'README.md': '# sample\n' }, git: true })
    await openPanel(r.page, 'Git')
    await r.page.locator('.git-tab').filter({ hasText: 'PR' }).click()
    // Nothing is fetched here (no auth, no network): what must hold is that the
    // tab renders and says something rather than throwing.
    await expect(r.page.locator('.git-panel')).toBeVisible()
    await expect(r.page.locator('.git-tab.active')).toHaveText(/PR/)
    await r.app.close()
  })

  test('a fresh workspace opens the launcher, and ⌘D opens another in a split', async () => {
    const r = await launchRiven({ files: { 'README.md': '# s\n' } })
    // A workspace with no saved layout offers the choice rather than guessing a
    // terminal, so the launcher is what is already on screen.
    await expect(r.page.locator('.launcher')).toHaveCount(1)
    await expect(r.page.locator('.launcher-tile').first()).toBeVisible()
    await r.page.keyboard.press('Meta+d')
    await expect(r.page.locator('.launcher')).toHaveCount(2)
    await r.app.close()
  })

  test('the browser panel opens with its address bar', async () => {
    const r = await launchRiven({ files: { 'README.md': '# s\n' } })
    await openPanel(r.page, '브라우저')
    await expect(r.page.locator('.browser-panel')).toBeVisible()
    await expect(r.page.locator('.browser-bar')).toBeVisible()
    await r.app.close()
  })

  test('the scheduler has a panel of its own, reached once something is scheduled', async () => {
    const r = await launchRiven({ files: { 'README.md': '# s\n' } })
    await r.page.locator('.ws-sched-row').click()
    await r.page.getByRole('button', { name: '새 예약' }).click()
    await r.page.locator('.sched-menu .sf .sf-prompt').fill('패널에서 보일 예약')
    await r.page.locator('.sched-menu .sf').getByRole('button', { name: '저장' }).click()
    // "예약 관리" only appears once there is something to manage — that is the
    // only way into the panel, so the panel test has to go through it.
    await r.page.locator('.ws-sched-row').click()
    await r.page.getByRole('button', { name: '예약 관리' }).click()
    await expect(r.page.locator('.sched-main')).toBeVisible()
    await expect(r.page.locator('.sched-list')).toContainText('패널에서 보일 예약')
    await r.app.close()
  })

  test('a panel asked for twice is one panel, brought to the front', async () => {
    const r = await launchRiven({ files: { 'README.md': '# s\n' } })
    await openPanel(r.page, '메모')
    await expect(r.page.locator('.no-head')).toHaveCount(1)
    // These panels are singletons: the second ask focuses the one that exists
    // rather than stacking a second copy of it.
    await openPanel(r.page, '메모')
    await expect(r.page.locator('.no-head')).toHaveCount(1)
    await expect(r.page.locator('.no-head')).toBeVisible()
    await r.app.close()
  })
})
