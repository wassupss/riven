import type { ConnectionConfig } from './types'

// Command lines for pg_dump / pg_restore / psql. Pure: the renderer shares the
// option types, and the argument building is tested without the tools.

export type DumpFormat = 'custom' | 'plain' | 'directory' | 'tar'
export type DumpContent = 'all' | 'schema' | 'data'
export type ArchiveFormat = DumpFormat

export interface BackupOptions {
  format: DumpFormat
  content: DumpContent
  /** Only these schemas (empty: the whole database). */
  schemas: string[]
  /** Only these tables, as [schema, table] (empty: no table filter). */
  tables: Array<[string, string]>
  noOwner: boolean
  noPrivileges: boolean
  /** Plain format: DROP ... IF EXISTS before each CREATE. */
  clean: boolean
  /** Plain format: include CREATE DATABASE. */
  create: boolean
  /** Data as COPY (fast) or INSERT statements (portable). */
  rows: 'copy' | 'inserts' | 'column-inserts'
  /** 0-9; custom and directory formats. */
  compress: number
  /** Parallel workers; directory format only. */
  jobs: number
}

export interface RestoreOptions {
  path: string
  format: ArchiveFormat
  content: DumpContent
  /** Archive formats: only these schemas (empty: everything in the archive). */
  schemas: string[]
  clean: boolean
  noOwner: boolean
  noPrivileges: boolean
  singleTransaction: boolean
  exitOnError: boolean
  /** Parallel workers; archive formats, not with a single transaction. */
  jobs: number
}

export interface ToolInfo {
  dir: string
  version: string
  major: number
  pgDump: string
  pgRestore: string | null
  psql: string | null
}

export interface ArchiveInfo {
  path: string
  format: ArchiveFormat
  size: number
  /** "Dumped from database version" when the file says. */
  serverVersion?: string
  dumpVersion?: string
  database?: string
  /** Schemas the archive has objects in. */
  schemas: string[]
  /** Object counts by TOC type (TABLE, TABLE DATA, INDEX ...). */
  counts: Record<string, number>
}

export const DUMP_EXT: Record<DumpFormat, string> = { custom: 'dump', plain: 'sql', tar: 'tar', directory: '' }

/** A schema or table name as a pg_dump/pg_restore pattern: quoted, so it matches literally. */
export const patternOf = (...parts: string[]): string => parts.map((p) => `"${p.replace(/"/g, '""')}"`).join('.')

const clampInt = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, Math.floor(Number(n) || 0)))

/** libpq environment for a connection: credentials never go on the command line. */
export function toolEnv(cfg: ConnectionConfig, database: string | undefined, password: string | undefined, home: string): Record<string, string> {
  const expand = (p: string): string => (p.startsWith('~') ? home + p.slice(1) : p)
  const env: Record<string, string> = {
    PGHOST: cfg.host || 'localhost',
    PGPORT: String(cfg.port || 5432),
    PGUSER: cfg.user,
    PGDATABASE: database || cfg.database || 'postgres',
    PGAPPNAME: 'riven',
    PGCONNECT_TIMEOUT: '10'
  }
  if (password) env.PGPASSWORD = password
  // Same as the driver: no SSL unless the connection asks for it.
  const s = cfg.ssl
  env.PGSSLMODE = s ? s.mode : 'disable'
  if (s && s.mode !== 'disable') {
    if (s.ca) env.PGSSLROOTCERT = expand(s.ca)
    if (s.cert) env.PGSSLCERT = expand(s.cert)
    if (s.key) env.PGSSLKEY = expand(s.key)
  }
  return env
}

const CONTENT_FLAG: Record<DumpContent, string | null> = { all: null, schema: '--schema-only', data: '--data-only' }

