import { ipcMain } from 'electron'
import { execFile, spawn } from 'child_process'
import { promises as fsp } from 'fs'
import * as path from 'path'
import { promisify } from 'util'
import { resolveBin } from './shellPath'

const pexec = promisify(execFile)

// Pull requests, inside the editor.
//
// Reviewing on github.com means leaving the place where the code already is,
// and Graphite's answer — one inbox, PRs grouped into the stacks they actually
// form, every PR's CI and review state visible without opening it — is the part
// worth having here. This module is the data half: it shells out to `gh`, which
// the user has already authenticated, so riven stores no token of its own and
// inherits whatever access they have.
//
// Everything runs as argv (never through a shell) and every value that reaches
// a command line is either a number riven parsed itself or a path it owns.

export type ReviewState = 'approved' | 'changes_requested' | 'review_required' | 'none'

export interface CheckSummary {
  total: number
  passed: number
  failed: number
  pending: number
}

export type PrState = 'open' | 'closed' | 'all'

export interface PullRequest {
  number: number
  title: string
  url: string
  author: string
  // OPEN | CLOSED | MERGED — a closed PR that was merged is not the same as one
  // that was abandoned, and the list has to say which.
  state: string
  isMine: boolean
  // Someone asked THIS user to review it — the top section of the inbox.
  needsMyReview: boolean
  headRefName: string
  baseRefName: string
  isDraft: boolean
  review: ReviewState
  checks: CheckSummary
  updatedAt: string
  // Stack position: the open PR this one is built on (its base branch is that
  // PR's head), and how deep it sits. Graphite's central idea — a PR based on
  // another PR is not an independent change and shouldn't be listed as one.
  parent: number | null
  depth: number
}

export interface PrListResult {
  ok: boolean
  prs: PullRequest[]
  login: string | null
  // Why there is nothing to show, when there is nothing to show. The panel says
  // this out loud rather than looking like a repo with no PRs.
  error?: 'no-gh' | 'not-authed' | 'no-remote' | 'failed'
  detail?: string
}

// ---- pure helpers (tested in githubPr.test.ts) -----------------------------

interface RawCheck {
  __typename?: string
  state?: string // StatusContext: SUCCESS | FAILURE | PENDING | ERROR
  status?: string // CheckRun: QUEUED | IN_PROGRESS | COMPLETED
  conclusion?: string // CheckRun: SUCCESS | FAILURE | NEUTRAL | SKIPPED | CANCELLED …
}

// gh returns two different shapes in one array: a CheckRun (status + conclusion)
// and a StatusContext (state). Reading only one of them silently loses half the
// signal, which is how a red PR looks green.
export function summariseChecks(rollup: unknown): CheckSummary {
  const out: CheckSummary = { total: 0, passed: 0, failed: 0, pending: 0 }
  if (!Array.isArray(rollup)) return out
  for (const raw of rollup as RawCheck[]) {
    if (!raw || typeof raw !== 'object') continue
    out.total++
    const verdict = (raw.state ?? (raw.status === 'COMPLETED' ? raw.conclusion : raw.status) ?? '')
      .toString()
      .toUpperCase()
    if (verdict === 'SUCCESS' || verdict === 'NEUTRAL' || verdict === 'SKIPPED') out.passed++
    else if (verdict === 'FAILURE' || verdict === 'ERROR' || verdict === 'TIMED_OUT' || verdict === 'CANCELLED')
      out.failed++
    else out.pending++
  }
  return out
}

export function reviewStateOf(decision: unknown): ReviewState {
  switch (String(decision ?? '').toUpperCase()) {
    case 'APPROVED':
      return 'approved'
    case 'CHANGES_REQUESTED':
      return 'changes_requested'
    case 'REVIEW_REQUIRED':
      return 'review_required'
    default:
      return 'none'
  }
}

type Stackable = Pick<PullRequest, 'number' | 'headRefName' | 'baseRefName'> & Partial<PullRequest>

