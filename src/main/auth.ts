import { BrowserWindow, ipcMain } from 'electron'

// OAuth in a desktop app: Supabase hands us a provider authorize URL (via
// signInWithOAuth({ skipBrowserRedirect: true })). We open it in a dedicated
// window, let the user authenticate with Google/GitHub, and intercept the
// redirect back to our callback URL to lift the PKCE `code` out of the query
// string. The renderer (which holds the PKCE verifier) then exchanges it for a
// session. No custom protocol registration required.

function extractCode(rawUrl: string, redirectPrefix: string): string | null {
  try {
    const u = new URL(rawUrl)
    // Only trust the code once we've landed on our own callback URL.
    if (!rawUrl.startsWith(redirectPrefix)) return null
    const code = u.searchParams.get('code')
    if (code) return code
    // Some providers surface errors on the callback too — treat as terminal.
    if (u.searchParams.get('error')) throw new Error(u.searchParams.get('error_description') || u.searchParams.get('error') || 'oauth_error')
    return null
  } catch (e) {
    if (e instanceof Error && e.message !== 'Invalid URL') throw e
    return null
  }
}

export function registerAuthHandlers(): void {
  ipcMain.handle('auth:oauth', async (_e, authorizeUrl: string, redirectTo: string): Promise<string> => {
    const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? undefined
    return new Promise<string>((resolve, reject) => {
      const win = new BrowserWindow({
        width: 480,
        height: 680,
        parent,
        modal: !!parent,
        show: true,
        autoHideMenuBar: true,
        title: '로그인',
        webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true }
      })

      let settled = false
      const finish = (fn: () => void): void => {
        if (settled) return
        settled = true
        fn()
        if (!win.isDestroyed()) win.close()
      }

      const onNavigate = (event: Electron.Event, url: string): void => {
        let code: string | null = null
        try {
          code = extractCode(url, redirectTo)
        } catch (err) {
          event.preventDefault?.()
          finish(() => reject(err instanceof Error ? err : new Error(String(err))))
          return
        }
        if (code) {
          event.preventDefault?.()
          finish(() => resolve(code as string))
        }
      }

      win.webContents.on('will-redirect', onNavigate)
      win.webContents.on('will-navigate', onNavigate)
      win.on('closed', () => {
        if (!settled) {
          settled = true
          reject(new Error('cancelled'))
        }
      })

      win.loadURL(authorizeUrl).catch((err) => finish(() => reject(err)))
    })
  })
}