export function dumpArgs(o: BackupOptions, file: string): string[] {
  const a = [`--format=${o.format}`, `--file=${file}`, '--verbose']
  const content = CONTENT_FLAG[o.content]
  if (content) a.push(content)
  for (const s of o.schemas) a.push(`--schema=${patternOf(s)}`)
  for (const [s, t] of o.tables) a.push(`--table=${patternOf(s, t)}`)
  if (o.noOwner) a.push('--no-owner')
  if (o.noPrivileges) a.push('--no-privileges')
  if (o.format === 'plain') {
    if (o.clean && o.content !== 'data') a.push('--clean', '--if-exists')
    if (o.create && o.content !== 'data') a.push('--create')
  }
  if (o.content !== 'schema') {
    if (o.rows === 'inserts') a.push('--inserts')
    else if (o.rows === 'column-inserts') a.push('--column-inserts')
  }
  if (o.format === 'custom' || o.format === 'directory') a.push(`--compress=${clampInt(o.compress, 0, 9)}`)
  if (o.format === 'directory' && o.jobs > 1) a.push(`--jobs=${clampInt(o.jobs, 1, 16)}`)
  return a
}

/** pg_restore for archives, psql for plain SQL. Connection comes from the environment. */
export function restoreArgs(o: RestoreOptions, stdin = false): { tool: 'pg_restore' | 'psql'; args: string[] } {
  if (o.format === 'plain') {
    const args = ['--no-psqlrc', '--echo-errors', `--file=${stdin ? '-' : o.path}`]
    // In one transaction any error rolls everything back, so stop there and report it as a failure.
    if (o.exitOnError || o.singleTransaction) args.push('--set=ON_ERROR_STOP=1')
    if (o.singleTransaction) args.push('--single-transaction')
    return { tool: 'psql', args }
  }
  // An empty dbname still means "restore into a database"; libpq fills it from PGDATABASE.
  const args = ['--verbose', `--format=${o.format}`, '--dbname=']
  const content = CONTENT_FLAG[o.content]
  if (content) args.push(content)
  for (const s of o.schemas) args.push(`--schema=${s}`)
  if (o.clean && o.content !== 'data') args.push('--clean', '--if-exists')
  if (o.noOwner) args.push('--no-owner')
  if (o.noPrivileges) args.push('--no-privileges')
  if (o.exitOnError) args.push('--exit-on-error')
  if (o.singleTransaction) args.push('--single-transaction')
  else if (o.jobs > 1) args.push(`--jobs=${clampInt(o.jobs, 1, 16)}`)
  args.push(o.path)
  return { tool: 'pg_restore', args }
}

/** "pg_dump (PostgreSQL) 16.2 (Homebrew)" -> { version: '16.2', major: 16 }. */
export function parseToolVersion(out: string): { version: string; major: number } | null {
  const m = /\(PostgreSQL\)\s+(\d+)(?:\.(\d+))?/.exec(out)
  if (!m) return null
  const major = Number(m[1])
  // 9.x majors were two numbers.
  if (major < 10 && m[2] !== undefined) return { version: `${m[1]}.${m[2]}`, major: major + Number(m[2]) / 10 }
  return { version: m[2] !== undefined ? `${m[1]}.${m[2]}` : m[1], major }
}

/** server_version_num -> major (90624 -> 9.6, 160002 -> 16). */
export const serverMajor = (num: number): number => (num >= 100000 ? Math.floor(num / 10000) : Math.floor(num / 10000) + (Math.floor(num / 100) % 100) / 10)

/** Which archive a file is, from its first bytes (512 are enough for tar). */
export function sniffFormat(head: Uint8Array, isDir: boolean): ArchiveFormat {
  if (isDir) return 'directory'
  const ascii = (from: number, n: number): string => String.fromCharCode(...head.subarray(from, from + n))
  if (head.length >= 5 && ascii(0, 5) === 'PGDMP') return 'custom'
  if (head.length >= 262 && ascii(257, 5) === 'ustar') return 'tar'
  return 'plain'
}