// Order PRs so a stack reads bottom-up, each child directly under its parent,
// and record how deep each one sits. A PR whose base branch is another OPEN
// PR's head branch is stacked on it; anything else is a root.
//
// Cycles can't happen in git's own data, but a malformed/raced response must
// not hang the panel, so every node is emitted exactly once.
export function buildStacks<T extends Stackable>(prs: T[]): Array<T & { parent: number | null; depth: number }> {
  const byHead = new Map<string, T>()
  for (const pr of prs) byHead.set(pr.headRefName, pr)
  const parentOf = (pr: T): T | null => {
    const p = byHead.get(pr.baseRefName)
    return p && p.number !== pr.number ? p : null
  }
  const children = new Map<number, T[]>()
  const roots: T[] = []
  for (const pr of prs) {
    const p = parentOf(pr)
    if (!p) roots.push(pr)
    else children.set(p.number, [...(children.get(p.number) ?? []), pr])
  }
  const out: Array<T & { parent: number | null; depth: number }> = []
  const seen = new Set<number>()
  const walk = (pr: T, depth: number, parent: number | null): void => {
    if (seen.has(pr.number)) return
    seen.add(pr.number)
    out.push({ ...pr, parent, depth })
    for (const c of (children.get(pr.number) ?? []).sort((a, b) => a.number - b.number)) {
      walk(c, depth + 1, pr.number)
    }
  }
  // Newest root first: the inbox is a work queue, not an archive.
  for (const r of roots.sort((a, b) => b.number - a.number)) walk(r, 0, null)
  // Anything left is part of a cycle; show it rather than dropping it.
  for (const pr of prs) if (!seen.has(pr.number)) walk(pr, 0, null)
  return out
}

interface RawPr {
  number: number
  title: string
  url: string
  state?: string
  author?: { login?: string }
  headRefName: string
  baseRefName: string
  isDraft: boolean
  reviewDecision?: string
  statusCheckRollup?: unknown
  reviewRequests?: Array<{ login?: string; slug?: string }>
  updatedAt: string
}

export function toPullRequests(raw: RawPr[], login: string | null): PullRequest[] {
  const mapped = raw.map((p) => ({
    number: p.number,
    title: p.title,
    url: p.url,
    state: String(p.state ?? 'OPEN').toUpperCase(),
    author: p.author?.login ?? '',
    isMine: !!login && p.author?.login === login,
    needsMyReview:
      !!login &&
      p.author?.login !== login &&
      (p.reviewRequests ?? []).some((r) => r?.login === login),
    headRefName: p.headRefName,
    baseRefName: p.baseRefName,
    isDraft: !!p.isDraft,
    review: reviewStateOf(p.reviewDecision),
    checks: summariseChecks(p.statusCheckRollup),
    updatedAt: p.updatedAt
  }))
  return buildStacks(mapped)
}

// ---- gh ---------------------------------------------------------------------

const PR_FIELDS = [
  'number',
  'title',
  'url',
  'state',
  'author',
  'headRefName',
  'baseRefName',
  'isDraft',
  'reviewDecision',
  'statusCheckRollup',
  'reviewRequests',
  'updatedAt'
].join(',')

async function gh(
  cwd: string,
  args: string[],
  timeoutMs = 20000
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const bin = await resolveBin('gh')
  if (!bin) return { ok: false, stdout: '', stderr: 'no-gh' }
  try {
    const { stdout, stderr } = await pexec(bin, args, { cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 })
    return { ok: true, stdout, stderr }
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string }
    return { ok: false, stdout: err.stdout ?? '', stderr: err.stderr || err.message || 'failed' }
  }
}

// Who gh is logged in as. Needed to tell "mine" from "waiting on me", and cheap
// enough to cache for the life of the app (it only changes on `gh auth switch`).
let cachedLogin: string | null = null
async function viewerLogin(cwd: string): Promise<string | null> {
  if (cachedLogin) return cachedLogin
  const r = await gh(cwd, ['api', 'user', '--jq', '.login'])
  const login = r.ok ? r.stdout.trim() : ''
  cachedLogin = login || null
  return cachedLogin
}

function classify(stderr: string): PrListResult['error'] {
  const s = stderr.toLowerCase()
  if (s.includes('no-gh')) return 'no-gh'
  if (s.includes('auth login') || s.includes('authentication') || s.includes('not logged')) return 'not-authed'
  if (s.includes('no git remote') || s.includes('not a git repository') || s.includes('could not determine'))
    return 'no-remote'
  return 'failed'
}

