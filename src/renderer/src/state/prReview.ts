import { create } from 'zustand'

// The review you are in the middle of writing.
//
// Comments can be started in two places — the PR panel's inline diff and a
// full diff editor tab — and they are ONE review: GitHub submits a review with
// all of its comments in a single call, so they cannot live in whichever
// component happened to create them. A panel that unmounts (tab switch, another
// workspace) must not take half of a review with it either.
//
// Keyed by repo + PR, so reviewing two PRs at once keeps them apart.

export interface DraftComment {
  path: string
  // Line in the file as the PR leaves it (RIGHT) or as it was (LEFT).
  line: number
  side: 'LEFT' | 'RIGHT'
  body: string
}

export interface ThreadLite {
  id: string
  path: string
  line: number | null
  originalLine: number | null
  diffSide: 'LEFT' | 'RIGHT'
  isResolved: boolean
  isOutdated: boolean
  comments: Array<{ author: string; body: string }>
}

interface PrReviewState {
  drafts: Record<string, DraftComment[]>
  // Published threads, put here by whoever loaded the PR so a diff editor can
  // show them without fetching the PR a second time.
  threads: Record<string, ThreadLite[]>
  addDraft: (key: string, d: DraftComment) => void
  removeDraft: (key: string, index: number) => void
  clearDrafts: (key: string) => void
  setThreads: (key: string, threads: ThreadLite[]) => void
}

export const prKey = (repo: string, number: number): string => `${repo}#${number}`

export const usePrReview = create<PrReviewState>((set) => ({
  drafts: {},
  threads: {},
  addDraft: (key, d) =>
    set((s) => ({ drafts: { ...s.drafts, [key]: [...(s.drafts[key] ?? []), d] } })),
  removeDraft: (key, index) =>
    set((s) => ({ drafts: { ...s.drafts, [key]: (s.drafts[key] ?? []).filter((_, i) => i !== index) } })),
  clearDrafts: (key) =>
    set((s) => {
      if (!s.drafts[key]?.length) return s
      const drafts = { ...s.drafts }
      delete drafts[key]
      return { drafts }
    }),
  setThreads: (key, threads) => set((s) => ({ threads: { ...s.threads, [key]: threads } }))
}))

// One PR's pending comments. Selecting the whole record and narrowing here
// keeps zustand from handing React a fresh array every render (see the same
// trap in ChangesPanel: Object.is on a new array re-renders forever).
export function draftsFor(drafts: Record<string, DraftComment[]>, key: string): DraftComment[] {
  return drafts[key] ?? EMPTY
}
export function threadsFor(threads: Record<string, ThreadLite[]>, key: string): ThreadLite[] {
  return threads[key] ?? EMPTY_T
}
const EMPTY: DraftComment[] = []
const EMPTY_T: ThreadLite[] = []

// Threads that belong on a given line of a file. GitHub nulls `line` once the
// diff moves under a thread, so the original line is the fallback — without it
// an outdated thread silently belongs to no line at all.
export function threadsOnLine(
  threads: ThreadLite[],
  path: string,
  line: number,
  side: 'LEFT' | 'RIGHT'
): ThreadLite[] {
  return threads.filter(
    (t) => t.path === path && t.diffSide === side && (t.line ?? t.originalLine) === line
  )
}
