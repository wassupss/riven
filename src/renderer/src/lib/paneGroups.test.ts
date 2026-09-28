import { describe, expect, it } from 'vitest'
import { groupPanes, stripGroup } from './paneGroups'

const pane = (id: string): { id: string } => ({ id })
const group = (name: string, ...keys: string[]): { group: string; members: Array<{ chatKey: string }> } => ({
  group: name,
  members: keys.map((chatKey) => ({ chatKey }))
})

describe('groupPanes', () => {
  it('collects a team together and leaves everything else alone', () => {
    const { groups, loose } = groupPanes(
      [pane('a'), pane('lead'), pane('m1'), pane('b'), pane('m2')],
      [group('팀', 'lead', 'm1', 'm2')]
    )
    expect(groups).toEqual([{ name: '팀', panes: [pane('lead'), pane('m1'), pane('m2')] }])
    expect(loose).toEqual([pane('a'), pane('b')])
  })

  it('keeps the rail order, not the group roster order', () => {
    // The rail is a list of what is OPEN; a group appears where its panes are.
    const { groups } = groupPanes(
      [pane('b1'), pane('a1')],
      [group('A', 'a1'), group('B', 'b1')]
    )
    expect(groups.map((g) => g.name)).toEqual(['B', 'A'])
  })

  it('drops a group whose panes are all closed', () => {
    const { groups, loose } = groupPanes([pane('x')], [group('사라진 팀', 'gone1', 'gone2')])
    expect(groups).toEqual([])
    expect(loose).toEqual([pane('x')])
  })

  it('lists a pane once when two groups claim it', () => {
    const { groups } = groupPanes([pane('shared')], [group('첫째', 'shared'), group('둘째', 'shared')])
    expect(groups).toEqual([{ name: '첫째', panes: [pane('shared')] }])
  })

  it('is a plain list when there are no groups', () => {
    const { groups, loose } = groupPanes([pane('a'), pane('b')], [])
    expect(groups).toEqual([])
    expect(loose).toHaveLength(2)
  })
})

describe('stripGroup', () => {
  it('drops the group segment a group header already says', () => {
    expect(stripGroup('멤버1 · 팀 · 점심메뉴 추천', '팀')).toBe('멤버1 · 점심메뉴 추천')
  })

  it('keeps a member whose own NAME is the group name', () => {
    expect(stripGroup('팀 · 팀 · 회의록', '팀')).toBe('팀 · 회의록')
  })

  it('leaves a plain title alone', () => {
    expect(stripGroup('채팅', '팀')).toBe('채팅')
    expect(stripGroup('리드 · 회의록', '다른팀')).toBe('리드 · 회의록')
  })
})
