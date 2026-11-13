// src/main/usage.ts in the Tauri build. usage:today and usage:codex run in Rust
// (src-tauri/src/services/usage.rs). usage:limits stays here until the keychain
// read it needs (Claude Code's OAuth token) moves too.
import { ipcMain } from 'electron'
import { usageLimits } from '../../../src/main/usage'

export function registerUsageHandlers(): void {
  ipcMain.handle('usage:limits', (_e, configDir?: string) => usageLimits(configDir))
}
