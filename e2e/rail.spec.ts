import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchRiven } from './app'

// More than one workspace open at once: switching between them, what each one
// keeps while the other is in front, and closing one without taking the rest
// with it. A workspace is a whole editor state, so "switch" is the operation
// most able to quietly lose something.

function onDisk(userDataDir: string): {
  openWorkspaces: string[]
  activeWorkspace: string
  names?: Record<string, string>
} {
  return JSON.parse(readFileSync(join(userDataDir, 'sessions.json'), 'utf8'))
}

test.describe('the workspace rail', () => {
  test('every open workspace has a card', async () => {
    const r = await launchRiven({ files: { 'README.md': '# s\n' }, extraWorkspaces: 2 })
    await expect(r.page.locator('.ws-card')).toHaveCount(3)
    await r.app.close()
  })

  test('clicking a card switches to it, and the switch is remembered', async () => {
    const r = await launchRiven({ files: { 'README.md': '# s\n' }, extraWorkspaces: 1 })
    const second = r.page.locator('.ws-card').nth(1)
    await second.click()
    await expect(second).toHaveClass(/active|on|current/)
    await expect
      .poll(() => onDisk(r.userDataDir).activeWorkspace, { timeout: 8000 })
      .toBe(r.extras[0])
    await r.app.close()
  })

  test('each workspace keeps its own open files across a switch', async () => {
    const r = await launchRiven({ files: { 'mine.txt': 'first workspace\n' }, extraWorkspaces: 1 })
    await r.page.keyboard.press('Meta+p')
    await r.page.locator('.palette-input').fill('mine')
    await r.page.locator('.palette-list .palette-label').filter({ hasText: 'mine.txt' }).first().click()
    const tab = r.page.locator('.file-tab-name').filter({ hasText: 'mine.txt' })
    await expect(tab).toBeVisible()

    // A workspace that goes to the back keeps its panels mounted and hidden
    // (see dock/RetainedPanel), so this asks whether the tab is on screen — the
    // thing a switch is supposed to change — not whether it still exists.
    await r.page.locator('.ws-card').nth(1).click()
    await expect(tab).toBeHidden()

    await r.page.locator('.ws-card').nth(0).click()
    await expect(tab).toBeVisible()
    await r.app.close()
  })

  test('closing one workspace leaves the others open', async () => {
    const r = await launchRiven({ files: { 'README.md': '# s\n' }, extraWorkspaces: 2 })
    await r.page.locator('.ws-card').nth(2).click({ button: 'right' })
    await r.page.locator('.ctx-item').filter({ hasText: '워크스페이스 닫기' }).click()
    await expect(r.page.locator('.ws-card')).toHaveCount(2)
    await expect
      .poll(() => onDisk(r.userDataDir).openWorkspaces.length, { timeout: 8000 })
      .toBe(2)
    await r.app.close()
  })

  test('a renamed workspace keeps its name after a restart', async () => {
    const first = await launchRiven({ files: { 'README.md': '# s\n' } })
    await first.page.locator('.ws-card').first().click({ button: 'right' })
    await first.page.locator('.ctx-item').filter({ hasText: '이름 변경' }).click()
    const field = first.page.locator('.ws-card-rename')
    await field.fill('내 프로젝트')
    await field.press('Enter')
    await expect(first.page.locator('.ws-card-title')).toHaveText('내 프로젝트')
    // Saving is debounced; closing inside that window would make this a test of
    // the timer rather than of the rename.
    await expect
      .poll(() => Object.values(onDisk(first.userDataDir).names ?? {}), { timeout: 8000 })
      .toContain('내 프로젝트')
    await first.app.close()

    const second = await launchRiven({ userDataDir: first.userDataDir, workspace: first.workspace })
    await expect(second.page.locator('.ws-card-title')).toHaveText('내 프로젝트')
    await second.app.close()
  })

  test('the rail can be folded away and brought back', async () => {
    const r = await launchRiven({ files: { 'README.md': '# s\n' } })
    const rail = r.page.locator('.ws-rail')
    await expect(rail).toBeVisible()
    await r.page.keyboard.press('Meta+b')
    await expect(rail).toBeHidden()
    await r.page.keyboard.press('Meta+b')
    await expect(rail).toBeVisible()
    await r.app.close()
  })
})
