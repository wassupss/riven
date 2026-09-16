// One pull request, in enough detail to actually review it: its state, the
// files it changes with their diffs, and the review threads people have left on
// those lines.
//
// Which API each piece comes from is not a style choice — it was measured:
//
//  - Files come from REST `pulls/{n}/files`, not `gh pr diff`, because the diff
//    endpoint hard-fails past 300 files, and `gh pr view --json files` silently
//    caps at 100 with no pagination and carries no patch text.
//  - Threads come from GraphQL `reviewThreads`, not REST `pulls/{n}/comments`,
//    because REST cannot say whether a thread is RESOLVED — there is no such
//    field on it — and resolved threads are most of what you want hidden.
//  - Status comes from `gh pr view --json`, which is GraphQL and so does not
//    spend the REST budget that paginated file fetches do.

import { ipcMain } from 'electron'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { resolveBin } from './shellPath'
import { summariseChecks, reviewStateOf, type CheckSummary, type ReviewState } from './githubPr'

const pexec = promisify(execFile)

export interface PrFile {
  filename: string
  previousFilename?: string
  status: string
  additions: number
  deletions: number
  changes: number
  // The unified diff for this file, or null when GitHub didn't send one. That
  // happens for binaries AND for diffs it considers too large — `changes > 0`
  // with no patch is the second case, and the UI must say so instead of
  // showing an empty file.
  patch: string | null
}

export interface PrComment {
  id: string
  databaseId: number | null
  author: string
  body: string
  createdAt: string
  outdated: boolean
  diffHunk: string
}

export interface PrThread {
  id: string
  path: string
  // Null on an outdated thread — GitHub drops the current line once the diff
  // has moved under it, leaving only where it originally was.
  line: number | null
  originalLine: number | null
  startLine: number | null
  diffSide: 'LEFT' | 'RIGHT'
  isResolved: boolean
  isOutdated: boolean
  resolvedBy: string | null
  comments: PrComment[]
}

export interface PrDetail {
  number: number
  title: string
  url: string
  body: string
  author: string
  state: string
  isDraft: boolean
  baseRefName: string
  headRefName: string
  headRefOid: string
  // MERGEABLE | CONFLICTING | UNKNOWN — UNKNOWN is transient, GitHub computes
  // it lazily, so the UI treats it as "not known yet", never as a conflict.
  mergeable: string
  mergeStateStatus: string
  review: ReviewState
  checks: CheckSummary
  checkRuns: Array<{ name: string; state: string; url: string | null }>
  additions: number
  deletions: number
  changedFiles: number
  files: PrFile[]
  threads: PrThread[]
  conversation: PrConversationItem[]
}

export type DetailResult =
  | { ok: true; detail: PrDetail }
  | { ok: false; error: string }

async function gh(
  cwd: string,
  args: string[],
  timeoutMs = 30000
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const bin = await resolveBin('gh')
  if (!bin) return { ok: false, stdout: '', stderr: 'GitHub CLI (gh) not found' }
  try {
    const { stdout, stderr } = await pexec(bin, args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024
    })
    return { ok: true, stdout, stderr }
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string }
    return { ok: false, stdout: err.stdout ?? '', stderr: err.stderr || err.message || 'failed' }
  }
}

