import { net, protocol } from 'electron'
import * as fs from 'fs/promises'
import * as path from 'path'
import { pathToFileURL } from 'url'
import { isConfined } from './workspace'

// Serves workspace files to the renderer as media (images, video, audio, PDF).
//
// Why a custom scheme and not file:// — in dev the renderer is a page on
// http://localhost, which is not allowed to load file:// subresources, so an
// <img src="file:///…"> silently fails in dev and works when packaged. A scheme
// main owns behaves identically in both. It also gives us one place to enforce
// that only files inside an OPEN workspace are readable: the renderer can ask
// for any path, so the check has to live here.
//
// net.fetch on a file URL handles Range requests, which is what lets a <video>
// seek instead of having to download the whole file first.

export const MEDIA_SCHEME = 'riven-media'

// Must run BEFORE app 'ready'. `stream` is what enables ranged media requests;
// `supportFetchAPI` + `corsEnabled` let the renderer fetch() one of these URLs:
// without corsEnabled Chromium rejects the request outright ("cross origin
// requests are only supported for protocol schemes: http, https, …") because in
// dev the page's origin is http://localhost.
export function registerMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: MEDIA_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
        bypassCSP: true
      }
    }
  ])
}

// CORS is enabled for the scheme, so every response has to say so explicitly.
function allowOrigin(res: Response): Response {
  const headers = new Headers(res.headers)
  headers.set('Access-Control-Allow-Origin', '*')
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
}

export function registerMediaProtocol(): void {
  protocol.handle(MEDIA_SCHEME, async (request) => {
    let file: string
    try {
      // riven-media://local/<uri-encoded absolute path>
      file = decodeURIComponent(new URL(request.url).pathname.replace(/^\//, ''))
    } catch {
      return allowOrigin(new Response('bad request', { status: 400 }))
    }
    if (!file || !path.isAbsolute(file))
      return allowOrigin(new Response('bad path', { status: 400 }))
    if (!isConfined(file)) return allowOrigin(new Response('forbidden', { status: 403 }))
    // HEAD is answered from a stat: the viewer only wants the byte count, and
    // net.fetch would have to read the file to produce a body it then discards.
    if (request.method === 'HEAD') {
      try {
        const st = await fs.stat(file)
        return allowOrigin(
          new Response(null, { status: 200, headers: { 'content-length': String(st.size) } })
        )
      } catch {
        return allowOrigin(new Response(null, { status: 404 }))
      }
    }
    try {
      // Forward the Range header so seeking a video doesn't pull the whole file.
      return allowOrigin(
        await net.fetch(pathToFileURL(file).toString(), {
          headers: request.headers,
          method: request.method
        })
      )
    } catch {
      return allowOrigin(new Response('not found', { status: 404 }))
    }
  })
}
