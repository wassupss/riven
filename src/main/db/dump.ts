import { execFile, spawn, type ChildProcess } from 'child_process'
import { createReadStream, existsSync } from 'fs'
import { open, readdir, rm, stat } from 'fs/promises'
import { homedir } from 'os'
import { delimiter, join } from 'path'
import { createInterface } from 'readline'
import { Readable } from 'stream'
import {
  dumpArgs,
  parseToc,
  plainLineFilter,
  parseToolVersion,
  plainHeader,
  progressObject,
  restoreArgs,
  sniffFormat,
  toolEnv,
  type ArchiveInfo,
  type BackupOptions,
  type RestoreOptions,
  type ToolInfo
} from './dumpArgs'
import { getPassword } from './store'
import type { ConnectionConfig } from './types'

// Backup and restore through the PostgreSQL client tools: found on disk, run
// as child processes with the password in the environment, verbose output
// streamed back as progress.

const WIN = process.platform === 'win32'
const exe = (name: string): string => (WIN ? `${name}.exe` : name)

async function subdirs(parent: string, prefix: string, tail: string): Promise<string[]> {
  try {
    const names = await readdir(parent)
    return names.filter((n) => n.startsWith(prefix)).map((n) => join(parent, n, tail))
  } catch {
    return []
  }
}

// Apps started from Finder get a bare PATH, so the usual install places are searched too.
async function candidateDirs(extra?: string): Promise<string[]> {
  const dirs: string[] = []
  if (extra) dirs.push(extra)
  dirs.push(...(process.env.PATH ?? '').split(delimiter).filter(Boolean))
  if (process.platform === 'darwin') {
    for (const root of ['/opt/homebrew', '/usr/local']) {
      dirs.push(join(root, 'bin'), join(root, 'opt/libpq/bin'))
      dirs.push(...(await subdirs(join(root, 'opt'), 'postgresql', 'bin')))
    }
    dirs.push(...(await subdirs('/Applications/Postgres.app/Contents/Versions', '', 'bin')))
  } else if (WIN) {
    for (const pf of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean) as string[])
      dirs.push(...(await subdirs(join(pf, 'PostgreSQL'), '', 'bin')))
  } else {
    dirs.push('/usr/bin', '/usr/local/bin')
    dirs.push(...(await subdirs('/usr/lib/postgresql', '', 'bin')))
    dirs.push(...(await subdirs('/usr', 'pgsql-', 'bin')))
  }
  return [...new Set(dirs)]
}

const versionOf = (bin: string): Promise<{ version: string; major: number } | null> =>
  new Promise((resolve) => {
    execFile(bin, ['--version'], { timeout: 5000, windowsHide: true }, (err, out) => resolve(err ? null : parseToolVersion(String(out))))
  })

let cache: { key: string; tools: ToolInfo[] } | null = null

/** Every pg_dump found, newest first, with its sibling pg_restore and psql. */
export async function findTools(extra?: string, refresh = false): Promise<ToolInfo[]> {
  const key = extra ?? ''
  if (cache && cache.key === key && !refresh) return cache.tools
  const found: ToolInfo[] = []
  const seen = new Set<string>()
  for (const dir of await candidateDirs(extra)) {
    const bin = join(dir, exe('pg_dump'))
    if (!existsSync(bin)) continue
    const v = await versionOf(bin)
    if (!v || seen.has(`${v.version}`)) continue
    seen.add(v.version)
    const sib = (n: string): string | null => (existsSync(join(dir, exe(n))) ? join(dir, exe(n)) : null)
    found.push({ dir, version: v.version, major: v.major, pgDump: bin, pgRestore: sib('pg_restore'), psql: sib('psql') })
  }
  found.sort((a, b) => b.major - a.major || b.version.localeCompare(a.version, undefined, { numeric: true }))
  cache = { key, tools: found }
  return found
}

const running = new Map<string, ChildProcess>()
const cancelled = new Set<string>()

export function cancelDump(jobId: string): boolean {
  const p = running.get(jobId)
  if (!p) return false
  cancelled.add(jobId)
  p.kill(WIN ? undefined : 'SIGTERM')
  return true
}

export interface ToolRun {
  /** Process exit code (0: success). */
  code: number
  /** Lines that reported errors, most recent last (capped). */
  errors: string[]
  /** Errors carried on past: pg_restore's own count, or psql's error lines. */
  ignored: number
}

const KEEP = 20

function baseEnv(): NodeJS.ProcessEnv {
  // Inherited PG* settings (a PGSERVICE, a stray PGPASSWORD) must not override the connection.
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('PG')) env[k] = v
  return env
}

function run(
  jobId: string,
  bin: string,
  args: string[],
  env: Record<string, string>,
  onLine: (line: string) => void,
  input?: NodeJS.ReadableStream
): Promise<ToolRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { env: { ...baseEnv(), ...env }, windowsHide: true, stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'] })
    running.set(jobId, child)
    // The first errors are the cause, the last ones what stopped it: keep both ends.
    const head: string[] = []
    const tail: string[] = []
    let count = 0
    let ignored = -1
    if (input && child.stdin) {
      input.on('error', () => child.kill())
      child.stdin.on('error', () => {})
      input.pipe(child.stdin)
    }
    const reader = (): ((chunk: Buffer) => void) => {
      let rest = ''
      return (chunk) => {
        const lines = (rest + chunk.toString('utf8')).split(/\r?\n/)
        rest = lines.pop() ?? ''
        for (const line of lines) {
          if (!line) continue
          const ign = /errors ignored on restore:\s*(\d+)/.exec(line)
          if (ign) ignored = Number(ign[1])
          else if (/\b(error|fatal|FATAL|ERROR)\b/.test(line)) {
            count++
            if (head.length < KEEP) head.push(line)
            else {
              tail.push(line)
              if (tail.length > KEEP) tail.shift()
            }
          }
          onLine(line)
        }
      }
    }
    child.stdout?.on('data', reader())
    child.stderr?.on('data', reader())
    child.on('error', (err) => {
      running.delete(jobId)
      reject(err)
    })
    child.on('close', (code) => {
      running.delete(jobId)
      if (input instanceof Readable) input.destroy()
      const skipped = count - head.length - tail.length
      const errors = skipped > 0 ? [...head, `... ${skipped} more ...`, ...tail] : [...head, ...tail]
      resolve({ code: code ?? 1, errors, ignored: ignored >= 0 ? ignored : count })
    })
  })
}