export async function listPullRequests(repoDir: string, state: PrState = 'open'): Promise<PrListResult> {
  const login = await viewerLogin(repoDir)
  // Only the three states gh accepts, chosen here rather than passed through —
  // this value goes into an argv that runs a command.
  const s: PrState = state === 'closed' || state === 'all' ? state : 'open'
  const r = await gh(repoDir, ['pr', 'list', '--state', s, '--limit', '50', '--json', PR_FIELDS])
  if (!r.ok) return { ok: false, prs: [], login, error: classify(r.stderr), detail: r.stderr.trim().slice(0, 300) }
  let raw: RawPr[]
  try {
    raw = JSON.parse(r.stdout || '[]')
  } catch {
    return { ok: false, prs: [], login, error: 'failed', detail: 'unreadable response' }
  }
  return { ok: true, prs: toPullRequests(raw, login), login }
}

// Same as gh(), but the process gets something on stdin — how a PR body (or a
// review body) is passed without ever putting it on a command line.
async function ghStdin(
  cwd: string,
  args: string[],
  stdin: string,
  timeoutMs = 30000
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const bin = await resolveBin('gh')
  if (!bin) return { ok: false, stdout: '', stderr: 'no-gh' }
  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      err += '\ntimed out'
    }, timeoutMs)
    child.stdout.on('data', (d) => (out += String(d)))
    child.stderr.on('data', (d) => (err += String(d)))
    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ ok: false, stdout: out, stderr: e.message })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ ok: code === 0, stdout: out, stderr: err })
    })
    child.stdin.end(stdin)
  })
}

// Publish the current branch. Separate from creating the PR because it is a
// separate decision: this is the step that puts the user's commits on a server.
export async function pushBranch(repoDir: string, branch: string): Promise<CreatePrResult> {
  if (!/^[\w][\w./-]*$/.test(branch)) return { ok: false, error: 'bad branch name' }
  try {
    await pexec('git', ['-C', repoDir, 'push', '-u', 'origin', branch], { timeout: 120000 })
    return { ok: true }
  } catch (e) {
    const err = e as { stderr?: string; message?: string }
    return { ok: false, error: (err.stderr || err.message || 'push failed').trim().slice(0, 400) }
  }
}

export interface NewPrDraft {
  // What the form should open with: the branch, where it would land, the title
  // GitHub itself would pick, and the repo's own template.
  branch: string
  base: string
  title: string
  body: string
  // Commits this branch has that the base does not — the form says how much is
  // about to be proposed, and an empty list is why "create" would fail.
  commits: number
  hasTemplate: boolean
  pushed: boolean
  error?: string
}

// The repo's PR template, if it keeps one. GitHub looks in these places (and is
// case-insensitive about the name); riven reads the same ones so the form opens
// with what the project expects a PR to say, instead of an empty box that the
// user then has to remember to fill from memory.
const TEMPLATE_PATHS = [
  '.github/pull_request_template.md',
  '.github/PULL_REQUEST_TEMPLATE.md',
  'docs/pull_request_template.md',
  'docs/PULL_REQUEST_TEMPLATE.md',
  'pull_request_template.md',
  'PULL_REQUEST_TEMPLATE.md'
]

async function readTemplate(repoDir: string): Promise<string> {
  for (const rel of TEMPLATE_PATHS) {
    try {
      return await fsp.readFile(path.join(repoDir, rel), 'utf8')
    } catch {
      /* try the next place GitHub would look */
    }
  }
  // A directory of templates (.github/PULL_REQUEST_TEMPLATE/*.md) is a choice
  // GitHub makes via a query parameter; picking one for the user would be
  // guessing, so that case falls through to an empty body.
  return ''
}

async function git(repoDir: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await pexec('git', ['-C', repoDir, ...args], { timeout: 10000 })
    return stdout.trim()
  } catch {
    return ''
  }
}

