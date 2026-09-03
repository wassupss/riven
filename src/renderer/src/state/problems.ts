import { useEffect, useMemo, useState } from 'react'
import * as monaco from 'monaco-editor'
import { useProjectDiagnostics } from './projectDiagnostics'

// Single source of truth for "problems" = live Monaco (LSP) markers merged with the
// last project-wide tsc/eslint run, de-duplicated. Shared by the Problems panel and
// the editor status bar so their counts always agree.

const SEV = monaco.MarkerSeverity
export type Sev = monaco.MarkerSeverity
export interface ProblemRow {
  path: string
  message: string
  source?: string
  severity: Sev
  line: number
  column: number
}

const projSev = (s: 'error' | 'warning' | 'info'): Sev =>
  s === 'error' ? SEV.Error : s === 'warning' ? SEV.Warning : SEV.Info

function markerRows(): ProblemRow[] {
  return monaco.editor
    .getModelMarkers({})
    .filter((m) => m.severity !== SEV.Hint)
    .map((m) => ({
      path: m.resource.fsPath,
      message: m.message,
      source: m.source,
      severity: m.severity,
      line: m.startLineNumber,
      column: m.startColumn
    }))
}

export function useProblemRows(): ProblemRow[] {
  const [markers, setMarkers] = useState<ProblemRow[]>(() => markerRows())
  const bySource = useProjectDiagnostics((s) => s.bySource)
  useEffect(() => {
    setMarkers(markerRows())
    const d = monaco.editor.onDidChangeMarkers(() => setMarkers(markerRows()))
    return () => d.dispose()
  }, [])
  return useMemo(() => {
    const proj: ProblemRow[] = Object.values(bySource)
      .flat()
      .map((d) => ({
        path: d.path,
        message: d.message,
        source: d.source,
        severity: projSev(d.severity),
        line: d.line,
        column: d.column
      }))
    const seen = new Set<string>()
    const out: ProblemRow[] = []
    for (const r of [...markers, ...proj]) {
      const key = `${r.path}|${r.line}|${r.column}|${r.message}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push(r)
    }
    return out
  }, [markers, bySource])
}

export function useProblemCounts(): { errors: number; warnings: number; infos: number } {
  const rows = useProblemRows()
  return useMemo(() => {
    let errors = 0
    let warnings = 0
    let infos = 0
    for (const r of rows) {
      if (r.severity === SEV.Error) errors++
      else if (r.severity === SEV.Warning) warnings++
      else infos++
    }
    return { errors, warnings, infos }
  }, [rows])
}
