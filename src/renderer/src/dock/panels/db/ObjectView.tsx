import { useEffect, useRef, useState } from 'react'
import * as monaco from 'monaco-editor'
import { KeyRound } from 'lucide-react'
import type { QueryResult, TableInfo } from '../../../../../main/db/types'
import { quoteIdent } from '../../../../../main/db/sqlText'
import { editorTheme } from '../../../editor/highlight'
import { useT } from '../../../i18n'
import { useDb, type ObjectTab } from '../../../state/db'
import { Segmented } from '../../../components/ui/Controls'
import ResultGrid from './ResultGrid'
import { errText } from './ConnectionForm'
import { typeTone } from './tone'

type Sub = 'columns' | 'indexes' | 'constraints' | 'ddl' | 'data'

const DATA_LIMIT = 200

// One table/view/routine: structure, DDL, and a first page of data.
export default function ObjectView({ tab }: { tab: ObjectTab }): JSX.Element {
  const t = useT()
  const conn = useDb((s) => s.connections.find((c) => c.id === tab.connId))
  const openSql = useDb((s) => s.openSql)
  const relation = ['table', 'partitioned', 'view', 'matview', 'foreign'].includes(tab.objKind)
  const [sub, setSub] = useState<Sub>(relation ? 'columns' : 'ddl')
  const [info, setInfo] = useState<{ data?: TableInfo | null; error?: string }>({})
  const [ddl, setDdl] = useState<{ text?: string; error?: string }>({})
  const [data, setData] = useState<{ result?: QueryResult; error?: string; loading?: boolean }>({})

  const qualified = conn ? `${quoteIdent(conn.kind, tab.schema)}.${quoteIdent(conn.kind, tab.name)}` : tab.name

  useEffect(() => {
    if (!relation) return
    let live = true
    setInfo({})
    window.api.db
      .table(tab.connId, tab.db, tab.schema, tab.name)
      .then((data) => live && setInfo({ data }))
      .catch((e) => live && setInfo({ error: errText(e) }))
    return () => {
      live = false
    }
  }, [tab.connId, tab.db, tab.schema, tab.name, relation])

  useEffect(() => {
    if (sub !== 'ddl' || ddl.text !== undefined) return
    let live = true
    window.api.db
      .ddl(tab.connId, tab.db, tab.schema, tab.name)
      .then((text) => live && setDdl({ text }))
      .catch((e) => live && setDdl({ error: errText(e) }))
    return () => {
      live = false
    }
  }, [sub, ddl.text, tab.connId, tab.db, tab.schema, tab.name])

  const loadData = (): void => {
    setData({ loading: true })
    window.api.db
      .query(tab.connId, tab.db, `select * from ${qualified}`, { limit: DATA_LIMIT })
      .then((result) => setData({ result }))
      .catch((e) => setData({ error: errText(e) }))
  }

  useEffect(() => {
    if (sub === 'data' && !data.result && !data.loading && !data.error) loadData()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sub])

  const subs: Array<{ value: Sub; label: string }> = relation
    ? [
        { value: 'columns', label: t('db.columns') },
        { value: 'indexes', label: t('db.indexes') },
        { value: 'constraints', label: t('db.constraints') },
        { value: 'ddl', label: 'DDL' },
        { value: 'data', label: t('db.data') }
      ]
    : [{ value: 'ddl', label: 'DDL' }]

  const ti = info.data

  return (
    <div className="dbx-obj">
      <div className="dbx-obj-head">
        <span className="dbx-obj-title">
          <span className="dbx-meta">{tab.schema}.</span>
          {tab.name}
        </span>
        <span className={`dbx-kind k-${tab.objKind}`}>{t(`db.kind.${tab.objKind}`)}</span>
        {ti?.comment && <span className="dbx-meta">{ti.comment}</span>}
        <span className="dbx-spacer" />
        {relation && conn && (
          <button className="dbx-link" onClick={() => openSql(conn.id, tab.db, `select * from ${qualified} limit 100;`, true)}>
            {t('db.queryIt')}
          </button>
        )}
      </div>
      {subs.length > 1 && (
        <div className="dbx-obj-subs">
          <Segmented value={sub} options={subs} onChange={setSub} />
          {sub === 'data' && (
            <button className="dbx-link" onClick={loadData}>
              {t('db.refresh')}
            </button>
          )}
        </div>
      )}
      <div className="dbx-obj-body">
        {sub === 'ddl' ? (
          ddl.error ? (
            <div className="dbx-error">{ddl.error}</div>
          ) : ddl.text === undefined ? (
            <div className="dbx-empty">{t('db.loading')}</div>
          ) : (
            <DdlView text={ddl.text} />
          )
        ) : sub === 'data' ? (
          data.error ? (
            <div className="dbx-error">{data.error}</div>
          ) : data.result ? (
            <ResultGrid columns={data.result.columns} rows={data.result.rows} />
          ) : (
            <div className="dbx-empty">{t('db.loading')}</div>
          )
        ) : info.error ? (
          <div className="dbx-error">{info.error}</div>
        ) : !ti ? (
          <div className="dbx-empty">{info.data === null ? t('db.notFound') : t('db.loading')}</div>
        ) : sub === 'columns' ? (
          <Table
            head={[t('db.c.name'), t('db.c.type'), t('db.c.nullable'), t('db.c.default'), t('db.c.comment')]}
            rows={ti.columns.map((c) => [
              <span key="n" className={c.primaryKey ? 'dbx-pk' : undefined}>
                {c.primaryKey && <KeyRound size={11} />}
                {c.name}
              </span>,
              <span key="t" className={`dbx-type tone-${typeTone(c.type)}`}>
                {c.type}
              </span>,
              c.nullable ? <span key="u" className="dbx-dim">NULL</span> : <span key="u" className="dbx-notnull">NOT NULL</span>,
              c.default ?? '',
              c.comment ?? ''
            ])}
          />
        ) : sub === 'indexes' ? (
          <Table
            head={[t('db.c.name'), t('db.c.flags'), t('db.c.definition')]}
            rows={ti.indexes.map((i) => [
              i.name,
              <span key="f" className="dbx-flags">
                {i.primary && <span className="dbx-tag pk">PK</span>}
                {i.unique && <span className="dbx-tag uq">UNIQUE</span>}
              </span>,
              i.def
            ])}
          />
        ) : (
          <Table head={[t('db.c.name'), t('db.c.type'), t('db.c.definition')]} rows={ti.constraints.map((c) => [
              c.name,
              <span key="k" className={`dbx-tag c-${c.type.toLowerCase().replace(/[^a-z]/g, '')}`}>
                {c.type}
              </span>,
              c.def
            ])} />
        )}
      </div>
    </div>
  )
}

function Table({ head, rows }: { head: string[]; rows: React.ReactNode[][] }): JSX.Element {
  const t = useT()
  if (!rows.length) return <div className="dbx-empty">{t('db.none')}</div>
  return (
    <div className="dbx-table-wrap">
      <table className="dbx-table">
        <thead>
          <tr>
            {head.map((h) => (
              <th key={h}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {r.map((c, j) => (
                <td key={j}>{c}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function DdlView({ text }: { text: string }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const model = monaco.editor.createModel(text, 'sql')
    const ed = monaco.editor.create(ref.current!, {
      model,
      theme: editorTheme(),
      readOnly: true,
      automaticLayout: true,
      minimap: { enabled: false },
      fontSize: 12,
      scrollBeyondLastLine: false,
      lineNumbers: 'off'
    })
    return () => {
      ed.dispose()
      model.dispose()
    }
  }, [text])
  return <div className="dbx-monaco" ref={ref} />
}