/** Header facts from the top of a plain SQL dump. */
export function plainHeader(text: string): Pick<ArchiveInfo, 'serverVersion' | 'dumpVersion'> {
  const out: Pick<ArchiveInfo, 'serverVersion' | 'dumpVersion'> = {}
  const s = /^-- Dumped from database version (\S+)/m.exec(text)
  const d = /^-- Dumped by pg_dump version (\S+)/m.exec(text)
  if (s) out.serverVersion = s[1]
  if (d) out.dumpVersion = d[1]
  return out
}

const TOC_TYPES = [
  'TABLE DATA',
  'SEQUENCE SET',
  'SEQUENCE OWNED BY',
  'FK CONSTRAINT',
  'MATERIALIZED VIEW DATA',
  'MATERIALIZED VIEW',
  'DEFAULT ACL',
  'TABLE ATTACH',
  'INDEX ATTACH',
  'ACL',
  'COMMENT',
  'CONSTRAINT',
  'DEFAULT',
  'EXTENSION',
  'FUNCTION',
  'PROCEDURE',
  'AGGREGATE',
  'INDEX',
  'SCHEMA',
  'SEQUENCE',
  'TABLE',
  'TRIGGER',
  'TYPE',
  'DOMAIN',
  'VIEW',
  'POLICY',
  'ROW SECURITY',
  'RULE',
  'PUBLICATION',
  'SUBSCRIPTION',
  'COLLATION',
  'BLOBS',
  'BLOB'
]

/** Summary of `pg_restore --list` output. */
export function parseToc(out: string): Pick<ArchiveInfo, 'serverVersion' | 'dumpVersion' | 'database' | 'schemas' | 'counts'> {
  const info: ReturnType<typeof parseToc> = { schemas: [], counts: {} }
  const schemas = new Set<string>()
  for (const line of out.split(/\r?\n/)) {
    if (line.startsWith(';')) {
      const kv = /^;\s+(dbname|Dumped from database version|Dumped by pg_dump version):\s*(.*)$/.exec(line)
      if (kv) {
        const v = kv[2].trim()
        if (kv[1] === 'dbname') info.database = v
        else if (kv[1].startsWith('Dumped from')) info.serverVersion = v
        else info.dumpVersion = v
      }
      continue
    }
    // "215; 1259 16385 TABLE public users postgres"
    const m = /^\d+;\s+\d+\s+\d+\s+(.*)$/.exec(line)
    if (!m) continue
    const rest = m[1]
    const type = TOC_TYPES.find((x) => rest.startsWith(x + ' '))
    if (!type) continue
    info.counts[type] = (info.counts[type] ?? 0) + 1
    const after = rest.slice(type.length + 1)
    const schema = after.split(' ')[0]
    if (type === 'SCHEMA') schemas.add(after.split(' ')[1] ?? schema)
    else if (schema && schema !== '-') schemas.add(schema)
  }
  info.schemas = [...schemas].sort()
  return info
}

/** The object a verbose pg_dump / pg_restore line is working on, for progress. */
export function progressObject(line: string): string | null {
  const m = /(?:dumping contents of table|processing data for table|restoring data for table|creating \w+(?: \w+)?)\s+"([^"]+)"/.exec(line)
  return m ? m[1] : null
}

/**
 * Settings a newer pg_dump writes that an older server rejects, by the server
 * major that introduced them. In a plain dump run as one transaction the first
 * failing SET would abort everything after it.
 */
const NEWER_SETTINGS: Array<[number, RegExp]> = [[17, /^SET transaction_timeout = /]]

/** Drops lines a server of this major can't run; null when nothing needs dropping. */
export function plainLineFilter(server: number): ((line: string) => boolean) | null {
  const bad = NEWER_SETTINGS.filter(([since]) => server < since).map(([, re]) => re)
  return bad.length ? (line) => !bad.some((re) => re.test(line)) : null
}
