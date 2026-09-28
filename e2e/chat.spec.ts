import { expect, test } from '@playwright/test'
import { launchRiven } from './app'

// The native chat pane, WITHOUT an agent behind it.
//
// Under RIVEN_E2E the agent CLIs deliberately resolve to nothing (see
// main/shellPath), because a suite that starts real turns bills the user for
// every run. That leaves exactly the part worth testing here: the pane and its
// composer, and what the pane does when the CLI it needs is not there — which is
// also what a machine without claude installed sees, and the one path where a
// silent failure would look like the agent simply never answering.

const COMPOSER = 'textarea.chat-input'

test.describe('the chat pane', () => {
  test('⌘⇧A opens a chat pane with a composer', async () => {
    const r = await launchRiven({ files: { 'README.md': '# s\n' } })
    await r.page.keyboard.press('Meta+Shift+a')
    await expect(r.page.locator('.chat-composer')).toBeVisible()
    await expect(r.page.locator(COMPOSER)).toHaveAttribute('placeholder', /Enter/)
    await r.app.close()
  })

  test('a missing CLI is named as soon as the pane opens, not on the first message', async () => {
    const r = await launchRiven({ files: { 'README.md': '# s\n' } })
    await r.page.keyboard.press('Meta+Shift+a')
    // Without this the pane looked ready and only said "no agent for this pane"
    // once something had been typed — a message that names neither the CLI nor
    // what to do about it.
    await expect(r.page.locator('.chat-error')).toContainText(/claude/i, { timeout: 20_000 })
    await r.app.close()
  })

  test('the message that could not be sent is still in the transcript', async () => {
    const r = await launchRiven({ files: { 'README.md': '# s\n' } })
    await r.page.keyboard.press('Meta+Shift+a')
    await r.page.locator(COMPOSER).fill('기억되어야 하는 질문')
    await r.page.locator(COMPOSER).press('Enter')
    await expect(r.page.locator('.chat-user-bubble')).toContainText('기억되어야 하는 질문')
    await expect(r.page.locator(COMPOSER)).toHaveValue('') // and the box is cleared
    await r.app.close()
  })

  test('Shift+Enter is a newline, not a send', async () => {
    const r = await launchRiven({ files: { 'README.md': '# s\n' } })
    await r.page.keyboard.press('Meta+Shift+a')
    await r.page.locator(COMPOSER).fill('첫 줄')
    await r.page.locator(COMPOSER).press('Shift+Enter')
    await r.page.locator(COMPOSER).type('둘째 줄')
    await expect(r.page.locator(COMPOSER)).toHaveValue('첫 줄\n둘째 줄')
    await expect(r.page.locator('.chat-user-bubble')).toHaveCount(0)
    await r.app.close()
  })

  test('two chat panes are two conversations, each with its own composer', async () => {
    const r = await launchRiven({ files: { 'README.md': '# s\n' } })
    await r.page.keyboard.press('Meta+Shift+a')
    await expect(r.page.locator('.chat-composer')).toHaveCount(1)
    await r.page.keyboard.press('Meta+Shift+a')
    await expect(r.page.locator('.chat-composer')).toHaveCount(2)
    const boxes = r.page.locator(COMPOSER)
    await boxes.nth(0).fill('첫 번째 패널')
    await boxes.nth(1).fill('두 번째 패널')
    await expect(boxes.nth(0)).toHaveValue('첫 번째 패널')
    await expect(boxes.nth(1)).toHaveValue('두 번째 패널')
    await r.app.close()
  })
})
