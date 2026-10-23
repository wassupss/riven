// SQL text rules shared by the DB engine and its MCP tools: statement splitting,
// identifier quoting, and the read-only / dangerous-statement guards.
//
// The scanner must read text the way the SERVER does, since
// the read-only check counts statements with it: MySQL needs whitespace after
// `--` for a comment and runs the body of `/*! ... */`, PostgreSQL nests block
// comments and treats `\` as an escape inside E'...'. A mismatch here is how a
// "single SELECT" smuggles a second statement past the guard.

export type DbKind = 'postgres' | 'mysql' | 'redis'

const isSpace = (c: string): boolean => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v'
const isCtl = (c: string): boolean => c.length > 0 && c.charCodeAt(0) < 0x20
const isDigit = (c: string): boolean => c >= '0' && c <= '9'
const isAlnum = (c: string): boolean => /^[A-Za-z0-9]$/.test(c)
const isWordChar = (c: string): boolean => c === '_' || isAlnum(c) || (c.length > 0 && c.charCodeAt(0) >= 0x80)

// Index just past a `--` / `#` line comment starting at i.
function lineEnd(text: string, i: number): number {
  const j = text.indexOf('\n', i)
  return j < 0 ? text.length : j + 1
}

// `--` starts a comment? (MySQL wants whitespace or a control char after it.)
function dashComment(text: string, i: number, kind: DbKind): boolean {
  if (text[i] !== '-' || text[i + 1] !== '-') return false
  if (kind !== 'mysql') return true
  const n = text[i + 2]
  return n === undefined || isSpace(n) || isCtl(n)
}

// End of a block comment opened at i (PG comments nest).
function blockEnd(text: string, i: number, kind: DbKind): number {
  let depth = 1
  let j = i + 2
  const n = text.length
  while (j < n && depth > 0) {
    if (text[j] === '/' && text[j + 1] === '*' && kind === 'postgres') {
      depth++
      j += 2
    } else if (text[j] === '*' && text[j + 1] === '/') {
      depth--
      j += 2
    } else j++
  }
  return j
}

// End index (exclusive) of a quoted run opened at i by quote char q.
function quoteEnd(text: string, i: number, kind: DbKind, eString: boolean): number {
  const q = text[i]
  const backslash = kind === 'mysql' || eString
  let j = i + 1
  const n = text.length
  while (j < n) {
    if (backslash && text[j] === '\\') {
      j += 2
      continue
    }
    if (text[j] === q) {
      if (text[j + 1] === q) {
        j += 2
        continue
      }
      break
    }
    j++
  }
  return Math.min(j + 1, n)
}

// A PG dollar-quote tag ($$ or $tag$) at i, or null.
function dollarTag(text: string, i: number): string | null {
  const close = text.indexOf('$', i + 1)
  if (close < 0) return null
  const inner = text.slice(i + 1, close)
  if (!/^[A-Za-z0-9_]*$/.test(inner)) return null
  if (inner.length > 0 && isDigit(inner[0])) return null
  return text.slice(i, close + 1)
}

/** Split on `;`, skipping strings, comments and PG dollar quotes. Redis: one command per line. Returns [start, end) ranges. */
export function splitStatements(text: string, kind: DbKind): Array<[number, number]> {
  if (kind === 'redis') {
    const out: Array<[number, number]> = []
    let pos = 0
    for (const line of text.split('\n')) {
      const t = line.trim()
      if (t && !t.startsWith('#') && !t.startsWith('//')) out.push([pos, pos + line.length])
      pos += line.length + 1
    }
    return out
  }
  const out: Array<[number, number]> = []
  const n = text.length
  let start = 0
  let i = 0
  while (i < n) {
    const c = text[i]
    if (dashComment(text, i, kind) || (c === '#' && kind === 'mysql')) {
      i = lineEnd(text, i)
      continue
    }
    if (c === '/' && text[i + 1] === '*') {
      // MySQL /*! ... */ is executed code, not a comment: keep reading inside it.
      if (kind === 'mysql' && text[i + 2] === '!') {
        i += 3
        continue
      }
      i = blockEnd(text, i, kind)
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      const eString =
        kind === 'postgres' &&
        c === "'" &&
        i > 0 &&
        (text[i - 1] === 'e' || text[i - 1] === 'E') &&
        (i < 2 || !isWordChar(text[i - 2]) || text.charCodeAt(i - 2) >= 0x80)
      i = quoteEnd(text, i, kind, eString)
      continue
    }
    if (c === '$' && kind === 'postgres') {
      const tag = dollarTag(text, i)
      if (tag) {
        const j = text.indexOf(tag, i + tag.length)
        i = j < 0 ? n : j + tag.length
        continue
      }
    }
    if (c === ';') {
      out.push([start, i])
      start = i + 1
    }
    i++
  }
  out.push([start, n])
  return out.filter(([s, e]) => text.slice(s, e).trim() !== '')
}

