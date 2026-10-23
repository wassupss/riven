import { useEffect, useMemo, useRef, useState } from 'react'
import * as monaco from 'monaco-editor'
import { KeyRound } from 'lucide-react'
import type { QueryResult, TableInfo } from '../../../../../main/db/types'
import { quoteIdent } from '../../../../../main/db/sqlText'
import { editorTheme } from '../../../editor/highlight'
import { useT } from '../../../i18n'
import { useDb, type ObjectTab, type RunResult } from '../../../state/db'
import { Segmented } from '../../../components/ui/Controls'
import ResultPane from './ResultPane'
import { errText } from './ConnectionForm'
import { typeTone } from './tone'
import { privKindOf } from '../../../../../main/db/privs'
import GrantsEditor from './GrantsEditor'
import RlsView from './RlsView'

type Sub = 'columns' | 'indexes' | 'constraints' | 'ddl' | 'data' | 'privs' | 'rls'

const DATA_LIMIT = 200

// One table/view/routine: structure, DDL, and its data, paged in as it scrolls.
export default function ObjectView({ tab }: { tab: ObjectTab }): JSX.Element {
  const t = useT()
  const conn = useDb((s) => s.connections.find((c) => c.id === tab.connId))
  const openSql = useDb((s) => s.openSql)
  const openDesign = useDb((s) => s.openDesign)
  // A DDL change in this schema: reload structure and DDL.
  const changed = useDb((s) =>
    s.changed && s.changed.connId === tab.connId && s.changed.db === tab.db && (s.changed.schema === undefined || s.changed.schema === tab.schema)
      ? s.changed.seq
      : 0
  )
  const relation = ['table', 'partitioned', 'view', 'matview', 'foreign'].includes(tab.objKind)
  const [sub, setSub] = useState<Sub>(relation ? 'columns' : 'ddl')
  const [info, setInfo] = useState<{ data?: TableInfo | null; error?: string }>({})
  const [ddl, setDdl] = useState<{ text?: string; error?: string }>({})
  const [data, setData] = useState<{ run?: RunResult & { result: QueryResult }; error?: string; loading?: boolean }>({})
  // Bumped by every reload so a page still in flight can't land on a fresh result.
  const gen = useRef(0)

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
  }, [tab.connId, tab.db, tab.schema, tab.name, relation, changed])

  useEffect(() => {
    if (changed) setDdl({})
  }, [changed])

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

  const dataSql = `select * from ${qualified}`
  const loadData = (): void => {
    const g = ++gen.current
    setData({ loading: true })
    window.api.db
      .query(tab.connId, tab.db, dataSql, { limit: DATA_LIMIT })
      .then((result) => g === gen.current && setData({ run: { sql: dataSql, result } }))
      .catch((e) => g === gen.current && setData({ error: errText(e) }))
  }
  // Paging, sort and filter updates, dropped once a reload replaced the data.
  const patchData = useMemo(() => {
    const g = gen.current
    return (fn: (r: RunResult) => RunResult): void =>
      setData((d) => (g !== gen.current || !d.run ? d : { run: fn(d.run) as RunResult & { result: QueryResult } }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gen.current])

  useEffect(() => {
    if (sub === 'data' && !data.run && !data.loading && !data.error) loadData()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sub])

  const privKind = conn?.kind === 'postgres' ? privKindOf(tab.objKind) : null
  const isTable = tab.objKind === 'table' || tab.objKind === 'partitioned'
  const subs: Array<{ value: Sub; label: string }> = [
    ...(relation
      ? [
          { value: 'columns' as const, label: t('db.columns') },
          { value: 'indexes' as const, label: t('db.indexes') },
          { value: 'constraints' as const, label: t('db.constraints') },
          { value: 'ddl' as const, label: 'DDL' },
          { value: 'data' as const, label: t('db.data') }
        ]
      : [{ value: 'ddl' as const, label: 'DDL' }]),
    ...(privKind ? [{ value: 'privs' as const, label: t('db.r.privileges') }] : []),
    ...(privKind && isTable ? [{ value: 'rls' as const, label: 'RLS' }] : [])
  ]

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
        {conn && !conn.readOnly && (tab.objKind === 'table' || tab.objKind === 'partitioned') && (
          <button className="dbx-link" onClick={() => openDesign(conn.id, tab.db, tab.schema, tab.name)}>
            {t('db.d.design')}
          </button>
        )}
        {relation && conn && (
          <button className="dbx-link" onClick={() => openSql(conn.id, tab.db, `select * from ${qualified};`, true)}>
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
        {sub === 'privs' && privKind ? (
          <div className="dbx-privs-page">
            <GrantsEditor
              connId={tab.connId}
              db={tab.db}
              target={{ kind: privKind, schema: tab.schema, name: tab.name, args: tab.args }}
              readOnly={!!conn?.readOnly}
            />
          </div>
        ) : sub === 'rls' && privKind ? (
          <div className="dbx-privs-page">
            <RlsView connId={tab.connId} db={tab.db} schema={tab.schema} table={tab.name} readOnly={!!conn?.readOnly} />
          </div>
        ) : sub === 'ddl' ? (
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
          ) : data.run && conn ? (
            <ResultPane
              key={gen.current}
              connId={tab.connId}
              db={tab.db}
              kind={conn.kind}
              limit={DATA_LIMIT}
              entry={data.run}
              patch={patchData}
              name={tab.name}
              table={qualified}
              editable={!conn.readOnly}
            />
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