// `nameWithOwner` for the repo this directory points at.
async function repoSlug(cwd: string): Promise<string | null> {
  const r = await gh(cwd, ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'])
  const slug = r.ok ? r.stdout.trim() : ''
  return /^[\w.-]+\/[\w.-]+$/.test(slug) ? slug : null
}

// `reviews` and `comments` are the conversation: a review's verdict and its
// summary, and the discussion that isn't attached to a line. Fetching only the
// line threads meant a PR someone had approved with "LGTM, one nit below" showed
// the nit and neither the approval nor the words around it.
const VIEW_FIELDS =
  'number,title,url,body,author,state,isDraft,baseRefName,headRefName,headRefOid,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,additions,deletions,changedFiles,reviews,comments'

export interface PrConversationItem {
  kind: 'review' | 'comment'
  author: string
  body: string
  at: string
  // For a review: APPROVED | CHANGES_REQUESTED | COMMENTED | DISMISSED.
  state?: string
}

// One timeline of what people said, oldest first. A review with no body and
// state COMMENTED is the empty shell GitHub creates to carry line comments;
// those comments are already shown on their lines, so the shell is noise.
export function toConversation(reviews: unknown, comments: unknown): PrConversationItem[] {
  const out: PrConversationItem[] = []
  for (const r of Array.isArray(reviews) ? reviews : []) {
    const rv = r as { author?: { login?: string }; body?: string; submittedAt?: string; state?: string }
    const body = (rv.body ?? '').trim()
    const state = String(rv.state ?? '')
    if (!body && state === 'COMMENTED') continue
    if (state === 'PENDING') continue // an unsubmitted draft is nobody's business yet
    out.push({ kind: 'review', author: rv.author?.login ?? '', body, at: rv.submittedAt ?? '', state })
  }
  for (const c of Array.isArray(comments) ? comments : []) {
    const cm = c as { author?: { login?: string }; body?: string; createdAt?: string }
    const body = (cm.body ?? '').trim()
    if (!body) continue
    out.push({ kind: 'comment', author: cm.author?.login ?? '', body, at: cm.createdAt ?? '' })
  }
  return out.sort((a, b) => a.at.localeCompare(b.at))
}

interface RawCheck {
  __typename?: string
  name?: string
  context?: string
  status?: string
  conclusion?: string
  state?: string
  detailsUrl?: string
  targetUrl?: string
}

// The rollup array holds two different shapes with different key names for the
// same ideas; branch on __typename rather than guessing per field.
export function toCheckRuns(rollup: unknown): PrDetail['checkRuns'] {
  if (!Array.isArray(rollup)) return []
  return (rollup as RawCheck[]).map((c) => ({
    name: c.name || c.context || '',
    state: (c.state ?? (c.status === 'COMPLETED' ? c.conclusion : c.status) ?? '').toString().toUpperCase(),
    url: c.detailsUrl || c.targetUrl || null
  }))
}

// `gh api --paginate --slurp` answers with one array per page. Flatten it, and
// accept a plain array too (a single page without --slurp).
export function flattenPages<T>(parsed: unknown): T[] {
  if (!Array.isArray(parsed)) return []
  if (parsed.length === 0) return []
  return Array.isArray(parsed[0]) ? (parsed as T[][]).flat() : (parsed as T[])
}

const THREADS_QUERY =
  'query($owner:String!,$name:String!,$number:Int!,$endCursor:String){' +
  'repository(owner:$owner,name:$name){pullRequest(number:$number){' +
  'reviewThreads(first:50,after:$endCursor){pageInfo{hasNextPage endCursor}nodes{' +
  'id isResolved isOutdated path line originalLine startLine diffSide resolvedBy{login}' +
  'comments(first:50){nodes{id databaseId author{login} body createdAt outdated diffHunk}}' +
  '}}}}}'

interface RawThreadPage {
  data?: {
    repository?: { pullRequest?: { reviewThreads?: { nodes?: RawThread[] } } }
  }
}
interface RawThread {
  id: string
  isResolved: boolean
  isOutdated: boolean
  path: string
  line: number | null
  originalLine: number | null
  startLine: number | null
  diffSide: 'LEFT' | 'RIGHT'
  resolvedBy?: { login?: string } | null
  comments?: { nodes?: Array<{ id: string; databaseId?: number; author?: { login?: string }; body: string; createdAt: string; outdated: boolean; diffHunk: string }> }
}

// gh prints one JSON document per page, concatenated. They are separate
// documents, not one array, so they are split by parsing progressively.
export function parseGraphqlPages(stdout: string): RawThreadPage[] {
  const out: RawThreadPage[] = []
  for (const chunk of stdout.split(/\n(?=\{)/)) {
    const s = chunk.trim()
    if (!s) continue
    try {
      out.push(JSON.parse(s))
    } catch {
      /* a partial page is better skipped than allowed to fail the whole load */
    }
  }
  return out
}

export function toThreads(pages: RawThreadPage[]): PrThread[] {
  const out: PrThread[] = []
  for (const p of pages) {
    for (const t of p.data?.repository?.pullRequest?.reviewThreads?.nodes ?? []) {
      out.push({
        id: t.id,
        path: t.path,
        line: t.line ?? null,
        originalLine: t.originalLine ?? null,
        startLine: t.startLine ?? null,
        diffSide: t.diffSide ?? 'RIGHT',
        isResolved: !!t.isResolved,
        isOutdated: !!t.isOutdated,
        resolvedBy: t.resolvedBy?.login ?? null,
        comments: (t.comments?.nodes ?? []).map((c) => ({
          id: c.id,
          databaseId: c.databaseId ?? null,
          author: c.author?.login ?? '',
          body: c.body,
          createdAt: c.createdAt,
          outdated: !!c.outdated,
          diffHunk: c.diffHunk ?? ''
        }))
      })
    }
  }
  return out
}

export async function prDetail(repoDir: string, number: number): Promise<DetailResult> {
  if (!Number.isInteger(number) || number <= 0) return { ok: false, error: 'bad pr number' }
  const n = String(number)
  const view = await gh(repoDir, ['pr', 'view', n, '--json', VIEW_FIELDS])
  if (!view.ok) return { ok: false, error: view.stderr.trim().slice(0, 300) }
  let v: Record<string, unknown>
  try {
    v = JSON.parse(view.stdout)
  } catch {
    return { ok: false, error: 'unreadable response' }
  }
  const slug = await repoSlug(repoDir)
  if (!slug) return { ok: false, error: 'could not resolve the GitHub repository' }
  const [owner, name] = slug.split('/')

  // Files: one REST request per 100 files, so this is the expensive call — it is
  // cached for a minute, which is free for a PR that isn't being force-pushed.
  const filesRes = await gh(repoDir, [
    'api',
    `repos/${slug}/pulls/${n}/files`,
    '--paginate',
    '--slurp',
    '--cache',
    '60s'
  ])
  let files: PrFile[] = []
  if (filesRes.ok) {
    try {
      files = flattenPages<PrFile & { previous_filename?: string }>(JSON.parse(filesRes.stdout)).map((f) => ({
        filename: f.filename,
        previousFilename: f.previous_filename,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        changes: f.changes,
        patch: f.patch ?? null
      }))
    } catch {
      files = []
    }
  }

  const threadsRes = await gh(repoDir, [
    'api',
    'graphql',
    '--paginate',
    '-f',
    `query=${THREADS_QUERY}`,
    '-F',
    `owner=${owner}`,
    '-F',
    `name=${name}`,
    '-F',
    `number=${n}`
  ])
  const threads = threadsRes.ok ? toThreads(parseGraphqlPages(threadsRes.stdout)) : []

  return {
    ok: true,
    detail: {
      number: Number(v.number),
      title: String(v.title ?? ''),
      url: String(v.url ?? ''),
      body: String(v.body ?? ''),
      author: String((v.author as { login?: string } | undefined)?.login ?? ''),
      state: String(v.state ?? ''),
      isDraft: !!v.isDraft,
      baseRefName: String(v.baseRefName ?? ''),
      headRefName: String(v.headRefName ?? ''),
      headRefOid: String(v.headRefOid ?? ''),
      mergeable: String(v.mergeable ?? 'UNKNOWN'),
      mergeStateStatus: String(v.mergeStateStatus ?? ''),
      review: reviewStateOf(v.reviewDecision),
      checks: summariseChecks(v.statusCheckRollup),
      checkRuns: toCheckRuns(v.statusCheckRollup),
      additions: Number(v.additions ?? 0),
      deletions: Number(v.deletions ?? 0),
      changedFiles: Number(v.changedFiles ?? 0),
      files,
      threads,
      conversation: toConversation(v.reviews, v.comments)
    }
  }
}

export interface PrFileContents {
  ok: boolean
  // The file as the base branch has it and as the PR leaves it. Either can be
  // empty: a file the PR adds has no base side, one it deletes has no head side.
  base: string
  head: string
  baseRefOid: string
  headRefOid: string
  error?: string
}

// Both sides of one file, for a real diff editor rather than a patch fragment.
// The patch from `pulls/{n}/files` only carries the changed hunks with three
// lines of context — enough to render a review, not enough to read the file or
// to comment on a line the hunks don't reach.
export async function prFileContents(
  repoDir: string,
  number: number,
  filePath: string
): Promise<PrFileContents> {
  const empty = { ok: false, base: '', head: '', baseRefOid: '', headRefOid: '' }
  if (!Number.isInteger(number) || number <= 0) return { ...empty, error: 'bad pr number' }
  if (!filePath || filePath.startsWith('/') || filePath.includes('..'))
    return { ...empty, error: 'bad path' }
  const view = await gh(repoDir, ['pr', 'view', String(number), '--json', 'baseRefOid,headRefOid'])
  if (!view.ok) return { ...empty, error: view.stderr.trim().slice(0, 300) }
  let oids: { baseRefOid?: string; headRefOid?: string }
  try {
    oids = JSON.parse(view.stdout)
  } catch {
    return { ...empty, error: 'unreadable response' }
  }
  const slug = await repoSlug(repoDir)
  if (!slug) return { ...empty, error: 'could not resolve the GitHub repository' }

  // A missing side is normal (added / deleted file), so a 404 here is data, not
  // an error — it is what "this file did not exist yet" looks like.
  const at = async (ref: string): Promise<string> => {
    if (!ref) return ''
    const r = await gh(repoDir, [
      'api',
      `repos/${slug}/contents/${filePath.split('/').map(encodeURIComponent).join('/')}?ref=${ref}`,
      '-H',
      'Accept: application/vnd.github.raw',
      '--cache',
      '5m'
    ])
    return r.ok ? r.stdout : ''
  }
  const [base, head] = await Promise.all([at(oids.baseRefOid ?? ''), at(oids.headRefOid ?? '')])
  return {
    ok: true,
    base,
    head,
    baseRefOid: oids.baseRefOid ?? '',
    headRefOid: oids.headRefOid ?? ''
  }
}

export function registerGithubDetailHandlers(): void {
  ipcMain.handle('gh:prDetail', (_e, repoDir: string, number: number) => prDetail(repoDir, number))
  ipcMain.handle('gh:prFile', (_e, repoDir: string, number: number, filePath: string) =>
    prFileContents(repoDir, number, String(filePath ?? ''))
  )
}
