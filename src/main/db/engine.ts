import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { writeFile } from 'fs/promises'
import { listDatabases, listSchemas, listObjects, tableInfo, objectDdl, findSchema, columnDetail, editTarget, completionMeta } from './meta'
import type { EditStatement } from './edit'
import { DDL_VERBS, type DdlPlan } from './ddl'
import { defaultAcls, listRoles, objectPrivileges, rlsInfo, roleGrants } from './privMeta'
import { indexStats, listLocks, listSessions, listSettings, reloadConf, serverOverview, signalBackend, tableStats } from './monitorMeta'
import {
  closeConnection,
  closeDatabase,
  pgDdl,
  hasSession,
  pgApply,
  pgCancel,
  pgExecute,
  pgQuery,
  pgRows,
  pgSessionClose,
  pgSessionEnd,
  pgSessionQuery,
  pgSessionStatus,
  pgStream,
  pgTest
} from './pg'
import { openExport, XLSX_MAX_ROWS } from './export'
import type { ExportOptions } from './mask'
import type { ImportOptions } from './csv'
import { cancelImport, previewCsv, runImport } from './importer'
import { erdModel } from './erdMeta'
import { schemaSnapshot } from './schemaDiffMeta'
import { cancelSearch, runSearch, searchTables, type SearchOptions } from './dataSearch'
import { cancelDump, findTools, inspectArchive, runBackup, runRestore } from './dump'
import { DUMP_EXT, serverMajor, type BackupOptions, type RestoreOptions, type ToolInfo } from './dumpArgs'
import { deleteConnection, getConnection, listConnections, resolveConnection, saveConnection } from './store'
import { pagedQuery, readOnlyViolation, statements, unsafeStatement } from './sqlText'
import type { ConnectionConfig, PrivTarget, QueryResult } from './types'

// DB engine entry points: the riven_db_* MCP tools (agents) and db:* IPC (panels).
// Lives in main so an agent can use a data source whether or not a DB panel is
// open. PostgreSQL only for now; MySQL/Redis plug in behind the same functions.

const AGENT_TIMEOUT_MS = 30_000
const DDL_TIMEOUT_MS = 10 * 60_000
const AGENT_DEFAULT_LIMIT = 100
const AGENT_MAX_LIMIT = 1000
const CELL_MAX = 500
const OUTPUT_MAX = 20_000

function requirePg(cfg: ConnectionConfig): void {
  if (cfg.kind !== 'postgres') throw new Error(`${cfg.kind} data sources are not supported yet (PostgreSQL only for now)`)
}

// ---- text formatting for agents ----------------------------------------------

const cellText = (v: unknown): string => {
  if (v === null || v === undefined) return 'NULL'
  const t = String(v).replace(/\r?\n/g, '\\n').replace(/\t/g, ' ')
  return t.length > CELL_MAX ? t.slice(0, CELL_MAX) + '…' : t
}

/** Pipe table capped at OUTPUT_MAX chars; says how many rows were cut. */
export function formatTable(headers: string[], rows: unknown[][]): string {
  if (!headers.length) return '(no columns)'
  const cells = rows.map((r) => r.map(cellText))
  const width = headers.map((h, i) => Math.min(60, Math.max(h.length, ...cells.map((r) => (r[i] ?? '').length))))
  const line = (r: string[]): string => r.map((c, i) => c.padEnd(width[i])).join(' | ').trimEnd()
  const out = [line(headers), width.map((w) => '-'.repeat(w)).join('-+-')]
  let len = out[0].length + out[1].length
  for (let i = 0; i < cells.length; i++) {
    const l = line(cells[i])
    if (len + l.length + 1 > OUTPUT_MAX) {
      out.push(`… ${cells.length - i} more row(s) not shown (output limit)`)
      break
    }
    out.push(l)
    len += l.length + 1
  }
  return out.join('\n')
}

function formatResult(r: QueryResult): string {
  if (!r.columns.length) return `${r.command || 'OK'}${r.rowCount !== null ? ` ${r.rowCount}` : ''} (${r.timeMs} ms)`
  const head = `${r.rows.length} row(s)${r.truncated ? ` (truncated at ${r.rows.length}; add LIMIT/WHERE or raise limit)` : ''}, ${r.timeMs} ms`
  return `${head}\n${formatTable(r.columns.map((c) => c.name), r.rows)}`
}

