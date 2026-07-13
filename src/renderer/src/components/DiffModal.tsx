import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import * as monaco from 'monaco-editor'
import { languageForPath } from '../editor/EditorPane'
import { editorTheme } from '../editor/highlight'

export default function DiffModal({
  path,
  original,
  modified,
  onClose
}: {
  path: string
  original: string
  modified: string
  onClose: () => void
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const lang = languageForPath(path)
    const diff = monaco.editor.createDiffEditor(ref.current!, {
      theme: editorTheme(),
      readOnly: true,
      automaticLayout: true,
      renderSideBySide: true,
      fontSize: 12,
      minimap: { enabled: false }
    })
    const o = monaco.editor.createModel(original, lang)
    const m = monaco.editor.createModel(modified, lang)
    diff.setModel({ original: o, modified: m })
    return () => {
      diff.dispose()
      o.dispose()
      m.dispose()
    }
  }, [path, original, modified])

  return createPortal(
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal diff-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span>변경 비교 — {path.split('/').pop()} (왼쪽: 이전 · 오른쪽: 에이전트 수정)</span>
          <button className="btn-small" onClick={onClose}>
            닫기
          </button>
        </div>
        <div className="diff-body" ref={ref} />
      </div>
    </div>,
    document.body
  )
}
