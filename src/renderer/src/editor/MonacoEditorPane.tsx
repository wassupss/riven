import { useEffect, useMemo, useRef, useState, useReducer } from 'react'
import * as monaco from 'monaco-editor'
import type { EditorPaneProps } from './EditorPane'
import { languageForPath } from './EditorPane'
import { computeHunks, type Hunk } from './diffLines'
import { ensureLspInitialized } from '../lsp/client'
import { useSession } from '../state/session'
import { useUI } from '../state/ui'
import { useNav } from '../state/nav'
import { installCrossFileNavigation } from './gotoDefinition'
import { contextBus } from '../bridge/contextBus'
import { setEditorFocuser, setFocusRegion } from '../keybindings/focus'
import { editorTheme } from './highlight'
import { useSettings, getSettings } from '../state/settings'
import { useT, t as staticT } from '../i18n'
import { SendHorizontal, Bot, ChevronLeft, ChevronRight, Check, Undo2 } from 'lucide-react'

type BlameLine = { author: string; time: number; summary: string; hash: string }

// GitLens-style relative time. Language follows the app setting.
function blameRelTime(epochSec: number): string {
  const ko = getSettings().language !== 'en'
  const d = Math.max(0, Date.now() / 1000 - epochSec)
  const n = (v: number): number => Math.floor(v)
  if (d < 60) return ko ? '방금 전' : 'just now'
  if (d < 3600) return ko ? `${n(d / 60)}분 전` : `${n(d / 60)}m ago`
  if (d < 86400) return ko ? `${n(d / 3600)}시간 전` : `${n(d / 3600)}h ago`
  if (d < 86400 * 7) return ko ? `${n(d / 86400)}일 전` : `${n(d / 86400)}d ago`
  if (d < 86400 * 30) return ko ? `${n(d / (86400 * 7))}주 전` : `${n(d / (86400 * 7))}w ago`
  if (d < 86400 * 365) return ko ? `${n(d / (86400 * 30))}개월 전` : `${n(d / (86400 * 30))}mo ago`
  return ko ? `${n(d / (86400 * 365))}년 전` : `${n(d / (86400 * 365))}y ago`
}

function truncateSummary(s: string, max = 50): string {
  const trimmed = s.trim()
  return trimmed.length > max ? trimmed.slice(0, max - 1) + '…' : trimmed
}

