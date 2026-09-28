import { expect, test } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import { AddressInfo } from 'node:net'
import { launchRiven, openPanel } from './app'

// The API client, against a throwaway server this file starts. Nothing here
// touches the network: the point is that the request riven builds — method,
// headers, body — arrives as the one the user described, which can only be
// checked by being the server on the other end.

interface Seen {
  method: string
  url: string
  headers: Record<string, string | string[] | undefined>
  body: string
}

async function serve(): Promise<{ base: string; seen: Seen[]; stop: () => Promise<void>; server: Server }> {
  const seen: Seen[] = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body })
      if (req.url?.startsWith('/missing')) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'nope' }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, echo: body || null, greeting: 'hello-from-test' }))
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address() as AddressInfo
  return {
    base: `http://127.0.0.1:${port}`,
    seen,
    server,
    stop: () => new Promise<void>((r) => server.close(() => r()))
  }
}

async function apiPanel(page: import('@playwright/test').Page): Promise<void> {
  await openPanel(page, 'API')
  await page.waitForSelector('.apc-urlbar')
}

test.describe('the API client', () => {
  test('a GET reaches the server and the response comes back', async () => {
    const srv = await serve()
    const r = await launchRiven({ files: { 'README.md': '# s\n' } })
    await apiPanel(r.page)
    await r.page.locator('.apc-url').fill(`${srv.base}/hello`)
    await r.page.locator('.apc-send').click()
    await expect(r.page.locator('.apc-status')).toContainText('200')
    await expect(r.page.locator('.apc-res')).toContainText('hello-from-test')
    expect(srv.seen.map((s) => `${s.method} ${s.url}`)).toEqual(['GET /hello'])
    await r.app.close()
    await srv.stop()
  })

  test('a POST sends the method, the header and the body that were typed', async () => {
    const srv = await serve()
    const r = await launchRiven({ files: { 'README.md': '# s\n' } })
    await apiPanel(r.page)
    await r.page.locator('.apc-method-sel').selectOption('POST')
    await r.page.locator('.apc-url').fill(`${srv.base}/submit`)

    // The header editor always keeps one blank row at the end; typing into it is
    // what creates the header.
    await r.page.locator('.apc-tab').filter({ hasText: '헤더' }).click()
    const blank = r.page.locator('.apc-kv-row').last()
    await blank.locator('input[placeholder="키"]').fill('X-Riven-Test')
    await r.page.locator('.apc-kv-row').first().locator('input[placeholder="값"]').fill('yes')

    await r.page.locator('.apc-tab').filter({ hasText: '본문' }).click()
    await r.page.getByText('JSON', { exact: true }).click()
    await r.page.locator('.apc-code-area').fill('{"n":1}')

    await r.page.locator('.apc-send').click()
    await expect(r.page.locator('.apc-status')).toContainText('200')
    const post = srv.seen.find((s) => s.method === 'POST')!
    expect(post.url).toBe('/submit')
    expect(post.headers['x-riven-test']).toBe('yes')
    expect(post.body).toBe('{"n":1}')
    await r.app.close()
    await srv.stop()
  })

  test('an error status is reported as itself, not as a failure', async () => {
    const srv = await serve()
    const r = await launchRiven({ files: { 'README.md': '# s\n' } })
    await apiPanel(r.page)
    await r.page.locator('.apc-url').fill(`${srv.base}/missing`)
    await r.page.locator('.apc-send').click()
    await expect(r.page.locator('.apc-status')).toContainText('404')
    await expect(r.page.locator('.apc-res')).toContainText('nope')
    await r.app.close()
    await srv.stop()
  })

  test('a server that is not there is reported, and does not hang the panel', async () => {
    const srv = await serve()
    const dead = srv.base
    await srv.stop() // nothing is listening on that port any more
    const r = await launchRiven({ files: { 'README.md': '# s\n' } })
    await apiPanel(r.page)
    await r.page.locator('.apc-url').fill(`${dead}/gone`)
    await r.page.locator('.apc-send').click()
    await expect(r.page.locator('.apc-status')).toContainText('요청 실패', { timeout: 20_000 })
    await expect(r.page.locator('.apc-send')).toBeEnabled()
    await r.app.close()
  })

  test('a sent request is remembered in the history', async () => {
    const srv = await serve()
    const r = await launchRiven({ files: { 'README.md': '# s\n' } })
    await apiPanel(r.page)
    await r.page.locator('.apc-url').fill(`${srv.base}/remembered`)
    await r.page.locator('.apc-send').click()
    await expect(r.page.locator('.apc-status')).toContainText('200')
    await expect(r.page.locator('.apc-aside, .apc-side').getByText('/remembered').first()).toBeVisible()
    await r.app.close()
    await srv.stop()
  })
})
