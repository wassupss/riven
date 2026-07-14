import { useEffect, useMemo, useRef, useState } from 'react'
import { useUI } from '../state/ui'
import { useSession } from '../state/session'
import { ensureEditor } from '../dock/registry'
import { keymap, chordLabel } from '../keybindings/keys'
import { FileIcon } from './FileIcon'
import { useT } from '../i18n'

// Fuzzy subsequence score: all query chars must appear in order. Higher is better;
// rewards consecutive matches, matches right after a separator, and basename hits.
function score(text: string, q: string): number {
  if (!q) return 1
  const t = text.toLowerCase()
  let ti = 0
  let s = 0
  let streak = 0
  for (let qi = 0; qi < q.length; qi++) {
    const c = q[qi]
    const found = t.indexOf(c, ti)
    if (found === -1) return -1
    let pt = 1
    if (found === ti) {
      streak++
      pt += streak * 2
    } else streak = 0
    const prev = found > 0 ? t[found - 1] : '/'
    if (prev === '/' || prev === '.' || prev === '-' || prev === '_') pt += 3
    s += pt
    ti = found + 1
  }
  // Prefer shorter paths + basename matches.
  s += Math.max(0, 20 - text.length / 4)
  return s
}

interface Item {
  key: string
  label: string
  sub?: string
  chord?: string
  icon?: JSX.Element
  run: () => void
}

export default function Palette(): JSX.Element | null {
  const t = useT()
  const mode = useUI((s) => s.palette)
  const setPalette = useUI((s) => s.setPalette)
  const activeWorkspace = useSession((s) => s.activeWorkspace)
  const openFile = useSession((s) => s.openFile)
  const [query, setQuery] = useState('')
  const [files, setFiles] = useState<string[]>([])
  const [sel, setSel] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setQuery('')
    setSel(0)
    if (mode) requestAnimationFrame(() => inputRef.current?.focus())
  }, [mode])

  useEffect(() => {
    if (mode !== 'files' || !activeWorkspace) return
    let alive = true
    window.api.workspace.listFiles(activeWorkspace).then((f) => alive && setFiles(f))
    return () => {
      alive = false
    }
  }, [mode, activeWorkspace])

  const close = (): void => setPalette(null)

  const items: Item[] = useMemo(() => {
    if (mode === 'files') {
      const q = query.toLowerCase().replace(/\s+/g, '')
      const ranked = files
        .map((p) => ({ p, s: score(p, q) }))
        .filter((r) => r.s >= 0)
        .sort((a, b) => b.s - a.s)
        .slice(0, 300)
      return ranked.map(({ p }) => {
        const name = p.split('/').pop() ?? p
        const dir = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : ''
        return {
          key: p,
          label: name,
          sub: dir,
          icon: <FileIcon name={name} size={15} />,
          run: () => {
            if (activeWorkspace) {
              openFile(`${activeWorkspace}/${p}`)
              ensureEditor()
            }
          }
        }
      })
    }
    if (mode === 'commands') {
      const q = query.toLowerCase().replace(/\s+/g, '')
      const actionLabel = (a: { id: string; label: string }): string => {
        if (a.id.startsWith('workspace.switch.'))
          return t('action.workspace.switch', a.label, { n: a.id.split('.').pop() ?? '' })
        if (a.id.startsWith('terminal.select.'))
          return t('action.terminal.select', a.label, { n: a.id.split('.').pop() ?? '' })
        return t(`action.${a.id}`, a.label)
      }
      const catLabel = (c: string): string => t(`category.${c}`, c)
      return keymap
        .list()
        .map((a) => ({ a, label: actionLabel(a), cat: catLabel(a.category) }))
        .map((r) => ({ ...r, s: score(`${r.cat} ${r.label}`, q) }))
        .filter((r) => r.s >= 0)
        .sort((a, b) => b.s - a.s)
        .map(({ a, label, cat }) => ({
          key: a.id,
          label,
          sub: cat,
          chord: chordLabel(keymap.binding(a.id)),
          run: () => a.run()
        }))
    }
    return []
  }, [mode, query, files, activeWorkspace, openFile, t])

  useEffect(() => {
    setSel(0)
  }, [query, mode])

  useEffect(() => {
    listRef.current?.querySelector('.palette-item.sel')?.scrollIntoView({ block: 'nearest' })
  }, [sel])

  if (!mode) return null

  const activate = (i: number): void => {
    const it = items[i]
    if (!it) return
    it.run()
    close()
  }

  const onKey = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') return close()
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSel((s) => Math.min(items.length - 1, s + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSel((s) => Math.max(0, s - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      activate(sel)
    }
  }

  return (
    <div className="modal-overlay palette-overlay" onMouseDown={close}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="palette-input"
          value={query}
          placeholder={mode === 'files' ? t('palette.filePlaceholder') : t('palette.commandPlaceholder')}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKey}
        />
        <div className="palette-list" ref={listRef}>
          {items.length === 0 && <div className="palette-empty">{t('common.noResults')}</div>}
          {items.map((it, i) => (
            <div
              key={it.key}
              className={`palette-item${i === sel ? ' sel' : ''}`}
              onMouseMove={() => i !== sel && setSel(i)}
              onClick={() => activate(i)}
            >
              {it.icon && <span className="palette-icon">{it.icon}</span>}
              <span className="palette-label">{it.label}</span>
              {it.sub && <span className="palette-sub">{it.sub}</span>}
              {it.chord && <span className="palette-chord">{it.chord}</span>}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