/** Throttled progress: the object being worked on and how many lines went by. */
function progressSink(send: (obj: string | null, lines: number) => void): { line: (l: string) => void; flush: () => void } {
  let obj: string | null = null
  let n = 0
  let last = 0
  return {
    line: (l) => {
      n++
      obj = progressObject(l) ?? obj
      const now = Date.now()
      if (now - last >= 150) {
        last = now
        send(obj, n)
      }
    },
    flush: () => send(obj, n)
  }
}

export async function runBackup(
  cfg: ConnectionConfig,
  db: string | undefined,
  tool: ToolInfo,
  o: BackupOptions,
  file: string,
  jobId: string,
  progress: (obj: string | null, lines: number) => void
): Promise<ToolRun & { size: number }> {
  // A directory dump needs an empty or missing directory; remember which, to clean up after a failure.
  const existed = existsSync(file)
  const sink = progressSink(progress)
  let res: ToolRun
  try {
    res = await run(jobId, tool.pgDump, dumpArgs(o, file), toolEnv(cfg, db, getPassword(cfg.id), homedir()), sink.line)
  } finally {
    sink.flush()
  }
  const failed = res.code !== 0 || cancelled.has(jobId)
  if (failed) {
    if (o.format !== 'directory' || !existed) await rm(file, { recursive: true, force: true }).catch(() => {})
    if (cancelled.delete(jobId)) throw new Error('Cancelled')
    throw new Error(res.errors.slice(-5).join('\n') || `pg_dump exited with code ${res.code}`)
  }
  return { ...res, size: await sizeOf(file) }
}

export async function runRestore(
  cfg: ConnectionConfig,
  db: string | undefined,
  tool: ToolInfo,
  o: RestoreOptions,
  server: number,
  jobId: string,
  progress: (obj: string | null, lines: number) => void
): Promise<ToolRun> {
  // A plain dump from a newer pg_dump goes through a filter for what this server can't run.
  const keep = o.format === 'plain' ? plainLineFilter(server) : null
  const { tool: which, args } = restoreArgs(o, !!keep)
  const bin = which === 'psql' ? tool.psql : tool.pgRestore
  if (!bin) throw new Error(`${which} not found next to ${tool.pgDump}`)
  const input = keep ? filtered(o.path, keep) : undefined
  const sink = progressSink(progress)
  let res: ToolRun
  try {
    res = await run(jobId, bin, args, toolEnv(cfg, db, getPassword(cfg.id), homedir()), sink.line, input)
  } finally {
    sink.flush()
  }
  if (cancelled.delete(jobId)) throw new Error('Cancelled')
  // pg_restore exits 1 when it carried on past errors: a result with warnings, not a failure.
  if (res.code !== 0 && !(which === 'pg_restore' && res.ignored > 0 && !o.exitOnError))
    throw new Error(res.errors.slice(-5).join('\n') || `${which} exited with code ${res.code}`)
  return res
}

function filtered(path: string, keep: (line: string) => boolean): NodeJS.ReadableStream {
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity })
  return Readable.from(
    (async function* () {
      for await (const line of lines) if (keep(line)) yield line + '\n'
    })()
  )
}

async function sizeOf(path: string): Promise<number> {
  const s = await stat(path)
  if (!s.isDirectory()) return s.size
  let total = 0
  for (const n of await readdir(path)) total += (await stat(join(path, n)).catch(() => ({ size: 0 }))).size
  return total
}

/** What a backup file is and what it holds. */
export async function inspectArchive(path: string, tool: ToolInfo | undefined): Promise<ArchiveInfo> {
  const s = await stat(path)
  let head: Uint8Array = new Uint8Array()
  if (!s.isDirectory()) {
    const fh = await open(path, 'r')
    try {
      const buf = Buffer.alloc(Math.min(s.size, 8192))
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0)
      head = buf.subarray(0, bytesRead)
    } finally {
      await fh.close()
    }
  } else if (!existsSync(join(path, 'toc.dat'))) throw new Error('Not a pg_dump directory (no toc.dat)')
  const format = sniffFormat(head, s.isDirectory())
  const size = s.isDirectory() ? await sizeOf(path) : s.size
  if (format === 'plain') return { path, format, size, schemas: [], counts: {}, ...plainHeader(Buffer.from(head).toString('utf8')) }
  if (!tool?.pgRestore) return { path, format, size, schemas: [], counts: {} }
  const out = await new Promise<string>((resolve, reject) => {
    execFile(
      tool.pgRestore as string,
      ['--list', `--format=${format}`, path],
      { timeout: 30_000, maxBuffer: 64 * 1024 * 1024, windowsHide: true, env: baseEnv() },
      (err, stdout, stderr) => (err ? reject(new Error(String(stderr).trim() || err.message)) : resolve(String(stdout)))
    )
  })
  return { path, format, size, ...parseToc(out) }
}
