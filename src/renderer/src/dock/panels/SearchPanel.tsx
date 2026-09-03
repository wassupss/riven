import { useEffect, useMemo, useRef, useState } from 'react'
import { useSession, pathOf } from '../../state/session'
import { useNav } from '../../state/nav'
import { ensureEditor } from '../registry'
import { useT } from '../../i18n'
import { highlightCode } from '../../components/highlight'
import { CaseSensitive, WholeWord, Regex, ChevronRight, ChevronDown, Replace } from 'lucide-react'

interface Match {
  file: string
  line: number
  column: number
  text: string
  matchStart: number
  matchLength: number
}

// A search-result line: the code, syntax-highlighted, with the matched span
// wrapped in <mark>. Highlight the three segments separately so the mark survives.
function MatchLine({ m }: { m: Match }): JSX.Element {
  const before = m.text.slice(0, m.matchStart)
  const hit = m.text.slice(m.matchStart, m.matchStart + m.matchLength)
  const after = m.text.slice(m.matchStart + m.matchLength)
  return (
    <code className="search-code">
      {highlightCode(before)}
      <mark>{highlightCode(hit, 1000)}</mark>
      {highlightCode(after, 2000)}
    </code>
  )
}

export default function SearchPanel({ workspace: wid }: { workspace: string }): JSX.Element {
  const workspace = pathOf(wid)
  const t = useT()
  const [query, setQuery] = useState('')
  const [replacement, setReplacement] = useState('')
  const [showReplace, setShowReplace] = useState(false)
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [wholeWord, setWholeWord] = useState(false)
  const [regex, setRegex] = useState(false)
  const [matches, setMatches] = useState<Match[]>([])
  const [truncated, setTruncated] = useState(false)
  const [searching, setSearching] = useState(false)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const openFile = useSession((s) => s.openFile)
  const requestReveal = useNav((s) => s.requestReveal)
  const inputRef = useRef<HTMLInputElement>(null)
  const reqSeq = useRef(0)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    if (query.trim()) run()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [caseSensitive, wholeWord, regex])

  const run = async (): Promise<void> => {
    const id = ++reqSeq.current
    if (!query.trim()) {
      setMatches([])
      setTruncated(false)
      return
    }
    setSearching(true)
    const res = await window.api.search.inFiles({ root: workspace, query, caseSensitive, wholeWord, regex })
    if (id !== reqSeq.current) return
    setMatches(res.matches)
    setTruncated(res.truncated)
    setSearching(false)
  }

  const rel = (p: string): string => (p.startsWith(workspace) ? p.slice(workspace.length + 1) : p)

  const grouped = useMemo(() => {
    const g = new Map<string, Match[]>()
    for (const m of matches) {
      if (!g.has(m.file)) g.set(m.file, [])
      g.get(m.file)!.push(m)
    }
    return g
  }, [matches])

  const doReplace = async (): Promise<void> => {
    if (!query.trim() || !matches.length) return
    if (!window.confirm(t('search.replaceConfirm', { q: query, files: grouped.size }))) return
    setSearching(true)
    const res = await window.api.search.replaceInFiles({
      root: workspace,
      query,
      replacement,
      caseSensitive,
      wholeWord,
      regex
    })
    setSearching(false)
    window.alert(t('search.replaced', { r: res.replacements, f: res.files }))
    run()
  }

  const toggleFile = (file: string): void =>
    setCollapsed((s) => {
      const n = new Set(s)
      n.has(file) ? n.delete(file) : n.add(file)
      return n
    })

  const Toggle = ({
    on,
    set,
    title,
    children
  }: {
    on: boolean
    set: () => void
    title: string
    children: JSX.Element
  }): JSX.Element => (
    <button className={`search-toggle${on ? ' on' : ''}`} title={title} onClick={set}>
      {children}
    </button>
  )

  return (
    <div className="search-panel">
      <div className="search-toolbar">
        <button
          className="search-replace-toggle"
          title={t('search.toggleReplace')}
          onClick={() => setShowReplace((v) => !v)}
        >
          {showReplace ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
        <div className="search-fields">
          <div className="search-field">
            <input
              ref={inputRef}
              className="search-input"
              value={query}
              placeholder={t('search.placeholder')}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') run()
              }}
            />
            <div className="search-toggles">
              <Toggle on={caseSensitive} set={() => setCaseSensitive((v) => !v)} title={t('search.caseSensitive')}>
                <CaseSensitive size={14} />
              </Toggle>
              <Toggle on={wholeWord} set={() => setWholeWord((v) => !v)} title={t('search.wholeWord')}>
                <WholeWord size={14} />
              </Toggle>
              <Toggle on={regex} set={() => setRegex((v) => !v)} title={t('search.regex')}>
                <Regex size={14} />
              </Toggle>
            </div>
          </div>
          {showReplace && (
            <div className="search-field">
              <input
                className="search-input"
                value={replacement}
                placeholder={t('search.replacePlaceholder')}
                onChange={(e) => setReplacement(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') doReplace()
                }}
              />
              <button
                className="search-toggle"
                title={t('search.replaceAll')}
                disabled={!matches.length || searching}
                onClick={doReplace}
              >
                <Replace size={14} />
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="search-summary">
        {searching
          ? t('search.searching')
          : matches.length
            ? t('search.summary', {
                n: matches.length,
                more: truncated ? t('search.more') : '',
                files: grouped.size
              })
            : query
              ? t('common.noResults')
              : ''}
      </div>

      <div className="search-results">
        {[...grouped.entries()].map(([file, ms]) => {
          const isCollapsed = collapsed.has(file)
          return (
            <div key={file} className="search-file">
              <div className="search-file-name" title={file} onClick={() => toggleFile(file)}>
                {isCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                <span className="search-file-path">{rel(file)}</span>
                <span className="search-file-count">{ms.length}</span>
              </div>
              {!isCollapsed &&
                ms.map((m, i) => (
                  <div
                    key={i}
                    className="search-match"
                    onClick={() => {
                      openFile(m.file)
                      ensureEditor()
                      requestReveal(m.file, m.line, m.column)
                    }}
                  >
                    <span className="search-line-no">{m.line}</span>
                    <MatchLine m={m} />
                  </div>
                ))}
            </div>
          )
        })}
      </div>
    </div>
  )
}
