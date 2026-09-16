import { useCallback, useEffect, useState } from 'react'
import { useT } from '../../i18n'
import PrReview from './PrReview'
import {
  RefreshCw,
  ExternalLink,
  GitPullRequest,
  GitPullRequestDraft,
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
      <span className={`pr-ico${pr.isDraft ? ' draft' : ''}`}>
        {pr.isDraft ? <GitPullRequestDraft size={14} /> : <GitPullRequest size={14} />}
      </span>
      <span className="pr-num">#{pr.number}</span>
      <span className="pr-title">{pr.title}</span>
      {pr.isDraft && <span className="pr-badge draft">{t('pr.draft')}</span>}
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

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setData(await window.api.gh.prs(repo))
    } finally {
      setLoading(false)
    }
  }, [repo])

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
          <button className="pr-act" title={t('pr.create')} onClick={() => void window.api.gh.createWeb(repo)}>
            <Plus size={13} />
          </button>
          <button className="pr-act" title={t('pr.refresh')} onClick={() => void load()} disabled={loading}>
            <RefreshCw size={13} className={loading ? 'spin' : undefined} />
          </button>
        </div>
      </div>

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
      ) : prs.length === 0 ? (
        <div className="pr-empty">{loading ? '…' : t('pr.empty')}</div>
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
