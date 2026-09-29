import { test, expect } from '@playwright/test'
import { launchRiven, type Launched } from './app'

// The rail: what a workspace card says about itself, what its right-click
// offers now that "패널 추가" lives there, and how panes that were created as a
// team are listed.

let riven: Launched

test.beforeAll(async () => {
  riven = await launchRiven({
    files: { 'README.md': '# sample\n' },
    groups: [
      {
        group: '검증팀',
        members: [
          { name: '리드', chatKey: 'chat-e2e-lead', parent: null },
          { name: '멤버1', chatKey: 'chat-e2e-m1', parent: 0 }
        ]
      }
    ]
  })
})

test.afterAll(async () => {
  await riven.app.close()
})

test('a workspace with no repository still gets a tile', async () => {
  const { page } = riven
  const card = page.locator('.ws-card').first()
  // No remote to photograph, so: the workspace's own colour and a glyph — the
  // same 16px tile a GitHub avatar would fill.
  await expect(card.locator('.ws-card-glyph svg')).toHaveCount(1)
  await expect(card.locator('.ws-card-avatar')).toHaveCount(1)
})

test('right-clicking a workspace offers the panel picker and its own actions', async () => {
  const { page } = riven
  await page.locator('.ws-card').first().click({ button: 'right' })
  const menu = page.locator('.ctx-menu')
  await expect(menu).toBeVisible()
  await expect(menu.locator('.ctx-item').first()).toContainText('패널 추가')
  await expect(menu).toContainText('이름 변경')
  await expect(menu).toContainText('색상')
  await expect(menu).toContainText('아이콘')
  // Colour and glyph are both the user's to pick.
  await expect(menu.locator('.tab-swatch')).toHaveCount(12)
  await expect(menu.locator('.ws-glyph')).toHaveCount(12)
  await page.locator('.ctx-backdrop').click()
})

test('the empty rail offers the same two things', async () => {
  const { page } = riven
  await page.locator('.ws-list').click({ button: 'right', position: { x: 5, y: 5 } })
  const menu = page.locator('.ctx-menu')
  await expect(menu).toBeVisible()
  await expect(menu).toContainText('패널 추가')
  await expect(menu).toContainText('폴더 열기')
  await page.locator('.ctx-backdrop').click()
})

test('a chosen icon sticks to the card', async () => {
  const { page } = riven
  await page.locator('.ws-card').first().click({ button: 'right' })
  await page.locator('.ws-glyph').nth(3).click()
  await expect(page.locator('.ws-card').first().locator('.ws-card-glyph svg')).toHaveClass(/rocket/)
})
