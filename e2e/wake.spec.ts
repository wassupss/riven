import { expect, test } from '@playwright/test'
import { launchRiven } from './app'

// A screen that went dark overnight rearranges the displays on waking, and the
// window's size changes under the page without the page reliably hearing it:
// the dock was left short of the status bar until a workspace switch forced a
// relayout. Now a display change reaches the window as a wake, and the dock
// relays itself out on it — the same relayout the switch did.

test('a display rearranging reaches the window, and the dock still fills its space after it', async () => {
  const r = await launchRiven({ files: { 'README.md': '# s\n' } })
  await r.page.keyboard.press('Meta+Shift+a')
  await expect(r.page.locator('.chat-composer')).toHaveCount(1, { timeout: 15_000 })
  await r.page.evaluate(() => {
    const w = window as unknown as { __wakes: string[]; api: { onSystemResumed: (cb: (r: string) => void) => void } }
    w.__wakes = []
    w.api.onSystemResumed((reason) => w.__wakes.push(reason))
  })
  // What a display waking up (or an external monitor coming back) fires, several times over.
  await r.app.evaluate(({ screen }) => {
    for (let i = 0; i < 3; i++) screen.emit('display-metrics-changed', {}, screen.getPrimaryDisplay(), ['bounds'])
  })
  await expect
    .poll(() => r.page.evaluate(() => (window as unknown as { __wakes: string[] }).__wakes), { timeout: 5000 })
    .toEqual(['display']) // coalesced into one
  const gap = await r.page.evaluate(() => {
    const host = [...document.querySelectorAll('.workbench-wrap')].find((e) => (e as HTMLElement).offsetParent)!
    const bottom = Math.max(...[...host.querySelectorAll('.dv-groupview')].map((g) => g.getBoundingClientRect().bottom))
    return Math.round(host.getBoundingClientRect().bottom - bottom)
  })
  expect(gap).toBe(0)
  await r.app.close()
})