export function statements(text: string, kind: DbKind): string[] {
  return splitStatements(text, kind).map(([s, e]) => text.slice(s, e).trim())
}

// ---- guard ------------------------------------------------------------------

interface Tok {
  text: string
  word: boolean
  depth: number
}

// Words and symbols outside strings/comments (lowercased); depth = paren depth.
function scan(sql: string, kind: DbKind): { toks: Tok[]; execComment: boolean } {
  const toks: Tok[] = []
  const n = sql.length
  const my = kind === 'mysql'
  let i = 0
  let depth = 0
  let execComment = false
  while (i < n) {
    const c = sql[i]
    if (isSpace(c)) {
      i++
      continue
    }
    if (dashComment(sql, i, kind) || (c === '#' && my)) {
      i = lineEnd(sql, i)
      continue
    }
    if (c === '/' && sql[i + 1] === '*') {
      if (my && sql[i + 2] === '!') {
        execComment = true
        i += 3
        while (i < n && isDigit(sql[i])) i++
        continue
      }
      i = blockEnd(sql, i, kind)
      continue
    }
    // A string is one opaque token; a quoted identifier stays a word (it can name things).
    if (c === "'" || c === '"' || c === '`') {
      const eString = kind === 'postgres' && c === "'" && i > 0 && (sql[i - 1] === 'e' || sql[i - 1] === 'E')
      const end = quoteEnd(sql, i, kind, eString)
      const inner = sql.slice(i + 1, Math.max(i + 1, end - 1))
      toks.push(c === "'" ? { text: "'", word: false, depth } : { text: inner.toLowerCase(), word: true, depth })
      i = end
      continue
    }
    if (c === '$' && kind === 'postgres') {
      const tag = dollarTag(sql, i)
      if (tag) {
        const j = sql.indexOf(tag, i + tag.length)
        i = j < 0 ? n : j + tag.length
        toks.push({ text: "'", word: false, depth })
        continue
      }
    }
    if (isWordChar(c)) {
      const s = i
      while (i < n && (isWordChar(sql[i]) || sql[i] === '$')) i++
      toks.push({ text: sql.slice(s, i).toLowerCase(), word: true, depth })
      continue
    }
    if (c === '(') depth++
    toks.push({ text: c, word: false, depth })
    if (c === ')') depth--
    i++
  }
  return { toks, execComment }
}

const READ_WORDS = ['select', 'with', 'values', 'table', 'show', 'explain', 'describe', 'desc']
// A read-only data source's own console may also control its transaction/session.
const SESSION_WORDS = ['begin', 'start', 'commit', 'rollback', 'end', 'abort', 'set', 'use']
// Functions with effects outside the transaction. Blocked when someone else
// (an agent) writes the query.
const SIDE_EFFECT_FUNCS = new Set([
  'pg_terminate_backend', 'pg_cancel_backend', 'pg_reload_conf', 'pg_rotate_logfile', 'pg_read_file',
  'pg_read_binary_file', 'pg_ls_dir', 'pg_stat_file', 'pg_ls_logdir', 'pg_ls_waldir', 'pg_ls_tmpdir',
  'pg_ls_archive_statusdir', 'pg_file_write', 'lo_import', 'lo_export', 'dblink', 'dblink_exec',
  'dblink_connect', 'dblink_send_query', 'set_config', 'pg_switch_wal', 'pg_create_restore_point',
  'pg_promote', 'pg_advisory_lock', 'pg_advisory_xact_lock', 'pg_try_advisory_lock', 'pg_sleep',
  'pg_sleep_for', 'pg_sleep_until',
  'load_file', 'sleep', 'benchmark', 'get_lock', 'release_lock', 'release_all_locks'
])

/** Why `sql` may not run read-only, or null. strict = agent-written (also blocks side-effect functions). */
export function readOnlyViolation(sql: string, kind: DbKind, strict: boolean): string | null {
  if (kind === 'redis') return null
  if (splitStatements(sql, kind).length !== 1) return 'Read-only mode runs exactly one statement'
  const sc = scan(sql, kind)
  if (sc.execComment) return 'MySQL executable comments (/*! ... */) are not allowed in read-only mode'
  const first = sc.toks.find((t) => t.word)?.text ?? ''
  const allowed = READ_WORDS.includes(first) || (!strict && SESSION_WORDS.includes(first))
  if (!allowed) return `Read-only mode: '${first}' statements are not allowed`
  const words = sc.toks.map((t) => t.text)
  const pairs = (a: string, b: string): boolean => words.some((w, k) => w === a && words[k + 1] === b)
  if (words.some((w) => w.includes('read_only')) || pairs('read', 'write'))
    return 'Read-only mode: changing the read-only setting is not allowed'
  if (pairs('into', 'outfile') || pairs('into', 'dumpfile'))
    return 'Read-only mode: SELECT ... INTO OUTFILE/DUMPFILE is not allowed'
  if (strict) {
    for (let k = 0; k < sc.toks.length; k++) {
      const t = sc.toks[k]
      if (t.word && sc.toks[k + 1]?.text === '(' && SIDE_EFFECT_FUNCS.has(t.text))
        return `Read-only mode: ${t.text}() is not allowed (it has side effects outside the transaction)`
    }
  }
  return null
}

