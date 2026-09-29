import { describe, it, expect, vi } from 'vitest'

vi.mock('./session', () => ({
  useSession: { getState: () => ({ patch: vi.fn(), ready: true, sessions: {} }), subscribe: vi.fn() }
}))

const { clipPost, addPost, boardText, boardUpdateFor, POSTS_KEPT, useGoals } = await import('./goals')
type Goal = Awaited<ReturnType<typeof import('./goals')['findGoal']>> & object
type Post = Goal['posts'][number]

const goal = (over: Record<string, unknown> = {}): Goal =>
  ({
    id: 'g1',
    ws: '/w',
    group: 'team',
    goal: '알림 방식을 정한다',
    doneWhen: '하나로 합의되고 근거가 적혀 있을 때',
    round: 2,
    status: 'open',
    posts: [],
    turns: 0,
    startedAt: 0,
    ...over
  }) as Goal

const post = (n: number, by = 'chat-1'): Post =>
  ({ id: `p${n}`, round: 1, by, kind: 'proposal', text: `안 ${n}`, at: n }) as Post

describe('clipPost', () => {
  it('keeps an argument whole', () => {
    expect(clipPost('  두 줄\n짜리 주장  ')).toBe('두 줄\n짜리 주장')
  })

  it('cuts one that would fill the board, and says it cut it', () => {
    const out = clipPost('x'.repeat(5000))
    expect(out.length).toBeLessThan(5000)
    expect(out.endsWith('(잘림)')).toBe(true)
  })
})

describe('addPost', () => {
  it('drops the oldest once the board is full', () => {
    let g = goal()
    for (let i = 0; i < POSTS_KEPT + 3; i++) g = addPost(g, post(i))
    expect(g.posts.length).toBe(POSTS_KEPT)
    expect(g.posts[0].text).toBe('안 3')
  })
})

describe('boardText', () => {
  const nameOf = (k: string): string => (k === 'user' ? '나' : k === 'chat-1' ? '설계' : '구현')

  it('is what a member needs to catch up: the goal, the bar, and who said what', () => {
    const g = addPost(addPost(goal(), post(1, 'chat-1')), post(2, 'chat-2'))
    const text = boardText(g, nameOf)
    expect(text).toContain('목표: 알림 방식을 정한다')
    expect(text).toContain('끝나는 조건: 하나로 합의되고')
    expect(text).toContain('R1 · 설계 · proposal')
    expect(text).toContain('R1 · 구현 · proposal')
  })

  it('says so when nothing has been posted yet', () => {
    expect(boardText(goal(), nameOf)).toContain('아직 올라온 글이 없습니다')
  })
})

describe('the store', () => {
  it('counts rounds and turns, and can be stopped once', () => {
    const id = useGoals.getState().start({ ws: '/w', group: 'team', goal: 'g', doneWhen: 'd' })
    expect(useGoals.getState().openRound(id)).toBe(1)
    expect(useGoals.getState().openRound(id)).toBe(2)
    useGoals.getState().addTurns(id, 3)
    useGoals.getState().stop(id)
    const g = useGoals.getState().byWorkspace['/w'].find((x) => x.id === id)
    expect({ round: g?.round, turns: g?.turns, status: g?.status }).toEqual({
      round: 2,
      turns: 3,
      status: 'stopped'
    })
    // A stopped goal is not re-stamped by a second stop.
    const endedAt = g?.endedAt
    useGoals.getState().stop(id)
    expect(useGoals.getState().byWorkspace['/w'].find((x) => x.id === id)?.endedAt).toBe(endedAt)
  })
})

describe('boardUpdateFor', () => {
  const nameOf = (k: string): string => ({ 'chat-1': '가', 'chat-2': '나', 'chat-3': '다' })[k] ?? k

  it('sends a member the whole board the first time', () => {
    const g = goal({ posts: [post(1, 'chat-1'), post(2, 'chat-2')] })
    const { text, lastId } = boardUpdateFor(g, 'chat-3', nameOf)
    expect(text).toContain('안 1')
    expect(text).toContain('안 2')
    expect(lastId).toBe('p2')
  })

  it('after that, only what is new — and never its own posts back', () => {
    const g = goal({
      posts: [post(1, 'chat-1'), post(2, 'chat-2'), post(3, 'chat-3'), post(4, 'chat-1')],
      sentUpTo: { 'chat-3': 'p2' }
    })
    const { text, lastId } = boardUpdateFor(g, 'chat-3', nameOf)
    expect(text).not.toContain('안 1') // already had it
    expect(text).not.toContain('안 3') // wrote it itself
    expect(text).toContain('안 4')
    expect(text).toContain('riven_goal_state') // where the rest is, if it forgot
    expect(lastId).toBe('p4')
  })

  it('starts over when what it was sent has aged off the board', () => {
    const g = goal({ posts: [post(9, 'chat-1')], sentUpTo: { 'chat-3': 'p1' } })
    expect(boardUpdateFor(g, 'chat-3', nameOf).text).toContain('안 9')
    expect(boardUpdateFor(g, 'chat-3', nameOf).text).not.toContain('지난번 이후')
  })

  it('grows with the round, not with the whole history', () => {
    // Five members, ten rounds of 1,000-character posts. The old way sent each
    // member the whole board every round.
    let g = goal()
    const members = ['m1', 'm2', 'm3', 'm4', 'm5']
    let sentNow = 0
    let sentBefore = 0
    let n = 0
    for (let r = 1; r <= 10; r++) {
      for (const m of members) {
        const u = boardUpdateFor(g, m, (k) => k)
        sentNow += u.text.length
        sentBefore += boardText(g, (k) => k).length
        if (u.lastId) g = { ...g, sentUpTo: { ...g.sentUpTo, [m]: u.lastId } }
      }
      for (const m of members) g = addPost(g, { ...post(++n, m), text: 'x'.repeat(1000) })
    }
    expect(sentNow).toBeLessThan(sentBefore / 3)
  })
})

describe('boardText with a budget', () => {
  it('drops the oldest posts first and says how many, keeping the head', () => {
    const g = goal({ posts: Array.from({ length: 30 }, (_, i) => ({ ...post(i), text: 'y'.repeat(900) })) })
    const t = boardText(g, (k) => k, 5000)
    expect(t.length).toBeLessThanOrEqual(5000)
    expect(t).toContain('알림 방식을 정한다')
    expect(t).toMatch(/앞선 글 \d+개 생략/)
    expect(t).toContain('R1 · chat-1')
  })
})
