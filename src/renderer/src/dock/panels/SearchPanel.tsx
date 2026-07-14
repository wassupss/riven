import { useEffect, useRef, useState } from 'react'
import { useSession } from '../../state/session'
import { useNav } from '../../state/nav'
import { ensureEditor } from '../registry'
import { useT } from '../../i18n'
import { FileText } from 'lucide-react'

interface Match {
  file: string
  line: number
  column: number
  text: string
  matchStart: number
  matchLength: number
}

export default function SearchPanel({ workspace }: { workspace: string }): JSX.Element {
  const t = useT()
  const [query, setQuery] = useState('')
  const [matches, setMatches] = useState<Match[]>([])
  const [truncated, setTruncated] = useState(false)
  const [searching, setSearching] = useState(false)
  const openFile = useSession((s) => s.openFile)
  const requestReveal = useNav((s) => s.requestReveal)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const run = async (): Promise<void> => {
    if (!query.trim()) {
      setMatches([])
      return
    }
    setSearching(true)
    const res = await window.api.search.inFiles({ root: workspace, query })
    setMatches(res.matches)
    setTruncated(res.truncated)
    setSearching(false)
  }

  const rel = (p: string): string => (p.startsWith(workspace) ? p.slice(workspace.length + 1) : p)

  const grouped = new Map<string, Match[]>()
  for (const m of matches) {
    if (!grouped.has(m.file)) grouped.set(m.file, [])
    grouped.get(m.file)!.push(m)
  }

  return (
    <div className="search-panel">
      <div className="search-bar">
        <input
          ref={inputRef}
          className="url-input"
          value={query}
          placeholder={t('search.placeholder')}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') run()
          }}
        />
        <button className="btn-small" onClick={run}>
          {t('common.search')}
        </button>
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
        {[...grouped.entries()].map(([file, ms]) => (
          <div key={file} className="search-file">
            <div className="search-file-name" title={file}>
              <FileText size={13} /> {rel(file)}
            </div>
            {ms.map((m, i) => (
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
                <span className="search-line-text">
                  {m.text.slice(0, m.matchStart)}
                  <mark>{m.text.slice(m.matchStart, m.matchStart + m.matchLength)}</mark>
                  {m.text.slice(m.matchStart + m.matchLength)}
                </span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}
