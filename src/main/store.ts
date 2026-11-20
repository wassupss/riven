import { app, ipcMain } from 'electron'
import { promises as fs, mkdirSync, renameSync, rmSync, writeFileSync } from 'fs'
import * as path from 'path'
import { atomicWriteJson, TMP_SUFFIX } from './atomicWrite'

// The renderer's own data, as plain files: userData/store/<name>.json, one
// JSON value per file, written like every other riven file (JSON.stringify(v,
// null, 2), temp file + rename). It used to live in localStorage, which belongs
// to the browser engine (Chromium here, WebKit in the Tauri build) and so could
// not follow the user from one to the other. The Tauri build answers the same
// channels from Rust (src-tauri/src/commands/store.rs) over the same folder.
//
// Saving null removes the file.

export const STORE_DIR = 'store'
// Names the renderer picks (lib/fileStore). Never a path.
const NAME = /^[a-z0-9][a-z0-9.-]{0,63}$/

export function storeDir(userData: string): string {
  return path.join(userData, STORE_DIR)
}

function fileFor(name: string): string {
  if (!NAME.test(name)) throw new Error(`store: bad name '${name}'`)
  return path.join(storeDir(app.getPath('userData')), `${name}.json`)
}

/** Every store file: name -> value. A file that does not parse is left out. */
export async function loadAll(dir: string): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {}
  let names: string[]
  try {
    names = await fs.readdir(dir)
  } catch {
    return out
  }
  for (const f of names.sort()) {
    if (!f.endsWith('.json')) continue
    const name = f.slice(0, -5)
    if (!NAME.test(name)) continue
    try {
      out[name] = JSON.parse(await fs.readFile(path.join(dir, f), 'utf8'))
    } catch {
      /* unreadable or half-written by hand: as if absent */
    }
  }
  return out
}

async function save(name: string, data: unknown): Promise<void> {
  const file = fileFor(name)
  if (data === null || data === undefined) {
    await fs.rm(file, { force: true })
    return
  }
  await fs.mkdir(path.dirname(file), { recursive: true })
  await atomicWriteJson(file, data)
}

export function registerStoreHandlers(): void {
  ipcMain.handle('store:loadAll', () => loadAll(storeDir(app.getPath('userData'))))
  ipcMain.handle('store:save', (_e, name: string, data: unknown) => save(name, data))
  // The flush on unload, like config:save-sync: an async save started there may
  // not land before the renderer goes away.
  ipcMain.on('store:save-sync', (e, name: string, data: unknown) => {
    try {
      const file = fileFor(name)
      if (data === null || data === undefined) {
        rmSync(file, { force: true })
      } else {
        mkdirSync(path.dirname(file), { recursive: true })
        const tmp = `${file}${TMP_SUFFIX}`
        writeFileSync(tmp, JSON.stringify(data, null, 2))
        renameSync(tmp, file)
      }
      e.returnValue = true
    } catch {
      e.returnValue = false
    }
  })
}
