import { useCallback, useEffect, useState } from 'react'
import { useT } from '../../i18n'
import PrReview from './PrReview'
import {
  RefreshCw,
  ExternalLink,
  GitPullRequest,
  GitPullRequestDraft,
  GitPullRequestClosed,
  GitMerge,
  Check,
  X,
  Loader,
  Plus,
  CornerDownRight
} from 'lucide-react'

type PrList = Awaited<ReturnType<typeof window.api.gh.prs>>
type Pr = PrList['prs'][number]

// The PR inbox, in the editor.
//
// Modelled on Graphite's: one list, sectioned by what it wants from YOU rather
// than by repository order — what you have to review first, then your own work,
// then everything else — with each PR's CI and review state readable without
// opening it, and PRs that are stacked on one another shown as the stack they
// are instead of as unrelated rows.

// What is about to appear, in outline. Shown while the first fetch runs — a
// list that arrives in one piece reads as faster than a spinner does, and an
// ellipsis says nothing about what is coming.
export function PrSkeleton({ rows = 5 }: { rows?: number }): JSX.Element {
  return (
    <div className="pr-skeleton" aria-busy="true">
      {Array.from({ length: rows }, (_, i) => (
        <div className="pr-skel-row" key={i}>
          <span className="pr-skel-ico" />
          <span className="pr-skel-num" />
          <span className="pr-skel-title" style={{ maxWidth: `${70 - (i % 3) * 14}%` }} />
          <span className="pr-skel-tail" />
        </div>
      ))}
    </div>
  )
}

function Checks({ pr }: { pr: Pr }): JSX.Element | null {
  const t = useT()
  const { total, passed, failed, pending } = pr.checks
  if (!total) return null
  if (failed > 0)
    return (
      <span className="pr-checks fail" title={t('pr.checksFailing', { failed })}>
        <X size={11} /> {failed}
      </span>
    )
  if (pending > 0)
    return (
      <span className="pr-checks pending" title={t('pr.checksPending')}>
        <Loader size={11} />
      </span>
    )
  return (
    <span className="pr-checks pass" title={t('pr.checksPassing', { passed, total })}>
      <Check size={11} /> {passed}
    </span>
  )
}

function ReviewBadge({ pr }: { pr: Pr }): JSX.Element | null {
  const t = useT()
  if (pr.review === 'approved') return <span className="pr-badge approved">{t('pr.approved')}</span>
  if (pr.review === 'changes_requested')
    return <span className="pr-badge changes">{t('pr.changesRequested')}</span>
  if (pr.review === 'review_required')
    return <span className="pr-badge required">{t('pr.reviewRequired')}</span>
  return null
}

function Row({
  pr,
  currentBranch,
  onCheckout,
  onOpen
}: {
  pr: Pr
  currentBranch: string | null
  onCheckout: (branch: string) => void
  onOpen: (number: number) => void
}): JSX.Element {
  const t = useT()
  const isCurrent = !!currentBranch && pr.headRefName === currentBranch
  return (
    <div
      className={`pr-row${isCurrent ? ' current' : ''}`}
      style={{ paddingLeft: 10 + pr.depth * 14 }}
      onClick={() => onOpen(pr.number)}
      title={`#${pr.number} ${pr.title}\n${pr.headRefName} → ${pr.baseRefName}`}
    >
      {/* A stacked PR is drawn as sitting ON the one below it — the whole point
          of a stack is that it isn't an independent change. */}
      {pr.depth > 0 && (
        <span className="pr-stack-mark" title={t('pr.stackedOn', { n: pr.parent ?? 0 })}>
          <CornerDownRight size={12} />
        </span>
      )}
      <span
        className={`pr-ico${pr.isDraft ? ' draft' : ''}${pr.state === 'MERGED' ? ' merged' : ''}${
          pr.state === 'CLOSED' ? ' closed' : ''
        }`}
      >
        {pr.state === 'MERGED' ? (
          <GitMerge size={14} />
        ) : pr.state === 'CLOSED' ? (
          <GitPullRequestClosed size={14} />
        ) : pr.isDraft ? (
          <GitPullRequestDraft size={14} />
        ) : (
          <GitPullRequest size={14} />
        )}
      </span>
      <span className="pr-num">#{pr.number}</span>
      <span className="pr-title">{pr.title}</span>
      {pr.state === 'MERGED' && <span className="pr-badge merged">{t('pr.merged')}</span>}
      {pr.state === 'CLOSED' && <span className="pr-badge required">{t('pr.closed')}</span>}
      {pr.isDraft && pr.state === 'OPEN' && <span className="pr-badge draft">{t('pr.draft')}</span>}
      <ReviewBadge pr={pr} />
      <Checks pr={pr} />
      <span className="pr-row-actions">
        {!isCurrent && (
          <button
            className="pr-row-act"
            title={t('pr.checkout')}
            onClick={(e) => {
              e.stopPropagation()
              onCheckout(pr.headRefName)
            }}
          >
            <GitPullRequest size={12} />
          </button>
        )}
        <button
          className="pr-row-act"
          title={t('pr.open')}
          onClick={(e) => {
            e.stopPropagation()
            window.api.openExternal(pr.url)
          }}
        >
          <ExternalLink size={12} />
        </button>
      </span>
    </div>
  )
}

