import '../../styles/notes-panel.css'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { pathOf } from '../../state/session'
import { useT, type TFn } from '../../i18n'
import Markdown from '../../components/Markdown'
import {
  FileText,
  Plus,
  Trash2,
  Eye,
  Pencil,
  Save,
  Bold,
  Italic,
  Heading,
  List,
  ListChecks,
  Link as LinkIcon,
  Code,
  Code2,
  Search,
  Hash,
  ListTree,
  PanelRight,
  Columns2
} from 'lucide-react'

interface NoteMeta {
  name: string
  title: string
  mtime: number
}

interface NoteDoc {
  name: string
  title: string
  body: string
  mtime: number
}

type Mode = 'edit' | 'preview' | 'split'

const rel = (t: TFn, ms: number): string => {
  const s = Math.floor((Date.now() - ms) / 1000)
  if (s < 60) return t('notes.time.now')
  if (s < 3600) return t('notes.time.min', { n: Math.floor(s / 60) })
  if (s < 86400) return t('notes.time.hour', { n: Math.floor(s / 3600) })
  return t('notes.time.day', { n: Math.floor(s / 86400) })
}

// Split raw note markdown into title (leading "# Heading") + body.
const parseRaw = (raw: string, fallback: string): { title: string; body: string } => {
  const m = raw.match(/^#\s+(.+)\n+/)
  if (m) return { title: m[1].trim(), body: raw.slice(m[0].length) }
  return { title: fallback, body: raw }
}

// Extract #tags from a body (skips fenced code blocks). Returns lowercased tags.
const extractTags = (body: string): string[] => {
  const out = new Set<string>()
  let inFence = false
  for (const line of body.split('\n')) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const re = /(^|\s)#([\p{L}\d_-]{1,40})/gu
    let mm: RegExpExecArray | null
    while ((mm = re.exec(line))) out.add(mm[2].toLowerCase())
  }
  return [...out]
}

// Convert [[Target]] / [[Target|Label]] into markdown links pointing at a
// #wiki: fragment (which survives react-markdown's URL sanitizer). Clicks are
// handled via event delegation on the preview container. Skips code spans.
const WIKI_RE = /\[\[([^\]|\n]+)(?:\|([^\]\n]+))?\]\]/g
const transformWiki = (md: string): string => {
  let inFence = false
  return md
    .split('\n')
    .map((line) => {
      if (/^\s*```/.test(line)) {
        inFence = !inFence
        return line
      }
      if (inFence) return line
      // Split off inline code spans (odd indices) so we don't rewrite inside them.
      return line
        .split(/(`[^`]*`)/)
        .map((seg, i) => {
          if (i % 2 === 1) return seg
          return seg.replace(WIKI_RE, (_all, target: string, label?: string) => {
            const t = target.trim()
            const text = (label ?? target).trim()
            return `[${text}](#wiki:${encodeURIComponent(t)})`
          })
        })
        .join('')
    })
    .join('\n')
}

