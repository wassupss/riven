import { expect, test } from '@playwright/test'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { launchRiven, openPanel } from './app'

// Creating, renaming and deleting files from the tree. These write to the real
// filesystem, so every assertion here is against the disk, not the DOM: a tree
// that shows a rename it never performed is the failure worth catching.

async function explorer(page: import('@playwright/test').Page): Promise<void> {
  await openPanel(page, '탐색기')
  await page.waitForSelector('.explorer-panel')
}

test.describe('the file tree', () => {
  test('a new file is created where the tree says it is', async () => {
    const r = await launchRiven({ files: { 'README.md': '# s\n' } })
    await explorer(r.page)
    await r.page.locator('.ex-header-actions button[title="새 파일"]').click()
    await r.page.locator('.input-modal .url-input').fill('created.ts')
    await r.page.locator('.input-modal').getByRole('button', { name: '확인' }).click()
    // The new file opens in the editor, which can take the explorer's dock group
    // and leave its rows attached but behind a tab — so this asks whether the row
    // is in the tree, not whether it is on screen.
    await expect(r.page.locator(`.ex-row[data-path="${join(r.workspace, 'created.ts')}"]`)).toHaveCount(1)
    expect(existsSync(join(r.workspace, 'created.ts'))).toBe(true)
    await r.app.close()
  })

  test('a new folder is created, and a file can go inside it', async () => {
    const r = await launchRiven({ files: { 'README.md': '# s\n' } })
    await explorer(r.page)
    await r.page.locator('.ex-header-actions button[title="새 폴더"]').click()
    await r.page.locator('.input-modal .url-input').fill('pkg')
    await r.page.locator('.input-modal').getByRole('button', { name: '확인' }).click()
    const row = r.page.locator(`.ex-row[data-path="${join(r.workspace, 'pkg')}"]`)
    await expect(row).toBeVisible()
    await row.hover()
    await row.locator('.ex-row-actions button[title="새 파일"]').click()
    await r.page.locator('.input-modal .url-input').fill('inside.ts')
    await r.page.locator('.input-modal').getByRole('button', { name: '확인' }).click()
    await expect
      .poll(() => existsSync(join(r.workspace, 'pkg', 'inside.ts')), { timeout: 5000 })
      .toBe(true)
    await r.app.close()
  })

  test('rename moves the file on disk', async () => {
    const r = await launchRiven({ files: { 'old.txt': 'body\n' } })
    await explorer(r.page)
    await r.page.locator('.ex-label').filter({ hasText: 'old.txt' }).click({ button: 'right' })
    await r.page.getByText('이름 변경', { exact: true }).click()
    await r.page.locator('.input-modal .url-input').fill('new.txt')
    await r.page.locator('.input-modal').getByRole('button', { name: '확인' }).click()
    await expect.poll(() => readdirSync(r.workspace).sort(), { timeout: 5000 }).toContain('new.txt')
    expect(existsSync(join(r.workspace, 'old.txt'))).toBe(false)
    await r.app.close()
  })

  test('delete asks first, and a refused delete keeps the file', async () => {
    const r = await launchRiven({ files: { 'keep.txt': 'body\n' } })
    await explorer(r.page)
    r.page.once('dialog', (d) => void d.dismiss()) // the user says no
    await r.page.locator('.ex-label').filter({ hasText: 'keep.txt' }).click({ button: 'right' })
    await r.page.getByText('삭제', { exact: true }).click()
    await r.page.waitForTimeout(500)
    expect(existsSync(join(r.workspace, 'keep.txt'))).toBe(true)

    r.page.once('dialog', (d) => void d.accept()) // and now yes
    await r.page.locator('.ex-label').filter({ hasText: 'keep.txt' }).click({ button: 'right' })
    await r.page.getByText('삭제', { exact: true }).click()
    await expect.poll(() => existsSync(join(r.workspace, 'keep.txt')), { timeout: 5000 }).toBe(false)
    await r.app.close()
  })

  test('a folder expands to show what is in it', async () => {
    const r = await launchRiven({ files: { 'src/a.ts': 'a\n', 'src/b.ts': 'b\n' } })
    await explorer(r.page)
    await expect(r.page.locator('.ex-label').filter({ hasText: 'a.ts' })).toBeHidden()
    await r.page.locator('.ex-label').filter({ hasText: 'src' }).click()
    await expect(r.page.locator('.ex-label').filter({ hasText: 'a.ts' })).toBeVisible()
    await expect(r.page.locator('.ex-label').filter({ hasText: 'b.ts' })).toBeVisible()
    await r.app.close()
  })
})