// Opening a pull request without going to github.com. The body is sent to `gh`
// on stdin, and publishing the branch — which is what actually puts commits on
// a server — stays a separate press, offered only when gh says it is missing.
function CreateForm({
  repo,
  branch,
  onDone,
  onCancel
}: {
  repo: string
  branch: string | null
  onDone: () => void
  onCancel: () => void
}): JSX.Element {
  const t = useT()
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [base, setBase] = useState('')
  const [draft, setDraft] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [needsPush, setNeedsPush] = useState(false)

  const create = async (): Promise<void> => {
    if (!title.trim() || busy) return
    setBusy(true)
    setError(null)
    const r = await window.api.gh.createPr(repo, { title, body, base, draft })
    setBusy(false)
    if (r.ok) {
      if (r.url) window.api.openExternal(r.url)
      onDone()
      return
    }
    setError(r.error ?? 'failed')
    setNeedsPush(!!r.needsPush)
  }

  const push = async (): Promise<void> => {
    if (!branch || busy) return
    setBusy(true)
    const r = await window.api.gh.pushBranch(repo, branch)
    setBusy(false)
    if (!r.ok) {
      setError(r.error ?? 'push failed')
      return
    }
    setNeedsPush(false)
    setError(null)
    void create()
  }

  return (
    <div className="pr-create">
      <div className="pr-create-head">{t('pr.createTitle', { branch: branch ?? '' })}</div>
      <input
        className="pr-create-input"
        autoFocus
        placeholder={t('pr.titlePlaceholder')}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
      />
      <textarea
        className="pr-reply-input"
        placeholder={t('pr.bodyPlaceholder')}
        value={body}
        onChange={(e) => setBody(e.target.value)}
      />
      <input
        className="pr-create-input"
        placeholder={t('pr.basePlaceholder')}
        value={base}
        onChange={(e) => setBase(e.target.value)}
      />
      <label className="pr-create-draft">
        <input type="checkbox" checked={draft} onChange={(e) => setDraft(e.target.checked)} />
        {t('pr.draft')}
      </label>
      {error && <div className="pr-create-error">{error}</div>}
      <div className="pr-reply-actions">
        {needsPush && branch && (
          <button className="btn-small" disabled={busy} onClick={() => void push()}>
            {t('pr.pushBranch', { branch })}
          </button>
        )}
        <button className="btn-small primary" disabled={busy || !title.trim()} onClick={() => void create()}>
          {t('pr.create')}
        </button>
        <button className="btn-small" disabled={busy} onClick={onCancel}>
          {t('common.cancel')}
        </button>
        <button className="btn-small" disabled={busy} onClick={() => void window.api.gh.createWeb(repo)}>
          {t('pr.createWeb')}
        </button>
      </div>
    </div>
  )
}

