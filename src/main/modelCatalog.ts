import { spawn } from 'child_process'
import { ipcMain } from 'electron'
import { resolveBin } from './shellPath'

// Which Claude models this account can use, and what each alias means TODAY.
//
// riven's pickers used to hold a fixed list of aliases — default / opus / sonnet
// — with no idea which version any of them resolved to, so the only version a
// user ever saw was the running model's id, mangled into "opus 5 5" after the
// first reply. The CLI knows the real answer: its `initialize` control response
// carries the model list with display names ("Opus 5.5") and the id each alias
// resolves to. Asking for it starts no turn, so it costs nothing.
//
// Cached per config dir, because an account profile decides what is available.

export interface ModelInfo {
  /** What to pass to --model: an alias ("opus") or a pinned id. */
  value: string
  /** The id that value resolves to right now. */
  resolvedModel?: string
  displayName: string
  description?: string
}

const PROBE_ID = 'riven-models'
const TIMEOUT_MS = 20_000

/** Pull the model list out of one line of the CLI's stream-json output. */
export function parseModelsLine(line: string): ModelInfo[] | null {
  let msg: unknown
  try {
    msg = JSON.parse(line)
  } catch {
    return null
  }
  const m = msg as {
    type?: string
    response?: { request_id?: string; subtype?: string; response?: { models?: unknown } }
  }
  if (m.type !== 'control_response' || m.response?.request_id !== PROBE_ID) return null
  const raw = m.response.response?.models
  if (!Array.isArray(raw)) return []
  return raw
    .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
    .filter((x) => typeof x.value === 'string' && typeof x.displayName === 'string')
    .map((x) => ({
      value: x.value as string,
      displayName: x.displayName as string,
      resolvedModel: typeof x.resolvedModel === 'string' ? x.resolvedModel : undefined,
      description: typeof x.description === 'string' ? x.description : undefined
    }))
}

async function probe(configDir?: string): Promise<ModelInfo[] | null> {
  const cmd = await resolveBin('claude')
  if (!cmd) return null
  const env: NodeJS.ProcessEnv = { ...process.env }
  if (configDir) env.CLAUDE_CONFIG_DIR = configDir
  return new Promise((resolve) => {
    let done = false
    let buf = ''
    const proc = spawn(
      cmd,
      [
        '-p',
        '--input-format',
        'stream-json',
        '--output-format',
        'stream-json',
        '--verbose',
        // A question about the account, not a conversation: leave no session
        // file behind for the resume list to show.
        '--no-session-persistence'
      ],
      { env, stdio: ['pipe', 'pipe', 'ignore'] }
    )
    const finish = (models: ModelInfo[] | null): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      try {
        proc.kill()
      } catch {
        /* already gone */
      }
      resolve(models)
    }
    const timer = setTimeout(() => finish(null), TIMEOUT_MS)
    proc.on('error', () => finish(null))
    proc.on('exit', () => finish(null))
    proc.stdout?.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8')
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line) continue
        const models = parseModelsLine(line)
        if (models) return finish(models)
      }
    })
    proc.stdin?.write(
      JSON.stringify({ type: 'control_request', request_id: PROBE_ID, request: { subtype: 'initialize' } }) + '\n'
    )
  })
}

const cache = new Map<string, Promise<ModelInfo[] | null>>()

export function claudeModels(configDir?: string): Promise<ModelInfo[] | null> {
  const key = configDir ?? ''
  let p = cache.get(key)
  if (!p) {
    p = probe(configDir).then((models) => {
      // A failed probe (offline, logged out, CLI missing) is not an answer:
      // forget it so the next picker that opens asks again.
      if (!models) cache.delete(key)
      return models
    })
    cache.set(key, p)
  }
  return p
}

export function registerModelCatalogHandlers(): void {
  ipcMain.handle('models:claude', (_e, configDir?: string) => claudeModels(configDir || undefined))
}
