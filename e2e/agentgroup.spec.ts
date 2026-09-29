import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { launchRiven, openPanel } from './app'

// Agent groups: the org chart the panel draws for a saved team. The group is
// seeded rather than built through the UI — building one opens a pane per
// member, and what matters here is the shape of the team and that it survives,
// not the agents behind it.
//
// The panel opens on its builder ("새 그룹"); saved groups are the tabs beside it.

const GROUP = {
  group: '리서치팀',
  members: [
    { name: '지휘', chatKey: 'chat-lead', parent: null },
    { name: '조사원', chatKey: 'chat-a', parent: 0 },
    { name: '검증자', chatKey: 'chat-b', parent: 0 }
  ]
}

async function openGroup(page: import('@playwright/test').Page, name: string): Promise<void> {
  await openPanel(page, '에이전트 그룹')
  await page.locator('.agp-tab').filter({ hasText: name }).click()
  await page.waitForSelector('.agp-chartwrap')
}

test.describe('agent groups', () => {
  test('a saved team is a tab, and the tab counts its members', async () => {
    const r = await launchRiven({ files: { 'README.md': '# s\n' }, groups: [GROUP] })
    await openPanel(r.page, '에이전트 그룹')
    const tab = r.page.locator('.agp-tab').filter({ hasText: '리서치팀' })
    await expect(tab).toHaveCount(1)
    await expect(tab.locator('.agp-tab-count')).toHaveText('3')
    await r.app.close()
  })

  test('the chart draws every member, and marks the one with no parent as lead', async () => {
    const r = await launchRiven({ files: { 'README.md': '# s\n' }, groups: [GROUP] })
    await openGroup(r.page, '리서치팀')
    for (const name of ['지휘', '조사원', '검증자']) {
      await expect(r.page.locator('.agp-node-name').filter({ hasText: name })).toHaveCount(1)
    }
    const lead = r.page.locator('.agp-node', {
      has: r.page.locator('.agp-node-name', { hasText: '지휘' })
    })
    await expect(lead).toHaveClass(/agp-main/)
    await expect(lead.locator('.agp-node-badge')).toBeVisible()
    await r.app.close()
  })

  test('members hang off their lead, not off the root', async () => {
    const r = await launchRiven({ files: { 'README.md': '# s\n' }, groups: [GROUP] })
    await openGroup(r.page, '리서치팀')
    // Structure, not pixels: the chart branches sideways, so "reports to" is the
    // member sitting inside the lead row's children — which is what the parent
    // index in the saved group means.
    const leadRow = r.page.locator('.agp-tree-row', { has: r.page.locator('.agp-node.agp-main') }).first()
    const kids = leadRow.locator('.agp-tree-kids .agp-node-name')
    await expect(kids).toHaveCount(2)
    await expect(kids.filter({ hasText: '조사원' })).toHaveCount(1)
    await expect(kids.filter({ hasText: '검증자' })).toHaveCount(1)
    await r.app.close()
  })

  test('a member whose pane is not open says so, rather than looking live', async () => {
    const r = await launchRiven({ files: { 'README.md': '# s\n' }, groups: [GROUP] })
    await openGroup(r.page, '리서치팀')
    await expect(r.page.locator('.agp-node-state.closed').first()).toContainText('닫힘')
    await r.app.close()
  })

  test('the team can be addressed as a lead or as one member', async () => {
    const r = await launchRiven({ files: { 'README.md': '# s\n' }, groups: [GROUP] })
    await openGroup(r.page, '리서치팀')
    await expect(r.page.locator('.agp-talk-to .agp-chip').filter({ hasText: '지휘' })).toHaveClass(/on/)
    await r.page.locator('.agp-talk-to .agp-chip').filter({ hasText: '검증자' }).click()
    await expect(r.page.locator('.agp-talk-to .agp-chip').filter({ hasText: '검증자' })).toHaveClass(/on/)
    await r.app.close()
  })

  test('a workspace with no team has nothing but the builder', async () => {
    const r = await launchRiven({ files: { 'README.md': '# s\n' } })
    await openPanel(r.page, '에이전트 그룹')
    await expect(r.page.locator('.agp-tab')).toHaveCount(1)
    await expect(r.page.locator('.agp-tab')).toHaveText('새 그룹')
    await r.app.close()
  })

  test('two teams stay two teams', async () => {
    const r = await launchRiven({
      files: { 'README.md': '# s\n' },
      groups: [GROUP, { group: '배포팀', members: [{ name: '릴리스', chatKey: 'chat-rel', parent: null }] }]
    })
    await openPanel(r.page, '에이전트 그룹')
    await expect(r.page.locator('.agp-tab')).toHaveCount(3) // builder + two teams
    await openGroup(r.page, '배포팀')
    await expect(r.page.locator('.agp-node-name').filter({ hasText: '릴리스' })).toHaveCount(1)
    await expect(r.page.locator('.agp-node-name').filter({ hasText: '지휘' })).toHaveCount(0)
    await r.app.close()
  })

  test('a team survives a restart', async () => {
    const first = await launchRiven({ files: { 'README.md': '# s\n' }, groups: [GROUP] })
    await first.app.close()
    const second = await launchRiven({ userDataDir: first.userDataDir, workspace: first.workspace })
    await openGroup(second.page, '리서치팀')
    await expect(second.page.locator('.agp-node-name').filter({ hasText: '검증자' })).toHaveCount(1)
    await second.app.close()
  })
})

