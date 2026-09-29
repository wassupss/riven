import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchRiven, openPanel, type Launched } from './app'

// Opening a file, changing it, and saving it — the loop that has to reach DISK,
// which is the part no component test can check.

let riven: Launched

test.beforeAll(async () => {
  riven = await launchRiven({
    files: { 'notes.txt': 'first line\n', 'src/app.ts': 'export const x = 1\n' }
  })
})

test.afterAll(async () => {
  await riven.app.close()
})

test('a file opens from the tree into the editor', async () => {
  const { page } = riven
  await openPanel(page, '탐색기 열기')
  await page.locator('.ex-label').filter({ hasText: 'notes.txt' }).first().click()
  // Monaco takes a moment; the content is the proof it loaded the right file.
  await expect(page.locator('.monaco-editor').first()).toBeVisible({ timeout: 20_000 })
  await expect(page.locator('.monaco-editor').first()).toContainText('first line', { timeout: 20_000 })
})

test('an edit is written to disk on save', async () => {
  const { page, workspace } = riven
  const editor = page.locator('.monaco-editor').first()
  await editor.click()
  await page.keyboard.press('Meta+a')
  await page.keyboard.type('second line')
  await page.keyboard.press('Meta+s')

  await expect
    .poll(() => readFileSync(join(workspace, 'notes.txt'), 'utf8'), { timeout: 15_000 })
    .toContain('second line')
})

test('the editor names the file it is showing, and opens a second beside it', async () => {
  const { page } = riven
  // The editor keeps its OWN tab strip — one dock panel, many files.
  await expect(page.locator('.file-tab-name').filter({ hasText: 'notes.txt' })).toHaveCount(1)

  // The editor took the foreground, so the tree is a background tab now —
  // which is the dock working as designed, and something a test has to do the
  // way a person does: bring it back first.
  await openPanel(page, '탐색기 열기')
  // Expanding a folder is a click and a render; the child has to arrive first.
  await page.locator('.ex-label').filter({ hasText: 'src' }).first().click()
  const child = page.locator('.ex-label').filter({ hasText: 'app.ts' }).first()
  await expect(child).toBeVisible()
  await child.click()
  await expect(page.locator('.file-tab-name').filter({ hasText: 'app.ts' })).toHaveCount(1)
  await expect(page.locator('.file-tab')).toHaveCount(2)
  await expect(page.locator('.monaco-editor').first()).toContainText('export const x = 1', {
    timeout: 20_000
  })
})
