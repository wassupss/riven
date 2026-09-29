import { test, expect } from '@playwright/test'
import { launchRiven, openPanel, type Launched } from './app'

// The terminal is the one part of riven that runs through a NATIVE module
// (node-pty), so it is the one that an Electron upgrade breaks. These drive a
// real shell: if the ABI is wrong, nothing echoes and this fails loudly.

let riven: Launched

test.beforeAll(async () => {
  riven = await launchRiven()
})

test.afterAll(async () => {
  await riven.app.close()
})

async function type(page: Launched['page'], text: string): Promise<void> {
  await page.locator('.xterm-helper-textarea').last().focus()
  await page.keyboard.type(text)
  await page.keyboard.press('Enter')
}

test('a shell runs and its output comes back', async () => {
  const { page } = riven
  await openPanel(page, '새 터미널')
  await expect(page.locator('.xterm')).toHaveCount(1)
  await type(page, 'echo RIVEN_PTY_OK')
  await expect(page.locator('.xterm-rows').last()).toContainText('RIVEN_PTY_OK', { timeout: 20_000 })
})

test('the shell keeps its own state between commands', async () => {
  const { page } = riven
  await type(page, 'FOO=bar')
  await type(page, 'echo value:$FOO')
  // One process, not one per command: the variable survives.
  await expect(page.locator('.xterm-rows').last()).toContainText('value:bar', { timeout: 20_000 })
})

test('terminal settings reach a terminal that is already open', async () => {
  const { page } = riven
  // Asserted on what riven itself renders — the font size it publishes to the
  // pane for the IME overlay to match — rather than on xterm's private state.
  // A setting that needs a NEW terminal to take effect is a setting that looks
  // broken, and that is the regression worth catching.
  const before = await page.locator('.term-pane, .xterm').first().evaluate((el) =>
    getComputedStyle(el.closest('[style*="--term-font-size"]') ?? el).getPropertyValue('--term-font-size').trim()
  )

  await page.keyboard.press('Meta+,')
  await page.locator('.settings-nav-item').filter({ hasText: '터미널' }).first().click()
  const size = page.locator('.set-row').filter({ hasText: '글꼴 크기' }).locator('input[type="number"]').first()
  await size.fill('17')
  await size.blur()
  await page.keyboard.press('Escape')

  await expect
    .poll(async () =>
      page.locator('.term-pane, .xterm').first().evaluate((el) =>
        getComputedStyle(el.closest('[style*="--term-font-size"]') ?? el).getPropertyValue('--term-font-size').trim()
      )
    )
    .toBe('17px')
  expect(before).not.toBe('17px')
})