/** Reason to confirm before running: UPDATE/DELETE without WHERE, DROP, TRUNCATE. */
export function unsafeStatement(sql: string, kind: DbKind): string | null {
  if (kind === 'redis') {
    const cmd = (sql.trim().split(/\s+/)[0] ?? '').toUpperCase()
    return ['FLUSHALL', 'FLUSHDB', 'DEL', 'UNLINK', 'SHUTDOWN'].includes(cmd) ? `${cmd} deletes data` : null
  }
  const top = scan(sql, kind)
    .toks.filter((t) => t.depth === 0 && t.word)
    .map((t) => t.text)
  const verb =
    top[0] === 'with'
      ? top.slice(1).find((w) => ['select', 'insert', 'update', 'delete', 'merge'].includes(w))
      : top[0]
  if (verb === 'drop') return `DROP ${(top[1] ?? '').toUpperCase()} removes the object and its data`
  if (verb === 'truncate') return 'TRUNCATE deletes every row'
  if ((verb === 'update' || verb === 'delete') && !top.includes('where'))
    return `${verb.toUpperCase()} without WHERE changes every row`
  return null
}

// Words that make re-running a query unsafe or impossible: writes (a data-
// modifying CTE would apply again), SELECT ... INTO, row locks, sequences.
const NOT_PAGEABLE = new Set(['insert', 'update', 'delete', 'merge', 'into', 'for', 'nextval', 'setval'])

/**
 * The query re-read from `offset` on, or null when it can't be paged that way.
 * Used to load more rows of a result: it re-runs the query, so only a plain
 * read qualifies. Without an ORDER BY the server may return rows in a different
 * order next time; the console accepts that, as every LIMIT/OFFSET pager does.
 */
export function pagedQuery(sql: string, kind: DbKind, offset: number): string | null {
  if (kind !== 'postgres' || splitStatements(sql, kind).length !== 1) return null
  const sc = scan(sql, kind)
  if (sc.execComment) return null
  const words = sc.toks.filter((t) => t.word).map((t) => t.text)
  if (!['select', 'with', 'values', 'table'].includes(words[0] ?? '')) return null
  if (words.some((w) => NOT_PAGEABLE.has(w) || SIDE_EFFECT_FUNCS.has(w))) return null
  const body = sql.trim().replace(/;\s*$/, '')
  // Newlines, so a trailing `-- comment` can't swallow the closing paren.
  return `select * from (\n${body}\n) as riven_page offset ${Math.max(0, Math.floor(offset))}`
}

// ---- identifiers ------------------------------------------------------------

// Words that break the grammar unquoted (PG + MySQL union; quoting one needlessly is harmless).
const RESERVED = new Set(
  (
    'all analyse analyze and any array as asc asymmetric between both by case cast change check collate column ' +
    'condition constraint create cross current_date current_role current_time current_timestamp current_user ' +
    'database default deferrable delete desc distinct do drop else end except exists false fetch for foreign from ' +
    'full grant group having in index initially inner insert interval intersect into is join key keys lateral ' +
    'leading left like limit localtime localtimestamp match natural not null offset on only or order outer placing ' +
    'primary range rank read references returning right row rows select session_user set some symmetric table then ' +
    'to trailing true union unique update usage user using values variadic when where window with write'
  ).split(' ')
)

export function quoteIdent(kind: DbKind, s: string): string {
  if (kind === 'redis') return s
  const re = kind === 'postgres' ? /^[a-z_][a-z0-9_]*$/ : /^[A-Za-z_][A-Za-z0-9_]*$/
  if (!RESERVED.has(s.toLowerCase()) && re.test(s)) return s
  return kind === 'mysql' ? '`' + s.replace(/`/g, '``') + '`' : '"' + s.replace(/"/g, '""') + '"'
}

export function literal(kind: DbKind, v: string | null): string {
  if (v === null) return 'NULL'
  if (kind === 'mysql') return "'" + v.replace(/\\/g, '\\\\').replace(/'/g, "''") + "'"
  return "'" + v.replace(/'/g, "''") + "'"
}