// Scratch markdown notes with an Obsidian-like experience: wikilinks, backlinks,
// tags, search, outline and a split editor/preview. Edits auto-save (debounced).
export default function NotesPanel({ workspace }: { workspace: string }): JSX.Element {
  const t = useT()
  const ws = pathOf(workspace)
  const [notes, setNotes] = useState<NoteMeta[]>([])
  const [docs, setDocs] = useState<Record<string, NoteDoc>>({})
  const [sel, setSel] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [mode, setMode] = useState<Mode>('edit')
  const [query, setQuery] = useState('')
  const [activeTag, setActiveTag] = useState<string | null>(null)
  const [asideOpen, setAsideOpen] = useState(true)

  // Wikilink autocomplete state (while typing "[[").
  const [ac, setAc] = useState<{ start: number; query: string } | null>(null)
  const [acIndex, setAcIndex] = useState(0)

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cacheRef = useRef<Map<string, { mtime: number; raw: string }>>(new Map())
  const taRef = useRef<HTMLTextAreaElement | null>(null)
  const previewRef = useRef<HTMLDivElement | null>(null)
  const pendingSel = useRef<[number, number] | null>(null)

  // ---- content cache (needed for backlinks / tags / search) ----
  const syncDocs = useCallback(
    async (list: NoteMeta[]) => {
      const cache = cacheRef.current
      const next: Record<string, NoteDoc> = {}
      await Promise.all(
        list.map(async (n) => {
          const hit = cache.get(n.name)
          let raw: string
          if (hit && hit.mtime === n.mtime) raw = hit.raw
          else {
            raw = (await window.api.notes.read(ws, n.name)) ?? ''
            cache.set(n.name, { mtime: n.mtime, raw })
          }
          const { title: tt, body: bb } = parseRaw(raw, n.title || n.name)
          next[n.name] = { name: n.name, title: tt, body: bb, mtime: n.mtime }
        })
      )
      // prune deleted notes from cache
      const alive = new Set(list.map((n) => n.name))
      for (const k of [...cache.keys()]) if (!alive.has(k)) cache.delete(k)
      setDocs(next)
    },
    [ws]
  )

  const refresh = useCallback(async () => {
    const list = await window.api.notes.list(ws)
    setNotes(list)
    void syncDocs(list)
    return list
  }, [ws, syncDocs])

  useEffect(() => {
    void refresh()
    const onChanged = (): void => void refresh()
    window.addEventListener('riven:notes-changed', onChanged)
    return () => window.removeEventListener('riven:notes-changed', onChanged)
  }, [refresh])

  const open = useCallback(
    async (name: string) => {
      setSel(name)
      setAc(null)
      const content = (await window.api.notes.read(ws, name)) ?? ''
      const meta = notes.find((n) => n.name === name)
      cacheRef.current.set(name, { mtime: meta?.mtime ?? Date.now(), raw: content })
      const { title: tt, body: bb } = parseRaw(content, meta?.title ?? name)
      setTitle(tt)
      setBody(bb)
    },
    [ws, notes]
  )

  const scheduleSave = useCallback(
    (nextTitle: string, nextBody: string) => {
      if (saveTimer.current) clearTimeout(saveTimer.current)
      saveTimer.current = setTimeout(async () => {
        const untitled = t('notes.untitled')
        const name = await window.api.notes.write(ws, sel, nextTitle || untitled, nextBody)
        if (sel !== name) setSel(name)
        // update cache eagerly so backlinks/tags reflect the edit
        cacheRef.current.set(name, {
          mtime: Date.now(),
          raw: `# ${nextTitle || untitled}\n\n${nextBody}`
        })
        void refresh()
      }, 500)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ws, sel, refresh]
  )

  const setTitleAndSave = (v: string): void => {
    setTitle(v)
    scheduleSave(v, body)
  }
  const setBodyAndSave = (v: string): void => {
    setBody(v)
    scheduleSave(title, v)
  }

  const newNote = useCallback(async (): Promise<void> => {
    const newTitle = t('notes.newTitle')
    const name = await window.api.notes.write(ws, null, newTitle, '')
    await refresh()
    setSel(name)
    setTitle(newTitle)
    setBody('')
    setMode((m) => (m === 'preview' ? 'edit' : m))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws, refresh])

  // Export the note as a real .md file in the workspace (repo).
  const saveToFile = async (): Promise<void> => {
    if (!sel) return
    const suggested = `${(title || 'note').replace(/[^\w가-힣.-]+/g, '-')}.md`
    const relPath = window.prompt(t('notes.saveToFilePrompt'), `docs/${suggested}`)
    if (!relPath?.trim()) return
    const res = await window.api.notes.saveToFile(ws, sel, relPath.trim(), false)
    if (res.ok) window.alert(t('notes.saved', { path: res.path ?? relPath }))
    else if (res.error?.includes('exists')) {
      if (window.confirm(t('notes.overwriteConfirm'))) {
        const r2 = await window.api.notes.saveToFile(ws, sel, relPath.trim(), true)
        if (r2.ok) window.alert(t('notes.saved', { path: r2.path ?? relPath }))
        else window.alert(r2.error ?? t('notes.saveFailed'))
      }
    } else window.alert(res.error ?? t('notes.saveFailed'))
  }

  const del = async (name: string): Promise<void> => {
    await window.api.notes.remove(ws, name)
    cacheRef.current.delete(name)
    if (sel === name) {
      setSel(null)
      setTitle('')
      setBody('')
    }
    void refresh()
  }

  // Resolve a wikilink target to an existing note name (by title or name, ci).
  const resolveWiki = useCallback(
    (target: string): string | null => {
      const q = target.trim().toLowerCase()
      const hit = notes.find(
        (n) => n.title.toLowerCase() === q || n.name.toLowerCase() === q
      )
      return hit?.name ?? null
    },
    [notes]
  )

  const openOrCreateWiki = useCallback(
    async (target: string) => {
      const existing = resolveWiki(target)
      if (existing) {
        void open(existing)
        return
      }
      const name = await window.api.notes.write(ws, null, target.trim() || t('notes.newTitle'), '')
      await refresh()
      void open(name)
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [resolveWiki, open, ws, refresh]
  )

  // ---- derived: tags, filtered list, backlinks, outline ----
  const tags = useMemo(() => {
    const counts = new Map<string, number>()
    for (const d of Object.values(docs))
      for (const tg of extractTags(d.body)) counts.set(tg, (counts.get(tg) ?? 0) + 1)
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  }, [docs])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return notes.filter((n) => {
      const d = docs[n.name]
      if (activeTag) {
        if (!d || !extractTags(d.body).includes(activeTag)) return false
      }
      if (!q) return true
      const hay = `${n.title}\n${d?.body ?? ''}`.toLowerCase()
      return hay.includes(q)
    })
  }, [notes, docs, query, activeTag])

  const backlinks = useMemo(() => {
    if (!sel) return []
    const cur = (title || docs[sel]?.title || '').trim().toLowerCase()
    const curName = sel
    if (!cur) return []
    const out: NoteDoc[] = []
    for (const d of Object.values(docs)) {
      if (d.name === curName) continue
      let mm: RegExpExecArray | null
      const re = new RegExp(WIKI_RE.source, 'g')
      let linked = false
      while ((mm = re.exec(d.body))) {
        if (mm[1].trim().toLowerCase() === cur) {
          linked = true
          break
        }
      }
      if (linked) out.push(d)
    }
    return out.sort((a, b) => b.mtime - a.mtime)
  }, [sel, title, docs])

  const outline = useMemo(() => {
    const out: { depth: number; text: string }[] = []
    let inFence = false
    for (const line of body.split('\n')) {
      if (/^\s*```/.test(line)) {
        inFence = !inFence
        continue
      }
      if (inFence) continue
      const m = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/)
      if (m) out.push({ depth: m[1].length, text: m[2].trim() })
    }
    return out
  }, [body])

  const wordCount = useMemo(
    () => body.split(/\s+/).filter(Boolean).length,
    [body]
  )
  const selMtime = sel ? docs[sel]?.mtime : undefined

  const previewMd = useMemo(
    () => transformWiki(`# ${title}\n\n${body}`),
    [title, body]
  )

  // ---- preview: wire wikilink clicks + mark missing targets ----
  const onPreviewClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const a = (e.target as HTMLElement).closest('a')
      if (!a) return
      const href = a.getAttribute('href') || ''
      if (!href.startsWith('#wiki:')) return
      e.preventDefault()
      void openOrCreateWiki(decodeURIComponent(href.slice('#wiki:'.length)))
    },
    [openOrCreateWiki]
  )

  useLayoutEffect(() => {
    const root = previewRef.current
    if (!root) return
    root.querySelectorAll('a[href^="#wiki:"]').forEach((el) => {
      const href = el.getAttribute('href') || ''
      const target = decodeURIComponent(href.slice('#wiki:'.length))
      el.classList.toggle('notes-wiki--missing', !resolveWiki(target))
    })
  }, [previewMd, resolveWiki, mode])

  // ---- outline navigation ----
  const jumpToHeading = (text: string): void => {
    if (mode !== 'edit') {
      const root = previewRef.current
      const el = [...(root?.querySelectorAll('h1,h2,h3,h4,h5,h6') ?? [])].find(
        (h) => (h.textContent || '').trim() === text
      )
      if (el) {
        el.scrollIntoView({ block: 'start', behavior: 'smooth' })
        return
      }
    }
    // fall back to focusing the matching line in the editor
    const ta = taRef.current
    if (!ta) return
    const idx = body.split('\n').findIndex((l) => l.replace(/^#{1,6}\s+/, '').trim() === text)
    if (idx < 0) return
    const pos = body.split('\n').slice(0, idx).reduce((a, l) => a + l.length + 1, 0)
    ta.focus()
    ta.setSelectionRange(pos, pos)
    const lineHeight = 20
    ta.scrollTop = Math.max(0, idx * lineHeight - 40)
  }

  // ---- editor formatting toolbar ----
  const applyFormat = useCallback(
    (kind: string) => {
      const ta = taRef.current
      if (!ta) return
      const start = ta.selectionStart
      const end = ta.selectionEnd
      const before = body.slice(0, start)
      const selected = body.slice(start, end)
      const after = body.slice(end)

      const wrap = (mark: string): void => {
        const inner = selected || ''
        const next = `${before}${mark}${inner}${mark}${after}`
        setBodyAndSave(next)
        pendingSel.current = [start + mark.length, start + mark.length + inner.length]
      }
      const linePrefix = (prefix: string): void => {
        const block = selected || ''
        const lines = block.length ? block.split('\n') : ['']
        const prefixed = lines.map((l) => `${prefix}${l}`).join('\n')
        const next = `${before}${prefixed}${after}`
        setBodyAndSave(next)
        pendingSel.current = [start, start + prefixed.length]
      }

      switch (kind) {
        case 'bold':
          wrap('**')
          break
        case 'italic':
          wrap('*')
          break
        case 'code':
          wrap('`')
          break
        case 'heading':
          linePrefix('## ')
          break
        case 'bullet':
          linePrefix('- ')
          break
        case 'checkbox':
          linePrefix('- [ ] ')
          break
        case 'link': {
          const label = selected || 'text'
          const inserted = `[${label}](url)`
          const next = `${before}${inserted}${after}`
          setBodyAndSave(next)
          // select the "url" placeholder
          const us = start + label.length + 3
          pendingSel.current = [us, us + 3]
          break
        }
        case 'codeblock': {
          const inner = selected || ''
          const inserted = `\`\`\`\n${inner}\n\`\`\``
          const next = `${before}${inserted}${after}`
          setBodyAndSave(next)
          pendingSel.current = [start + 4, start + 4 + inner.length]
          break
        }
        case 'wikilink': {
          const inserted = '[[]]'
          const next = `${before}${inserted}${after}`
          setBodyAndSave(next)
          pendingSel.current = [start + 2, start + 2]
          break
        }
      }
      requestAnimationFrame(() => ta.focus())
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [body, title]
  )

  // apply queued selection after a programmatic edit
  useLayoutEffect(() => {
    if (pendingSel.current && taRef.current) {
      const [a, b] = pendingSel.current
      taRef.current.setSelectionRange(a, b)
      pendingSel.current = null
    }
  }, [body])

  // ---- wikilink autocomplete detection ----
  const detectAc = (text: string, caret: number): { start: number; query: string } | null => {
    const before = text.slice(0, caret)
    const openIdx = before.lastIndexOf('[[')
    if (openIdx === -1) return null
    const between = before.slice(openIdx + 2)
    if (/[\]\n]/.test(between)) return null
    return { start: openIdx + 2, query: between }
  }

  const acSuggestions = useMemo(() => {
    if (!ac) return []
    const q = ac.query.trim().toLowerCase()
    return notes
      .filter((n) => !q || n.title.toLowerCase().includes(q))
      .slice(0, 8)
  }, [ac, notes])

  const acCanCreate = !!ac && ac.query.trim().length > 0 &&
    !notes.some((n) => n.title.toLowerCase() === ac.query.trim().toLowerCase())

  const acItems = useMemo(() => {
    const items = acSuggestions.map((n) => ({ label: n.title, create: false }))
    if (acCanCreate) items.push({ label: ac!.query.trim(), create: true })
    return items
  }, [acSuggestions, acCanCreate, ac])

  useEffect(() => {
    setAcIndex(0)
  }, [ac?.query])

  const insertWikiTarget = (target: string): void => {
    const ta = taRef.current
    if (!ta || !ac) return
    const caret = ta.selectionStart
    const before = body.slice(0, ac.start)
    const after = body.slice(caret)
    const inserted = `${target}]]`
    const next = `${before}${inserted}${after}`
    setBodyAndSave(next)
    const pos = before.length + inserted.length
    pendingSel.current = [pos, pos]
    setAc(null)
  }

  const onBodyChange = (e: React.ChangeEvent<HTMLTextAreaElement>): void => {
    const v = e.target.value
    setBodyAndSave(v)
    setAc(detectAc(v, e.target.selectionStart))
  }

  const onBodyCaret = (e: React.SyntheticEvent<HTMLTextAreaElement>): void => {
    const ta = e.currentTarget
    setAc(detectAc(ta.value, ta.selectionStart))
  }

  const onBodyKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    // autocomplete navigation
    if (ac && acItems.length) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setAcIndex((i) => (i + 1) % acItems.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setAcIndex((i) => (i - 1 + acItems.length) % acItems.length)
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        insertWikiTarget(acItems[acIndex].label)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setAc(null)
        return
      }
    }
    // Tab inserts two spaces
    if (e.key === 'Tab') {
      e.preventDefault()
      const ta = e.currentTarget
      const start = ta.selectionStart
      const end = ta.selectionEnd
      const next = `${body.slice(0, start)}  ${body.slice(end)}`
      setBodyAndSave(next)
      pendingSel.current = [start + 2, start + 2]
      return
    }
    // Bold / Italic shortcuts
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'b') {
      e.preventDefault()
      applyFormat('bold')
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'i') {
      e.preventDefault()
      applyFormat('italic')
    }
  }

  const modeBtn = (m: Mode, icon: JSX.Element, label: string): JSX.Element => (
    <button
      className={`no-btn${mode === m ? ' active' : ''}`}
      title={label}
      onClick={() => setMode(m)}
    >
      {icon}
    </button>
  )

  const tbBtn = (kind: string, icon: JSX.Element, label: string): JSX.Element => (
    <button className="no-btn" title={label} onMouseDown={(e) => e.preventDefault()} onClick={() => applyFormat(kind)}>
      {icon}
    </button>
  )

  return (
    <div className="notes-panel notes-obsidian">
      {/* left: search + tags + list */}
      <div className="no-side">
        <div className="no-side-head">
          <span>{t('notes.title')}</span>
          <button className="no-btn" title={t('notes.new')} onClick={newNote}>
            <Plus size={14} />
          </button>
        </div>
        <div className="no-search">
          <Search size={13} />
          <input
            value={query}
            placeholder={t('common.search')}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        {tags.length > 0 && (
          <div className="no-tags">
            {tags.map(([tg, count]) => (
              <button
                key={tg}
                className={`no-tag${activeTag === tg ? ' active' : ''}`}
                onClick={() => setActiveTag((a) => (a === tg ? null : tg))}
                title={`#${tg}`}
              >
                <Hash size={10} />
                {tg}
                <span className="no-tag-count">{count}</span>
              </button>
            ))}
          </div>
        )}
        <div className="no-list">
          {filtered.length === 0 && <div className="no-empty">{t('notes.empty')}</div>}
          {filtered.map((n) => (
            <div
              key={n.name}
              className={`no-item${sel === n.name ? ' active' : ''}`}
              onClick={() => open(n.name)}
            >
              <FileText size={13} />
              <span className="no-item-title">{n.title}</span>
              <span className="no-item-time">{rel(t, n.mtime)}</span>
            </div>
          ))}
        </div>
      </div>

      {/* center: title + toolbar + editor/preview */}
      <div className="no-main">
        {sel ? (
          <>
            <div className="no-head">
              <input
                className="no-title"
                value={title}
                placeholder={t('notes.titlePlaceholder')}
                onChange={(e) => setTitleAndSave(e.target.value)}
              />
              <div className="no-seg">
                {modeBtn('edit', <Pencil size={13} />, t('notes.edit'))}
                {modeBtn('split', <Columns2 size={13} />, t('notes.split'))}
                {modeBtn('preview', <Eye size={13} />, t('notes.preview'))}
              </div>
              <button className="no-btn" title={t('notes.saveToFile')} onClick={() => saveToFile()}>
                <Save size={14} />
              </button>
              <button className="no-btn" title={t('notes.delete')} onClick={() => del(sel)}>
                <Trash2 size={14} />
              </button>
              <button
                className={`no-btn${asideOpen ? ' active' : ''}`}
                title={t('notes.panelToggle')}
                onClick={() => setAsideOpen((v) => !v)}
              >
                <PanelRight size={14} />
              </button>
            </div>

            {mode !== 'preview' && (
              <div className="no-toolbar">
                {tbBtn('bold', <Bold size={13} />, t('notes.tbBold'))}
                {tbBtn('italic', <Italic size={13} />, t('notes.tbItalic'))}
                {tbBtn('heading', <Heading size={13} />, t('notes.tbHeading'))}
                <span className="no-sep" />
                {tbBtn('bullet', <List size={13} />, t('notes.tbBullet'))}
                {tbBtn('checkbox', <ListChecks size={13} />, t('notes.tbCheckbox'))}
                <span className="no-sep" />
                {tbBtn('link', <LinkIcon size={13} />, t('notes.tbLink'))}
                {tbBtn('wikilink', <FileText size={13} />, t('notes.tbWikilink'))}
                {tbBtn('code', <Code size={13} />, t('notes.tbCode'))}
                {tbBtn('codeblock', <Code2 size={13} />, t('notes.tbCodeblock'))}
              </div>
            )}

            <div className={`no-body${mode === 'split' ? ' split' : ''}`}>
              {mode !== 'preview' && (
                <div className="no-edit-wrap">
                  <textarea
                    ref={taRef}
                    className="no-textarea"
                    value={body}
                    placeholder={t('notes.bodyPlaceholder')}
                    onChange={onBodyChange}
                    onKeyDown={onBodyKeyDown}
                    onKeyUp={onBodyCaret}
                    onClick={onBodyCaret}
                    spellCheck={false}
                  />
                  {ac && acItems.length > 0 && (
                    <div className="no-autocomplete">
                      {acItems.map((it, i) => (
                        <div
                          key={`${it.label}-${it.create}`}
                          className={`no-ac-item${i === acIndex ? ' active' : ''}${it.create ? ' create' : ''}`}
                          onMouseDown={(e) => {
                            e.preventDefault()
                            insertWikiTarget(it.label)
                          }}
                        >
                          {it.create ? <Plus size={11} /> : <FileText size={11} />}
                          {it.create ? t('notes.acCreate', { label: it.label }) : it.label}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
              {mode !== 'edit' && (
                <div className="no-preview md" ref={previewRef} onClick={onPreviewClick}>
                  <Markdown text={previewMd} />
                </div>
              )}
            </div>

            <div className="no-meta">
              <span>{t('notes.words', { n: wordCount })}</span>
              <span>{t('notes.chars', { n: body.length })}</span>
              {selMtime && <span>{t('notes.modified', { time: rel(t, selMtime) })}</span>}
            </div>
          </>
        ) : (
          <div className="no-main-empty">{t('notes.pick')}</div>
        )}
      </div>

      {/* right: backlinks + outline */}
      {sel && asideOpen && (
        <div className="no-aside">
          <div className="no-aside-sec">
            <div className="no-aside-head">
              <LinkIcon size={12} />
              <span>{t('notes.backlinks')}</span>
              <span className="no-count">{backlinks.length}</span>
            </div>
            {backlinks.length === 0 ? (
              <div className="no-aside-empty">{t('notes.noBacklinks')}</div>
            ) : (
              backlinks.map((d) => (
                <button key={d.name} className="no-link" onClick={() => open(d.name)} title={d.title}>
                  {d.title}
                </button>
              ))
            )}
          </div>
          <div className="no-aside-sec">
            <div className="no-aside-head">
              <ListTree size={12} />
              <span>{t('notes.outline')}</span>
              <span className="no-count">{outline.length}</span>
            </div>
            {outline.length === 0 ? (
              <div className="no-aside-empty">{t('notes.noHeadings')}</div>
            ) : (
              outline.map((h, i) => (
                <button
                  key={`${i}-${h.text}`}
                  className="no-link no-outline-item"
                  style={{ ['--depth' as string]: h.depth }}
                  onClick={() => jumpToHeading(h.text)}
                  title={h.text}
                >
                  {h.text}
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  )
}