test('a closed member comes back with its own conversation, not a blank one', async () => {
  // What a member did is the team's work: closing its pane must not lose it.
  const said = (role: 'user' | 'assistant', text: string): Record<string, unknown> => ({
    role,
    text,
    tools: [],
    items: [{ type: 'text', text }],
    done: true,
    interrupted: false,
    startedAt: 1
  })
  const r = await launchRiven({
    files: { 'README.md': '# s\n' },
    groups: [GROUP],
    panes: {
      'chat-a': {
        session: '11111111-2222-3333-4444-555555555555',
        title: '조사원 · 리서치팀',
        log: [said('user', '경쟁사 세 곳 조사해줘'), said('assistant', '조사 결과: A사는 가격이 가장 낮다')]
      }
    }
  })
  await openGroup(r.page, '리서치팀')
  await r.page.locator('.agp-node', { has: r.page.locator('.agp-node-name', { hasText: '조사원' }) }).click()
  await expect(r.page.getByText('조사 결과: A사는 가격이 가장 낮다')).toBeVisible({ timeout: 15_000 })
  // Same pane, not a replacement: the member still points at it.
  const disk = JSON.parse(readFileSync(join(r.userDataDir, 'sessions.json'), 'utf8'))
  expect(disk.sessions[r.workspace].groups[0].members[1].chatKey).toBe('chat-a')
  await r.app.close()
})

test('members whose panes are open read as open, including after a restart', async () => {
  // The chart used to ask whichever dock was "active" whether a member's pane
  // existed, and only looked again when an agent's status changed. Restored
  // with the window, the panes were there and every card still said closed.
  const said = (role: 'user' | 'assistant', text: string): Record<string, unknown> => ({
    role,
    text,
    tools: [],
    items: [{ type: 'text', text }],
    done: true,
    interrupted: false,
    startedAt: 1
  })
  const pane = (title: string): Record<string, unknown> => ({
    session: '11111111-2222-3333-4444-55555555555' + title.length,
    title,
    log: [said('user', 'hi'), said('assistant', 'hello')]
  })
  const first = await launchRiven({
    files: { 'README.md': '# s\n' },
    groups: [GROUP],
    panes: {
      'chat-lead': pane('지휘 · 리서치팀'),
      'chat-a': pane('조사원 · 리서치팀'),
      'chat-b': pane('검증자 · 리서치팀')
    }
  })
  await openGroup(first.page, '리서치팀')
  for (const name of ['지휘', '조사원', '검증자']) {
    await first.page.locator('.agp-node', { has: first.page.locator('.agp-node-name', { hasText: name }) }).click()
    await expect(first.page.locator('.dv-tab').filter({ hasText: name })).toHaveCount(1, { timeout: 15_000 })
  }
  await openGroup(first.page, '리서치팀')
  await expect(first.page.locator('.agp-node-state.closed')).toHaveCount(0)
  await first.page.waitForTimeout(1500) // let the layout save
  await first.app.close()

  const second = await launchRiven({ userDataDir: first.userDataDir, workspace: first.workspace })
  await expect(second.page.locator('.dv-tab').filter({ hasText: '검증자' })).toHaveCount(1, { timeout: 15_000 })
  await openGroup(second.page, '리서치팀')
  await expect(second.page.locator('.agp-node')).toHaveCount(3)
  await expect(second.page.locator('.agp-node-state.closed')).toHaveCount(0)
  await second.app.close()
})

test('the chart still knows its members are open after another workspace was on screen', async () => {
  const said = (role: 'user' | 'assistant', text: string): Record<string, unknown> => ({
    role,
    text,
    tools: [],
    items: [{ type: 'text', text }],
    done: true,
    interrupted: false,
    startedAt: 1
  })
  const r = await launchRiven({
    files: { 'README.md': '# s\n' },
    groups: [GROUP],
    extraWorkspaces: 1,
    panes: {
      'chat-a': {
        session: '11111111-2222-3333-4444-555555555555',
        title: '조사원 · 리서치팀',
        log: [said('user', 'hi'), said('assistant', 'hello')]
      }
    }
  })
  await openGroup(r.page, '리서치팀')
  const member = r.page.locator('.agp-node', { has: r.page.locator('.agp-node-name', { hasText: '조사원' }) })
  await member.click()
  await expect(r.page.locator('.dv-tab').filter({ hasText: '조사원' })).toHaveCount(1, { timeout: 15_000 })
  await openGroup(r.page, '리서치팀')
  await expect(member.locator('.agp-node-state')).not.toHaveClass(/closed/)

  // Over in the other workspace, an agent comes and goes — the kind of change
  // that makes every team chart in the window draw itself again.
  await r.page.locator('.ws-card').nth(1).click()
  await r.page.keyboard.press('Meta+Shift+a')
  await expect(r.page.locator('.chat-composer')).toHaveCount(2, { timeout: 15_000 })
  await r.page.waitForTimeout(500)

  await r.page.locator('.ws-card').nth(0).click()
  await expect(member.locator('.agp-node-state')).not.toHaveClass(/closed/)
  await r.app.close()
})
