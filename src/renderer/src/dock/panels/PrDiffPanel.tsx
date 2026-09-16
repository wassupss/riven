import { useEffect, useMemo, useRef, useState } from 'react'
import * as monaco from 'monaco-editor'
import { languageForPath } from '../../editor/EditorPane'
import { editorTheme } from '../../editor/highlight'
import { usePrReview, prKey, draftsFor, threadsFor, threadsOnLine } from '../../state/prReview'
import { useT } from '../../i18n'
import { MessageSquarePlus, X } from 'lucide-react'

export interface PrDiffParams {
  repo: string
  number: number
  path: string
}

// One PR file, in the editor riven already has.
//
// The panel's own inline diff is fine for skimming, but a review happens in the
// file: you want the parts the PR did not touch, real syntax highlighting, and
// the ability to comment on a line three screens away from the nearest hunk.
// This is that — a Monaco diff of the base and head blobs, with the PR's
// existing threads marked in the gutter and a comment composer on any line.
//
// Comments made here go into the same pending review as the ones made in the
// panel (see state/prReview): GitHub submits a review and its comments in one
// call, so they cannot belong to whichever view created them.
export default function PrDiffPanel({ params }: { params: PrDiffParams }): JSX.Element {
  const t = useT()
  const { repo, number, path } = params
  const key = prKey(repo, number)
  const hostRef = useRef<HTMLDivElement>(null)
  const diffRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [composing, setComposing] = useState<{ line: number; side: 'LEFT' | 'RIGHT' } | null>(null)
  const [body, setBody] = useState('')

  const allDrafts = usePrReview((s) => s.drafts)
  const allThreads = usePrReview((s) => s.threads)
  const addDraft = usePrReview((s) => s.addDraft)
  const drafts = useMemo(() => draftsFor(allDrafts, key).filter((d) => d.path === path), [allDrafts, key, path])
  const threads = useMemo(() => threadsFor(allThreads, key).filter((th) => th.path === path), [allThreads, key, path])

  // --- the editor ------------------------------------------------------------
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const diff = monaco.editor.createDiffEditor(host, {
      theme: editorTheme(),
      readOnly: true,
      automaticLayout: true,
      renderSideBySide: true,
      fontSize: 12,
      minimap: { enabled: false },
      // The gutter is the affordance: it is where thread markers appear and
      // where a click starts a comment.
      glyphMargin: true,
      scrollBeyondLastLine: false
    })
    diffRef.current = diff
    // Dev/e2e: the diff editor of the last-opened PR file, so a test can ask
    // what decorations it actually has (the DOM only shows the visible ones).
    if (import.meta.env.DEV) (window as unknown as { __rivenPrDiff?: unknown }).__rivenPrDiff = diff

    let disposed = false
    const originals: monaco.editor.ITextModel[] = []
    void window.api.gh
      .prFile(repo, number, path)
      .then((res) => {
        if (disposed) return
        if (!res.ok) {
          setError(res.error ?? 'failed')
          setLoading(false)
          return
        }
        const lang = languageForPath(path)
        const o = monaco.editor.createModel(res.base, lang)
        const m = monaco.editor.createModel(res.head, lang)
        originals.push(o, m)
        diff.setModel({ original: o, modified: m })
        setLoading(false)
      })
      .catch((e) => {
        if (disposed) return
        setError(String(e))
        setLoading(false)
      })

    // A click in either gutter starts a comment on that line, on that side —
    // LEFT is the file as it was, RIGHT as the PR leaves it, which is exactly
    // the distinction GitHub's API wants.
    const listen = (
      ed: monaco.editor.ICodeEditor,
      side: 'LEFT' | 'RIGHT'
    ): monaco.IDisposable =>
      ed.onMouseDown((e) => {
        const kinds = [
          monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN,
          monaco.editor.MouseTargetType.GUTTER_LINE_NUMBERS
        ]
        if (!e.target.position || !kinds.includes(e.target.type)) return
        setComposing({ line: e.target.position.lineNumber, side })
        setBody('')
      })
    const subs = [listen(diff.getOriginalEditor(), 'LEFT'), listen(diff.getModifiedEditor(), 'RIGHT')]

    return () => {
      disposed = true
      subs.forEach((s) => s.dispose())
      diff.dispose()
      originals.forEach((m) => m.dispose())
      diffRef.current = null
    }
  }, [repo, number, path])

  // --- markers for threads and pending comments ------------------------------
  useEffect(() => {
    const diff = diffRef.current
    if (!diff) return
    const collections: monaco.editor.IEditorDecorationsCollection[] = []
    const mark = (ed: monaco.editor.ICodeEditor, side: 'LEFT' | 'RIGHT'): void => {
      const model = ed.getModel()
      if (!model) return
      const decos: monaco.editor.IModelDeltaDecoration[] = []
      const lines = model.getLineCount()
      for (let line = 1; line <= lines; line++) {
        const onLine = threadsOnLine(threads, path, line, side)
        const pending = drafts.filter((d) => d.line === line && d.side === side)
        if (!onLine.length && !pending.length) continue
        // The hover carries the conversation, so a marked line can be read
        // without leaving the file.
        const hover = [
          ...onLine.map((th) => ({
            value: th.comments
              .map((c) => `**${c.author}**${th.isResolved ? ` _(${t('pr.resolved')})_` : ''}\n\n${c.body}`)
              .join('\n\n---\n\n')
          })),
          ...pending.map((d) => ({ value: `**${t('pr.pending')}**\n\n${d.body}` }))
        ]
        decos.push({
          range: new monaco.Range(line, 1, line, 1),
          options: {
            isWholeLine: true,
            glyphMarginClassName: pending.length
              ? 'pr-glyph pending'
              : onLine.every((th) => th.isResolved)
                ? 'pr-glyph resolved'
                : 'pr-glyph',
            linesDecorationsClassName: 'pr-line-mark',
            glyphMarginHoverMessage: hover,
            hoverMessage: hover
          }
        })
      }
      const c = ed.createDecorationsCollection(decos)
      collections.push(c)
    }
    mark(diff.getOriginalEditor(), 'LEFT')
    mark(diff.getModifiedEditor(), 'RIGHT')
    return () => collections.forEach((c) => c.clear())
  }, [threads, drafts, path, loading, t])

  const save = (): void => {
    if (!composing || !body.trim()) return
    addDraft(key, { path, line: composing.line, side: composing.side, body })
    setComposing(null)
    setBody('')
  }

  return (
    <div className="pr-diff-panel">
      <div className="pr-diff-head">
        <span className="pr-diff-path" title={path}>
          {path}
        </span>
        <span className="pr-diff-meta">
          #{number}
          {drafts.length > 0 && (
            <span className="pr-diff-pending">{t('pr.pendingComments', { n: drafts.length })}</span>
          )}
        </span>
      </div>
      {error ? (
        <div className="pr-empty">{t('pr.failed', { err: error })}</div>
      ) : (
        <>
          <div className="pr-diff-host" ref={hostRef} />
          {loading && <div className="pr-diff-loading">{t('pr.loadingDiff')}</div>}
          {composing && (
            <div className="pr-diff-composer">
              <div className="pr-diff-composer-head">
                <MessageSquarePlus size={12} />
                {t('pr.commentOnLineN', { n: composing.line, side: composing.side === 'LEFT' ? '−' : '+' })}
                <button className="pr-diff-composer-x" onClick={() => setComposing(null)} title={t('common.cancel')}>
                  <X size={12} />
                </button>
              </div>
              <textarea
                className="pr-reply-input"
                autoFocus
                value={body}
                placeholder={t('pr.commentPlaceholder')}
                onChange={(e) => setBody(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save()
                  if (e.key === 'Escape') setComposing(null)
                }}
              />
              <div className="pr-reply-actions">
                <button className="btn-small primary" disabled={!body.trim()} onClick={save}>
                  {t('pr.addComment')}
                </button>
                <span className="pr-diff-hint">{t('pr.submitHint')}</span>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
