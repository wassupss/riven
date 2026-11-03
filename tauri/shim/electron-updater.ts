// The Tauri build is a local test build: it never updates itself. update.ts only
// reaches autoUpdater in a packaged app, but it is imported either way.
import { EventEmitter } from 'events'

class NoUpdater extends EventEmitter {
  autoDownload = false
  autoInstallOnAppQuit = false
  logger: unknown = null
  checkForUpdates(): Promise<null> {
    return Promise.resolve(null)
  }
  checkForUpdatesAndNotify(): Promise<null> {
    return Promise.resolve(null)
  }
  downloadUpdate(): Promise<string[]> {
    return Promise.resolve([])
  }
  quitAndInstall(): void {}
}

export const autoUpdater = new NoUpdater()
export default { autoUpdater }
