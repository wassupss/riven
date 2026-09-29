import { expect, test, type Page } from '@playwright/test'
import { launchRiven, openPanel, type Launched } from './app'

// The browser panel's page is a native view laid OVER the app, positioned from
// the panel's box. It has to follow that box — including when it only MOVES
// (a neighbour opening beside it), which no resize event reports — and it has
// to vanish when its workspace goes to the back and return when it comes back.
// The bounds poll that does the following now slows down off screen; these
// hold it to still doing its job.

async function openPage(page: Page): Promise<void> {
  await openPanel(page, '브라우저')
  await page.locator('.browser-addr-wrap input').fill('about:blank')
  await page.locator('.browser-addr-wrap input').press('Enter')
}

/** The visible native page views' bounds, as main has them. */
function views(r: Launched): Promise<Array<{ x: number; y: number; width: number; height: number }>> {
  return r.app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('index.html'))
    if (!w) return []
    return w.contentView.children
      .filter((v) => (v as unknown as { getVisible?: () => boolean }).getVisible?.() !== false)
      .map((v) => v.getBounds())
      .filter((b) => b.width > 0 && b.height > 0)
  })
}

async function viewportBox(page: Page): Promise<{ x: number; y: number; width: number; height: number }> {
  const b = await page.locator('.browser-viewport').first().boundingBox()
  if (!b) throw new Error('no viewport')
  return { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) }
}

const near = (a: { x: number; width: number }, b: { x: number; width: number }): boolean =>
  Math.abs(a.x - b.x) <= 2 && Math.abs(a.width - b.width) <= 2

test.describe('the browser page view', () => {
  test('sits where the panel is, and follows it when the panel moves', async () => {
    const r = await launchRiven({ files: { 'README.md': '# s\n' } })
    await openPage(r.page)
    await expect.poll(async () => (await views(r)).length, { timeout: 10_000 }).toBe(1)
    await expect.poll(async () => near((await views(r))[0], await viewportBox(r.page)), { timeout: 5000 }).toBe(true)

    // The rail folds away: the whole dock shifts left, so the panel moves. The
    // view has to follow it, not stay painted where the panel used to be.
    const before = await viewportBox(r.page)
    await r.page.keyboard.press('Meta+b')
    await expect.poll(async () => (await viewportBox(r.page)).x, { timeout: 10_000 }).not.toBe(before.x)
    await expect.poll(async () => near((await views(r))[0], await viewportBox(r.page)), { timeout: 5000 }).toBe(true)
    await r.app.close()
  })

  test('goes away with its workspace, and comes straight back with it', async () => {
    const r = await launchRiven({ files: { 'README.md': '# s\n' }, extraWorkspaces: 1 })
    await openPage(r.page)
    await expect.poll(async () => (await views(r)).length, { timeout: 10_000 }).toBe(1)

    await r.page.locator('.ws-card').nth(1).click()
    await expect.poll(async () => (await views(r)).length, { timeout: 5000 }).toBe(0)

    // Back: well inside the slow off-screen poll, so this is the switch itself.
    await r.page.locator('.ws-card').nth(0).click()
    await expect.poll(async () => (await views(r)).length, { timeout: 1500 }).toBe(1)
    await r.app.close()
  })
})