export default function PrPanel({
  repo,
  branch,
  onCheckout
}: {
  repo: string
  branch: string | null
  onCheckout: (branch: string) => void
}): JSX.Element {
  const t = useT()
  const [data, setData] = useState<PrList | null>(null)
  const [loading, setLoading] = useState(false)
  // Which PR is being reviewed, if any. The inbox stays mounted underneath so
  // going back costs nothing.
  const [reviewing, setReviewing] = useState<number | null>(null)
  const [state, setState] = useState<'open' | 'closed' | 'all'>('open')
  const [creating, setCreating] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setData(await window.api.gh.prs(repo, state))
    } finally {
      setLoading(false)
    }
  }, [repo, state])

  // Changing the filter (or the repo) drops the old rows rather than leaving
  // open PRs on screen under a "Closed" filter for the seconds the fetch takes.
  useEffect(() => {
    setData(null)
  }, [state, repo])

  // Load when the tab is opened or the repo changes. Deliberately NOT polled:
  // every refresh spends GitHub API budget, and a review queue that updates when
  // you ask is better than one that quietly burns the rate limit all day.
  useEffect(() => {
    void load()
  }, [load])

  const prs = data?.prs ?? []
  const sections: Array<{ key: string; label: string; rows: Pr[] }> = [
    { key: 'review', label: t('pr.needsMyReview'), rows: prs.filter((p) => p.needsMyReview) },
    { key: 'mine', label: t('pr.mine'), rows: prs.filter((p) => p.isMine) },
    {
      key: 'others',
      label: t('pr.others'),
      rows: prs.filter((p) => !p.isMine && !p.needsMyReview)
    }
  ].filter((s) => s.rows.length > 0)

  const problem = data && !data.ok ? data.error : null

  if (reviewing !== null)
    return <PrReview repo={repo} number={reviewing} onBack={() => setReviewing(null)} />

  return (
    <div className="pr-panel">
      <div className="pr-head">
        <span className="pr-head-title">
          {t('git.tab.pr')}
          {prs.length > 0 && <span className="pr-count">{prs.length}</span>}
        </span>
        <div className="pr-head-actions">
          <button className="pr-act" title={t('pr.create')} onClick={() => setCreating((v) => !v)}>
            <Plus size={13} />
          </button>
          <button className="pr-act" title={t('pr.refresh')} onClick={() => void load()} disabled={loading}>
            <RefreshCw size={13} className={loading ? 'spin' : undefined} />
          </button>
        </div>
      </div>

      {/* Closed and merged PRs are part of the history you review against —
          "what did we decide last time" lives there. */}
      <div className="pr-filters">
        {(['open', 'closed', 'all'] as const).map((s) => (
          <button
            key={s}
            className={`pr-filter${state === s ? ' active' : ''}`}
            onClick={() => setState(s)}
          >
            {t(`pr.state.${s}`)}
          </button>
        ))}
      </div>

      {creating && (
        <CreateForm
          repo={repo}
          branch={branch}
          onDone={() => {
            setCreating(false)
            void load()
          }}
          onCancel={() => setCreating(false)}
        />
      )}

      {problem ? (
        <div className="pr-empty">
          {problem === 'no-gh'
            ? t('pr.noGh')
            : problem === 'not-authed'
              ? t('pr.notAuthed')
              : problem === 'no-remote'
                ? t('pr.noRemote')
                : t('pr.failed', { err: data?.detail ?? '' })}
        </div>
      ) : loading && prs.length === 0 ? (
        <PrSkeleton />
      ) : prs.length === 0 ? (
        <div className="pr-empty">{t('pr.empty')}</div>
      ) : (
        <div className="pr-list">
          {sections.map((s) => (
            <div key={s.key} className="pr-section">
              <div className="pr-section-head">
                {s.label}
                <span className="pr-section-count">{s.rows.length}</span>
              </div>
              {s.rows.map((pr) => (
                <Row
                  key={pr.number}
                  pr={pr}
                  currentBranch={branch}
                  onCheckout={onCheckout}
                  onOpen={setReviewing}
                />
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
