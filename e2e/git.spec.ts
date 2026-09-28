import { expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchRiven, openPanel } from './app'

// The git panel against a real repository: staging, committing, branching and
// discarding all run git, so every assertion here is checked by asking git
// afterwards rather than by reading the panel back to itself.

function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim()
}

async function gitPanel(page: import('@playwright/test').Page): Promise<void> {
  await openPanel(page, 'Git')
  await page.waitForSelector('.git-panel')
}

test.describe('the git panel', () => {
  test('it lists the working tree the repository actually has', async () => {
    const r = await launchRiven({ files: { 'README.md': '# sample\n', 'src/a.ts': 'a\n' }, git: true })
    await gitPanel(r.page)
    await expect(r.page.locator('.git-file').filter({ hasText: 'README.md' })).toBeVisible()
    await expect(r.page.locator('.git-branch')).toContainText('main')
    await r.app.close()
  })

  test('staging a file stages it in git, and unstaging puts it back', async () => {
    const r = await launchRiven({ files: { 'README.md': '# sample\n' }, git: true })
    await gitPanel(r.page)
    const row = r.page.locator('.git-row', { has: r.page.locator('.git-file', { hasText: 'README.md' }) }).first()
    await row.hover()
    await row.locator('.git-act[title="스테이지"]').click()
    await expect.poll(() => git(r.workspace, 'diff', '--cached', '--name-only'), { timeout: 8000 }).toContain('README.md')

    const stagedRow = r.page.locator('.git-row', { has: r.page.locator('.git-file', { hasText: 'README.md' }) }).first()
    await stagedRow.hover()
    await stagedRow.locator('.git-act[title="언스테이지"]').click()
    await expect.poll(() => git(r.workspace, 'diff', '--cached', '--name-only'), { timeout: 8000 }).toBe('')
    await r.app.close()
  })

  test('a commit made from the panel is a commit in the repository', async () => {
    const r = await launchRiven({ files: { 'README.md': '# sample\n' }, git: true })
    await gitPanel(r.page)
    await r.page.locator('.git-act[title="모두 스테이지"]').click()
    await expect.poll(() => git(r.workspace, 'diff', '--cached', '--name-only'), { timeout: 8000 }).toContain('README.md')
    await r.page.locator('.git-msg').fill('panel commit')
    await r.page.locator('.git-commit button.primary').click()
    await expect.poll(() => git(r.workspace, 'log', '-1', '--format=%s'), { timeout: 10_000 }).toBe('panel commit')
    // And the tree is clean again, which is what the panel claims by emptying.
    expect(git(r.workspace, 'status', '--porcelain')).toBe('')
    await r.app.close()
  })

  test('the commit button refuses an empty message and an empty stage', async () => {
    const r = await launchRiven({ files: { 'README.md': '# sample\n' }, git: true })
    await gitPanel(r.page)
    const commit = r.page.locator('.git-commit button.primary')
    await expect(commit).toBeDisabled() // nothing staged, nothing typed
    await r.page.locator('.git-msg').fill('message but nothing staged')
    await expect(commit).toBeDisabled()
    await r.page.locator('.git-act[title="모두 스테이지"]').click()
    await expect(commit).toBeEnabled()
    await r.app.close()
  })

  test('a new branch is created and checked out', async () => {
    const r = await launchRiven({ files: { 'README.md': '# sample\n' }, git: true })
    await gitPanel(r.page)
    await r.page.locator('.git-branch').click()
    await r.page.locator('.git-branch-item.new').click()
    await r.page.locator('.input-modal .url-input').fill('feature/from-panel')
    await r.page.locator('.input-modal').getByRole('button', { name: '확인' }).click()
    await expect
      .poll(() => git(r.workspace, 'rev-parse', '--abbrev-ref', 'HEAD'), { timeout: 10_000 })
      .toBe('feature/from-panel')
    await expect(r.page.locator('.git-branch')).toContainText('feature/from-panel')
    await r.app.close()
  })

  test('discarding a change restores the committed content', async () => {
    const r = await launchRiven({ files: { 'README.md': '# sample\n' }, git: true })
    writeFileSync(join(r.workspace, 'README.md'), '# sample\n\nchanged after the commit\n')
    await gitPanel(r.page)
    const row = r.page.locator('.git-row', { has: r.page.locator('.git-file', { hasText: 'README.md' }) }).first()
    await row.hover()
    r.page.once('dialog', (d) => void d.accept())
    await row.locator('.git-act.danger').click()
    await expect.poll(() => git(r.workspace, 'status', '--porcelain'), { timeout: 10_000 }).toBe('')
    await r.app.close()
  })

  test('a folder that is not a repository says so instead of showing an empty list', async () => {
    const r = await launchRiven({ files: { 'README.md': '# not a repo\n' } })
    await gitPanel(r.page)
    await expect(r.page.getByText('git 저장소가 아니에요.')).toBeVisible()
    await r.app.close()
  })
})
