import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchRiven, openPanel } from './app'

// Settings that have to reach something. settings.spec checks that the tabs
// exist and that a value is stored; these check the other half — that the app
// changes when the switch does, which is the half that quietly stops working
// when a value is renamed on one side only.

async function settings(page: import('@playwright/test').Page, tab: string): Promise<void> {
  if (!(await page.locator('.settings-modal').isVisible().catch(() => false))) {
    await page.keyboard.press('Meta+,')
    await expect(page.locator('.settings-modal')).toBeVisible()
  }
  await page.locator('.settings-nav-item').filter({ hasText: tab }).first().click()
}

test.describe('settings reach the app', () => {
  test('switching the language relabels the interface, and it stays switched', async () => {
    const r = await launchRiven({ files: { 'README.md': '# s\n' } })
    await expect(r.page.locator('.ws-rail-title')).toHaveText('워크스페이스')
    await settings(r.page, '일반')
    await r.page.locator('.ui-seg-btn').filter({ hasText: 'English' }).click()
    await expect(r.page.locator('.ws-rail-title')).toHaveText('Workspaces')
    await r.page.keyboard.press('Escape')

    // Settings are written after a short debounce; closing inside it would make
    // this a test of the timer. (A flush on unload covers the real quit path.)
    await expect
      .poll(
        () =>
          JSON.parse(readFileSync(join(r.userDataDir, 'settings.json'), 'utf8')).language as string,
        { timeout: 8000 }
      )
      .toBe('en')
    await r.app.close()
    const second = await launchRiven({ userDataDir: r.userDataDir, workspace: r.workspace })
    await expect(second.page.locator('.ws-rail-title')).toHaveText('Workspaces')
    await second.app.close()
  })

  test('picking a theme repaints the app', async () => {
    const r = await launchRiven({ files: { 'README.md': '# s\n' } })
    const bg = (): Promise<string> =>
      r.page.evaluate(() => getComputedStyle(document.body).backgroundColor)
    const before = await bg()
    await settings(r.page, '일반')
    const swatches = r.page.locator('.theme-swatch')
    const count = await swatches.count()
    expect(count).toBeGreaterThan(1)
    // Pick the first theme that isn't the one already applied.
    const other = swatches.filter({ hasNot: r.page.locator('.active') })
    await other.nth((await other.count()) - 1).click()
    await expect.poll(bg, { timeout: 8000 }).not.toBe(before)
    await r.app.close()
  })

  test('the editor font size set here is the size the editor uses', async () => {
    const r = await launchRiven({ files: { 'a.ts': 'const x = 1\n' } })
    await r.page.keyboard.press('Meta+p')
    await r.page.locator('.palette-input').fill('a.ts')
    await r.page.locator('.palette-list .palette-label').filter({ hasText: 'a.ts' }).first().click()
    await expect(r.page.locator('.monaco-editor').first()).toBeVisible({ timeout: 20_000 })

    await settings(r.page, '에디터')
    const row = r.page.locator('.set-row').filter({ hasText: '글꼴 크기' }).first()
    await row.locator('input[type="number"], input[type="range"]').first().fill('22')
    await r.page.keyboard.press('Escape')
    await expect
      .poll(
        () =>
          r.page
            .locator('.monaco-editor .view-lines')
            .first()
            .evaluate((el) => getComputedStyle(el).fontSize),
        { timeout: 10_000 }
      )
      .toBe('22px')
    await r.app.close()
  })

  test('the terminal font size set here reaches a terminal already open', async () => {
    const r = await launchRiven({ files: { 'README.md': '# s\n' } })
    await openPanel(r.page, '터미널')
    await expect(r.page.locator('.xterm').first()).toBeVisible({ timeout: 20_000 })
    await settings(r.page, '터미널')
    const row = r.page.locator('.set-row').filter({ hasText: '글꼴 크기' }).first()
    await row.locator('input[type="number"], input[type="range"]').first().fill('17')
    await r.page.keyboard.press('Escape')
    await expect
      .poll(
        () =>
          r.page.locator('.terminal-pane, .xterm').first().evaluate((el) =>
            getComputedStyle(el).getPropertyValue('--term-font-size').trim()
          ),
        { timeout: 10_000 }
      )
      .toContain('17')
    await r.app.close()
  })

  test('the permissions tab reports what macOS has actually granted', async () => {
    const r = await launchRiven({ files: { 'README.md': '# s\n' } })
    await settings(r.page, '권한')
    const body = r.page.locator('.settings-body')
    await expect(body).toContainText('마이크')
    await expect(body).toContainText('화면 기록')
    // Each row says where it stands — granted / denied / not asked — rather than
    // showing a switch that pretends riven decides it.
    const states = r.page.locator('.perm-state')
    await expect(states.first()).toBeVisible()
    for (const text of await states.allInnerTexts()) {
      expect(text.trim().length).toBeGreaterThan(0)
    }
    await r.app.close()
  })

  test('the shortcut table lists riven\'s own keys, and each has a chord', async () => {
    const r = await launchRiven({ files: { 'README.md': '# s\n' } })
    await settings(r.page, '단축키')
    // The tab is split by what the key reaches: the editor's keymap, the
    // terminal's, and riven's own. Only the last is this app's to define.
    await r.page.locator('.kb-tab').filter({ hasText: '리븐' }).click()
    const body = r.page.locator('.settings-body')
    await expect(body).toContainText('빠른 패널 열기')
    await expect(body).toContainText('파일 저장')
    const row = r.page.locator('.kb-row').filter({ hasText: '파일 저장' }).first()
    await expect(row.locator('.kb-chord')).toContainText('S')
    await r.app.close()
  })

  test('the editor keymap can be switched to another editor\'s', async () => {
    const r = await launchRiven({ files: { 'README.md': '# s\n' } })
    await settings(r.page, '단축키')
    await r.page.locator('.kb-tab').filter({ hasText: '코드 에디터' }).click()
    const chips = r.page.locator('.keymap-chip')
    await expect(chips.filter({ hasText: 'VS Code' })).toHaveCount(1)
    await chips.filter({ hasText: 'JetBrains' }).click()
    await expect(chips.filter({ hasText: 'JetBrains' })).toHaveClass(/active/)
    await r.app.close()
  })
})
