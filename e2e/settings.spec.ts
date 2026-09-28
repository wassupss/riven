import { test, expect } from '@playwright/test'
import { launchRiven, type Launched } from './app'

// The settings window, through the keyboard and the mouse a person uses.
//
// The things asserted here are the ones that were wrong at some point: a tab
// that exists but shows nothing, a switch that writes a value nobody reads, and
// a value that does not survive the window being closed.

let riven: Launched

test.beforeAll(async () => {
  riven = await launchRiven()
})

test.afterAll(async () => {
  await riven.app.close()
})

const open = async (page: Launched['page']): Promise<void> => {
  if (await page.locator('.settings-modal').isVisible().catch(() => false)) return
  await page.keyboard.press('Meta+,')
  await expect(page.locator('.settings-modal')).toBeVisible()
}

test('every tab in the nav shows something', async () => {
  const { page } = riven
  await open(page)
  const items = page.locator('.settings-nav-item')
  // One subject per tab, rather than one page that scrolls through all of them.
  await expect(items).toHaveCount(10)

  for (const label of ['일반', '에디터', '터미널', 'AI', '권한', '알림', '펫', '단축키', '계정', '정보']) {
    await items.filter({ hasText: label }).first().click()
    await expect(page.locator('.settings-body')).not.toBeEmpty()
  }
})

test('the terminal tab carries the behaviour settings, not just fonts', async () => {
  const { page } = riven
  await open(page)
  await page.locator('.settings-nav-item').filter({ hasText: '터미널' }).first().click()
  const body = page.locator('.settings-body')
  for (const row of ['커서 모양', '커서 깜빡임', '스크롤백', '선택하면 복사', '오른쪽 클릭으로 붙여넣기']) {
    await expect(body).toContainText(row)
  }
})

test('a notification event can be turned off on its own', async () => {
  const { page } = riven
  await open(page)
  await page.locator('.settings-nav-item').filter({ hasText: '알림' }).first().click()
  const body = page.locator('.settings-body')
  await expect(body).toContainText('작업 완료')
  await expect(body).toContainText('실패')

  // Switches are per-row; the "finished" one is the row that says so.
  const row = page.locator('.set-row').filter({ hasText: '작업 완료' }).first()
  await row.locator('button[role="switch"], .ui-switch').first().click()
  await expect(row.locator('button[role="switch"], .ui-switch').first()).toHaveAttribute(
    'aria-checked',
    'false'
  )
})

test('a setting survives closing the window', async () => {
  const { page } = riven
  await open(page)
  await page.locator('.settings-nav-item').filter({ hasText: '일반' }).first().click()
  const row = page.locator('.set-row').filter({ hasText: '잠자기 방지' }).first()
  const toggle = row.locator('button[role="switch"], .ui-switch').first()
  await expect(toggle).toHaveAttribute('aria-checked', 'true')
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-checked', 'false')

  await page.keyboard.press('Escape')
  await expect(page.locator('.settings-modal')).toHaveCount(0)
  await open(page)
  await page.locator('.settings-nav-item').filter({ hasText: '일반' }).first().click()
  await expect(
    page.locator('.set-row').filter({ hasText: '잠자기 방지' }).first().locator('button[role="switch"], .ui-switch').first()
  ).toHaveAttribute('aria-checked', 'false')
})

test('permissions decide what an agent may do without asking', async () => {
  const { page } = riven
  await open(page)
  await page.locator('.settings-nav-item').filter({ hasText: '권한' }).first().click()
  const body = page.locator('.settings-body')
  // The tools are the CLI's own names, so what is switched here is what the
  // agent is actually launched with.
  for (const tool of ['Read', 'Edit', 'Bash', 'WebFetch']) {
    await expect(body).toContainText(tool)
  }
  await expect(body).toContainText('미리 허용할 도구')
  await expect(body).toContainText('확인 창')

  // Withholding a tool leaves it out of the allow-list rather than banning it.
  const bash = page.locator('.set-row').filter({ hasText: 'Bash' }).first()
  const toggle = bash.locator('button[role="switch"], .ui-switch').first()
  await expect(toggle).toHaveAttribute('aria-checked', 'true')
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-checked', 'false')
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-checked', 'true')
})
