import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import * as os from 'os'
import { existsSync } from 'fs'
import { execSync } from 'child_process'
import { registerPtyHandlers } from './pty'
import { registerWorkspaceHandlers } from './workspace'
import { registerLspHandlers } from './lsp'
import { registerBridgeHandlers } from './bridge'
import { registerGitHandlers } from './git'
import { registerSessionsHandlers } from './sessions'
import { registerConfigHandlers } from './config'
import { registerSearchHandlers } from './search'
import { registerCliHandlers } from './cli'
import { registerPortsHandlers } from './ports'
import { registerAiHandlers } from './ai'
import { registerUsageHandlers } from './usage'
import { registerAuthHandlers } from './auth'
import { buildMenu } from './menu'

// Product name for the app menu / About panel / dock (in dev it'd be "Electron").
app.setName('riven')

function resolveClaude(): string | null {
  // Prefer a PATH-resolved claude (via login shell so profiles load),
  // then fall back to the cmux-bundled binary.
  const loginShell = process.env.SHELL || '/bin/zsh'
  try {
    const found = execSync(`${loginShell} -lic 'command -v claude' 2>/dev/null`, {
      encoding: 'utf8',
      timeout: 4000
    }).trim()
    if (found && existsSync(found)) return found
  } catch {
    /* not on PATH */
  }
  const cmuxPath = '/Applications/cmux.app/Contents/Resources/bin/claude'
  if (existsSync(cmuxPath)) return cmuxPath
  return null
}

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1600,
    height: 1000,
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#1e1e1e',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      webviewTag: true,
      contextIsolation: true
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow.show())

  // Dev affordance: RIVEN_CAPTURE=<path> [RIVEN_CAPTURE_DELAY=ms] captures the
  // real rendered UI to a PNG once loaded, then quits. Used to grab authentic
  // screenshots (e.g. for the landing page) instead of hand-drawn mockups.
  if (process.env.RIVEN_CAPTURE) {
    mainWindow.webContents.once('did-finish-load', () => {
      const delay = Number(process.env.RIVEN_CAPTURE_DELAY) || 7000
      setTimeout(async () => {
        try {
          const img = await mainWindow.webContents.capturePage()
          const { promises: fsp } = await import('fs')
          await fsp.writeFile(process.env.RIVEN_CAPTURE as string, img.toPNG())
          console.log('[riven] captured', process.env.RIVEN_CAPTURE)
        } catch (e) {
          console.error('[riven] capture failed', e)
        }
        app.quit()
      }, delay)
    })
  }

  // Forward renderer console (prefixed) to the main stdout — dev only.
  if (!app.isPackaged) {
    mainWindow.webContents.on('console-message', (_e, _level, message) => {
      if (message.startsWith('[riven]')) console.log(message)
    })
  }

  mainWindow.webContents.setWindowOpenHandler((details) => {
    const u = details.url
    // Allow same-origin / blank windows (dockview panel pop-out); open real
    // external http(s) links in the default browser.
    if (u === '' || u === 'about:blank' || u.startsWith('http://localhost') || u.startsWith('file://')) {
      return { action: 'allow' }
    }
    if (/^https?:/.test(u)) {
      shell.openExternal(u)
      return { action: 'deny' }
    }
    return { action: 'allow' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  registerPtyHandlers()
  registerWorkspaceHandlers()
  registerLspHandlers()
  registerBridgeHandlers()
  registerGitHandlers()
  registerSessionsHandlers()
  registerConfigHandlers()
  registerSearchHandlers()
  registerCliHandlers()
  registerPortsHandlers()
  registerAiHandlers()
  registerUsageHandlers()
  registerAuthHandlers()
  buildMenu()

  const claudePath = resolveClaude()

  ipcMain.handle('env:defaults', () => ({
    home: os.homedir(),
    shell: process.env.SHELL || '/bin/zsh',
    platform: process.platform,
    claudePath
  }))

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
