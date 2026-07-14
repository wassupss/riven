import { contextBridge, ipcRenderer } from 'electron'

export interface DirEntry {
  name: string
  path: string
  isDirectory: boolean
}

const api = {
  env: {
    defaults: (): Promise<{
      home: string
      shell: string
      platform: string
      claudePath: string | null
    }> => ipcRenderer.invoke('env:defaults')
  },
  workspace: {
    pickFolder: (): Promise<string | null> => ipcRenderer.invoke('workspace:pickFolder'),
    readDir: (dir: string): Promise<DirEntry[]> => ipcRenderer.invoke('workspace:readDir', dir),
    listFiles: (folder: string): Promise<string[]> => ipcRenderer.invoke('workspace:listFiles', folder),
    scripts: (folder: string): Promise<{ manager: string; scripts: string[] }> =>
      ipcRenderer.invoke('scripts:list', folder),
    importFont: (): Promise<{ family: string; dataUrl: string } | null> =>
      ipcRenderer.invoke('font:import'),
    readFile: (file: string): Promise<string> => ipcRenderer.invoke('workspace:readFile', file),
    writeFile: (file: string, content: string): Promise<void> =>
      ipcRenderer.invoke('workspace:writeFile', file, content),
    createFile: (p: string): Promise<void> => ipcRenderer.invoke('workspace:createFile', p),
    createFolder: (p: string): Promise<void> => ipcRenderer.invoke('workspace:createFolder', p),
    rename: (oldPath: string, newPath: string): Promise<void> =>
      ipcRenderer.invoke('workspace:rename', oldPath, newPath),
    delete: (p: string): Promise<void> => ipcRenderer.invoke('workspace:delete', p),
    reveal: (p: string): Promise<void> => ipcRenderer.invoke('workspace:reveal', p),
    snapshotContents: (folder: string): Promise<Record<string, string>> =>
      ipcRenderer.invoke('workspace:snapshotContents', folder)
  },
  search: {
    inFiles: (opts: { root: string; query: string; caseSensitive?: boolean }): Promise<{
      matches: Array<{
        file: string
        line: number
        column: number
        text: string
        matchStart: number
        matchLength: number
      }>
      truncated: boolean
    }> => ipcRenderer.invoke('search:inFiles', opts)
  },
  pty: {
    open: (opts: {
      sessionKey: string
      cwd: string
      initialCommand?: string
      cols?: number
      rows?: number
    }): Promise<{ id: string; existed: boolean; buffer: string }> =>
      ipcRenderer.invoke('pty:open', opts),
    write: (id: string, data: string): void => ipcRenderer.send('pty:write', id, data),
    snapshot: (id: string, data: string): void => ipcRenderer.send('pty:snapshot', id, data),
    resize: (id: string, cols: number, rows: number): void =>
      ipcRenderer.send('pty:resize', id, cols, rows),
    kill: (id: string): void => ipcRenderer.send('pty:kill', id),
    onData: (id: string, cb: (data: string) => void): (() => void) => {
      const channel = `pty:data:${id}`
      const listener = (_e: unknown, data: string): void => cb(data)
      ipcRenderer.on(channel, listener)
      return () => ipcRenderer.removeListener(channel, listener)
    },
    onExit: (id: string, cb: (code: number) => void): (() => void) => {
      const channel = `pty:exit:${id}`
      const listener = (_e: unknown, code: number): void => cb(code)
      ipcRenderer.on(channel, listener)
      return () => ipcRenderer.removeListener(channel, listener)
    },
    onStatus: (cb: (e: { key: string; busy: boolean }) => void): (() => void) => {
      const listener = (_e: unknown, payload: { key: string; busy: boolean }): void => cb(payload)
      ipcRenderer.on('pty:status', listener)
      return () => ipcRenderer.removeListener('pty:status', listener)
    },
    onAgent: (cb: (e: { key: string; agent: boolean; name?: string | null }) => void): (() => void) => {
      const listener = (_e: unknown, payload: { key: string; agent: boolean; name?: string | null }): void =>
        cb(payload)
      ipcRenderer.on('pty:agent', listener)
      return () => ipcRenderer.removeListener('pty:agent', listener)
    },
    onBell: (cb: (e: { key: string }) => void): (() => void) => {
      const listener = (_e: unknown, payload: { key: string }): void => cb(payload)
      ipcRenderer.on('pty:bell', listener)
      return () => ipcRenderer.removeListener('pty:bell', listener)
    },
    onDone: (cb: (e: { key: string; duration: number }) => void): (() => void) => {
      const listener = (_e: unknown, payload: { key: string; duration: number }): void => cb(payload)
      ipcRenderer.on('pty:done', listener)
      return () => ipcRenderer.removeListener('pty:done', listener)
    }
  },
  lsp: {
    servers: (rootPath: string): Promise<string[]> =>
      ipcRenderer.invoke('lsp:servers', rootPath),
    start: (serverKey: string, rootPath: string): Promise<unknown> =>
      ipcRenderer.invoke('lsp:start', serverKey, rootPath),
    request: (serverKey: string, method: string, params: unknown): Promise<unknown> =>
      ipcRenderer.invoke('lsp:request', serverKey, method, params),
    notify: (serverKey: string, method: string, params: unknown): void =>
      ipcRenderer.send('lsp:notify', serverKey, method, params),
    onNotify: (
      cb: (msg: { serverKey: string; method: string; params: unknown }) => void
    ): (() => void) => {
      const listener = (_e: unknown, msg: { serverKey: string; method: string; params: unknown }): void =>
        cb(msg)
      ipcRenderer.on('lsp:notify', listener)
      return () => ipcRenderer.removeListener('lsp:notify', listener)
    }
  },
  bridge: {
    saveCapture: (folder: string, dataUrl: string): Promise<string> =>
      ipcRenderer.invoke('capture:save', folder, dataUrl),
    watchStart: (folder: string): Promise<void> => ipcRenderer.invoke('watch:start', folder),
    watchStop: (): void => ipcRenderer.send('watch:stop'),
    onFsChanged: (cb: (e: { type: string; path: string }) => void): (() => void) => {
      const listener = (_e: unknown, payload: { type: string; path: string }): void => cb(payload)
      ipcRenderer.on('fs:changed', listener)
      return () => ipcRenderer.removeListener('fs:changed', listener)
    }
  },
  notify: {
    show: (title: string, body: string): void => ipcRenderer.send('notify:show', { title, body })
  },
  cli: {
    list: (): Promise<Array<{ name: string; cmd: string; group: string; path: string }>> =>
      ipcRenderer.invoke('cli:list')
  },
  ai: {
    complete: (
      prefix: string,
      suffix: string,
      opts: { mode: string; endpoint: string; model: string; apiKey?: string }
    ): Promise<string> => ipcRenderer.invoke('ai:complete', prefix, suffix, opts)
  },
  usage: {
    today: (): Promise<{
      totalCost: number
      totalTokens: number
      perModel: Array<{ model: string; input: number; output: number; cacheWrite: number; cacheRead: number; cost: number }>
    }> => ipcRenderer.invoke('usage:today'),
    limits: (): Promise<{
      session: { usedPct: number; resetsAt: string | null } | null
      weekly: { usedPct: number; resetsAt: string | null } | null
    }> => ipcRenderer.invoke('usage:limits')
  },
  ports: {
    list: (folder: string): Promise<number[]> => ipcRenderer.invoke('ports:list', folder)
  },
  git: {
    info: (folder: string): Promise<{ repoName: string; branch: string | null; isRepo: boolean }> =>
      ipcRenderer.invoke('git:info', folder),
    showFile: (folder: string, relPath: string): Promise<string | null> =>
      ipcRenderer.invoke('git:showFile', folder, relPath),
    blame: (
      folder: string,
      relPath: string
    ): Promise<{
      ok: boolean
      lines?: Record<number, { author: string; time: number; summary: string; hash: string }>
      error?: string
    }> => ipcRenderer.invoke('git:blame', folder, relPath),
    status: (
      folder: string
    ): Promise<{
      branch: string | null
      isRepo: boolean
      ahead: number
      behind: number
      hasUpstream: boolean
      files: Array<{
        path: string
        x: string
        y: string
        staged: boolean
        unstaged: boolean
        untracked: boolean
      }>
    }> => ipcRenderer.invoke('git:status', folder),
    stage: (folder: string, relPath: string): Promise<void> =>
      ipcRenderer.invoke('git:stage', folder, relPath),
    unstage: (folder: string, relPath: string): Promise<void> =>
      ipcRenderer.invoke('git:unstage', folder, relPath),
    stageAll: (folder: string): Promise<void> => ipcRenderer.invoke('git:stageAll', folder),
    discard: (folder: string, relPath: string, untracked: boolean): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('git:discard', folder, relPath, untracked),
    push: (folder: string): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('git:push', folder),
    pull: (folder: string): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('git:pull', folder),
    commit: (folder: string, message: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('git:commit', folder, message),
    watch: (folder: string): Promise<void> => ipcRenderer.invoke('git:watch', folder),
    onChanged: (cb: () => void): (() => void) => {
      const listener = (): void => cb()
      ipcRenderer.on('git:changed', listener)
      return () => ipcRenderer.removeListener('git:changed', listener)
    }
  },
  sessions: {
    load: (): Promise<unknown> => ipcRenderer.invoke('sessions:load'),
    save: (data: unknown): Promise<void> => ipcRenderer.invoke('sessions:save', data)
  },
  config: {
    load: (name: string): Promise<unknown> => ipcRenderer.invoke('config:load', name),
    save: (name: string, data: unknown): Promise<void> => ipcRenderer.invoke('config:save', name, data)
  },
  auth: {
    // Runs the provider OAuth flow in a dedicated window and resolves with the
    // PKCE `code` from our callback URL (rejects with 'cancelled' if closed).
    oauth: (authorizeUrl: string, redirectTo: string): Promise<string> =>
      ipcRenderer.invoke('auth:oauth', authorizeUrl, redirectTo)
  },
  menu: {
    onCloseTab: (cb: () => void): (() => void) => {
      const listener = (): void => cb()
      ipcRenderer.on('menu:close-tab', listener)
      return () => ipcRenderer.removeListener('menu:close-tab', listener)
    }
  }
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
