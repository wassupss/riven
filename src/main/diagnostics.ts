import { ipcMain } from 'electron'
import { execFile } from 'child_process'
import { promisify } from 'util'
import * as fs from 'fs'
import * as path from 'path'

const pexec = promisify(execFile)

// Project-wide diagnostics: runs the workspace's OWN eslint / tsc binaries (never
// a bundled/global one — respects the project's config and version) and returns
// structured problems + the raw tool output for the Output panel. Complements the
// live per-file LSP (tsserver) diagnostics with project-scope + lint results.

export interface Diagnostic {
  path: string // absolute
  line: number
  column: number
  severity: 'error' | 'warning' | 'info'
  message: string
  source: string // 'tsc' | 'eslint'
  code?: string
}

interface RunResult {
  ok: boolean
  diagnostics: Diagnostic[]
  log: string
  error?: string
}

// Local project binary (node_modules/.bin/<name>), or null if not installed.
function localBin(root: string, name: string): string | null {
  const p = path.join(root, 'node_modules', '.bin', name)
  return fs.existsSync(p) ? p : null
}

// ---- eslint ---------------------------------------------------------------
interface EslintMsg {
  line: number
  column: number
  severity: number // 1 = warn, 2 = error
  message: string
  ruleId: string | null
}
interface EslintFile {
  filePath: string
  messages: EslintMsg[]
}

async function runEslint(root: string): Promise<RunResult> {
  const bin = localBin(root, 'eslint')
  if (!bin) return { ok: false, diagnostics: [], log: '', error: 'eslint not installed in this project' }
  let stdout = ''
  let stderr = ''
  try {
    const r = await pexec(bin, ['.', '--format', 'json', '--ext', '.js,.jsx,.ts,.tsx'], {
      cwd: root,
      maxBuffer: 64 * 1024 * 1024,
      timeout: 180_000
    })
    stdout = r.stdout
    stderr = r.stderr
  } catch (e) {
    // eslint exits non-zero when it finds problems — stdout still holds the JSON.
    const err = e as { stdout?: string; stderr?: string; message?: string }
    stdout = err.stdout ?? ''
    stderr = err.stderr ?? err.message ?? ''
  }
  const diagnostics: Diagnostic[] = []
  try {
    const files = JSON.parse(stdout || '[]') as EslintFile[]
    for (const f of files) {
      for (const m of f.messages) {
        diagnostics.push({
          path: f.filePath,
          line: m.line || 1,
          column: m.column || 1,
          severity: m.severity === 2 ? 'error' : 'warning',
          message: m.message,
          source: 'eslint',
          code: m.ruleId ?? undefined
        })
      }
    }
  } catch {
    return { ok: false, diagnostics: [], log: stdout + stderr, error: 'failed to parse eslint output' }
  }
  const log = `$ eslint . --format json\n${stderr}\n${diagnostics.length} problem(s) found.`
  return { ok: true, diagnostics, log }
}

// ---- tsc ------------------------------------------------------------------
// tsc --noEmit --pretty false emits: path(line,col): error TSxxxx: message
const TSC_RE = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.*)$/

async function runTsc(root: string): Promise<RunResult> {
  const bin = localBin(root, 'tsc')
  if (!bin) return { ok: false, diagnostics: [], log: '', error: 'typescript (tsc) not installed in this project' }
  let stdout = ''
  let stderr = ''
  try {
    const r = await pexec(bin, ['--noEmit', '--pretty', 'false'], {
      cwd: root,
      maxBuffer: 64 * 1024 * 1024,
      timeout: 300_000
    })
    stdout = r.stdout
    stderr = r.stderr
  } catch (e) {
    // tsc exits non-zero when there are type errors — the report is on stdout.
    const err = e as { stdout?: string; stderr?: string; message?: string }
    stdout = err.stdout ?? ''
    stderr = err.stderr ?? err.message ?? ''
  }
  const diagnostics: Diagnostic[] = []
  for (const raw of stdout.split('\n')) {
    const m = TSC_RE.exec(raw.trim())
    if (!m) continue
    diagnostics.push({
      path: path.isAbsolute(m[1]) ? m[1] : path.join(root, m[1]),
      line: Number(m[2]) || 1,
      column: Number(m[3]) || 1,
      severity: m[4] === 'warning' ? 'warning' : 'error',
      message: m[6],
      source: 'tsc',
      code: m[5]
    })
  }
  const log = `$ tsc --noEmit\n${stdout}${stderr}\n${diagnostics.length} problem(s) found.`
  return { ok: true, diagnostics, log }
}

export function registerDiagnosticsHandlers(): void {
  ipcMain.handle(
    'diagnostics:run',
    async (_e, root: string, kind: 'eslint' | 'tsc'): Promise<RunResult> => {
      if (!root) return { ok: false, diagnostics: [], log: '', error: 'no workspace' }
      return kind === 'eslint' ? runEslint(root) : runTsc(root)
    }
  )
}
