import { test, expect } from '@playwright/test'
import { launchRiven, openPanel, type Launched } from './app'

// What survives a restart. riven's whole premise is that you come back to where
// you were — the layout, the schedule, the settings — and the only honest way
// to check that is to close the app and open it again on the same profile.

let first: Launched

test.afterAll(async () => {
  // The second launch is closed inside the test; this catches an early failure.
  await first?.app.close().catch(() => {})
})

test('layout, schedules and settings all come back', async () => {
  first = await launchRiven({ files: { 'README.md': '# sample\n' } })
  const { page, userDataDir, workspace } = first

  // 1. A panel that was open.
  await openPanel(page, '메모')
  await expect(page.locator('.dv-tab').filter({ hasText: '메모' })).toHaveCount(1)

  // 2. A schedule.
  await page.locator('.ws-sched-row').click()
  await page.getByRole('button', { name: '새 예약' }).click()
  const form = page.locator('.sched-menu .sf')
  await form.locator('.sf-prompt').fill('재시작 후에도 남아야 함')
  await form.getByRole('button', { name: '매일' }).click()
  await form.locator('.sf-time').fill('06:45')
  await form.getByRole('button', { name: '저장' }).click()
  await expect(page.locator('.sched-menu')).toHaveCount(0)

  // 3. A setting.
  await page.keyboard.press('Meta+,')
  await page.locator('.settings-nav-item').filter({ hasText: '일반' }).first().click()
  const keepAwake = page
    .locator('.set-row')
    .filter({ hasText: '잠자기 방지' })
    .locator('button[role="switch"], .ui-switch')
    .first()
  await keepAwake.click()
  await expect(keepAwake).toHaveAttribute('aria-checked', 'false')
  await page.keyboard.press('Escape')

  // Give the session tree its debounced write before pulling the plug.
  await page.waitForTimeout(1200)
  await first.app.close()

  // Same profile, same folder: this is a restart, not a fresh install.
  const second = await launchRiven({ userDataDir, workspace })
  try {
    await expect(second.page.locator('.dv-tab').filter({ hasText: '메모' })).toHaveCount(1)

    await second.page.locator('.ws-sched-row').click()
    await second.page.getByRole('button', { name: '예약 관리' }).click()
    const row = second.page.locator('.sched-item')
    await expect(row).toContainText('재시작 후에도 남아야 함')
    await expect(row).toContainText('매일 06:45')

    await second.page.keyboard.press('Meta+,')
    await second.page.locator('.settings-nav-item').filter({ hasText: '일반' }).first().click()
    await expect(
      second.page
        .locator('.set-row')
        .filter({ hasText: '잠자기 방지' })
        .locator('button[role="switch"], .ui-switch')
        .first()
    ).toHaveAttribute('aria-checked', 'false')
  } finally {
    await second.app.close()
  }
})
