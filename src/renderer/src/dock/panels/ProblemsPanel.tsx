import { useMemo, useState } from 'react'
import * as monaco from 'monaco-editor'
import {
  CircleX,
  TriangleAlert,
  Info,
  ChevronRight,
  ChevronDown,
  Ban,
  RefreshCw
} from 'lucide-react'
import { pathOf, useSession } from '../../state/session'
import { useNav } from '../../state/nav'
import { useProjectDiagnostics } from '../../state/projectDiagnostics'
import { useProblemRows, type ProblemRow, type Sev } from '../../state/problems'
import { useT } from '../../i18n'
import '../../styles/problems.css'

const SEV = monaco.MarkerSeverity
const sevRank = (s: Sev): number => (s === SEV.Error ? 0 : s === SEV.Warning ? 1 : 2)

// VS Code-style Problems list. Lives in the editor's bottom drawer (not a global
// dock panel). Sources: live LSP markers + project tsc/eslint runs (via re-run).
export default function ProblemsPanel(): JSX.Element {
  const t = useT()
  const rows = useProblemRows()
  const [showErrors, setShowErrors] = useState(true)
  const [showWarnings, setShowWarnings] = useState(true)
  const [showInfos, setShowInfos] = useState(true)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const openWorkspaces = useSession((s) => s.openWorkspaces)
  const activeWorkspace = useSession((s) => s.activeWorkspace)
  const setActiveWorkspace = useSession((s) => s.setActiveWorkspace)
  const openFile = useSession((s) => s.openFile)
  const running = useProjectDiagnostics((s) => s.running)
  const runDiag = useProjectDiagnostics((s) => s.run)
  const anyRunning = !!running.tsc || !!running.eslint

  const errorCount = rows.filter((r) => r.severity === SEV.Error).length
  const warnCount = rows.filter((r) => r.severity === SEV.Warning).length
  const infoCount = rows.length - errorCount - warnCount

  const filtered = useMemo(
    () =>
      rows.filter(
        (r) =>
          (r.severity === SEV.Error && showErrors) ||
          (r.severity === SEV.Warning && showWarnings) ||
          (r.severity === SEV.Info && showInfos)
      ),
    [rows, showErrors, showWarnings, showInfos]
  )

  const groups = useMemo(() => {
    const by = new Map<string, ProblemRow[]>()
    for (const r of filtered) {
      const list = by.get(r.path) ?? []
      list.push(r)
      by.set(r.path, list)
    }
    return [...by.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([path, list]) => ({
        path,
        rows: list.sort((x, y) => x.line - y.line || sevRank(x.severity) - sevRank(y.severity))
      }))
  }, [filtered])

  const relParts = (abs: string): { name: string; dir: string } => {
    const ws = openWorkspaces.find((w) => abs.startsWith(pathOf(w) + '/'))
    const rel = ws ? abs.slice(pathOf(ws).length + 1) : abs
    const i = rel.lastIndexOf('/')
    return i < 0 ? { name: rel, dir: '' } : { name: rel.slice(i + 1), dir: rel.slice(0, i) }
  }

  const openAt = (r: ProblemRow): void => {
    const ws = openWorkspaces.find((w) => r.path.startsWith(pathOf(w) + '/'))
    if (ws) setActiveWorkspace(ws)
    openFile(r.path)
    useNav.getState().requestReveal(r.path, r.line, r.column)
  }

  const rerun = (): void => {
    const root = activeWorkspace ? pathOf(activeWorkspace) : null
    if (!root) return
    void runDiag(root, 'tsc')
    void runDiag(root, 'eslint')
  }

  const SevIcon = ({ s }: { s: Sev }): JSX.Element =>
    s === SEV.Error ? (
      <CircleX size={14} className="prob-sev err" />
    ) : s === SEV.Warning ? (
      <TriangleAlert size={14} className="prob-sev warn" />
    ) : (
      <Info size={14} className="prob-sev info" />
    )

  return (
    <div className="prob-panel">
      <div className="prob-toolbar">
        <button
          className={`prob-filter${showErrors ? ' on' : ''}`}
          onClick={() => setShowErrors((v) => !v)}
          title={t('problems.errors')}
        >
          <CircleX size={13} className="prob-sev err" /> {errorCount}
        </button>
        <button
          className={`prob-filter${showWarnings ? ' on' : ''}`}
          onClick={() => setShowWarnings((v) => !v)}
          title={t('problems.warnings')}
        >
          <TriangleAlert size={13} className="prob-sev warn" /> {warnCount}
        </button>
        <button
          className={`prob-filter${showInfos ? ' on' : ''}`}
          onClick={() => setShowInfos((v) => !v)}
          title={t('problems.infos')}
        >
          <Info size={13} className="prob-sev info" /> {infoCount}
        </button>
        <div className="prob-spacer" />
        <button className="prob-run" onClick={rerun} disabled={anyRunning} title={t('problems.rerun')}>
          <RefreshCw size={13} className={anyRunning ? 'spin' : ''} /> {t('problems.rerun')}
        </button>
      </div>

      <div className="prob-list">
        {groups.length === 0 ? (
          <div className="prob-empty">
            <Ban size={16} /> {t('problems.none')}
          </div>
        ) : (
          groups.map((g) => {
            const { name, dir } = relParts(g.path)
            const isCollapsed = collapsed[g.path]
            return (
              <div key={g.path} className="prob-group">
                <button
                  className="prob-file"
                  onClick={() => setCollapsed((c) => ({ ...c, [g.path]: !c[g.path] }))}
                >
                  {isCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                  <span className="prob-file-name">{name}</span>
                  {dir && <span className="prob-file-dir">{dir}</span>}
                  <span className="prob-file-count">{g.rows.length}</span>
                </button>
                {!isCollapsed &&
                  g.rows.map((r, i) => (
                    <button key={i} className="prob-row" onClick={() => openAt(r)}>
                      <SevIcon s={r.severity} />
                      <span className="prob-msg">{r.message}</span>
                      {r.source && <span className="prob-source">{r.source}</span>}
                      <span className="prob-loc">
                        [{r.line}:{r.column}]
                      </span>
                    </button>
                  ))}
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
