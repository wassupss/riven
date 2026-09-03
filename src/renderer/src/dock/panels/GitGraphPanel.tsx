import { useEffect, useMemo, useState } from 'react'
import { pathOf } from '../../state/session'
import { useT } from '../../i18n'

interface Commit {
  hash: string
  parents: string[]
  author: string
  date: string
  refs: string
  subject: string
}
interface Row {
  commit: Commit
  lane: number
  before: (string | null)[]
  after: (string | null)[]
}

const LANE_COLORS = [
  '#a18fff',
  '#4cc38a',
  '#e2b053',
  '#5eb1ef',
  '#ff7847',
  '#e5534b',
  '#4ec9b0',
  '#c586c0'
]
const laneColor = (i: number): string => LANE_COLORS[i % LANE_COLORS.length]
const COL = 14 // px per lane
const ROW = 34 // px row height

// Assign each commit a lane and track the lane state before/after it, so the SVG
// rail can draw continuous lines, the commit dot, and branch/merge diagonals.
function layout(commits: Commit[]): { rows: Row[]; maxLanes: number } {
  const lanes: (string | null)[] = []
  const rows: Row[] = []
  let maxLanes = 1
  const claim = (hash: string): number => {
    let i = lanes.indexOf(hash)
    if (i === -1) {
      i = lanes.indexOf(null)
      if (i === -1) {
        i = lanes.length
        lanes.push(null)
      }
      lanes[i] = hash
    }
    return i
  }
  for (const commit of commits) {
    const lane = claim(commit.hash)
    const before = [...lanes]
    const [p0, ...rest] = commit.parents
    lanes[lane] = p0 ?? null
    for (const p of rest) claim(p)
    // Compact trailing empty lanes.
    while (lanes.length && lanes[lanes.length - 1] == null) lanes.pop()
    rows.push({ commit, lane, before, after: [...lanes] })
    maxLanes = Math.max(maxLanes, before.length, lanes.length)
  }
  return { rows, maxLanes }
}

function Rail({ row, maxLanes }: { row: Row; maxLanes: number }): JSX.Element {
  const w = maxLanes * COL
  const cx = row.lane * COL + COL / 2
  const mid = ROW / 2
  const lines: JSX.Element[] = []
  // Continuing lanes: a line for any lane occupied on entry or exit.
  const n = Math.max(row.before.length, row.after.length)
  for (let i = 0; i < n; i++) {
    const x = i * COL + COL / 2
    const top = row.before[i] != null
    const bot = row.after[i] != null
    if (top) lines.push(<line key={`t${i}`} x1={x} y1={0} x2={x} y2={mid} stroke={laneColor(i)} strokeWidth={1.5} />)
    if (bot) lines.push(<line key={`b${i}`} x1={x} y1={mid} x2={x} y2={ROW} stroke={laneColor(i)} strokeWidth={1.5} />)
  }
  // Diagonals from this commit's dot to where each parent sits below.
  for (const p of row.commit.parents) {
    const pl = row.after.indexOf(p)
    if (pl >= 0 && pl !== row.lane) {
      const px = pl * COL + COL / 2
      lines.push(
        <line key={`d${p}`} x1={cx} y1={mid} x2={px} y2={ROW} stroke={laneColor(pl)} strokeWidth={1.5} />
      )
    }
  }
  return (
    <svg className="gg-rail" width={w} height={ROW} style={{ flex: `0 0 ${w}px` }}>
      {lines}
      <circle cx={cx} cy={mid} r={4} fill={laneColor(row.lane)} stroke="var(--bg)" strokeWidth={1.5} />
    </svg>
  )
}

export default function GitGraphPanel({ workspace }: { workspace: string }): JSX.Element {
  const t = useT()
  const ws = pathOf(workspace)
  const [commits, setCommits] = useState<Commit[]>([])
  const [loading, setLoading] = useState(true)

  const refresh = async (): Promise<void> => {
    setLoading(true)
    const log = await window.api.git.log(ws, 200)
    setCommits(log)
    setLoading(false)
  }

  useEffect(() => {
    void refresh()
    const off = window.api.git.onChanged(() => void refresh())
    return off
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws])

  const { rows, maxLanes } = useMemo(() => layout(commits), [commits])

  return (
    <div className="gg-panel">
      {loading && commits.length === 0 ? (
        <div className="empty-hint center">{t('common.loading')}</div>
      ) : commits.length === 0 ? (
        <div className="empty-hint center">{t('gitgraph.empty')}</div>
      ) : (
        <div className="gg-scroll">
          {rows.map((row) => (
            <div key={row.commit.hash} className="gg-row" style={{ height: ROW }}>
              <Rail row={row} maxLanes={maxLanes} />
              <div className="gg-meta">
                <span className="gg-subject">
                  {row.commit.refs && <span className="gg-refs">{row.commit.refs}</span>}
                  {row.commit.subject}
                </span>
                <span className="gg-sub">
                  <span className="gg-hash">{row.commit.hash.slice(0, 7)}</span>
                  {' · '}
                  {row.commit.author} · {row.commit.date}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