// ---- MCP tools ----------------------------------------------------------------

export type Ask = (question: string, options: string[]) => Promise<string>

const a = (v: unknown): string => (typeof v === 'string' ? v.trim() : v == null ? '' : String(v))

/** schema.table / "Schema"."Table" / table -> [schema|null, table]. */
function splitQualified(name: string): [string | null, string] {
  const parts: string[] = []
  const re = /"((?:[^"]|"")*)"|([^.]+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(name))) parts.push(m[1] !== undefined ? m[1].replace(/""/g, '"') : m[2].trim())
  return parts.length >= 2 ? [parts[parts.length - 2], parts[parts.length - 1]] : [null, parts[0] ?? name]
}

async function toolConnections(): Promise<string> {
  const list = listConnections()
  if (!list.length) return 'No data sources yet. The user can add one in riven (DB Explorer panel).'
  return formatTable(
    ['name', 'kind', 'host', 'database', 'user', 'read_only', 'id'],
    list.map((c) => [c.name, c.kind, `${c.host}:${c.port}`, c.database || '', c.user, c.readOnly ? 'yes' : 'no', c.id])
  )
}

async function toolBrowse(args: Record<string, unknown>): Promise<string> {
  const cfg = resolveConnection(a(args.connection))
  requirePg(cfg)
  const db = a(args.database) || undefined
  const schema = a(args.schema)
  if (schema) {
    const objs = await listObjects(cfg, db, schema)
    if (!objs.length) return `Schema ${schema} has no tables, views or routines (or does not exist).`
    return formatTable(
      ['name', 'kind', 'rows≈ / signature', 'comment'],
      objs.map((o) => [
        o.name,
        o.kind,
        o.args !== undefined ? `(${o.args}) -> ${o.result}` : (o.rows ?? ''),
        o.comment ?? ''
      ])
    )
  }
  // No schema: the database's schemas, plus (when no database was named) the
  // other databases on the server, so one call orients the agent.
  const schemas = (await listSchemas(cfg, db)).filter((s) => !s.isSystem).map((s) => s.name)
  const lines = [
    `Database ${db || cfg.database || 'postgres'} schemas: ${schemas.join(', ') || '(none)'} (system schemas hidden)`
  ]
  if (!db) lines.push(`Databases on this server: ${(await listDatabases(cfg)).join(', ')}`)
  return lines.join('\n')
}

async function toolDescribe(args: Record<string, unknown>): Promise<string> {
  const cfg = resolveConnection(a(args.connection))
  requirePg(cfg)
  const db = a(args.database) || undefined
  const [qs, name] = splitQualified(a(args.table))
  if (!name) return 'error: table is required'
  const schema = a(args.schema) || qs || (await findSchema(cfg, db, name))
  if (!schema) return `error: no table, view or routine named ${name}`
  if (args.ddl === true) return await objectDdl(cfg, db, schema, name)
  const t = await tableInfo(cfg, db, schema, name)
  if (!t) return await objectDdl(cfg, db, schema, name) // a routine: its definition is the description
  const out = [`${t.kind} ${t.schema}.${t.name}${t.comment ? ` -- ${t.comment}` : ''}`]
  out.push(
    formatTable(
      ['column', 'type', 'null', 'default', 'pk', 'comment'],
      t.columns.map((c) => [c.name, c.type, c.nullable ? 'yes' : 'no', c.default ?? '', c.primaryKey ? 'PK' : '', c.comment ?? ''])
    )
  )
  if (t.constraints.length) out.push('Constraints:\n' + t.constraints.map((c) => `  ${c.name} ${c.def}`).join('\n'))
  if (t.indexes.length) out.push('Indexes:\n' + t.indexes.map((i) => `  ${i.def}`).join('\n'))
  return out.join('\n\n')
}

