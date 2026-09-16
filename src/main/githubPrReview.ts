// Leaving a review — the half that writes.
//
// Everything here publishes to GitHub under the user's own account, so nothing
// in this file is ever called on riven's initiative: each entry point exists
// because the user pressed a button that says what it will do.
//
// Bodies and ids never touch a command line. The review payload goes in on
// stdin as JSON (`gh api --input -`), which is also the only way to send inline
// comments in one review — `gh pr review` has no flag for them.

import { ipcMain } from 'electron'
import { spawn } from 'child_process'
import { resolveBin } from './shellPath'

export type ReviewEvent = 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT'

export interface DraftComment {
  path: string
  // Line in the file as this PR leaves it (RIGHT) or as it was (LEFT).
  line: number
  side: 'LEFT' | 'RIGHT'
  startLine?: number
  body: string
}

export interface WriteResult {
  ok: boolean
  error?: string
}

// GitHub node ids for a review thread. Checked because they are interpolated
// into a GraphQL variable — and because a wrong id type here fails in a way
// that reads like a permissions error.
const THREAD_ID_RE = /^PRRT_[A-Za-z0-9_-]+$/

async function ghJson(
  cwd: string,
  args: string[],
  stdin?: string,
  timeoutMs = 30000
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const bin = await resolveBin('gh')
  if (!bin) return { ok: false, stdout: '', stderr: 'GitHub CLI (gh) not found' }
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
    if (stdin !== undefined) child.stdin.end(stdin)
    else child.stdin.end()
  })
}

async function repoSlug(cwd: string): Promise<string | null> {
  const r = await ghJson(cwd, ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'])
  const slug = r.ok ? r.stdout.trim() : ''
  return /^[\w.-]+\/[\w.-]+$/.test(slug) ? slug : null
}

// The body GitHub wants for POST /pulls/{n}/reviews. Pure, so the shape of a
// multi-line comment (which needs start_line AND start_side) is pinned by tests
// rather than discovered from a 422.
export function reviewPayload(
  event: ReviewEvent,
  body: string,
  comments: DraftComment[],
  commitId: string
): Record<string, unknown> {
  const payload: Record<string, unknown> = { event, body, commit_id: commitId }
  if (comments.length) {
    payload.comments = comments.map((c) => {
      const one: Record<string, unknown> = { path: c.path, line: c.line, side: c.side, body: c.body }
      if (c.startLine !== undefined && c.startLine < c.line) {
        one.start_line = c.startLine
        one.start_side = c.side
      }
      return one
    })
  }
  return payload
}

export async function submitReview(
  repoDir: string,
  number: number,
  event: ReviewEvent,
  body: string,
  comments: DraftComment[],
  commitId: string
): Promise<WriteResult> {
  if (!Number.isInteger(number) || number <= 0) return { ok: false, error: 'bad pr number' }
  if (event !== 'APPROVE' && event !== 'REQUEST_CHANGES' && event !== 'COMMENT')
    return { ok: false, error: 'bad review event' }
  // GitHub rejects an empty REQUEST_CHANGES/COMMENT review, and an approval
  // with nothing to say is fine — but a review with neither body nor comments
  // is a misclick, not a review.
  if (!body.trim() && comments.length === 0 && event !== 'APPROVE')
    return { ok: false, error: 'nothing to submit' }
  const slug = await repoSlug(repoDir)
  if (!slug) return { ok: false, error: 'could not resolve the GitHub repository' }
  const r = await ghJson(
    repoDir,
    ['api', '--method', 'POST', `repos/${slug}/pulls/${number}/reviews`, '--input', '-'],
    JSON.stringify(reviewPayload(event, body, comments, commitId))
  )
  return r.ok ? { ok: true } : { ok: false, error: r.stderr.trim().slice(0, 400) }
}

const REPLY_MUTATION =
  'mutation($threadId:ID!,$body:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$threadId,body:$body}){comment{id}}}'

export async function replyToThread(repoDir: string, threadId: string, body: string): Promise<WriteResult> {
  if (!THREAD_ID_RE.test(threadId)) return { ok: false, error: 'bad thread id' }
  if (!body.trim()) return { ok: false, error: 'empty reply' }
  // Variables go in as JSON on stdin so a body with quotes, newlines or
  // backticks is data, never syntax.
  const r = await ghJson(
    repoDir,
    ['api', 'graphql', '--input', '-'],
    JSON.stringify({ query: REPLY_MUTATION, variables: { threadId, body } })
  )
  return r.ok ? { ok: true } : { ok: false, error: r.stderr.trim().slice(0, 400) }
}

export async function setThreadResolved(
  repoDir: string,
  threadId: string,
  resolved: boolean
): Promise<WriteResult> {
  if (!THREAD_ID_RE.test(threadId)) return { ok: false, error: 'bad thread id' }
  const field = resolved ? 'resolveReviewThread' : 'unresolveReviewThread'
  const query = `mutation($threadId:ID!){${field}(input:{threadId:$threadId}){thread{id isResolved}}}`
  const r = await ghJson(
    repoDir,
    ['api', 'graphql', '--input', '-'],
    JSON.stringify({ query, variables: { threadId } })
  )
  return r.ok ? { ok: true } : { ok: false, error: r.stderr.trim().slice(0, 400) }
}

export function registerGithubReviewHandlers(): void {
  ipcMain.handle(
    'gh:submitReview',
    (
      _e,
      repoDir: string,
      number: number,
      event: ReviewEvent,
      body: string,
      comments: DraftComment[],
      commitId: string
    ) => submitReview(repoDir, number, event, body ?? '', comments ?? [], commitId ?? '')
  )
  ipcMain.handle('gh:replyThread', (_e, repoDir: string, threadId: string, body: string) =>
    replyToThread(repoDir, threadId, body ?? '')
  )
  ipcMain.handle('gh:resolveThread', (_e, repoDir: string, threadId: string, resolved: boolean) =>
    setThreadResolved(repoDir, threadId, !!resolved)
  )
}
