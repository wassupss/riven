import { useEffect, useMemo, useState } from 'react'
import { CircleAlert, Copy, FileCode2, Search, Square } from 'lucide-react'
import type { SearchHit, SearchMode, SearchOptions } from '../../../../../main/db/dataSearchSql'
import type { SchemaInfo } from '../../../../../main/db/types'
import { useT } from '../../../i18n'
import { Button, Segmented, Select, Switch, TextInput } from '../../../components/ui/Controls'
import { useDb, type SearchTab } from '../../../state/db'
import { useDbSearch } from '../../../state/dbSearch'
import ResultGrid from './ResultGrid'

// Full data search: one value looked up in every table of a database (or one
// schema). Hits arrive table by table; each table's matching rows are shown
// in the grid, and its query can be taken to a console to dig further.

const LS_OPTS = 'db.search.opts'
const PER_TABLE = [10, 100, 500, 1000]
const TIMEOUTS = [5, 30, 120]

type Prefs = Pick<SearchOptions, 'mode' | 'caseSensitive' | 'allTypes' | 'includeViews' | 'perTable' | 'timeoutMs'>
const DEFAULTS: Prefs = { mode: 'contains', caseSensitive: false, allTypes: false, includeViews: false, perTable: 100, timeoutMs: 30_000 }

function loadPrefs(): Prefs {
  try {
    return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(LS_OPTS) ?? '{}') as Partial<Prefs>) }
  } catch {
    return DEFAULTS
  }
}

const hitKey = (h: SearchHit): string => `${h.schema}.${h.table}`

