import { expect, test } from '@playwright/test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchRiven, openPanel } from './app'

// Notes are markdown files under userData, one folder per workspace. The file is
// named when the note is created and keeps that name through every rename, so
// these look at contents rather than filenames — what a test can check that a
// glance cannot is that the typing reached a file at all, that it comes back on
// the next launch, and that deleting unlinks rather than just hiding a row.

function noteBodies(userDataDir: string): string[] {
  const root = join(userDataDir, 'notes')
  if (!existsSync(root)) return []
  const out: string[] = []
  for (const dir of readdirSync(root)) {
    for (const f of readdirSync(join(root, dir))) out.push(readFileSync(join(root, dir, f), 'utf8'))
  }
  return out
}

const TITLE = 'input[placeholder="제목"]'
const BODY = 'textarea[placeholder="마크다운으로 작성…"]'

async function notes(page: import('@playwright/test').Page): Promise<void> {
  await openPanel(page, '메모')
  await page.waitForSelector('.no-main, .no-main-empty')
}

test.describe('notes', () => {
  test('a note is written to a file under the workspace it belongs to', async () => {
    const r = await launchRiven({ files: { 'README.md': '# s\n' } })
    await notes(r.page)
    await r.page.locator('.no-btn[title="새 메모"]').click()
    await r.page.locator(TITLE).fill('회의록')
    await r.page.locator(BODY).fill('- 결정: 44로 올린다\n')
    await expect
      .poll(() => noteBodies(r.userDataDir).filter((b) => b.includes('44로 올린다')).length, {
        timeout: 8000
      })
      .toBe(1)
    expect(noteBodies(r.userDataDir).join('\n')).toContain('# 회의록')
    await r.app.close()
  })

  test('a note is still there after a restart', async () => {
    const first = await launchRiven({ files: { 'README.md': '# s\n' } })
    await notes(first.page)
    await first.page.locator('.no-btn[title="새 메모"]').click()
    await first.page.locator(TITLE).fill('carryover')
    await first.page.locator(BODY).fill('survives\n')
    await expect
      .poll(() => noteBodies(first.userDataDir).some((b) => b.includes('survives')), { timeout: 8000 })
      .toBe(true)
    await first.app.close()

    const second = await launchRiven({ userDataDir: first.userDataDir, workspace: first.workspace })
    await notes(second.page)
    const row = second.page.locator('.no-item-title').filter({ hasText: 'carryover' })
    await expect(row).toBeVisible()
    await row.click()
    await expect(second.page.locator(BODY)).toHaveValue(/survives/)
    await second.app.close()
  })

  test('the markdown is rendered, not just stored', async () => {
    const r = await launchRiven({ files: { 'README.md': '# s\n' } })
    await notes(r.page)
    await r.page.locator('.no-btn[title="새 메모"]').click()
    await r.page.locator(TITLE).fill('md')
    await r.page.locator(BODY).fill('## 제목입니다\n\n본문\n')
    await r.page.locator('.no-btn[title="분할"]').click()
    await expect(r.page.locator('.no-preview h2').filter({ hasText: '제목입니다' })).toBeVisible()
    await r.app.close()
  })

  test('deleting a note removes its file', async () => {
    const r = await launchRiven({ files: { 'README.md': '# s\n' } })
    await notes(r.page)
    await r.page.locator('.no-btn[title="새 메모"]').click()
    await r.page.locator(TITLE).fill('throwaway')
    await r.page.locator(BODY).fill('to be removed\n')
    await expect
      .poll(() => noteBodies(r.userDataDir).some((b) => b.includes('to be removed')), { timeout: 8000 })
      .toBe(true)
    r.page.once('dialog', (d) => void d.accept())
    await r.page.locator('.no-btn[title="삭제"]').click()
    await expect
      .poll(() => noteBodies(r.userDataDir).some((b) => b.includes('to be removed')), { timeout: 8000 })
      .toBe(false)
    await r.app.close()
  })
})
