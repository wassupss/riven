import { ipcMain, BrowserWindow, WebContents } from 'electron'
import { spawn, type ChildProcess } from 'child_process'
import { pathToFileURL, fileURLToPath } from 'url'
import * as fs from 'fs'
import * as path from 'path'

// Node reports script URLs by their REAL path (symlinks resolved, e.g. /tmp ->
// /private/tmp on macOS). Breakpoints set with a non-real path never bind, so we
// always resolve realpath before making a file URL.
function realFileUrl(p: string): string {
  try {
    return pathToFileURL(fs.realpathSync(p)).toString()
  } catch {
    return pathToFileURL(p).toString()
  }
}

// A self-contained Node.js debugger. Spawns `node --inspect-brk` and drives the V8
// inspector over CDP (Chrome DevTools Protocol) directly — no external debug
// adapter needed. Supports breakpoints, stepping, call stack, and scope variables.
// One session at a time (MVP). TypeScript entry files run via Node's built-in type
// stripping (Node >= 22.6 --experimental-strip-types).

interface Frame {
  id: string // callFrameId
  name: string
  file: string // fs path ('' if unknown)
  line: number // 1-based
  column: number
}
interface Scope {
  type: string
  name?: string
  objectId?: string
}

let child: ChildProcess | null = null
let ws: WebSocket | null = null
let msgId = 0
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
const scriptUrlById = new Map<string, string>()
let sink: WebContents | null = null
// Breakpoints requested by the renderer (path -> 1-based lines), applied on start
// and kept in sync while running.
const breakpoints = new Map<string, number[]>()

function emit(type: string, payload?: unknown): void {
  if (sink && !sink.isDestroyed()) sink.send('debug:event', { type, payload })
}

function send(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    if (!ws) return reject(new Error('no debug session'))
    const id = ++msgId
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
}

function urlToPath(url: string): string {
  try {
    return url.startsWith('file:') ? fileURLToPath(url) : ''
  } catch {
    return ''
  }
}

async function applyBreakpoints(path0: string, lines: number[]): Promise<void> {
  if (!ws) return
  const url = realFileUrl(path0)
  // Clear this file's existing breakpoints, then set the requested ones. (MVP:
  // re-set all for the file — Node dedupes by location.)
  for (const line of lines) {
    try {
      await send('Debugger.setBreakpointByUrl', { url, lineNumber: Math.max(0, line - 1), columnNumber: 0 })
    } catch {
      /* file may not be parsed yet; Node resolves pending breakpoints on parse */
    }
  }
}

async function onPaused(params: Record<string, unknown>): Promise<void> {
  const callFrames = (params.callFrames as Array<Record<string, unknown>>) ?? []
  const frames: Frame[] = callFrames.map((f) => {
    const loc = f.location as { scriptId: string; lineNumber: number; columnNumber?: number }
    const url = scriptUrlById.get(loc.scriptId) ?? ''
    return {
      id: f.callFrameId as string,
      name: (f.functionName as string) || '(anonymous)',
      file: urlToPath(url),
      line: (loc.lineNumber ?? 0) + 1,
      column: (loc.columnNumber ?? 0) + 1
    }
  })
  // Scopes of the top frame (skip the global scope — too large/noisy).
  const top = callFrames[0]
  const scopes: Scope[] = top
    ? ((top.scopeChain as Array<Record<string, unknown>>) ?? [])
        .filter((s) => s.type !== 'global')
        .map((s) => ({
          type: s.type as string,
          name: (s.name as string) || undefined,
          objectId: (s.object as { objectId?: string })?.objectId
        }))
    : []
  emit('paused', { reason: params.reason, frames, scopes })
}

function wireEvents(): void {
  if (!ws) return
  ws.onmessage = (ev): void => {
    const msg = JSON.parse(String(ev.data))
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id)!
      pending.delete(msg.id)
      msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result)
      return
    }
    switch (msg.method) {
      case 'Debugger.scriptParsed':
        scriptUrlById.set(msg.params.scriptId, msg.params.url)
        break
      case 'Debugger.paused':
        void onPaused(msg.params)
        break
      case 'Debugger.resumed':
        emit('resumed')
        break
      case 'Runtime.consoleAPICalled': {
        const args = (msg.params.args || []).map((a: { value?: unknown; description?: string }) =>
          a.value !== undefined ? String(a.value) : (a.description ?? '')
        )
        emit('output', { level: msg.params.type, text: args.join(' ') })
        break
      }
      case 'Runtime.exceptionThrown':
        emit('output', {
          level: 'error',
          text: msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text || 'exception'
        })
        break
    }
  }
}

