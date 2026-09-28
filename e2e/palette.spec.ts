import { expect, test } from '@playwright/test'
import { launchRiven } from './app'

// The two ways in that aren't a mouse: ⌘P to reach a file by name, ⌘⇧P to reach
// a command by name. Both are how somebody who knows the app actually drives it,
// and both are one keymap registration away from silently not existing.

test.describe('the palette', () => {
  test('⌘P opens a file by name', async () => {
    const r = await launchRiven({
      files: { 'src/deep/target.ts': 'export const found = 1\n', 'other.md': '# no\n' }
    })
    await r.page.keyboard.press('Meta+p')
    await expect(r.page.locator('.palette')).toBeVisible()
    await r.page.locator('.palette-input').fill('target')
    const hit = r.page.locator('.palette-list .palette-label').filter({ hasText: 'target.ts' }).first()
    await expect(hit).toBeVisible()
    await hit.click()
    await expect(r.page.locator('.palette')).toBeHidden()
    await expect(r.page.getByText('export const found = 1')).toBeVisible()
    await r.app.close()
  })

  test('⌘P says so when nothing matches, instead of an empty box', async () => {
    const r = await launchRiven({ files: { 'a.txt': 'a\n' } })
    await r.page.keyboard.press('Meta+p')
    await r.page.locator('.palette-input').fill('zzzznotafile')
    await expect(r.page.locator('.palette-empty')).toBeVisible()
    await r.app.close()
  })

  test('⌘⇧P finds a command and runs it', async () => {
    const r = await launchRiven({ files: { 'a.txt': 'a\n' } })
    const sidebar = r.page.locator('.sidebar')
    await expect(sidebar).toBeVisible()
    await r.page.keyboard.press('Meta+Shift+p')
    await expect(r.page.locator('.palette')).toBeVisible()
    await r.page.locator('.palette-input').fill('사이드바')
    const cmd = r.page.locator('.palette-list .palette-label').filter({ hasText: '사이드바' }).first()
    await expect(cmd).toBeVisible()
    await cmd.click()
    await expect(sidebar).toBeHidden()
    await r.app.close()
  })

  test('the command palette shows the shortcut a command answers to', async () => {
    const r = await launchRiven({ files: { 'a.txt': 'a\n' } })
    await r.page.keyboard.press('Meta+Shift+p')
    await r.page.locator('.palette-input').fill('저장')
    const row = r.page.locator('.palette-item').filter({ hasText: '파일 저장' }).first()
    await expect(row.locator('.palette-chord')).toContainText('S')
    await r.page.keyboard.press('Escape')
    await expect(r.page.locator('.palette')).toBeHidden()
    await r.app.close()
  })
})
