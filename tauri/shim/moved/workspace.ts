// src/main/workspace.ts in the Tauri build. The group now lives in Rust
// (src-tauri/src/commands/workspace.rs). What Node still needs from it is
// isConfined for media.ts, so Rust, which owns the open roots, sends them here
// on every workspace:setRoots (the 'roots' event on the control line).
import * as path from 'path'
import { onEvent } from '../rust'

const roots = new Set<string>()

onEvent((m) => {
  if (m.ev !== 'roots' || !Array.isArray(m.roots)) return
  roots.clear()
  for (const r of m.roots) if (typeof r === 'string' && r) roots.add(r)
})

export function isConfined(target: string): boolean {
  if (roots.size === 0) return true // nothing open yet
  const resolved = path.resolve(target)
  for (const root of roots) {
    const r = path.resolve(root)
    if (resolved === r || resolved.startsWith(r + path.sep)) return true
  }
  return false
}

export function registerWorkspaceHandlers(): void {}