export default function SearchView({ tab }: { tab: SearchTab }): JSX.Element {
  const t = useT()
  const conn = useDb((s) => s.connections.find((c) => c.id === tab.connId))
  const openSql = useDb((s) => s.openSql)
  const setSearchSchemas = useDb((s) => s.setSearchSchemas)
  const run = useDbSearch((s) => s.runs[tab.id])
  const start = useDbSearch((s) => s.start)
  const cancel = useDbSearch((s) => s.cancel)
  const [term, setTerm] = useState(run?.options.term ?? '')
  const [prefs, setPrefs] = useState<Prefs>(() => (run ? { ...DEFAULTS, ...run.options } : loadPrefs()))
  const [schemas, setSchemas] = useState<SchemaInfo[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let live = true
    window.api.db
      .schemas(tab.connId, tab.db)
      .then((s) => live && setSchemas(s.filter((x) => !x.isSystem)))
      .catch(() => live && setSchemas([]))
    return () => {
      live = false
    }
  }, [tab.connId, tab.db])

  const setPref = <K extends keyof Prefs>(k: K, v: Prefs[K]): void =>
    setPrefs((p) => {
      const n = { ...p, [k]: v }
      localStorage.setItem(LS_OPTS, JSON.stringify(n))
      return n
    })

  const go = (): void => {
    if (!term || run?.running) return
    setSelected(null)
    void start(tab.id, tab.connId, tab.db, { ...prefs, term, schemas: tab.schemas })
  }

  const hits = run?.hits ?? []
  const found = useMemo(() => hits.filter((h) => h.result), [hits])
  const failed = hits.length - found.length
  const rows = found.reduce((n, h) => n + (h.result?.rows.length ?? 0), 0)
  // The first hit is shown until the user picks one.
  const hit = hits.find((h) => hitKey(h) === selected) ?? found[0] ?? hits[0] ?? null
  const pct = run?.total ? Math.round((run.done / run.total) * 100) : 0

  const copy = async (): Promise<void> => {
    if (!hit) return
    await navigator.clipboard.writeText(hit.sql)
    setCopied(true)
    setTimeout(() => setCopied(false), 1200)
  }

  return (
    <div className="dbx-obj dbx-search">
      <div className="dbx-obj-head">
        <span className="dbx-obj-title">{t('db.search.heading')}</span>
        <TextInput
          className="dbx-search-term"
          autoFocus
          placeholder={t('db.search.placeholder')}
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') go()
            else if (e.key === 'Escape') cancel(tab.id)
          }}
        />
        <Select value={tab.schemas[0] ?? ''} title={t('db.search.scope')} onChange={(e) => setSearchSchemas(tab.id, e.target.value ? [e.target.value] : [])}>
          <option value="">{t('db.search.allSchemas')}</option>
          {schemas.map((s) => (
            <option key={s.name} value={s.name}>
              {s.name}
            </option>
          ))}
        </Select>
        {run?.running ? (
          <Button onClick={() => cancel(tab.id)}>
            <Square size={12} /> {t('db.search.cancel')}
          </Button>
        ) : (
          <Button variant="primary" disabled={!term} onClick={go}>
            <Search size={13} /> {t('db.search.run')}
          </Button>
        )}
      </div>
      <div className="dbx-search-opts">
        <Segmented<SearchMode>
          value={prefs.mode}
          onChange={(v) => setPref('mode', v)}
          options={[
            { value: 'contains', label: t('db.search.contains') },
            { value: 'exact', label: t('db.search.exact') },
            { value: 'regex', label: t('db.search.regex') }
          ]}
        />
        <label className="dbx-search-opt">
          <Switch checked={prefs.caseSensitive} onChange={(v) => setPref('caseSensitive', v)} /> {t('db.search.case')}
        </label>
        <label className="dbx-search-opt" title={t('db.search.allTypesHint')}>
          <Switch checked={prefs.allTypes} onChange={(v) => setPref('allTypes', v)} /> {t('db.search.allTypes')}
        </label>
        <label className="dbx-search-opt" title={t('db.search.viewsHint')}>
          <Switch checked={prefs.includeViews} onChange={(v) => setPref('includeViews', v)} /> {t('db.search.views')}
        </label>
        <label className="dbx-search-opt">
          {t('db.search.perTable')}
          <Select value={String(prefs.perTable)} onChange={(e) => setPref('perTable', Number(e.target.value))}>
            {PER_TABLE.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </Select>
        </label>
        <label className="dbx-search-opt" title={t('db.search.timeoutHint')}>
          {t('db.search.timeout')}
          <Select value={String(prefs.timeoutMs / 1000)} onChange={(e) => setPref('timeoutMs', Number(e.target.value) * 1000)}>
            {TIMEOUTS.map((n) => (
              <option key={n} value={n}>
                {t('db.search.seconds', { n: String(n) })}
              </option>
            ))}
          </Select>
        </label>
      </div>
      {run && (
        <div className="dbx-search-progress">
          <div className="dbx-search-bar">
            <span style={{ width: `${run.running && run.total === undefined ? 0 : run.running ? pct : 100}%` }} />
          </div>
          <span className="dbx-meta">
            {run.total === undefined && run.running
              ? t('db.search.listing')
              : t('db.search.status', { done: String(run.done), total: String(run.total ?? 0), tables: String(found.length), rows: String(rows) })}
            {failed > 0 && ` · ${t('db.search.failed', { n: String(failed) })}`}
            {run.cancelled && ` · ${t('db.search.cancelled')}`}
            {!run.running && run.ms !== undefined && ` · ${(run.ms / 1000).toFixed(1)}s`}
          </span>
        </div>
      )}
      {run?.error && <div className="dbx-error">{run.error}</div>}
      {!run && <div className="dbx-empty-state">{t('db.search.hint')}</div>}
      {run && !run.running && !run.error && !hits.length && <div className="dbx-empty-state">{t('db.search.none', { term: run.options.term })}</div>}
      {hits.length > 0 && (
        <div className="dbx-diff-body">
          <div className="dbx-diff-list">
            <div className="dbx-diff-items">
              {hits.map((h) => (
                <div
                  key={hitKey(h)}
                  className={`dbx-diff-row${h === hit ? ' sel' : ''}`}
                  onClick={() => setSelected(hitKey(h))}
                  title={h.error ?? `${h.schema}.${h.table}`}
                >
                  {h.error && <CircleAlert size={12} className="dbx-search-err" />}
                  <span className="dbx-diff-name">
                    {tab.schemas.length === 1 ? h.table : `${h.schema}.${h.table}`}
                    {h.kind !== 'table' && <span className="dbx-meta"> {t(`db.search.kind.${h.kind}`)}</span>}
                  </span>
                  {h.result && (
                    <span className="dbx-meta">
                      {h.result.rows.length}
                      {h.result.truncated ? '+' : ''}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
          {hit && (
            <div className="dbx-diff-main">
              <div className="dbx-diff-mig-head dbx-search-hit-head">
                <span className="dbx-diff-name">
                  {hit.schema}.{hit.table}
                </span>
                {hit.result?.truncated && <span className="dbx-meta">{t('db.search.capped', { n: String(hit.result.rows.length) })}</span>}
                <span className="dbx-spacer" />
                <button className="dbx-icon-btn" title={copied ? t('db.diff.copied') : t('db.diff.copy')} onClick={() => void copy()}>
                  <Copy size={13} />
                </button>
                <button className="dbx-icon-btn" title={t('db.search.openConsole')} onClick={() => openSql(tab.connId, tab.db, hit.sql, true)}>
                  <FileCode2 size={13} />
                </button>
              </div>
              {hit.error ? (
                <div className="dbx-error">{hit.error}</div>
              ) : (
                hit.result && (
                  <div className="dbx-result-body">
                    <ResultGrid columns={hit.result.columns} rows={hit.result.rows} />
                  </div>
                )
              )}
            </div>
          )}
        </div>
      )}
      {!conn && <div className="dbx-error">{t('db.search.noConn')}</div>}
    </div>
  )
}
