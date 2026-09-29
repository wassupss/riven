import { create } from 'zustand'
import { useSession } from './session'

// The goal board: one shared object a group works a problem out on.
//
// Delegation gets an answer out of one agent. It does not accumulate: every
// exchange is a one-off, the next round starts by explaining everything again,
// and members never see each other's answers unless the lead relays them (which
// costs a second telling and loses what it summarises). So a team could talk,
// but it could not converge on anything.
//
// A goal is that missing object. Everyone posts to it, everyone reads it, and
// the user watches the same board in the panel. It is deliberately a LAYER over
// what is already here — the participants are the group roster, the asking is
// the existing delegation path (serialised per pane, answers tied to their
// turn), the visibility is the group timeline. Nothing here re-implements those.
//
// There is no round cap. By decision, nothing stops a goal automatically: the
// stop button and the running cost on screen are what stop it, so both have to
// be impossible to miss (see the panel).

export type PostKind = 'proposal' | 'critique' | 'revision' | 'vote' | 'note' | 'summary'
export type GoalStatus = 'open' | 'converged' | 'stopped'

export interface GoalPost {
  id: string
  round: number
  /** Pane key, or 'user' when the person put it there. */
  by: string
  kind: PostKind
  text: string
  at: number
}

export interface Goal {
  id: string
  ws: string
  group: string
  goal: string
  doneWhen: string
  /** Where the result should be written, if anywhere. */
  artifact?: string
  round: number
  status: GoalStatus
  posts: GoalPost[]
  /** What it has cost so far: agent turns spent on its rounds. */
  turns: number
  startedAt: number
  endedAt?: number
  /** The lead's closing words, once it declares the thing settled. */
  summary?: string
  /**
   * Per member (pane key): the id of the last post that member has been sent.
   * A member is a pane that keeps its conversation, so what it was sent last
   * round is still in its context — see boardUpdateFor.
   */
  sentUpTo?: Record<string, string>
}

/** A post is an argument, not a log line — but it still cannot be a novel. */
export const POST_CAP = 4000
/** Per goal. Old posts fall off rather than growing sessions.json without end. */
export const POSTS_KEPT = 300

export function clipPost(text: string, cap = POST_CAP): string {
  const t = text.trim()
  return t.length > cap ? t.slice(0, cap) + '\n…(잘림)' : t
}

export function addPost(goal: Goal, post: GoalPost, kept = POSTS_KEPT): Goal {
  const posts = [...goal.posts, post]
  return { ...goal, posts: posts.length > kept ? posts.slice(posts.length - kept) : posts }
}

/**
 * What a member needs to catch up, oldest first: every post, with who wrote it
 * and which round it belongs to. This is the shared context — the reason a
 * member does not have to be told what everyone else said.
 */
export function boardText(
  goal: Goal,
  nameOf: (paneKey: string) => string,
  maxChars = 0
): string {
  const head = boardHead(goal)
  if (!goal.posts.length) return `${head}\n\n(아직 올라온 글이 없습니다)`
  const posts = goal.posts.map((p) => postText(p, nameOf))
  if (maxChars <= 0) return `${head}\n\n${posts.join('\n\n')}`
  // Over budget, the OLDEST posts go first: the newest are what a round is
  // reacting to, and the head (goal, done-when) is never dropped.
  const kept: string[] = []
  let size = head.length
  for (let i = posts.length - 1; i >= 0; i--) {
    if (size + posts[i].length + 2 > maxChars && kept.length) break
    kept.unshift(posts[i])
    size += posts[i].length + 2
  }
  const dropped = posts.length - kept.length
  const gap = dropped ? `(앞선 글 ${dropped}개 생략)\n\n` : ''
  return `${head}\n\n${gap}${kept.join('\n\n')}`
}

function boardHead(goal: Goal): string {
  return [`목표: ${goal.goal}`, `끝나는 조건: ${goal.doneWhen}`, `라운드 ${goal.round} · ${goal.status}`].join('\n')
}

function postText(p: GoalPost, nameOf: (paneKey: string) => string): string {
  return `--- R${p.round} · ${nameOf(p.by)} · ${p.kind}\n${p.text}`
}

/** How much of the board goal_state hands back, in characters. */
export const BOARD_CAP = 20_000

/**
 * What one member needs this round: the whole board the first time, and after
 * that only what was posted since it was last sent the board.
 *
 * Every round used to send every member the entire board again. A member is a
 * pane that keeps its conversation, so the previous boards were already in its
 * context — each round re-sent all of them on top, and a goal's cost grew with
 * the square of its rounds. `lastId` is what to record as sent.
 *
 * If the member's context has since been compacted it may have lost the older
 * posts, so the update always says where the whole board is.
 */