export default function MonacoEditorPane({
  file,
  onSave,
  onDirtyChange,
  agentEdit,
  onAgentRevert,
  onDismiss
}: EditorPaneProps): JSX.Element {
  const t = useT()
  const activeWorkspace = useSession((s) => s.activeWorkspace)
  const containerRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const lineDecoRef = useRef<monaco.editor.IEditorDecorationsCollection | null>(null)
  const glyphDecoRef = useRef<monaco.editor.IEditorDecorationsCollection | null>(null)
  const blameDecoRef = useRef<monaco.editor.IEditorDecorationsCollection | null>(null)
  const blameRef = useRef<Record<number, BlameLine> | null>(null)
  const updateBlameRef = useRef<() => void>(() => {})
  const viewZoneIds = useRef<string[]>([])
  const lineToHunk = useRef(new Map<number, Hunk>())
  const savedVersions = useRef(new Map<string, number>())
  const appliedRev = useRef(new Map<string, number>())
  const [dirty, setDirty] = useState(false)
  const [hunks, setHunks] = useState<Hunk[]>([])
  const [hunkIdx, setHunkIdx] = useState(0)
  const [selBox, setSelBox] = useState<{ top: number; left: number; lines: number } | null>(null)
  // Cursor-style per-hunk review: accepted (dismissed) hunks + hover toolbar.
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())
  const [hunkHover, setHunkHover] = useState<{ top: number; idx: number } | null>(null)
  const hunkLineMapRef = useRef(new Map<number, number>())
  const displayedRef = useRef<Hunk[]>([])
  const hoverHideRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const onDismissRef = useRef(onDismiss)
  onDismissRef.current = onDismiss

  const hunkKey = (h: Hunk): string => `${h.beforeStart}:${h.beforeCount}:${h.afterStart}:${h.afterCount}`
  const displayed = useMemo(() => hunks.filter((h) => !dismissed.has(hunkKey(h))), [hunks, dismissed])
  displayedRef.current = displayed

  const fileRef = useRef(file)
  fileRef.current = file
  const onSaveRef = useRef(onSave)
  onSaveRef.current = onSave
  const onRevertRef = useRef(onAgentRevert)
  onRevertRef.current = onAgentRevert

  const [, forceRender] = useReducer((x) => x + 1, 0)
  // The editor reads contextBus only for the send-to-agent chip's hasAgent
  // state, so re-render only when THAT flips — not on every bus emit (sink
  // register/unregister, the 900ms agent poll, active-terminal changes).
  const hasAgentRef = useRef(contextBus.hasAgent(activeWorkspace))
  useEffect(() => {
    hasAgentRef.current = contextBus.hasAgent(activeWorkspace)
    return contextBus.subscribe(() => {
      const now = contextBus.hasAgent(activeWorkspace)
      if (now !== hasAgentRef.current) {
        hasAgentRef.current = now
        forceRender()
      }
    })
  }, [activeWorkspace])

  // Inline (GitLens-style) blame annotation on the cursor line.
  const updateBlame = (): void => {
    const ed = editorRef.current
    const coll = blameDecoRef.current
    if (!ed || !coll) return
    const lines = blameRef.current
    const pos = ed.getPosition()
    const model = ed.getModel()
    if (!lines || !pos || !model) {
      coll.clear()
      return
    }
    const info = lines[pos.lineNumber]
    if (!info) {
      coll.clear()
      return
    }
    const col = model.getLineMaxColumn(pos.lineNumber)
    const content = `   ${info.author}, ${blameRelTime(info.time)}  ·  ${truncateSummary(info.summary)}`
    coll.set([
      {
        range: new monaco.Range(pos.lineNumber, col, pos.lineNumber, col),
        options: {
          after: { content, inlineClassName: 'git-blame-inline' },
          showIfCollapsed: true
        }
      }
    ])
  }
  updateBlameRef.current = updateBlame

  const recomputeDirty = (): void => {
    const model = editorRef.current?.getModel()
    if (!model) return setDirty(false)
    const saved = savedVersions.current.get(model.uri.toString())
    setDirty(saved !== undefined && model.getAlternativeVersionId() !== saved)
  }

  const doSave = async (): Promise<void> => {
    const ed = editorRef.current
    const model = ed?.getModel()
    const f = fileRef.current
    if (!ed || !model || !f) return
    if (getSettings().formatOnSave) {
      // Run the language's formatter first; if none is registered this is a
      // harmless no-op / throw that we swallow so the save still happens.
      try {
        await ed.getAction('editor.action.formatDocument')?.run()
      } catch {
        /* no formatter for this language */
      }
    }
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
          glyphMarginHoverMessage: { value: staticT('editor.revertThisChange') }
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
    const list = displayedRef.current
    if (!ed || list.length === 0) return
    const idx = ((i % list.length) + list.length) % list.length
    setHunkIdx(idx)
    const line = list[idx].afterStart + 1
    ed.revealLineInCenter(Math.max(1, line))
    ed.setPosition({ lineNumber: Math.max(1, line), column: 1 })
  }

  // Accept (dismiss) one hunk — keeps the applied change, clears its highlight.
  const acceptHunk = (h: Hunk): void => {
    setDismissed((s) => new Set(s).add(hunkKey(h)))
    setHunkHover(null)
  }
  const scheduleHideHover = (): void => {
    if (hoverHideRef.current) clearTimeout(hoverHideRef.current)
    hoverHideRef.current = setTimeout(() => setHunkHover(null), 220)
  }
  const cancelHideHover = (): void => {
    if (hoverHideRef.current) clearTimeout(hoverHideRef.current)
  }

  // ---- context bridge --------------------------------------------------------
  // Send the current selection (or whole file) to the focused terminal's LLM,
  // tagged with `@file:startLine-endLine` + a fenced code block.
  const sendSelection = (): void => {
    const ed = editorRef.current
    const model = ed?.getModel()
    const f = fileRef.current
    if (!ed || !model || !f) return
    const sel = ed.getSelection()
    const root = useSession.getState().activeWorkspace
    const rel = root && f.path.startsWith(root) ? f.path.slice(root.length + 1) : f.path
    const lang = languageForPath(f.path)
    let loc: string
    let code: string
    if (sel && !sel.isEmpty()) {
      loc = `${rel}:${sel.startLineNumber}-${sel.endLineNumber}`
      code = model.getValueInRange(sel)
    } else {
      loc = rel
      code = model.getValue()
    }
    const ok = contextBus.sendText(root, `\n@${loc}\n\`\`\`${lang}\n${code}\n\`\`\`\n`)
    setSelBox(null)
    // No agent running → offer to launch one (the text was queued, flushed on up).
    if (!ok && root) useUI.getState().setAgentPicker(root)
  }
  const sendRef = useRef(sendSelection)
  sendRef.current = sendSelection

  // ---- editor lifecycle ------------------------------------------------------
  useEffect(() => {
    installCrossFileNavigation()
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
      renderWhitespace: 'selection',
      inlineSuggest: { enabled: true }
    })
    editorRef.current = ed
    blameDecoRef.current = ed.createDecorationsCollection([])
    ed.onDidChangeCursorPosition(() => updateBlameRef.current())
    const offSettings = useSettings.subscribe((s) =>
      ed.updateOptions({ fontFamily: s.settings.editorFontFamily, fontSize: s.settings.editorFontSize })
    )
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => doSaveRef.current())
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyL, () => sendRef.current())

    // Selection → floating "send to terminal" chip (Copilot/Cursor style).
    const refreshSelBox = (): void => {
      const sel = ed.getSelection()
      if (!sel || sel.isEmpty()) {
        setSelBox(null)
        return
      }
      const pos = ed.getScrolledVisiblePosition({
        lineNumber: sel.startLineNumber,
        column: sel.startColumn
      })
      if (!pos) {
        setSelBox(null)
        return
      }
      const top = (containerRef.current?.offsetTop ?? 0) + pos.top
      setSelBox({
        top: Math.max(0, top - 30),
        left: Math.min(pos.left, (containerRef.current?.clientWidth ?? 400) - 160),
        lines: sel.endLineNumber - sel.startLineNumber + 1
      })
    }
    ed.onDidChangeCursorSelection(refreshSelBox)
    ed.onDidScrollChange(refreshSelBox)

    ed.onDidChangeModelContent(() => recomputeDirty())
    // Click the gutter ↩ glyph to revert that hunk.
    ed.onMouseDown((e) => {
      if (e.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) return
      const line = e.target.position?.lineNumber
      if (line == null) return
      const h = lineToHunk.current.get(line)
      if (h) revertHunkRef.current(h)
    })
    // Hover over a changed region → floating accept/revert toolbar (Cursor style).
    ed.onMouseMove((e) => {
      const line = e.target.position?.lineNumber
      const idx = line != null ? hunkLineMapRef.current.get(line) : undefined
      if (idx == null) {
        scheduleHideHover()
        return
      }
      cancelHideHover()
      const h = displayedRef.current[idx]
      if (!h) return
      const pos = ed.getScrolledVisiblePosition({ lineNumber: Math.max(1, h.afterStart + 1), column: 1 })
      if (!pos) return
      const top = (containerRef.current?.offsetTop ?? 0) + pos.top
      setHunkHover({ top: Math.max(0, top), idx })
    })
    ed.onMouseLeave(() => scheduleHideHover())
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentEdit?.before, agentEdit?.after, file?.path, file?.content])

  // Fresh review per file — clear accepted set when switching files.
  useEffect(() => {
    setDismissed(new Set())
    setHunkHover(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file?.path])

  // Decorate the still-under-review hunks + build the line→hunk map for hover.
  useEffect(() => {
    decorateHunks(displayed)
    const m = new Map<number, number>()
    displayed.forEach((h, i) => {
      if (h.afterCount > 0) {
        for (let l = h.afterStart + 1; l <= h.afterStart + h.afterCount; l++) m.set(l, i)
      } else {
        m.set(Math.max(1, h.afterStart), i)
      }
    })
    hunkLineMapRef.current = m
    setHunkIdx((i) => (i < displayed.length ? i : 0))
    // All hunks accepted → dismiss the whole review.
    if (hunks.length > 0 && displayed.length === 0) onDismissRef.current?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayed, file?.content])

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

  // Fetch git blame for the open file (drives the inline annotation).
  useEffect(() => {
    blameRef.current = null
    blameDecoRef.current?.clear()
    const p = file?.path
    if (!p || !activeWorkspace) return
    let cancelled = false
    window.api.git
      .blame(activeWorkspace, p)
      .then((res) => {
        if (cancelled || !res.ok || !res.lines) return
        blameRef.current = res.lines
        updateBlameRef.current()
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [file?.path, activeWorkspace, dirty])

  return (
    <div className="editor-wrap">
      {/* Floating "send to terminal LLM" chip, appears at the selection. */}
      {selBox && file && (
        <button
          className="sel-send"
          style={{ top: selBox.top, left: selBox.left }}
          title={
            contextBus.hasAgent(activeWorkspace)
              ? t('editor.sendSelTitle')
              : t('editor.noAgentTitle')
          }
          onMouseDown={(e) => {
            e.preventDefault()
            sendSelection()
          }}
        >
          <SendHorizontal size={13} /> {contextBus.hasAgent(activeWorkspace) ? t('editor.toAgent') : t('editor.openAgent')} ({t('editor.lines', { n: selBox.lines })})
        </button>
      )}

      {displayed.length > 0 && (
        <div className="hunk-nav">
          <span className="hunk-count"><Bot size={13} /> {t('editor.change', { cur: Math.min(hunkIdx + 1, displayed.length), total: displayed.length })}</span>
          <button className="hunk-btn" title={t('editor.prevChange')} onClick={() => gotoHunk(hunkIdx - 1)}>
            <ChevronLeft size={14} />
          </button>
          <button className="hunk-btn" title={t('editor.nextChange')} onClick={() => gotoHunk(hunkIdx + 1)}>
            <ChevronRight size={14} />
          </button>
        </div>
      )}

      {/* Per-hunk hover toolbar — accept keeps the change, revert undoes it. */}
      {hunkHover && displayed[hunkHover.idx] && (
        <div
          className="hunk-hover"
          style={{ top: hunkHover.top }}
          onMouseEnter={cancelHideHover}
          onMouseLeave={scheduleHideHover}
        >
          <button className="hunk-hover-btn accept" onClick={() => acceptHunk(displayed[hunkHover.idx])}>
            <Check size={13} /> {t('editor.accept')}
          </button>
          <button
            className="hunk-hover-btn revert"
            onClick={() => {
              revertHunk(displayed[hunkHover.idx])
              setHunkHover(null)
            }}
          >
            <Undo2 size={13} /> {t('editor.revert')}
          </button>
        </div>
      )}

      <div className="editor-body" ref={containerRef} style={{ display: file ? 'block' : 'none' }} />
      {!file && (
        <div className="empty-pane">
          <div>
            <p>{t('editor.emptyTitle')}</p>
            <p className="hint">{t('editor.emptyHint')}</p>
          </div>
        </div>
      )}
    </div>
  )
}
