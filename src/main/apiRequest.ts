// riven_api_request: run an HTTP request and return a compact status/headers/body
// summary. Body is truncated so a huge response doesn't flood the transcript.
// Its own module so the Tauri build's Node tool runner (tauri/shim/moved/
// mcpServer.ts) can run it without the MCP server.
export async function runApiRequest(args: Record<string, unknown>): Promise<string> {
  const method = String(args.method ?? 'GET').toUpperCase()
  const url = String(args.url ?? '')
  if (!url) return 'error: url is required'
  const headers = (args.headers as Record<string, string>) ?? {}
  const body = args.body != null ? String(args.body) : undefined
  try {
    const res = await fetch(url, {
      method,
      headers,
      body: method === 'GET' || method === 'HEAD' ? undefined : body
    })
    const text = await res.text()
    const hdrs: string[] = []
    res.headers.forEach((v, k) => hdrs.push(`${k}: ${v}`))
    const clipped = text.length > 8000 ? text.slice(0, 8000) + '\n… (truncated)' : text
    return `HTTP ${res.status} ${res.statusText}\n${hdrs.join('\n')}\n\n${clipped}`
  } catch (e) {
    return `error: ${e instanceof Error ? e.message : String(e)}`
  }
}
