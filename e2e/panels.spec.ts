import { test, expect } from '@playwright/test'
import { launchRiven, openPanel, type Launched } from './app'

// Every panel riven can open, opened the way a person opens it (⌘O), and asked
// to show something real about the workspace. A panel that mounts empty is what
// this catches — the failure that only appears once a component is wired into
// the dock and pointed at an actual folder.

let riven: Launched

test.beforeAll(async () => {
  riven = await launchRiven({
    files: {
      'README.md': '# sample\n\nhello from the seeded workspace\n',
      'src/app.ts': 'export const greet = (): string => "needle in the haystack"\n',
      'src/util.ts': 'export const noop = (): void => undefined\n'
    },
    git: true
  })
})

test.afterAll(async () => {
  await riven.app.close()
})

test('the file tree is a panel, and it lists the workspace', async () => {
  const { page } = riven
  await openPanel(page, '탐색기 열기')
  await expect(page.locator('.ex-label').filter({ hasText: 'README.md' })).toBeVisible()
  await expect(page.locator('.ex-label').filter({ hasText: 'src' })).toBeVisible()
})

test('search finds text across the workspace', async () => {
  const { page } = riven
  await openPanel(page, '검색')
  await page.locator('.search-input').first().fill('needle')
  await page.keyboard.press('Enter')
  const results = page.locator('.search-results, [class*="search-"]').first()
  await expect(results).toContainText('src/app.ts')
  await expect(results).toContainText('needle in the haystack')
})

test('git sees the repository the workspace is', async () => {
  const { page } = riven
  await openPanel(page, 'Git')
  const git = page.locator('.git-panel')
  await expect(git.locator('.git-branch').first()).toContainText('main')
  // Seeded: one commit, then README.md changed — so exactly one dirty file.
  await expect(git).toContainText('변경됨 (1)')
  await expect(git).toContainText('README.md')
})

test('the workspace card reports the repository and its state', async () => {
  const { page } = riven
  const card = page.locator('.ws-card').first()
  // The remote names it; the folder name never would.
  await expect(card).toContainText('riven-e2e/sample')
  await expect(card.locator('.ws-card-branch')).toContainText('main')
  await expect(card.locator('.ws-card-dirty')).toContainText('1')
  await expect(card.locator('.ws-card-avatar')).toHaveCount(1)
})

test('notes, changes and the API client all mount', async () => {
  const { page } = riven
  for (const [label, marker] of [
    ['메모', '.no-aside, .no-btn'],
    ['변경 사항', '[class*="changes-"]'],
    ['API', '.dv-groupview']
  ] as const) {
    await openPanel(page, label)
    await expect(page.locator(marker).first()).toBeVisible()
  }
})

test('the sidebar can be hidden and brought back', async () => {
  const { page } = riven
  await expect(page.locator('.ws-rail')).toBeVisible()
  await page.keyboard.press('Meta+b')
  await expect(page.locator('.ws-rail')).toHaveCount(0)
  await page.keyboard.press('Meta+b')
  await expect(page.locator('.ws-rail')).toBeVisible()
})
