import { describe, it, expect, vi } from 'vitest'

vi.mock('./session', () => ({
  useSession: { getState: () => ({ patch: vi.fn(), ready: true, sessions: {} }), subscribe: vi.fn() }
}))

const { clipPost, addPost, boardText, POSTS_KEPT, useGoals } = await import('./goals')
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
