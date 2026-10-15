import { app, ipcMain, safeStorage } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import { atomicWriteText } from './atomicWrite'

// Remote control's long-term key pair (see renderer state/remote). Whoever has
// its secret half can open the pairing requests and messages meant for this
// machine, so it is not kept in settings.json: it is sealed with the OS
// keystore (Keychain on macOS, DPAPI on Windows, libsecret on Linux) and only
// this app, run by this user, can open it again.
//
// The public half is stored next to it so the renderer can tell the pair still
// belongs with the public key in its settings; a mismatch means start over.

interface DeskKey {
  publicKey: string
  secretKey: string
}

const file = (): string => join(app.getPath('userData'), 'remote-key.bin')

/** Linux without a keyring falls back to a hard-coded password: not worth calling sealed. */
function sealable(): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false
  if (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text') return false
  return true
}

async function load(): Promise<DeskKey | null> {
  if (!sealable()) return null
  let raw: string
  try {
    raw = await fs.readFile(file(), 'utf8')
  } catch {
    return null
  }
  try {
    const k = JSON.parse(safeStorage.decryptString(Buffer.from(raw, 'base64'))) as DeskKey
    return typeof k.publicKey === 'string' && typeof k.secretKey === 'string' ? k : null
  } catch {
    // Sealed by another user or machine (a copied profile): unusable here.
    return null
  }
}

async function save(k: DeskKey | null): Promise<boolean> {
  if (!k) {
    await fs.rm(file(), { force: true })
    return true
  }
  if (!sealable()) return false
  const sealed = safeStorage.encryptString(JSON.stringify({ publicKey: k.publicKey, secretKey: k.secretKey }))
  await atomicWriteText(file(), sealed.toString('base64'))
  await fs.chmod(file(), 0o600).catch(() => {})
  return true
}

export function registerRemoteKey(): void {
  ipcMain.handle('remoteKey:available', () => sealable())
  ipcMain.handle('remoteKey:load', () => load())
  ipcMain.handle('remoteKey:save', (_e, k: DeskKey | null) => save(k))
}