async function toolQuery(args: Record<string, unknown>): Promise<string> {
  const cfg = resolveConnection(a(args.connection))
  requirePg(cfg)
  const sql = a(args.sql).replace(/;\s*$/, '')
  if (!sql) return 'error: sql is required'
  const bad = readOnlyViolation(sql, cfg.kind, true)
  if (bad) return `refused: ${bad}. riven_db_query is read-only; use riven_db_execute for changes.`
  const n = typeof args.limit === 'number' ? Math.floor(args.limit) : AGENT_DEFAULT_LIMIT
  const limit = Math.min(Math.max(n, 1), AGENT_MAX_LIMIT)
  const r = await pgQuery(cfg, a(args.database) || undefined, sql, { limit, readOnly: true, timeoutMs: AGENT_TIMEOUT_MS })
  return formatResult(r)
}

async function toolExecute(args: Record<string, unknown>, ask: Ask): Promise<string> {
  const cfg = resolveConnection(a(args.connection))
  requirePg(cfg)
  if (cfg.readOnly) return `refused: data source "${cfg.name}" is read-only.`
  const raw = Array.isArray(args.statements) ? args.statements.map(a) : [a(args.statements ?? args.sql)]
  const stmts = raw.flatMap((s) => statements(s, cfg.kind))
  if (!stmts.length) return 'error: statements is required'
  const db = a(args.database) || cfg.database || 'postgres'
  const warnings = stmts.map((s) => unsafeStatement(s, cfg.kind)).filter((w): w is string => !!w)
  const preview = stmts.map((s) => (s.length > 300 ? s.slice(0, 300) + '…' : s)).join(';\n')
  const question =
    `${cfg.name} / ${db} 에 아래 SQL ${stmts.length}개를 한 트랜잭션으로 실행할까요?\n\n${preview}` +
    (warnings.length ? `\n\n주의: ${[...new Set(warnings)].join(', ')}` : '')
  const answer = await ask(question, ['실행', '취소'])
  if (answer !== '실행') {
    if (answer.startsWith('riven: ask_user is only available'))
      return 'refused: riven_db_execute needs the user to confirm in a riven chat pane. Show the SQL to the user instead.'
    return `not executed: the user did not approve (${answer || 'no answer'}).`
  }
  const results = await pgExecute(cfg, db, stmts, AGENT_TIMEOUT_MS)
  return 'committed:\n' + results.map((r, i) => `  ${i + 1}. ${r.command}${r.rowCount !== null ? ` ${r.rowCount}` : ''}`).join('\n')
}

/** Run a riven_db_* tool; never throws (errors become the result text). */
export async function runDbTool(tool: string, args: Record<string, unknown>, ask: Ask): Promise<string> {
  try {
    switch (tool) {
      case 'riven_db_connections':
        return await toolConnections()
      case 'riven_db_browse':
        return await toolBrowse(args)
      case 'riven_db_describe':
        return await toolDescribe(args)
      case 'riven_db_query':
        return await toolQuery(args)
      case 'riven_db_execute':
        return await toolExecute(args, ask)
      default:
        return `error: unknown tool ${tool}`
    }
  } catch (e) {
    return `error: ${e instanceof Error ? e.message : String(e)}`
  }
}

// ---- IPC for the DB panels ---------------------------------------------------

function byId(id: string): ConnectionConfig {
  const c = getConnection(id)
  if (!c) throw new Error('Unknown connection')
  requirePg(c)
  return c
}

