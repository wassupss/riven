import { ipcMain } from 'electron'

// A structured HTTP request runner for the API-client panel (and reused shape by
// the riven_api_request MCP tool). Runs in main so it's not subject to renderer
// CORS. Returns status + headers + body + timing.

export interface ApiResponse {
  ok: boolean
  status: number
  statusText: string
  headers: Record<string, string>
  body: string
  timeMs: number
  contentType: string
  error?: string
}

export async function runRequest(opts: {
  method: string
  url: string
  headers?: Record<string, string>
  body?: string
}): Promise<ApiResponse> {
  const started = Date.now()
  const method = (opts.method || 'GET').toUpperCase()
  try {
    const res = await fetch(opts.url, {
      method,
      headers: opts.headers ?? {},
      body: method === 'GET' || method === 'HEAD' ? undefined : opts.body
    })
    const body = await res.text()
    const headers: Record<string, string> = {}
    res.headers.forEach((v, k) => (headers[k] = v))
    return {
      ok: res.ok,
      status: res.status,
      statusText: res.statusText,
      headers,
      body,
      timeMs: Date.now() - started,
      contentType: res.headers.get('content-type') ?? ''
    }
  } catch (e) {
    return {
      ok: false,
      status: 0,
      statusText: '',
      headers: {},
      body: '',
      timeMs: Date.now() - started,
      contentType: '',
      error: e instanceof Error ? e.message : String(e)
    }
  }
}

export function registerApiHandlers(): void {
  ipcMain.handle(
    'api:request',
    (_e, opts: { method: string; url: string; headers?: Record<string, string>; body?: string }) =>
      runRequest(opts)
  )
}
