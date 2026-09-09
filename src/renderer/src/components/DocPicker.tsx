import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check } from 'lucide-react'
import { FileIcon } from './FileIcon'
import { score } from '../lib/fuzzy'
import { isDocFile } from '../lib/mediaKind'
import { useT } from '../i18n'

// Picks document files out of a workspace. Used by the notes panel to pull a
// repo's existing markdown/text into notes, so a design doc written in the tree
// can be worked on with wikilinks, tags and backlinks like any other note.
//
// Several files are usually wanted at once (a whole docs/ folder), so rows are
// checkable: Space toggles, Enter imports the checked set (or the highlighted
// row when nothing is checked).

export default function DocPicker({
  root,
  onCancel,
  onPick
}: {
  root: string
  onCancel: () => void
  onPick: (paths: string[]) => void
}): JSX.Element {
  const t = useT()
  const [files, setFiles] = useState<string[] | null>(null)
  const [query, setQuery] = useState('')
  const [sel, setSel] = useState(0)
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let alive = true
    void window.api.workspace.listFiles(root).then((f) => alive && setFiles(f.filter(isDocFile)))
    requestAnimationFrame(() => inputRef.current?.focus())
    return () => {
      alive = false
    }
  }, [root])

  const items = useMemo(() => {
    const q = query.toLowerCase().replace(/\s+/g, '')
    return (files ?? [])
      .map((p) => ({ p, s: score(p, q) }))
      .filter((r) => r.s >= 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 300)
      .map((r) => r.p)
  }, [files, query])

  useEffect(() => {
    setSel(0)
  }, [query])

  useEffect(() => {
    listRef.current?.querySelector('.palette-item.sel')?.scrollIntoView({ block: 'nearest' })
  }, [sel])

  const toggle = (p: string): void =>
    setChecked((prev) => {
      const next = new Set(prev)
      if (next.has(p)) next.delete(p)
      else next.add(p)
      return next
    })

  const confirm = (): void => {
    const picked = checked.size > 0 ? items.filter((p) => checked.has(p)) : items[sel] ? [items[sel]] : []
    if (picked.length > 0) onPick(picked)
  }

  const onKey = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') return onCancel()
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSel((s) => Math.min(items.length - 1, s + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSel((s) => Math.max(0, s - 1))
    } else if (e.key === ' ' && items[sel]) {
      // Only when the query is empty would a space be meaningful text; a picker
      // query never needs one, so Space is free to mean "check this row".
      e.preventDefault()
      toggle(items[sel])
    } else if (e.key === 'Enter') {
      e.preventDefault()
      confirm()
    }
  }

  // Portalled: the notes panel lives inside a dockview group that clips overflow,
  // so an in-tree overlay would be cropped to the panel.
  return createPortal(
    <div className="modal-overlay palette-overlay" onMouseDown={onCancel}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="palette-input"
          value={query}
          placeholder={t('notes.importPlaceholder')}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKey}
        />
        <div className="palette-list" ref={listRef}>
          {files === null && <div className="palette-empty">{t('common.loading')}</div>}
          {files !== null && items.length === 0 && (
            <div className="palette-empty">{t('common.noResults')}</div>
          )}
          {items.map((p, i) => {
            const name = p.split('/').pop() ?? p
            const dir = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : ''
            return (
              <div
                key={p}
                className={`palette-item${i === sel ? ' sel' : ''}`}
                onMouseMove={() => i !== sel && setSel(i)}
                onClick={() => toggle(p)}
                onDoubleClick={() => onPick([p])}
              >
                <span className={`pick-box${checked.has(p) ? ' on' : ''}`}>
                  {checked.has(p) && <Check size={11} />}
                </span>
                <span className="palette-icon">
                  <FileIcon name={name} size={15} />
                </span>
                <span className="palette-label">{name}</span>
                <span className="palette-sub">{dir}</span>
              </div>
            )
          })}
        </div>
        <div className="palette-foot">
          <span>{t('notes.importCount', { n: checked.size })}</span>
          <button className="btn-small" onClick={onCancel}>
            {t('common.cancel')}
          </button>
          <button className="btn-small primary" onClick={confirm} disabled={items.length === 0}>
            {t('notes.importAction')}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