export async function newPrDraft(repoDir: string): Promise<NewPrDraft> {
  const branch = await git(repoDir, ['rev-parse', '--abbrev-ref', 'HEAD'])
  const empty: NewPrDraft = {
    branch,
    base: '',
    title: '',
    body: '',
    commits: 0,
    hasTemplate: false,
    pushed: false
  }
  if (!branch || branch === 'HEAD') return { ...empty, error: 'not on a branch' }

  // The repo's default branch is what a PR lands on unless told otherwise.
  const viewed = await gh(repoDir, ['repo', 'view', '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name'])
  const base = viewed.ok ? viewed.stdout.trim() : ''
  const range = base ? `origin/${base}..HEAD` : ''
  const log = range ? await git(repoDir, ['log', '--format=%s', range]) : ''
  const subjects = log ? log.split('\n').filter(Boolean) : []
  // GitHub's own rule, reproduced: one commit lends the PR its subject, several
  // fall back to the branch name — nobody wants "wip" as a pull request title.
  const title = subjects.length === 1 ? subjects[0] : humanizeBranch(branch)
  const body = await readTemplate(repoDir)
  const pushed = !!(await git(repoDir, ['rev-parse', '--verify', `origin/${branch}`]))
  return {
    branch,
    base,
    title,
    body,
    commits: subjects.length,
    hasTemplate: !!body,
    pushed
  }
}

// feat/some-thing → "Some thing". A branch name is the one description that
// always exists, and this is how it reads as a sentence.
export function humanizeBranch(branch: string): string {
  const last = branch.split('/').pop() ?? branch
  const words = last.replace(/[-_]+/g, ' ').trim()
  return words ? words[0].toUpperCase() + words.slice(1) : branch
}

export interface CreatePrInput {
  title: string
  body: string
  base: string
  draft: boolean
}

export interface CreatePrResult {
  ok: boolean
  url?: string
  error?: string
  // The branch has no remote counterpart yet. Pushing is a separate, explicit
  // step: it publishes the user's commits, so riven asks rather than assumes.
  needsPush?: boolean
}

// `gh pr create` refuses, by design, when the branch was never pushed. Its
// wording is what has to be recognised, since there is no exit code for it.
function looksUnpushed(stderr: string): boolean {
  const s = stderr.toLowerCase()
  return s.includes('must first push') || s.includes('no git remote found') || s.includes('head branch')
}

export async function createPullRequest(
  repoDir: string,
  input: CreatePrInput
): Promise<CreatePrResult> {
  const title = input.title.trim()
  if (!title) return { ok: false, error: 'a pull request needs a title' }
  const args = ['pr', 'create', '--title', title, '--body-file', '-']
  if (input.base.trim()) args.push('--base', input.base.trim())
  if (input.draft) args.push('--draft')
  // The body arrives on stdin, so newlines, quotes and backticks in a
  // description are data rather than anything a shell could read.
  const r = await ghStdin(repoDir, args, input.body, 60000)
  if (r.ok) {
    const url = r.stdout.trim().split('\n').find((l) => l.startsWith('http')) ?? ''
    return { ok: true, url }
  }
  return {
    ok: false,
    error: r.stderr.trim().slice(0, 400),
    needsPush: looksUnpushed(r.stderr)
  }
}

export function registerGithubHandlers(): void {
  ipcMain.handle('gh:prs', (_e, repoDir: string, state: PrState) => listPullRequests(repoDir, state))
  ipcMain.handle('gh:newPrDraft', (_e, repoDir: string) => newPrDraft(repoDir))
  ipcMain.handle('gh:createPr', (_e, repoDir: string, input: CreatePrInput) =>
    createPullRequest(repoDir, {
      title: String(input?.title ?? ''),
      body: String(input?.body ?? ''),
      base: String(input?.base ?? ''),
      draft: !!input?.draft
    })
  )
  // Publishing the branch, as its own step with its own button.
  ipcMain.handle('gh:pushBranch', (_e, repoDir: string, branch: string) => pushBranch(repoDir, branch))
  // The browser flow stays available for anyone who wants GitHub's own form.
  ipcMain.handle('gh:createWeb', async (_e, repoDir: string) => {
    const r = await gh(repoDir, ['pr', 'create', '--web'], 30000)
    return { ok: r.ok, error: r.ok ? undefined : r.stderr.trim().slice(0, 300) }
  })
}
