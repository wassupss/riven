// The IPC channels Rust owns (src-tauri/src/commands). Everything listed here
// skips Node: the preload shim sends invoke/send to Tauri, and main -> page
// events come from Tauri. A channel not listed still goes to Node, the
// temporary fallback until its group moves (docs/tauri-rust-main.md).
//
// To move a channel: add its #[tauri::command] in src-tauri/src/commands and
// list it here. The command name is derived from the channel
// ('workspace:readFile' -> workspace_read_file); the array names the
// positional arguments, which Tauri takes as named ones (camelCase here,
// snake_case in Rust).

export const RUST_INVOKE: Record<string, readonly string[]> = {
  // config
  'config:load': ['name'],
  'config:save': ['name', 'data'],
  'config:reveal': ['name'],
  // sessions
  'sessions:load': [],
  'sessions:save': ['data'],
  // workspace
  'workspace:setRoots': ['roots'],
  'workspace:pickFolder': [],
  'workspace:readDir': ['dir'],
  'workspace:listFiles': ['folder'],
  'workspace:readFile': ['file'],
  'workspace:writeFile': ['file', 'content'],
  'workspace:createFile': ['path'],
  'workspace:createFolder': ['path'],
  'workspace:rename': ['oldPath', 'newPath'],
  'workspace:delete': ['path'],
  'workspace:reveal': ['path'],
  'workspace:importPaths': ['destDir', 'sources'],
  'workspace:snapshotContents': ['folder'],
  'image:saveTemp': ['dataUrl'],
  'font:import': [],
  'scripts:list': ['folder'],
  // search
  'search:inFiles': ['opts'],
  'search:replaceInFiles': ['opts'],
  // notes
  'notes:list': ['ws'],
  'notes:read': ['ws', 'note'],
  'notes:write': ['ws', 'note', 'title', 'body'],
  'notes:append': ['ws', 'note', 'body'],
  'notes:delete': ['ws', 'note'],
  'notes:writeFile': ['ws', 'relPath', 'body', 'overwrite'],
  'notes:saveToFile': ['ws', 'note', 'relPath', 'overwrite'],
  // the workspace watcher (bridge.ts)
  'watch:start': ['folder'],
  'watch:stop': []
}

// ipcRenderer.sendSync channels Rust owns, each with its async twin. Tauri
// has no synchronous call, so the page's sync XHR still goes to Node, which
// relays it to Rust (dispatch 'ipc.sync' in main.rs) and waits. WebKit refuses
// a sync XHR while the page is being torn down (beforeunload on reload/close),
// which is exactly when these flushes run, so then the preload fires the async
// twin at Rust instead and does not wait.
export const RUST_SYNC: Readonly<Record<string, string>> = {
  'config:save-sync': 'config:save',
  'sessions:save-sync': 'sessions:save'
}

// webContents.send channels Rust emits (as the Tauri event 'riven:ipc').
export const RUST_EVENTS: ReadonlySet<string> = new Set(['fs:changed'])

export function rustCommand(channel: string): string {
  return channel
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[:-]/g, '_')
    .toLowerCase()
}
