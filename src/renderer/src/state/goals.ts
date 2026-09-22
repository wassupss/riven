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
export function boardText(goal: Goal, nameOf: (paneKey: string) => string): string {
  const head = [
    `목표: ${goal.goal}`,
    `끝나는 조건: ${goal.doneWhen}`,
    `라운드 ${goal.round} · ${goal.status}`
  ].join('\n')
  if (!goal.posts.length) return `${head}\n\n(아직 올라온 글이 없습니다)`
  const body = goal.posts
    .map((p) => `--- R${p.round} · ${nameOf(p.by)} · ${p.kind}\n${p.text}`)
    .join('\n\n')
  return `${head}\n\n${body}`
}

interface State {
  byWorkspace: Record<string, Goal[]>
  start: (g: Omit<Goal, 'id' | 'round' | 'status' | 'posts' | 'turns' | 'startedAt'>) => string
  post: (id: string, post: Omit<GoalPost, 'id' | 'at'> & { at?: number }) => void
  openRound: (id: string) => number
  addTurns: (id: string, n: number) => void
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