export function registerDbHandlers(): void {
  ipcMain.handle('db:list', () => listConnections())
  ipcMain.handle('db:save', async (_e, cfg: ConnectionConfig, password?: string | null) => {
    const saved = saveConnection(cfg, password)
    await closeConnection(saved.id) // config may have changed: reconnect lazily
    return saved
  })
  ipcMain.handle('db:delete', async (_e, id: string) => {
    await closeConnection(id)
    deleteConnection(id)
  })
  ipcMain.handle('db:test', (_e, cfg: ConnectionConfig, password?: string) => {
    requirePg(cfg)
    return pgTest(cfg, password)
  })
  ipcMain.handle('db:databases', (_e, id: string) => listDatabases(byId(id)))
  ipcMain.handle('db:schemas', (_e, id: string, db?: string) => listSchemas(byId(id), db))
  ipcMain.handle('db:objects', (_e, id: string, db: string | undefined, schema: string) => listObjects(byId(id), db, schema))
  ipcMain.handle('db:table', (_e, id: string, db: string | undefined, schema: string, name: string) => tableInfo(byId(id), db, schema, name))
  ipcMain.handle('db:ddl', (_e, id: string, db: string | undefined, schema: string, name: string) => objectDdl(byId(id), db, schema, name))
  ipcMain.handle(
    'db:query',
    (
      _e,
      id: string,
      db: string | undefined,
      sql: string,
      o: { limit?: number; queryId?: string; offset?: number; session?: string; aux?: boolean }
    ) => {
      const cfg = byId(id)
      if (cfg.readOnly) {
        const bad = readOnlyViolation(sql, cfg.kind, false)
        if (bad) throw new Error(bad)
      }
      // A later page of an earlier result: only plain reads may be re-run.
      if (o?.offset) {
        const paged = pagedQuery(sql, cfg.kind, o.offset)
        if (!paged) throw new Error('This query cannot be paged')
        sql = paged
      }
      const limit = Math.min(Math.max(o?.limit ?? 1000, 1), 100_000)
      // A manual-commit tab runs on its own connection. Paging and counts join
      // it only while it exists (to see the open transaction's rows).
      if (o?.session && (!o.aux || hasSession(o.session)))
        return pgSessionQuery(cfg, db, o.session, sql, { limit, queryId: o.queryId, aux: o.aux })
      return pgQuery(cfg, db, sql, { limit, queryId: o?.queryId })
    }
  )
  ipcMain.handle('db:session-commit', (_e, session: string) => pgSessionEnd(session, 'commit'))
  ipcMain.handle('db:session-rollback', (_e, session: string) => pgSessionEnd(session, 'rollback'))
  ipcMain.handle('db:session-status', (_e, session: string) => pgSessionStatus(session))
  ipcMain.handle('db:session-close', (_e, session: string) => pgSessionClose(session))
  ipcMain.handle('db:editTarget', (_e, id: string, db: string | undefined, table: number) => editTarget(byId(id), db, table))
  ipcMain.handle('db:apply', (_e, id: string, db: string | undefined, session: string | undefined, stmts: EditStatement[]) => {
    const cfg = byId(id)
    if (cfg.readOnly) throw new Error('This connection is read-only')
    if (!Array.isArray(stmts) || !stmts.length) return []
    return pgApply(cfg, db, session, stmts)
  })
  ipcMain.handle('db:ddl-apply', async (_e, id: string, db: string | undefined, plan: DdlPlan) => {
    const cfg = byId(id)
    if (cfg.readOnly) throw new Error('This connection is read-only')
    const stmts = Array.isArray(plan?.stmts) ? plan.stmts.filter((s) => typeof s === 'string' && s.trim()) : []
    if (!stmts.length) return 0
    const bad = stmts.find((s) => !DDL_VERBS.test(s.trim()))
    if (bad) throw new Error(`Not a DDL statement: ${bad.slice(0, 60)}`)
    // Can't drop the database the statement runs on; ours are closed so they don't block it.
    if (plan.release) {
      if (plan.release === (db || cfg.database || 'postgres')) throw new Error('Run this from another database')
      await closeDatabase(id, plan.release)
    }
    const searchPath = typeof plan.searchPath === 'string' && plan.searchPath ? plan.searchPath : undefined
    return pgDdl(cfg, db, stmts, plan.atomic !== false, DDL_TIMEOUT_MS, searchPath)
  })
  ipcMain.handle('db:roles', (_e, id: string) => listRoles(byId(id)))
  ipcMain.handle('db:privileges', (_e, id: string, db: string | undefined, target: PrivTarget) => objectPrivileges(byId(id), db, target))
  ipcMain.handle('db:default-acl', (_e, id: string, db: string | undefined) => defaultAcls(byId(id), db))
  ipcMain.handle('db:rls', (_e, id: string, db: string | undefined, schema: string, table: string) => rlsInfo(byId(id), db, schema, table))
  ipcMain.handle('db:completion-meta', (_e, id: string, db: string | undefined) => completionMeta(byId(id), db))
  ipcMain.handle('db:role-grants', (_e, id: string, db: string | undefined, role: string) => roleGrants(byId(id), db, role))
  ipcMain.handle('db:mon-overview', (_e, id: string, db: string | undefined) => serverOverview(byId(id), db))
  ipcMain.handle('db:mon-sessions', (_e, id: string, db: string | undefined) => listSessions(byId(id), db))
  ipcMain.handle('db:mon-locks', (_e, id: string, db: string | undefined) => listLocks(byId(id), db))
  ipcMain.handle('db:mon-tables', (_e, id: string, db: string | undefined) => tableStats(byId(id), db))
  ipcMain.handle('db:mon-indexes', (_e, id: string, db: string | undefined) => indexStats(byId(id), db))
  ipcMain.handle('db:mon-settings', (_e, id: string, db: string | undefined) => listSettings(byId(id), db))
  ipcMain.handle('db:mon-signal', (_e, id: string, db: string | undefined, pid: number, terminate: boolean) => {
    const cfg = byId(id)
    if (cfg.readOnly) throw new Error('This connection is read-only')
    if (!Number.isInteger(pid) || pid <= 0) throw new Error('Bad pid')
    return signalBackend(cfg, db, pid, terminate === true)
  })
  ipcMain.handle('db:mon-reload', (_e, id: string, db: string | undefined) => {
    const cfg = byId(id)
    if (cfg.readOnly) throw new Error('This connection is read-only')
    return reloadConf(cfg, db)
  })
  ipcMain.handle('db:cancel',(_e, id: string, queryId: string) => pgCancel(byId(id), queryId))
  ipcMain.handle('db:column', (_e, id: string, db: string | undefined, table: number, attnum: number) =>
    columnDetail(byId(id), db, table, attnum)
  )
  ipcMain.handle('db:erd', (_e, id: string, db: string | undefined, schema: string) => erdModel(byId(id), db, schema))
  ipcMain.handle('db:schema-snapshot', (_e, id: string, db: string | undefined, schema: string) => schemaSnapshot(byId(id), db, schema))
  // Saves renderer-made text (a diagram, a script) through a save dialog.
  ipcMain.handle('db:save-text', async (e, name: string, ext: string, text: string) => {
    if (typeof text !== 'string' || !SAVE_TEXT[ext]) throw new Error('Unsupported file type')
    const win = BrowserWindow.fromWebContents(e.sender)
    // eslint-disable-next-line no-control-regex
    const safe = (name || 'untitled').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 120)
    const opts: Electron.SaveDialogOptions = { defaultPath: `${safe}.${ext}`, filters: [SAVE_TEXT[ext]] }
    const pick = await (win ? dialog.showSaveDialog(win, opts) : dialog.showSaveDialog(opts))
    if (pick.canceled || !pick.filePath) return null
    await writeFile(pick.filePath, text, 'utf8')
    return pick.filePath
  })
  ipcMain.handle('db:import-pick', async (e) => {
    // Dev-only hook for driving the dialog without the native picker.
    if (!app.isPackaged && process.env.RIVEN_DEV_PICK_FILE) return process.env.RIVEN_DEV_PICK_FILE
    const win = BrowserWindow.fromWebContents(e.sender)
    const opts: Electron.OpenDialogOptions = {
      properties: ['openFile'],
      filters: [
        { name: 'CSV / TSV', extensions: ['csv', 'tsv', 'txt'] },
        { name: 'All files', extensions: ['*'] }
      ]
    }
    const pick = await (win ? dialog.showOpenDialog(win, opts) : dialog.showOpenDialog(opts))
    return pick.canceled || !pick.filePaths[0] ? null : pick.filePaths[0]
  })
  ipcMain.handle('db:search-tables', (_e, id: string, db: string | undefined, o: SearchOptions) => searchTables(byId(id), db, o))
  ipcMain.handle('db:search-run', (e, id: string, db: string | undefined, o: SearchOptions, searchId: string) =>
    runSearch(byId(id), db, o, searchId, (p) => {
      if (!e.sender.isDestroyed()) e.sender.send('db:search-progress', searchId, p)
    })
  )
  ipcMain.handle('db:search-cancel', (_e, searchId: string) => cancelSearch(searchId))
  ipcMain.handle('db:import-preview', (_e, path: string, encoding: string, delimiter?: string) => previewCsv(path, encoding, delimiter))
  ipcMain.handle('db:import-run', (e, id: string, db: string | undefined, o: ImportOptions, queryId?: string) => {
    const cfg = byId(id)
    if (cfg.readOnly) throw new Error('This connection is read-only')
    let last = 0
    return runImport(cfg, db, o, queryId, (rows, bytes, size) => {
      const now = Date.now()
      if (!queryId || e.sender.isDestroyed() || (now - last < 100 && bytes < size)) return
      last = now
      e.sender.send('db:import-progress', queryId, rows, bytes, size)
    })
  })
  ipcMain.handle('db:import-cancel', (_e, id: string, queryId: string) => {
    cancelImport(queryId)
    return pgCancel(byId(id), queryId)
  })
  // Backup and restore through pg_dump / pg_restore / psql.
  const toolAt = async (dir: string | undefined, extra?: string): Promise<ToolInfo> => {
    const tools = await findTools(extra)
    const t = dir ? tools.find((x) => x.dir === dir) : tools[0]
    if (!t) throw new Error('pg_dump not found. Install the PostgreSQL client tools or pick their folder.')
    return t
  }
  const progressTo = (e: Electron.IpcMainInvokeEvent, jobId: string) => (obj: string | null, lines: number): void => {
    if (!e.sender.isDestroyed()) e.sender.send('db:backup-progress', jobId, obj, lines)
  }
  ipcMain.handle('db:backup-tools', (_e, extra?: string, refresh?: boolean) => findTools(extra || undefined, refresh === true))
  ipcMain.handle('db:backup-server', async (_e, id: string, db: string | undefined) => {
    const r = await pgRows(byId(id), db, 'show server_version_num')
    return serverMajor(Number(r[0]?.[0]))
  })
  ipcMain.handle('db:backup-run', async (e, id: string, db: string | undefined, toolDir: string | undefined, extra: string | undefined, name: string, o: BackupOptions, jobId: string) => {
    const cfg = byId(id)
    const tool = await toolAt(toolDir, extra)
    let file: string | null = null
    if (!app.isPackaged && process.env.RIVEN_DEV_SAVE_FILE) file = process.env.RIVEN_DEV_SAVE_FILE
    else {
      const win = BrowserWindow.fromWebContents(e.sender)
      // eslint-disable-next-line no-control-regex
      const safe = (name || 'backup').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 120)
      const ext = DUMP_EXT[o.format]
      const opts: Electron.SaveDialogOptions = {
        defaultPath: ext ? `${safe}.${ext}` : safe,
        filters: ext ? [{ name: o.format === 'plain' ? 'SQL' : 'pg_dump archive', extensions: [ext] }] : undefined
      }
      const pick = await (win ? dialog.showSaveDialog(win, opts) : dialog.showSaveDialog(opts))
      if (pick.canceled || !pick.filePath) return null
      file = pick.filePath
    }
    const r = await runBackup(cfg, db, tool, o, file, jobId, progressTo(e, jobId))
    return { path: file, size: r.size, warnings: r.errors.length }
  })
  ipcMain.handle('db:restore-pick', async (e, dir: boolean) => {
    if (!app.isPackaged && process.env.RIVEN_DEV_PICK_FILE) return process.env.RIVEN_DEV_PICK_FILE
    const win = BrowserWindow.fromWebContents(e.sender)
    const opts: Electron.OpenDialogOptions = dir
      ? { properties: ['openDirectory'] }
      : {
          properties: ['openFile'],
          filters: [
            { name: 'Backups', extensions: ['dump', 'backup', 'sql', 'tar', 'pgdump'] },
            { name: 'All files', extensions: ['*'] }
          ]
        }
    const pick = await (win ? dialog.showOpenDialog(win, opts) : dialog.showOpenDialog(opts))
    return pick.canceled || !pick.filePaths[0] ? null : pick.filePaths[0]
  })
  ipcMain.handle('db:restore-inspect', async (_e, path: string, toolDir: string | undefined, extra: string | undefined) => {
    const tool = await toolAt(toolDir, extra).catch(() => undefined)
    return inspectArchive(path, tool)
  })
  ipcMain.handle('db:restore-run', async (e, id: string, db: string | undefined, toolDir: string | undefined, extra: string | undefined, o: RestoreOptions, jobId: string) => {
    const cfg = byId(id)
    if (cfg.readOnly) throw new Error('This connection is read-only')
    const tool = await toolAt(toolDir, extra)
    const ver = await pgRows(cfg, db, 'show server_version_num')
    const r = await runRestore(cfg, db, tool, o, serverMajor(Number(ver[0]?.[0])), jobId, progressTo(e, jobId))
    return { ignored: r.ignored, errors: r.errors }
  })
  ipcMain.handle('db:backup-cancel', (_e, jobId: string) => cancelDump(jobId))
  ipcMain.handle('db:export', async (e, id: string, db: string | undefined, req: ExportRequest) => {
    const cfg = byId(id)
    const o = req.options
    if (!o.columns.length) throw new Error('No columns selected')
    // Rows from the database are re-read through the paging wrapper: plain reads only.
    let sql: string | null = null
    if (req.sql !== undefined) {
      if (cfg.readOnly) {
        const bad = readOnlyViolation(req.sql, cfg.kind, false)
        if (bad) throw new Error(bad)
      }
      sql = pagedQuery(req.sql, cfg.kind, Math.max(0, Math.floor(req.offset ?? 0)))
      if (!sql) throw new Error('This query cannot be exported in full; export the loaded rows instead')
    }
    const win = BrowserWindow.fromWebContents(e.sender)
    const ext = o.format
    const pick = await (win ? dialog.showSaveDialog(win, saveOpts(req.name, ext)) : dialog.showSaveDialog(saveOpts(req.name, ext)))
    if (pick.canceled || !pick.filePath) return null
    const path = pick.filePath
    const w = await openExport(path, o)
    const cap = o.format === 'xlsx' ? XLSX_MAX_ROWS : Number.MAX_SAFE_INTEGER
    let n = 0
    const progress = (): void => {
      if (req.queryId && !e.sender.isDestroyed()) e.sender.send('db:export-progress', req.queryId, n)
    }
    try {
      if (sql) {
        await pgStream(cfg, db, sql, { queryId: req.queryId, max: Math.min(req.max ?? cap, cap) }, async (rows) => {
          await w.rows(rows)
          n += rows.length
          progress()
        })
      } else {
        const rows = req.rows ?? []
        for (let i = 0; i < rows.length; i += 2000) {
          await w.rows(rows.slice(i, i + 2000))
          n = Math.min(i + 2000, rows.length)
        }
      }
      return { path, rows: await w.close() }
    } catch (err) {
      await w.abort()
      throw err
    }
  })
}

