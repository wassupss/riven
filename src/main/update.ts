import { app, ipcMain, Notification, BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'

// Auto-update wiring. electron-updater checks GitHub Releases (see the publish
// block in electron-builder.yml). We drive the flow ourselves — instead of
// `checkForUpdatesAndNotify` (whose notification isn't clickable) — so:
//   • a downloaded update fires a notification that INSTALLS on click, and
//   • the renderer gets live status for an in-app "Updates" panel + a status pill.
export type UpdateStatus =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'available'; version: string }
  | { state: 'downloading'; percent: number }
  | { state: 'downloaded'; version: string }
  | { state: 'upToDate' }
  | { state: 'error'; message: string }

let latest: UpdateStatus = { state: 'idle' }

export function registerUpdateHandlers(): void {
  const send = (s: UpdateStatus): void => {
    latest = s
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send('update:status', s)
    }
  }

  autoUpdater.autoDownload = true
  autoUpdater.on('checking-for-update', () => send({ state: 'checking' }))
  autoUpdater.on('update-available', (i) => send({ state: 'available', version: i.version }))
  autoUpdater.on('update-not-available', () => send({ state: 'upToDate' }))
  autoUpdater.on('download-progress', (p) =>
    send({ state: 'downloading', percent: Math.round(p.percent) })
  )
  autoUpdater.on('update-downloaded', (i) => {
    send({ state: 'downloaded', version: i.version })
    if (Notification.isSupported()) {
      const n = new Notification({
        title: `riven ${i.version} 업데이트 준비됨 / update ready`,
        body: '클릭하면 재시작하여 설치합니다. / Click to restart and install.'
      })
      n.on('click', () => autoUpdater.quitAndInstall(false, true))
      n.show()
    }
  })
  autoUpdater.on('error', (e) =>
    send({ state: 'error', message: (e as Error)?.message ?? String(e) })
  )

  ipcMain.handle('app:version', () => app.getVersion())
  ipcMain.handle('update:current', () => latest)
  ipcMain.handle('update:check', async () => {
    // Dev has no update feed — report up-to-date rather than erroring.
    if (!app.isPackaged) {
      send({ state: 'upToDate' })
      return
    }
    try {
      await autoUpdater.checkForUpdates()
    } catch (e) {
      send({ state: 'error', message: (e as Error).message })
    }
  })
  // isForceRunAfter=true → relaunch riven after the update is applied.
  ipcMain.handle('update:install', () => autoUpdater.quitAndInstall(false, true))

  // Check once on launch (packaged only; dev has no feed).
  if (app.isPackaged) {
    autoUpdater.checkForUpdates().catch((e) => console.error('[riven] update check failed', e))
  }
}
