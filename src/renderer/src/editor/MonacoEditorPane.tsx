import { useEffect, useRef, useState, useReducer } from 'react'
import * as monaco from 'monaco-editor'
import type { EditorPaneProps } from './EditorPane'
import { languageForPath } from './EditorPane'
import { computeHunks, type Hunk } from './diffLines'
import { ensureLspInitialized } from '../lsp/client'
import { useSession } from '../state/session'
import { useNav } from '../state/nav'
import { contextBus } from '../bridge/contextBus'
import { setEditorFocuser, setFocusRegion } from '../keybindings/focus'
import { editorTheme } from './highlight'
import { useSettings, getSettings } from '../state/settings'

export default function MonacoEditorPane({
  file,
  onSave,
  onDirtyChange,
  agentEdit,
  onAgentRevert
}: EditorPaneProps): JSX.Element {
  const activeWorkspace = useSession((s) => s.activeWorkspace)
  const containerRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const lineDecoRef = useRef<monaco.editor.IEditorDecorationsCollection | null>(null)
  const glyphDecoRef = useRef<monaco.editor.IEditorDecorationsCollection | null>(null)
  const viewZoneIds = useRef<string[]>([])
  const lineToHunk = useRef(new Map<number, Hunk>())
  const savedVersions = useRef(new Map<string, number>())
  const appliedRev = useRef(new Map<string, number>())
  const [dirty, setDirty] = useState(false)
  const [hunks, setHunks] = useState<Hunk[]>([])
  const [hunkIdx, setHunkIdx] = useState(0)

  const fileRef = useRef(file)
  fileRef.current = file
  const onSaveRef = useRef(onSave)
  onSaveRef.current = onSave
  const onRevertRef = useRef(onAgentRevert)
  onRevertRef.current = onAgentRevert

  const [, forceRender] = useReducer((x) => x + 1, 0)
  useEffect(() => contextBus.subscribe(forceRender), [])

  const recomputeDirty = (): void => {
    const model = editorRef.current?.getModel()
    if (!model) return setDirty(false)
    const saved = savedVersions.current.get(model.uri.toString())
    setDirty(saved !== undefined && model.getAlternativeVersionId() !== saved)
  }

  const doSave = (): void => {
    const ed = editorRef.current
    const model = ed?.getModel()
    const f = fileRef.current
    if (!ed || !model || !f) return
    onSaveRef.current(f.path, model.getValue())
    savedVersions.current.set(model.uri.toString(), model.getAlternativeVersionId())
    recomputeDirty()
  }
  const doSaveRef = useRef(doSave)
  doSaveRef.current = doSave

  // ---- agent-edit hunk review (computed from before/after, not the model) ----
  const decorateHunks = (hs: Hunk[]): void => {
    const ed = editorRef.current
    const model = ed?.getModel()
    lineDecoRef.current?.clear()
    glyphDecoRef.current?.clear()
    lineToHunk.current.clear()
    // Clear old "removed lines" view zones.
    ed?.changeViewZones((acc) => {
      viewZoneIds.current.forEach((id) => acc.removeZone(id))
      viewZoneIds.current = []
    })
    if (!ed || !model || hs.length === 0) return

    const lineDecos: monaco.editor.IModelDeltaDecoration[] = []
    const glyphDecos: monaco.editor.IModelDeltaDecoration[] = []
    const lc = model.getLineCount()
    for (const h of hs) {
      const startLine = Math.min(Math.max(1, h.afterStart + 1), lc)
      lineToHunk.current.set(startLine, h)
      // Added lines → green highlight.
      if (h.afterCount > 0) {
        const endLine = Math.min(h.afterStart + h.afterCount, lc)
        lineDecos.push({
          range: new monaco.Range(startLine, 1, endLine, 1),
          options: {
            isWholeLine: true,
            className: 'agent-add-line',
            overviewRuler: { color: '#4ec57f', position: monaco.editor.OverviewRulerLane.Left }
          }
        })
      }
      glyphDecos.push({
        range: new monaco.Range(startLine, 1, startLine, 1),
        options: {
          glyphMarginClassName: 'agent-revert-glyph',
          glyphMarginHoverMessage: { value: '이 변경 되돌리기' }
        }
      })
    }
    lineDecoRef.current = ed.createDecorationsCollection(lineDecos)
    glyphDecoRef.current = ed.createDecorationsCollection(glyphDecos)

    // Removed/old lines → red "deleted" view zones above each hunk.
    ed.changeViewZones((acc) => {
      for (const h of hs) {
        if (h.beforeCount === 0) continue
        const dom = document.createElement('div')
        dom.className = 'agent-del-zone'
        for (const line of h.beforeLines) {
          const row = document.createElement('div')
          row.className = 'agent-del-row'
          row.textContent = '− ' + line
          dom.appendChild(row)
        }
        const id = acc.addZone({
          afterLineNumber: Math.max(0, h.afterStart),
          heightInLines: h.beforeLines.length,
          domNode: dom
        })
        viewZoneIds.current.push(id)
      }
    })
  }

  // Revert one hunk: rebuild `after` with the hunk's before-lines and hand it
  // back to the host (which writes it to disk + updates the review state).
  const revertHunk = (h: Hunk): void => {
    if (!agentEdit) return
    const afterLines = agentEdit.after.split('\n')
    const newLines = [
      ...afterLines.slice(0, h.afterStart),
      ...h.beforeLines,
      ...afterLines.slice(h.afterStart + h.afterCount)
    ]
    onRevertRef.current?.(newLines.join('\n'))
  }
  const revertHunkRef = useRef(revertHunk)
  revertHunkRef.current = revertHunk

  const gotoHunk = (i: number): void => {
    const ed = editorRef.current
    if (!ed || hunks.length === 0) return
    const idx = ((i % hunks.length) + hunks.length) % hunks.length
    setHunkIdx(idx)
    const line = hunks[idx].afterStart + 1
    ed.revealLineInCenter(Math.max(1, line))
    ed.setPosition({ lineNumber: Math.max(1, line), column: 1 })
  }

  // ---- context bridge --------------------------------------------------------
  const sendToClaude = (): void => {
    const ed = editorRef.current
    const model = ed?.getModel()
    const f = fileRef.current
    if (!ed || !model || !f) return
    const sel = ed.getSelection()
    const [code, kind] =
      sel && !sel.isEmpty()
        ? ([model.getValueInRange(sel), 'selection'] as const)
        : ([model.getValue(), 'file'] as const)
    const root = useSession.getState().activeWorkspace
    const rel = root && f.path.startsWith(root) ? f.path.slice(root.length + 1) : f.path
    contextBus.sendCode(root, rel, code, kind)
  }
  const sendRef = useRef(sendToClaude)
  sendRef.current = sendToClaude

  const sendDiagnostics = (): void => {
    const ed = editorRef.current
    const model = ed?.getModel()
    const f = fileRef.current
    if (!ed || !model || !f) return
    const markers = monaco.editor
      .getModelMarkers({ resource: model.uri })
      .filter((m) => m.severity >= monaco.MarkerSeverity.Warning)
    const root = useSession.getState().activeWorkspace
    const rel = root && f.path.startsWith(root) ? f.path.slice(root.length + 1) : f.path
    if (markers.length === 0) {
      contextBus.sendText(root, `\n[진단 (${rel})] 에러/경고 없음\n`)
      return
    }
    const lines = markers.map((m) => {
      const sev = m.severity === monaco.MarkerSeverity.Error ? 'error' : 'warning'
      return `${rel}:${m.startLineNumber}:${m.startColumn} ${sev}: ${m.message}`
    })
    contextBus.sendText(root, `\n[진단 (${rel})]\n${lines.join('\n')}\n`)
  }

  // ---- editor lifecycle ------------------------------------------------------
  useEffect(() => {
    const cfg = getSettings()
    const ed = monaco.editor.create(containerRef.current!, {
      theme: editorTheme(),
      fontFamily: cfg.editorFontFamily,
      fontSize: cfg.editorFontSize,
      minimap: { enabled: true },
      glyphMargin: true,
      automaticLayout: true,
      scrollBeyondLastLine: false,
      tabSize: 2,
      renderWhitespace: 'selection'
    })
    editorRef.current = ed
    const offSettings = useSettings.subscribe((s) =>
      ed.updateOptions({ fontFamily: s.settings.editorFontFamily, fontSize: s.settings.editorFontSize })
    )
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => doSaveRef.current())
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyL, () => sendRef.current())

    ed.onDidChangeModelContent(() => recomputeDirty())
    // Click the gutter ↩ glyph to revert that hunk.
    ed.onMouseDown((e) => {
      if (e.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) return
      const line = e.target.position?.lineNumber
      if (line == null) return
      const h = lineToHunk.current.get(line)
      if (h) revertHunkRef.current(h)
    })
    ed.onDidFocusEditorText(() => setFocusRegion({ kind: 'editor' }))
    ed.onDidFocusEditorWidget(() => setFocusRegion({ kind: 'editor' }))
    setEditorFocuser(() => ed.focus())
    return () => {
      offSettings()
      ed.dispose()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const ed = editorRef.current
    if (!ed) return
    if (!file) {
      ed.setModel(null)
      setDirty(false)
      return
    }
    const root = useSession.getState().activeWorkspace
    if (root) ensureLspInitialized(root)
    const uri = monaco.Uri.parse(`file://${file.path}`)
    const key = uri.toString()
    const rev = file.revision ?? 0
    let model = monaco.editor.getModel(uri)
    if (!model) {
      model = monaco.editor.createModel(file.content, languageForPath(file.path), uri)
      appliedRev.current.set(key, rev)
      savedVersions.current.set(key, model.getAlternativeVersionId())
    } else if (rev > (appliedRev.current.get(key) ?? -1)) {
      model.setValue(file.content)
      appliedRev.current.set(key, rev)
      savedVersions.current.set(key, model.getAlternativeVersionId())
    }
    ed.setModel(model)
    recomputeDirty()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file?.path, file?.revision, file?.content])

  // Agent-edit hunks come straight from before/after (independent of model
  // state), so the highlight is reliable. Re-runs after each revert (which
  // changes agentEdit.after) and after the model content is applied.
  useEffect(() => {
    const hs = agentEdit ? computeHunks(agentEdit.before, agentEdit.after) : []
    setHunks(hs)
    setHunkIdx((i) => (i < hs.length ? i : 0))
    decorateHunks(hs)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentEdit?.before, agentEdit?.after, file?.path, file?.content])

  useEffect(() => {
    onDirtyChange?.(dirty)
  }, [dirty, onDirtyChange])

  // Jump to a location requested by search / go-to, once its file is loaded.
  const reveal = useNav((s) => s.reveal)
  const clearReveal = useNav((s) => s.clearReveal)
  useEffect(() => {
    const ed = editorRef.current
    if (!ed || !reveal || !file || reveal.path !== file.path) return
    ed.revealLineInCenter(reveal.line)
    ed.setPosition({ lineNumber: reveal.line, column: reveal.column })
    ed.focus()
    clearReveal()
  }, [reveal, file?.path])

  return (
    <div className="editor-wrap">
      <div className="editor-tabbar">
        <span className="editor-tab">
          {file ? file.path.split('/').pop() : '—'}
          {dirty ? ' •' : ''}
        </span>
        <span className="editor-path">{file?.path ?? ''}</span>
        <button
          className="btn-small diag-btn"
          disabled={!file || !contextBus.hasSink(activeWorkspace)}
          title="이 파일의 에러/경고를 터미널로 전송"
          onClick={sendDiagnostics}
        >
          ⚠ 진단
        </button>
        <button
          className="btn-small send-btn"
          disabled={!file || !contextBus.hasSink(activeWorkspace)}
          title={
            contextBus.hasSink(activeWorkspace)
              ? `포커스된 터미널에 전송 (선택영역/파일, ⌘L)`
              : '터미널을 먼저 열어'
          }
          onClick={sendToClaude}
        >
          ➤ 터미널
        </button>
      </div>

      {hunks.length > 0 && (
        <div className="hunk-nav">
          <span className="hunk-count">🤖 변경 {hunkIdx + 1}/{hunks.length}</span>
          <button className="hunk-btn" title="이전 변경" onClick={() => gotoHunk(hunkIdx - 1)}>
            ‹
          </button>
          <button className="hunk-btn" title="다음 변경" onClick={() => gotoHunk(hunkIdx + 1)}>
            ›
          </button>
          <span className="hunk-hint">거터의 ↩ 클릭 = 해당 구간 되돌리기</span>
        </div>
      )}

      <div className="editor-body" ref={containerRef} style={{ display: file ? 'block' : 'none' }} />
      {!file && (
        <div className="empty-pane">
          <div>
            <p>파일을 선택하면 여기서 편집할 수 있어.</p>
            <p className="hint">저장 ⌘S · claude 전송 ⌘L</p>
          </div>
        </div>
      )}
    </div>
  )
}