interface ExportRequest {
  options: ExportOptions
  /** Suggested file name, without extension. */
  name: string
  /** Rows the grid holds (export of the loaded rows). */
  rows?: Array<Array<string | number | boolean | null>>
  /** Or re-read from the database: this query, from `offset`, at most `max` rows. */
  sql?: string
  offset?: number
  max?: number
  /** Cancel handle (db:cancel) and progress events. */
  queryId?: string
}

const FILTERS: Record<string, { name: string; extensions: string[] }> = {
  xlsx: { name: 'Excel', extensions: ['xlsx'] },
  csv: { name: 'CSV', extensions: ['csv'] },
  tsv: { name: 'TSV', extensions: ['tsv'] },
  json: { name: 'JSON', extensions: ['json'] },
  sql: { name: 'SQL', extensions: ['sql'] }
}

const SAVE_TEXT: Record<string, { name: string; extensions: string[] }> = {
  svg: { name: 'SVG', extensions: ['svg'] },
  sql: { name: 'SQL', extensions: ['sql'] },
  mmd: { name: 'Mermaid', extensions: ['mmd', 'md'] },
  txt: { name: 'Text', extensions: ['txt'] }
}

function saveOpts(name: string, ext: string): Electron.SaveDialogOptions {
  // eslint-disable-next-line no-control-regex
  const safe = (name || 'result').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 120)
  return { defaultPath: `${safe}.${ext}`, filters: [FILTERS[ext]] }
}
