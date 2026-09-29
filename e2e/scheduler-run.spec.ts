import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchRiven } from './app'

// The scheduler actually firing — the half the create/edit tests cannot reach,
// because the form only makes jobs in the future. These seed the job instead, so
// a run can be watched happening.
//
// The runner settles for 8s before its first tick, on purpose (panes are still
// being restored), so these tests are slow by design rather than by accident.

const SETTLED = 25_000

function jobsOnDisk(userDataDir: string, workspace: string): Array<Record<string, any>> {
  const data = JSON.parse(readFileSync(join(userDataDir, 'sessions.json'), 'utf8'))
  return data.sessions?.[workspace]?.jobs ?? []
}

async function openScheduler(page: import('@playwright/test').Page): Promise<void> {
  await page.locator('.ws-sched-row').click()
  await page.getByRole('button', { name: '예약 관리' }).click()
  await page.waitForSelector('.sched-main')
}

test.describe('scheduled work runs', () => {
  test('a job that is due runs, and the run is written down', async () => {
    const r = await launchRiven({
      files: { 'README.md': '# s\n' },
      jobs: [
        {
          id: 'job_due',
          name: '지금 할 일',
          prompt: '이건 예약이 실행됐다는 증거',
          // Two minutes ago, inside the default hour of grace.
          trigger: { kind: 'once', at: Date.now() - 120_000 }
        }
      ]
    })
    // The run opens a fresh chat pane carrying the job's prompt as its first
    // message. No agent answers it here (the CLI is withheld under RIVEN_E2E),
    // which is fine: what is being tested is that the schedule fired.
    await expect(r.page.locator('.chat-user-bubble')).toContainText('이건 예약이 실행됐다는 증거', {
      timeout: SETTLED
    })
    await expect
      .poll(() => jobsOnDisk(r.userDataDir, r.workspace)[0]?.runs?.length ?? 0, { timeout: 15_000 })
      .toBe(1)
    await r.app.close()
  })

  test('a one-shot switches itself off after it has run', async () => {
    const r = await launchRiven({
      files: { 'README.md': '# s\n' },
      jobs: [
        {
          id: 'job_once',
          name: '한 번만',
          prompt: '한 번만 실행',
          trigger: { kind: 'once', at: Date.now() - 60_000 }
        }
      ]
    })
    await expect
      .poll(() => jobsOnDisk(r.userDataDir, r.workspace)[0]?.enabled, { timeout: SETTLED })
      .toBe(false)
    await openScheduler(r.page)
    await expect(r.page.locator('.sched-meta').first()).toContainText('멈춤')
    await r.app.close()
  })

  test('a slot that passed while riven was closed is reported, not silently skipped', async () => {
    const r = await launchRiven({
      files: { 'README.md': '# s\n' },
      jobs: [
        {
          id: 'job_missed',
          name: '놓친 일',
          prompt: '아침 요약',
          // Daily, and the last run was days ago: the slot in between is long
          // past the grace window, so it cannot be run now — only reported.
          trigger: { kind: 'daily', hour: 9, minute: 0 },
          graceMinutes: 30,
          createdAt: Date.now() - 7 * 86_400_000,
          lastRunAt: Date.now() - 3 * 86_400_000
        }
      ]
    })
    await expect
      .poll(
        () => jobsOnDisk(r.userDataDir, r.workspace)[0]?.runs?.some((x: any) => x.status === 'missed'),
        { timeout: SETTLED }
      )
      .toBe(true)
    await openScheduler(r.page)
    await expect(r.page.locator('.sched-warn').first()).toBeVisible()
    // Reported once and then left alone: the clock moved past the slot, so the
    // next tick must not find the same miss again.
    const first = jobsOnDisk(r.userDataDir, r.workspace)[0].runs.length
    await r.page.waitForTimeout(22_000) // one more tick
    expect(jobsOnDisk(r.userDataDir, r.workspace)[0].runs.length).toBe(first)
    await r.app.close()
  })

  test('a paused job stays paused when its time comes', async () => {
    const r = await launchRiven({
      files: { 'README.md': '# s\n' },
      jobs: [
        {
          id: 'job_off',
          name: '꺼둔 일',
          prompt: '실행되면 안 됨',
          trigger: { kind: 'once', at: Date.now() - 60_000 },
          enabled: false
        }
      ]
    })
    await r.page.waitForTimeout(SETTLED)
    expect(jobsOnDisk(r.userDataDir, r.workspace)[0].runs).toHaveLength(0)
    await expect(r.page.locator('.chat-user-bubble')).toHaveCount(0)
    await r.app.close()
  })

  test('a job aimed at a pane that is gone fails loudly rather than vanishing', async () => {
    const r = await launchRiven({
      files: { 'README.md': '# s\n' },
      jobs: [
        {
          id: 'job_pane',
          name: '없는 패널로',
          prompt: '아무도 못 받는 메시지',
          trigger: { kind: 'once', at: Date.now() - 60_000 },
          target: { kind: 'pane', chatKey: 'chat-gone', title: '사라진 패널' }
        }
      ]
    })
    await expect
      .poll(() => jobsOnDisk(r.userDataDir, r.workspace)[0]?.runs?.[0]?.status, { timeout: SETTLED })
      .toBe('failed')
    await openScheduler(r.page)
    await expect(r.page.locator('.sched-warn').first()).toContainText('사라진 패널')
    await r.app.close()
  })
})