export function boardUpdateFor(
  goal: Goal,
  member: string,
  nameOf: (paneKey: string) => string
): { text: string; lastId: string | null } {
  const lastId = goal.posts.at(-1)?.id ?? null
  const sent = goal.sentUpTo?.[member]
  const from = sent ? goal.posts.findIndex((p) => p.id === sent) : -1
  // Never sent, or what was sent has aged off the board: start from the top.
  if (!sent || from < 0) return { text: boardText(goal, nameOf, BOARD_CAP), lastId }
  // Its own posts are left out: it wrote them, and has them in full.
  const fresh = goal.posts.slice(from + 1).filter((p) => p.by !== member)
  const body = fresh.length
    ? `--- 지난번 이후 새 글 ${fresh.length}개\n\n${fresh.map((p) => postText(p, nameOf)).join('\n\n')}`
    : '(지난번 이후 새 글 없음)'
  const where = `(이전 글은 이미 받은 보드에 있습니다. 전체가 필요하면 riven_goal_state(goal_id="${goal.id}"))`
  return { text: `${boardHead(goal)}\n\n${body}\n\n${where}`, lastId }
}

interface State {
  byWorkspace: Record<string, Goal[]>
  start: (g: Omit<Goal, 'id' | 'round' | 'status' | 'posts' | 'turns' | 'startedAt'>) => string
  post: (id: string, post: Omit<GoalPost, 'id' | 'at'> & { at?: number }) => void
  openRound: (id: string) => number
  addTurns: (id: string, n: number) => void
  /** Record that `member` has been sent the board up to post `postId`. */
  markSent: (id: string, member: string, postId: string | null) => void
  finish: (id: string, summary: string) => void
  stop: (id: string) => void
  remove: (id: string) => void
}

let seq = 0
const uid = (p: string): string => `${p}${Date.now().toString(36)}${(++seq).toString(36)}`

function persist(ws: string): void {
  adopt()
  const st = useSession.getState()
  if (!st.ready) return // never write over goals still being loaded
  st.patch(ws, { goals: useGoals.getState().byWorkspace[ws] ?? [] })
}

let adopted = false
function adopt(): void {
  if (adopted) return
  const st = useSession.getState()
  if (!st.ready) return
  adopted = true
  const byWorkspace: Record<string, Goal[]> = {}
  for (const [ws, s] of Object.entries(st.sessions)) {
    const goals = (s.goals ?? []) as Goal[]
    // A round that was mid-flight when the app closed has no loop behind it any
    // more, so the board says so rather than showing work that is not happening.
    if (goals.length) byWorkspace[ws] = goals
  }
  if (Object.keys(byWorkspace).length) useGoals.setState({ byWorkspace })
}

function edit(id: string, fn: (g: Goal) => Goal): void {
  let ws: string | null = null
  useGoals.setState((s) => {
    const next: Record<string, Goal[]> = { ...s.byWorkspace }
    for (const [w, list] of Object.entries(next)) {
      if (!list.some((g) => g.id === id)) continue
      ws = w
      next[w] = list.map((g) => (g.id === id ? fn(g) : g))
    }
    return { byWorkspace: next }
  })
  if (ws) persist(ws)
}

export const useGoals = create<State>((set) => ({
  byWorkspace: {},

  start: (g) => {
    const goal: Goal = {
      ...g,
      id: uid('goal_'),
      round: 0,
      status: 'open',
      posts: [],
      turns: 0,
      startedAt: Date.now()
    }
    set((s) => ({
      byWorkspace: { ...s.byWorkspace, [g.ws]: [...(s.byWorkspace[g.ws] ?? []), goal] }
    }))
    persist(g.ws)
    return goal.id
  },

  post: (id, p) =>
    edit(id, (g) =>
      addPost(g, { ...p, text: clipPost(p.text), id: uid('p'), at: p.at ?? Date.now() })
    ),

  openRound: (id) => {
    let round = 0
    edit(id, (g) => {
      round = g.round + 1
      return { ...g, round }
    })
    return round
  },

  addTurns: (id, n) => edit(id, (g) => ({ ...g, turns: g.turns + Math.max(0, n) })),

  markSent: (id, member, postId) =>
    edit(id, (g) => (postId ? { ...g, sentUpTo: { ...g.sentUpTo, [member]: postId } } : g)),

  finish: (id, summary) =>
    edit(id, (g) => ({ ...g, status: 'converged', summary, endedAt: Date.now() })),

  stop: (id) => edit(id, (g) => (g.status === 'open' ? { ...g, status: 'stopped', endedAt: Date.now() } : g)),

  remove: (id) => {
    let ws: string | null = null
    set((s) => {
      const next: Record<string, Goal[]> = { ...s.byWorkspace }
      for (const [w, list] of Object.entries(next)) {
        if (!list.some((g) => g.id === id)) continue
        ws = w
        next[w] = list.filter((g) => g.id !== id)
      }
      return { byWorkspace: next }
    })
    if (ws) persist(ws)
  }
}))

useSession.subscribe(adopt)
adopt()

export function goalsFor(ws: string): Goal[] {
  return useGoals.getState().byWorkspace[ws] ?? []
}

export function findGoal(id: string): Goal | null {
  for (const list of Object.values(useGoals.getState().byWorkspace)) {
    const g = list.find((x) => x.id === id)
    if (g) return g
  }
  return null
}