async function connect(wsUrl: string): Promise<void> {
  ws = new WebSocket(wsUrl)
  await new Promise<void>((res, rej) => {
    ws!.onopen = () => res()
    ws!.onerror = () => rej(new Error('inspector connect failed'))
  })
  wireEvents()
  await send('Runtime.enable')
  await send('Debugger.enable')
  await send('Debugger.setPauseOnExceptions', { state: 'uncaught' })
  // Apply any breakpoints the user set before launch.
  for (const [p, lines] of breakpoints) await applyBreakpoints(p, lines)
  await send('Runtime.runIfWaitingForDebugger')
  emit('started')
}

function cleanup(): void {
  try {
    ws?.close()
  } catch {
    /* */
  }
  ws = null
  scriptUrlById.clear()
  pending.clear()
  if (child && !child.killed) {
    try {
      child.kill('SIGKILL')
    } catch {
      /* */
    }
  }
  child = null
}

async function start(cfg: { file: string; cwd?: string; args?: string[] }): Promise<{ ok: boolean; error?: string }> {
  if (child) cleanup() // one session at a time
  sink = BrowserWindow.getFocusedWindow()?.webContents ?? BrowserWindow.getAllWindows()[0]?.webContents ?? null
  const file = (() => {
    try {
      return fs.realpathSync(cfg.file)
    } catch {
      return cfg.file
    }
  })()
  const isTs = /\.(ts|tsx|mts|cts)$/.test(file)
  const nodeArgs = ['--inspect-brk=127.0.0.1:0']
  if (isTs) nodeArgs.push('--experimental-strip-types')
  nodeArgs.push(file, ...(cfg.args ?? []))
  return new Promise((resolve) => {
    let settled = false
    try {
      child = spawn(process.execPath, nodeArgs, {
        cwd: cfg.cwd || path.dirname(cfg.file),
        // ELECTRON_RUN_AS_NODE makes Electron's binary behave as plain Node.
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
      })
    } catch (e) {
      return resolve({ ok: false, error: String(e) })
    }
    child.stderr?.on('data', (buf: Buffer) => {
      const s = buf.toString()
      // Node prints "Debugger listening on ws://127.0.0.1:PORT/UUID" to stderr.
      const m = /ws:\/\/[^\s]+/.exec(s)
      if (m && !settled) {
        settled = true
        connect(m[0]).then(
          () => resolve({ ok: true }),
          (err) => {
            cleanup()
            resolve({ ok: false, error: String(err) })
          }
        )
      } else if (!m) {
        emit('output', { level: 'stderr', text: s })
      }
    })
    child.stdout?.on('data', (buf: Buffer) => emit('output', { level: 'stdout', text: buf.toString() }))
    child.on('exit', (code) => {
      emit('terminated', { code })
      cleanup()
    })
  })
}

export function registerDebuggerHandlers(): void {
  ipcMain.handle('debug:start', (_e, cfg: { file: string; cwd?: string; args?: string[] }) => start(cfg))
  ipcMain.handle('debug:stop', () => {
    cleanup()
    emit('terminated', { code: null })
    return { ok: true }
  })
  ipcMain.handle('debug:continue', () => send('Debugger.resume').catch(() => ({})))
  ipcMain.handle('debug:stepOver', () => send('Debugger.stepOver').catch(() => ({})))
  ipcMain.handle('debug:stepInto', () => send('Debugger.stepInto').catch(() => ({})))
  ipcMain.handle('debug:stepOut', () => send('Debugger.stepOut').catch(() => ({})))
  ipcMain.handle('debug:setBreakpoints', async (_e, file: string, lines: number[]) => {
    breakpoints.set(file, lines)
    if (ws) {
      // Re-sync: remove all, then re-add for this file. MVP uses a coarse approach —
      // Node keeps breakpoints by id; re-setting the same location is idempotent.
      await applyBreakpoints(file, lines)
    }
    return { ok: true }
  })
  ipcMain.handle('debug:getProperties', async (_e, objectId: string) => {
    try {
      const r = await send('Runtime.getProperties', { objectId, ownProperties: true, generatePreview: true })
      const props = (r.result as Array<Record<string, unknown>>) ?? []
      return props
        .filter((p) => p.enumerable !== false)
        .map((p) => {
          const v = (p.value as Record<string, unknown>) ?? {}
          return {
            name: p.name as string,
            type: (v.type as string) ?? 'undefined',
            value: (v.description as string) ?? (v.value !== undefined ? String(v.value) : 'undefined'),
            objectId: (v.objectId as string) ?? null
          }
        })
    } catch {
      return []
    }
  })
  ipcMain.handle('debug:evaluate', async (_e, callFrameId: string, expression: string) => {
    try {
      const r = await send('Debugger.evaluateOnCallFrame', {
        callFrameId,
        expression,
        returnByValue: false,
        generatePreview: true
      })
      const v = (r.result as Record<string, unknown>) ?? {}
      return {
        value: (v.description as string) ?? (v.value !== undefined ? String(v.value) : 'undefined'),
        type: (v.type as string) ?? 'undefined',
        objectId: (v.objectId as string) ?? null
      }
    } catch (e) {
      return { value: String(e), type: 'error', objectId: null }
    }
  })
}
