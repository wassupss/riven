import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchRiven, openPanel } from './app'

// Search and replace across the workspace. Replace rewrites real files, which is
// the one panel action here that cannot be undone from inside the app — so the
// confirmation and the exact set of files it touched are both asserted.

const FILES = {
  'a.ts': 'const needle = 1\nconst other = 2\n',
  'nested/b.ts': 'export function needle(): void {}\n',
  'c.md': 'nothing here\n',
  'case.ts': 'const NEEDLE = 3\n'
}

async function search(page: import('@playwright/test').Page, q: string): Promise<void> {
  await openPanel(page, '검색')
  await page.waitForSelector('.search-panel')
  // Search runs on Enter, not as you type: a workspace-wide grep per keystroke
  // is exactly what the panel avoids.
  await page.locator('input[placeholder="전체 파일에서 검색"]').fill(q)
  await page.locator('input[placeholder="전체 파일에서 검색"]').press('Enter')
}

test.describe('search across the workspace', () => {
  test('a match is found in every file that has one, and named by file', async () => {
    const r = await launchRiven({ files: FILES })
    await search(r.page, 'needle')
    await expect(r.page.locator('.search-file')).toHaveCount(3) // a, nested/b, case (case-insensitive)
    await expect(r.page.locator('.search-file-name').filter({ hasText: 'b.ts' })).toBeVisible()
    await expect(r.page.locator('.search-summary')).toContainText('3')
    await r.app.close()
  })

  test('match case narrows the result, rather than being a decoration', async () => {
    const r = await launchRiven({ files: FILES })
    await search(r.page, 'needle')
    await expect(r.page.locator('.search-file')).toHaveCount(3)
    await r.page.locator('.search-toggle[title="대소문자 구분"]').click()
    await expect(r.page.locator('.search-file')).toHaveCount(2) // NEEDLE drops out
    await r.app.close()
  })

  test('a regex search is run as a pattern, not as text', async () => {
    const r = await launchRiven({ files: FILES })
    await search(r.page, 'needle|nothing')
    await expect(r.page.locator('.search-results .search-match')).toHaveCount(0)
    await r.page.locator('.search-toggle[title="정규식 사용"]').click()
    await expect(r.page.locator('.search-file')).toHaveCount(4)
    await r.app.close()
  })

  test('clicking a result opens that file at that line', async () => {
    const r = await launchRiven({ files: FILES })
    await search(r.page, 'needle')
    await r.page.locator('.search-match').filter({ hasText: 'export function' }).first().click()
    await expect(r.page.locator('.file-tab-name').filter({ hasText: 'b.ts' })).toHaveCount(1)
    await expect(r.page.locator('.monaco-editor').first()).toContainText('export function needle', {
      timeout: 20_000
    })
    await r.app.close()
  })

  test('replace all asks first, then rewrites the files on disk', async () => {
    const r = await launchRiven({ files: FILES })
    await search(r.page, 'needle')
    await r.page.locator('.search-replace-toggle').click()
    await r.page.locator('input[placeholder="치환할 내용"]').fill('thread')

    // Replace confirms before it runs and reports with an alert after, so this
    // answers dialogs for the rest of the test rather than one at a time.
    // ...and answering one that arrives as the app is closing must not fail the
    // run, hence the catch.
    let answer: 'dismiss' | 'accept' = 'dismiss'
    r.page.on('dialog', (d) => {
      void (answer === 'accept' ? d.accept() : d.dismiss()).catch(() => {})
    })

    await r.page.locator('.search-toggle[title="모두 치환"]').click() // refused
    await r.page.waitForTimeout(500)
    expect(readFileSync(join(r.workspace, 'a.ts'), 'utf8')).toContain('needle')

    answer = 'accept'
    await r.page.locator('.search-toggle[title="모두 치환"]').click()
    // Replace walks the tree file by file, so waiting on the first one to change
    // would race the rest: this waits until every file it should touch has.
    const read = (p: string): string => readFileSync(join(r.workspace, p), 'utf8')
    await expect
      .poll(() => `${read('a.ts')}|${read('nested/b.ts')}|${read('case.ts')}`, { timeout: 10_000 })
      .toBe('const thread = 1\nconst other = 2\n|export function thread(): void {}\n|const thread = 3\n')
    expect(readFileSync(join(r.workspace, 'c.md'), 'utf8')).toBe('nothing here\n') // untouched
    await r.app.close()
  })
})
