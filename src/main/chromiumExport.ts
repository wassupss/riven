import { app, ipcMain, safeStorage, session } from 'electron'
import { promises as fs } from 'fs'
import * as path from 'path'
import { appWindow } from './appWindow'
import { atomicWriteJson, atomicWriteText } from './atomicWrite'

// The bridge to the Tauri build (docs/tauri-rust-main.md, release plan).
//
// Both builds share the data folder, the files in it and the keychain item.
// What only Chromium holds cannot follow on its own, so the last Electron
// release writes it out, into userData/electron-export/:
//
//   local-storage.json   the app page's localStorage, minus what already lives
//                        in userData/store (renderer lib/fileStore): UI
//                        conveniences (widths, toggles, last formats), the pane
//                        id counter and old pre-session keys. The Tauri build
//                        puts these into its own localStorage on first start
//                        (src-tauri/src/lsmigrate.rs).
//   browser-cookies.bin  the browser panel's cookies (partition
//                        persist:riven-browser), sealed with safeStorage like
//                        every other secret (base64 of "v10" + ciphertext), so
//                        sign-ins in the panel are not lost with Chromium.
//   manifest.json        what was written, when and why.
//
// When: once at the first start with this code (if there is no manifest yet),
// and again, always, when an update has been downloaded and before it is
// installed, so the copy is as fresh as it can be at the switch.

export const EXPORT_DIR = 'electron-export'
export const BROWSER_PARTITION = 'persist:riven-browser'

export interface ExportManifest {
  version: 1
  exportedAt: string
  reason: string
  appVersion: string
  page: string | null
  localStorageEntries: number | null
  cookies: number | null
}

const exportDir = (): string => path.join(app.getPath('userData'), EXPORT_DIR)

// The page answers with every localStorage entry that did not move to a file
// (lib/fileStore installs this function once it has read the files).
const READ_LS = 'typeof window.__rivenLocalStorageExport === "function" ? window.__rivenLocalStorageExport() : null'

let running: Promise<ExportManifest | null> | null = null

async function run(reason: string): Promise<ExportManifest | null> {
  const dir = exportDir()
  await fs.mkdir(dir, { recursive: true })
  let origin: string | null = null
  let lsCount: number | null = null
  const w = appWindow()
  if (w && !w.isDestroyed()) {
    try {
      const entries = (await w.webContents.executeJavaScript(READ_LS, true)) as Record<string, string> | null
      if (entries && typeof entries === 'object') {
        // Which page's storage this is (file:// has no useful origin).
        origin = w.webContents.getURL().split(/[?#]/)[0] || null
        await atomicWriteJson(path.join(dir, 'local-storage.json'), { version: 1, page: origin, entries })
        lsCount = Object.keys(entries).length
      }
    } catch (e) {
      console.error('[export] reading localStorage failed', e)
    }
  }
  let cookies: number | null = null
  if (safeStorage.isEncryptionAvailable()) {
    try {
      const list = await session.fromPartition(BROWSER_PARTITION).cookies.get({})
      const sealed = safeStorage.encryptString(JSON.stringify({ version: 1, partition: BROWSER_PARTITION, cookies: list }))
      const file = path.join(dir, 'browser-cookies.bin')
      await atomicWriteText(file, sealed.toString('base64'))
      await fs.chmod(file, 0o600).catch(() => {})
      cookies = list.length
    } catch (e) {
      console.error('[export] browser cookies failed', e)
    }
  }
  const manifest: ExportManifest = {
    version: 1,
    exportedAt: new Date().toISOString(),
    reason,
    appVersion: app.getVersion(),
    page: origin,
    localStorageEntries: lsCount,
    cookies
  }
  // Only a run that got the page's localStorage counts as done: the startup
  // export is tried again next time otherwise.
  if (lsCount !== null) await atomicWriteJson(path.join(dir, 'manifest.json'), manifest)
  return manifest
}

/** Write the Chromium-only data out. Runs one at a time. */
export function exportChromiumData(reason: string): Promise<ExportManifest | null> {
  if (running) return running.then(() => exportChromiumData(reason))
  running = run(reason)
    .catch((e) => {
      console.error('[export] failed', e)
      return null
    })
    .finally(() => {
      running = null
    })
  return running
}

async function hasManifest(): Promise<boolean> {
  try {
    await fs.access(path.join(exportDir(), 'manifest.json'))
    return true
  } catch {
    return false
  }
}

export function registerChromiumExport(): void {
  // The page has read its files and can answer READ_LS: the one-time export.
  ipcMain.handle('export:ready', async () => {
    if (await hasManifest()) return false
    await exportChromiumData('first start')
    return true
  })
}
