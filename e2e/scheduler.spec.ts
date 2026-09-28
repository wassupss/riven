import { test, expect } from '@playwright/test'
import { launchRiven, type Launched } from './app'

// Scheduling, end to end, through the UI a person uses: the rail row, the menu
// it opens, the form inside it, and the panel that manages what exists.
//
// Nothing here spawns an agent — every job is scheduled for a time that will not
// arrive during the test — so the suite costs nothing to run.

let riven: Launched

test.beforeAll(async () => {
  riven = await launchRiven()
})

test.afterAll(async () => {
  await riven.app.close()
})

test('the rail offers scheduled work before anything is scheduled', async () => {
  const { page } = riven
  const row = page.locator('.ws-sched-row')
  await expect(row).toHaveCount(1)
  await expect(row).toContainText('예약 작업')

  await row.click()
  await expect(page.locator('.sched-menu')).toBeVisible()
  await expect(page.locator('.sched-menu-empty')).toContainText('동작 중인 예약이 없습니다')
  await page.locator('.sched-menu-scrim').click()
  await expect(page.locator('.sched-menu')).toHaveCount(0)
})

test('a schedule is created from the rail, without opening a panel', async () => {
  const { page } = riven
  await expect(page.locator('.ws-card')).toHaveCount(1)

  await page.locator('.ws-sched-row').click()
  await page.getByRole('button', { name: '새 예약' }).click()

  const form = page.locator('.sched-menu .sf')
  await expect(form).toBeVisible()
  await form.locator('.sf-prompt').fill('어제 바뀐 것 요약해줘')
  // Six rules, chosen as chips — the form's whole point.
  await expect(form.locator('.sf-chip')).toHaveCount(6)
  await form.getByRole('button', { name: '평일' }).click()
  await form.locator('.sf-time').fill('08:30')
  await expect(form.locator('.sf-preview')).toContainText('평일 08:30')

  await form.getByRole('button', { name: '저장' }).click()
  await expect(page.locator('.sched-menu')).toHaveCount(0)
  // The row now reports what is pending instead of asking to be used.
  await expect(page.locator('.ws-sched-row')).toContainText('예약 작업')

  // What the panel says it saved, read where the user reads it.
  await page.locator('.ws-sched-row').click()
  await page.getByRole('button', { name: '예약 관리' }).click()
  const row = page.locator('.sched-item')
  await expect(row).toContainText('어제 바뀐 것 요약해줘')
  await expect(row).toContainText('평일 08:30')
  await expect(row).toContainText('새 채팅 패널')
})

test('an existing schedule is edited, not rebuilt', async () => {
  const { page } = riven
  const row = page.locator('.sched-item')
  await expect(row).toHaveCount(1)
  await row.getByTitle('수정').click()
  const form = page.locator('.sched-formwrap .sf')
  // Prefilled: editing means changing what is there, not typing it again.
  await expect(form.locator('.sf-prompt')).toHaveValue('어제 바뀐 것 요약해줘')
  await expect(form.locator('.sf-time')).toHaveValue('08:30')
  await form.locator('.sf-time').fill('07:15')
  await form.getByRole('button', { name: '수정 저장' }).click()

  await expect(page.locator('.sched-item')).toContainText('평일 07:15')
})

test('a schedule can be paused and deleted', async () => {
  const { page } = riven
  const row = page.locator('.sched-item')
  await row.locator('.sched-toggle').click()
  await expect(row).toHaveClass(/off/)
  await expect(row).toContainText('멈춤')

  await row.getByTitle('삭제').click()
  await expect(page.locator('.sched-item')).toHaveCount(0)
  await expect(page.locator('.sched-empty')).toBeVisible()
})
