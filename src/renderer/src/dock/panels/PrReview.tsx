import { useCallback, useEffect, useMemo, useState } from 'react'
import { useT } from '../../i18n'
import Markdown from '../../components/Markdown'
import { openPrDiff } from '../registry'
import { usePrReview, prKey, draftsFor } from '../../state/prReview'
import { parsePatch, threadAnchor, lineAnchor, type PatchLine } from '../../lib/patch'
import {
  ArrowLeft,
  ExternalLink,
  RefreshCw,
  Check,
  X,
  MessageSquare,
  FileCode2,
  CornerDownRight,
  ChevronRight,
  ChevronDown
} from 'lucide-react'

type DetailResult = Awaited<ReturnType<typeof window.api.gh.detail>>
type Detail = Extract<DetailResult, { ok: true }>['detail']
type Thread = Detail['threads'][number]
type FileEntry = Detail['files'][number]
type Draft = { path: string; line: number; side: 'LEFT' | 'RIGHT'; body: string }

// Reviewing a pull request without leaving the editor: the diff, the threads
// already on it, and the three things you can do about them — reply, resolve,
// and submit a review.
//
// Nothing here talks to GitHub on its own. Every write happens on a button
// press, because every write appears in public under the user's name.

function Thread({
  thread,
  repo,
  onChanged
}: {
  thread: Thread
  repo: string
  onChanged: () => void
}): JSX.Element {
  const t = useT()
  const [reply, setReply] = useState('')
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(!thread.isResolved)

  const send = async (): Promise<void> => {
    if (!reply.trim() || busy) return
    setBusy(true)
    const r = await window.api.gh.replyThread(repo, thread.id, reply)
    setBusy(false)
    if (!r.ok) {
      window.alert(r.error ?? 'reply failed')
      return
    }
    setReply('')
    onChanged()
  }

  const toggleResolved = async (): Promise<void> => {
    setBusy(true)
    const r = await window.api.gh.resolveThread(repo, thread.id, !thread.isResolved)
    setBusy(false)
    if (!r.ok) {
      window.alert(r.error ?? 'failed')
      return
    }
    onChanged()
  }

  return (
    <div className={`pr-thread${thread.isResolved ? ' resolved' : ''}`}>
      <div className="pr-thread-head" onClick={() => setOpen((v) => !v)}>
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <MessageSquare size={12} />
        <span className="pr-thread-who">{thread.comments[0]?.author}</span>
        <span className="pr-thread-count">{thread.comments.length}</span>
        {thread.isResolved && <span className="pr-badge approved">{t('pr.resolved')}</span>}
        {thread.isOutdated && <span className="pr-badge required">{t('pr.outdated')}</span>}
      </div>
      {open && (
        <div className="pr-thread-body">
          {thread.comments.map((c) => (
            <div key={c.id} className="pr-comment">
              <div className="pr-comment-head">
                <span className="pr-comment-who">{c.author}</span>
              </div>
              <div className="pr-comment-body">
                <Markdown text={c.body} />
              </div>
            </div>
          ))}
          <div className="pr-reply">
            <textarea
              className="pr-reply-input"
              placeholder={t('pr.replyPlaceholder')}
              value={reply}
              onChange={(e) => setReply(e.target.value)}
            />
            <div className="pr-reply-actions">
              <button className="btn-small" disabled={busy || !reply.trim()} onClick={() => void send()}>
                {t('pr.reply')}
              </button>
              <button className="btn-small" disabled={busy} onClick={() => void toggleResolved()}>
                {thread.isResolved ? t('pr.unresolve') : t('pr.resolve')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function FileDiff({
  file,
  threads,
  drafts,
  repo,
  onChanged,
  onDraft,
  onOpenInEditor
}: {
  file: FileEntry
  threads: Thread[]
  drafts: Draft[]
  repo: string
  onChanged: () => void
  onDraft: (d: Draft) => void
  onOpenInEditor: () => void
}): JSX.Element {
  const t = useT()
  const [open, setOpen] = useState(true)
  const [composing, setComposing] = useState<{ line: number; side: 'LEFT' | 'RIGHT' } | null>(null)
  const [text, setText] = useState('')
  const hunks = useMemo(() => parsePatch(file.patch), [file.patch])

  const byAnchor = useMemo(() => {
    const m = new Map<string, Thread[]>()
    for (const th of threads) {
      const a = threadAnchor(th)
      m.set(a, [...(m.get(a) ?? []), th])
    }
    return m
  }, [threads])

  const draftsByAnchor = useMemo(() => {
    const m = new Map<string, Draft[]>()
    for (const d of drafts) {
      const a = `${d.path}::${d.side}::${d.line}`
      m.set(a, [...(m.get(a) ?? []), d])
    }
    return m
  }, [drafts])

  const addDraft = (): void => {
    if (!composing || !text.trim()) return
    onDraft({ path: file.filename, line: composing.line, side: composing.side, body: text })
    setText('')
    setComposing(null)
  }

  const row = (l: PatchLine, i: number): JSX.Element => {
    const anchor = lineAnchor(file.filename, l)
    const lineThreads = anchor ? (byAnchor.get(anchor) ?? []) : []
    const lineDrafts = anchor ? (draftsByAnchor.get(anchor) ?? []) : []
    const side: 'LEFT' | 'RIGHT' = l.kind === 'del' ? 'LEFT' : 'RIGHT'
    const num = side === 'LEFT' ? l.oldLine : l.newLine
    return (
      <div key={i} className={`pr-dl ${l.kind}`}>
        <span className="pr-dl-gutter">
          <span className="pr-dl-num">{l.oldLine ?? ''}</span>
          <span className="pr-dl-num">{l.newLine ?? ''}</span>
          {l.kind !== 'hunk' && num !== null && (
            <button
              className="pr-dl-comment"
              title={t('pr.commentOnLine')}
              onClick={() => {
                setComposing({ line: num, side })
                setText('')
              }}
            >
              +
            </button>
          )}
        </span>
        <span className="pr-dl-text">{l.text || ' '}</span>
        {(lineThreads.length > 0 || lineDrafts.length > 0 || (composing && composing.line === num && composing.side === side)) && (
          <div className="pr-dl-notes">
            {lineThreads.map((th) => (
              <Thread key={th.id} thread={th} repo={repo} onChanged={onChanged} />
            ))}
            {lineDrafts.map((d, k) => (
              <div key={k} className="pr-draft">
                <CornerDownRight size={11} /> {d.body}
              </div>
            ))}
            {composing && composing.line === num && composing.side === side && (
              <div className="pr-reply">
                <textarea
                  className="pr-reply-input"
                  autoFocus
                  placeholder={t('pr.commentPlaceholder')}
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                />
                <div className="pr-reply-actions">
                  <button className="btn-small" disabled={!text.trim()} onClick={addDraft}>
                    {t('pr.addComment')}
                  </button>
                  <button className="btn-small" onClick={() => setComposing(null)}>
                    {t('common.cancel')}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    )
  }

  // Threads whose line GitHub no longer knows (outdated, or on a file-level
  // comment) still belong to this file — show them above the diff rather than
  // dropping them.
  const floating = threads.filter((th) => {
    const a = threadAnchor(th)
    return !hunks.some((h) => h.lines.some((l) => lineAnchor(file.filename, l) === a))
  })

  return (
    <div className="pr-file">
      <div className="pr-file-head" onClick={() => setOpen((v) => !v)}>
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span className="pr-file-name">{file.filename}</span>
        <span className="pr-file-stats">
          <span className="changes-add">+{file.additions}</span>
          <span className="changes-del">−{file.deletions}</span>
        </span>
        {threads.length > 0 && (
          <span className="pr-file-threads">
            <MessageSquare size={11} /> {threads.length}
          </span>
        )}
        {/* The panel's inline diff is for skimming; the editor is for reading.
            It has the untouched parts of the file, real highlighting, and
            comments on any line — not just the ones near a hunk. */}
        <button
          className="pr-file-open"
          title={t('pr.openInEditor')}
          onClick={(e) => {
            e.stopPropagation()
            onOpenInEditor()
          }}
        >
          <FileCode2 size={12} />
        </button>
      </div>
      {open && (
        <div className="pr-file-body">
          {floating.map((th) => (
            <Thread key={th.id} thread={th} repo={repo} onChanged={onChanged} />
          ))}
          {file.patch === null ? (
            <div className="pr-file-nopatch">
              {file.changes > 0 ? t('pr.diffTooLarge') : t('pr.binaryFile')}
            </div>
          ) : (
            hunks.map((h, hi) => <div key={hi} className="pr-hunk">{h.lines.map(row)}</div>)
          )}
        </div>
      )}
    </div>
  )
}

export default function PrReview({
  repo,
  number,
  onBack
}: {
  repo: string
  number: number
  onBack: () => void
}): JSX.Element {
  const t = useT()
  const [data, setData] = useState<DetailResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [body, setBody] = useState('')
  const [submitting, setSubmitting] = useState(false)
  // Pending comments live outside this component: the same review can be
  // written here and in a diff editor tab, and GitHub takes it in one call.
  const key = prKey(repo, number)
  const allDrafts = usePrReview((s) => s.drafts)
  const drafts = useMemo(() => draftsFor(allDrafts, key), [allDrafts, key])
  const addDraft = usePrReview((s) => s.addDraft)
  const clearDrafts = usePrReview((s) => s.clearDrafts)
  const setThreads = usePrReview((s) => s.setThreads)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await window.api.gh.detail(repo, number)
      setData(res)
      // Hand the threads to the store so a diff editor tab can mark them in the
      // gutter without fetching the whole PR a second time.
      if (res.ok) setThreads(key, res.detail.threads)
    } finally {
      setLoading(false)
    }
  }, [repo, number, key, setThreads])

  useEffect(() => {
    void load()
  }, [load])

  const detail = data?.ok ? data.detail : null

  const submit = async (event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT'): Promise<void> => {
    if (!detail || submitting) return
    setSubmitting(true)
    const r = await window.api.gh.submitReview(repo, number, event, body, drafts, detail.headRefOid)
    setSubmitting(false)
    if (!r.ok) {
      window.alert(r.error ?? 'review failed')
      return
    }
    clearDrafts(key)
    setBody('')
    void load()
  }

  if (data && !data.ok) {
    return (
      <div className="pr-panel">
        <div className="pr-head">
          <button className="pr-act" onClick={onBack} title={t('pr.back')}>
            <ArrowLeft size={13} />
          </button>
          <span className="pr-head-title">#{number}</span>
        </div>
        <div className="pr-empty">{t('pr.failed', { err: data.error })}</div>
      </div>
    )
  }

  return (
    <div className="pr-panel">
      <div className="pr-head">
        <button className="pr-act" onClick={onBack} title={t('pr.back')}>
          <ArrowLeft size={13} />
        </button>
        <span className="pr-head-title pr-review-title">
          #{number} {detail?.title ?? ''}
        </span>
        <div className="pr-head-actions">
          <button
            className="pr-act"
            title={t('pr.open')}
            onClick={() => detail && window.api.openExternal(detail.url)}
          >
            <ExternalLink size={13} />
          </button>
          <button className="pr-act" title={t('pr.refresh')} onClick={() => void load()} disabled={loading}>
            <RefreshCw size={13} className={loading ? 'spin' : undefined} />
          </button>
        </div>
      </div>

      {!detail ? (
        // A PR's diff takes a few seconds to fetch; show its shape meanwhile.
        <div className="pr-review">
          <div className="pr-skeleton" aria-busy="true">
            <div className="pr-skel-row">
              <span className="pr-skel-title" style={{ maxWidth: '55%' }} />
              <span className="pr-skel-tail" />
            </div>
            <div className="pr-skel-row">
              <span className="pr-skel-block" />
            </div>
            {Array.from({ length: 4 }, (_, i) => (
              <div className="pr-skel-row" key={i}>
                <span className="pr-skel-ico" />
                <span className="pr-skel-title" style={{ maxWidth: `${64 - (i % 3) * 12}%` }} />
                <span className="pr-skel-tail" />
              </div>
            ))}
          </div>
        </div>
      ) : (
        // Three bands: the facts, the scrolling review, and the submit bar.
        // The submit bar used to live INSIDE the scroller as a sticky footer,
        // where it collided with the sticky file headers — the composer ended
        // up drawn through the middle of a file row. A panel footer cannot
        // collide with anything.
        <>
          <div className="pr-review-meta">
            <span className="pr-review-branch">
              {detail.headRefName} → {detail.baseRefName}
            </span>
            <span className="pr-review-counts">
              <span className="changes-add">+{detail.additions}</span>
              <span className="changes-del">−{detail.deletions}</span>
              <span className="pr-review-files">{t('pr.nFiles', { n: detail.changedFiles })}</span>
            </span>
            {detail.checks.failed > 0 ? (
              <span className="pr-checks fail">
                <X size={11} /> {detail.checks.failed}
              </span>
            ) : detail.checks.total > 0 ? (
              <span className="pr-checks pass">
                <Check size={11} /> {detail.checks.passed}/{detail.checks.total}
              </span>
            ) : null}
            {detail.mergeable === 'CONFLICTING' && (
              <span className="pr-badge changes">{t('pr.conflicting')}</span>
            )}
          </div>

          <div className="pr-review">
            {/* A PR description is markdown — checklists, tables, code fences
                and all. Showing the raw source was showing the reviewer the
                wrong thing: the parts that matter most (task lists, headings)
                are the parts markup carries. */}
            {detail.body.trim() && (
              <div className="pr-review-body">
                <Markdown text={detail.body} />
              </div>
            )}

            <div className="pr-files">
            {detail.files.map((f) => (
              <FileDiff
                key={f.filename}
                file={f}
                repo={repo}
                threads={detail.threads.filter((th) => th.path === f.filename)}
                drafts={drafts.filter((d) => d.path === f.filename)}
                onChanged={() => void load()}
                onDraft={(d) => addDraft(key, d)}
                onOpenInEditor={() => openPrDiff(repo, number, f.filename)}
              />
              ))}
            </div>
          </div>

          {/* Submitting is the one thing here that publishes, so it says how
              many pending comments go with it before you press anything. */}
          <div className="pr-submit">
            <textarea
              className="pr-submit-body"
              placeholder={t('pr.reviewPlaceholder')}
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
            <div className="pr-submit-actions">
              {drafts.length > 0 && (
                <span className="pr-submit-count">{t('pr.pendingComments', { n: drafts.length })}</span>
              )}
              <button
                className="btn-small"
                disabled={submitting}
                onClick={() => void submit('COMMENT')}
                title={t('pr.comment')}
              >
                {t('pr.comment')}
              </button>
              <button
                className="btn-small"
                disabled={submitting}
                onClick={() => void submit('REQUEST_CHANGES')}
                title={t('pr.requestChanges')}
              >
                {t('pr.requestChanges')}
              </button>
              <button
                className="btn-small primary"
                disabled={submitting}
                onClick={() => void submit('APPROVE')}
                title={t('pr.approve')}
              >
                {t('pr.approve')}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
