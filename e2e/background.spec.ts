import { expect, test } from '@playwright/test'
import { launchRiven, type Launched } from './app'

// A minimised riven has to stop spending: animations, polls. It could not tell
// it was minimised — backgroundThrottling is off (a hidden window must keep
// laying out its dock), and that also keeps document.visibilityState at
// 'visible' — so none of its own "nobody is looking" rules ever fired. Main now
// reports minimise/restore; these hold it to that.

async function mainWindow(r: Launched, call: 'minimize' | 'restore'): Promise<void> {
  await r.app.evaluate(({ BrowserWindow }, fn) => {
    const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('index.html'))
    if (w) w[fn]()
  }, call)
}

const hidden = (r: Launched): Promise<boolean> =>
  r.page.evaluate(() => document.body.classList.contains('win-hidden'))

test.describe('in the background', () => {
  test('minimising is noticed, and restoring undoes it', async () => {
    const r = await launchRiven({ files: { 'README.md': '# s\n' } })
    expect(await hidden(r)).toBe(false)
    await mainWindow(r, 'minimize')
    await expect.poll(() => hidden(r), { timeout: 5000 }).toBe(true)
    await mainWindow(r, 'restore')
    await expect.poll(() => hidden(r), { timeout: 5000 }).toBe(false)
    await r.app.close()
  })

  test('every animation pauses while minimised — not only the listed ones', async () => {
    const r = await launchRiven({ files: { 'README.md': '# s\n' } })
    // Any infinite animation at all, standing in for the next one somebody adds.
    await r.page.evaluate(() => {
      const style = document.createElement('style')
      style.textContent = '@keyframes e2e-spin{to{rotate:360deg}} .e2e-spinner{animation:e2e-spin 1s linear infinite}'
      document.head.appendChild(style)
      const el = document.createElement('div')
      el.className = 'e2e-spinner'
      document.body.appendChild(el)
    })
    const state = (): Promise<string | undefined> =>
      r.page.evaluate(() => document.querySelector('.e2e-spinner')?.getAnimations()[0]?.playState)
    await expect.poll(state).toBe('running')
    await mainWindow(r, 'minimize')
    await expect.poll(state, { timeout: 5000 }).toBe('paused')
    await mainWindow(r, 'restore')
    await expect.poll(state, { timeout: 5000 }).toBe('running')
    await r.app.close()
  })
})
