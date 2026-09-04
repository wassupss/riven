import { contextBridge, ipcRenderer, webFrame } from 'electron'

export interface DirEntry {
  name: string
  path: string
  isDirectory: boolean
}

// pty:status/agent/bell/done are single shared channels (payloads carry a `key`
// so each terminal filters its own). Subscribing per-terminal put 1 ipcRenderer
// listener per terminal per channel, so a handful of terminals tripped Node's
// default 10-listener warning. Multiplex instead: exactly ONE ipcRenderer
// listener per channel (attached lazily, kept for the app lifetime) fans out to
// the set of registered callbacks, so the listener count is O(channels), not
// O(terminals).
function multiplexed<T>(channel: string): (cb: (payload: T) => void) => () => void {
  const callbacks = new Set<(payload: T) => void>()
  let attached = false
  return (cb) => {
    if (!attached) {
      ipcRenderer.on(channel, (_e, payload: T) => {
        for (const c of callbacks) c(payload)
      })
      attached = true
    }
    callbacks.add(cb)
    return () => {
      callbacks.delete(cb)
    }
  }
}

const onPtyStatus = multiplexed<{ key: string; busy: boolean }>('pty:status')
const onPtyAgent = multiplexed<{ key: string; agent: boolean; name?: string | null }>('pty:agent')
const onPtyBell = multiplexed<{ key: string }>('pty:bell')
const onPtyDone = multiplexed<{ key: string; duration: number; summary?: string }>('pty:done')

// Native agent-chat events all share one channel; the payload's `key` scopes it
// to a pane. Renderer chat panels filter by their own key.
export type ChatEvent =
  | {
      key: string
      kind: 'init'
      sessionId: string | null
      model: string | null
      tools: string[]
      slashCommands: string[]
      mcpServers: Array<{ name: string; status: string }>
    }
  | { key: string; kind: 'text'; delta: string }
  | {
      key: string
      kind: 'tool'
      name: string
      detail: string
      path: string | null
      code: string | null
      toolId: string | null
      parent: string | null
    }
  | { key: string; kind: 'toolResult'; toolId: string; isError: boolean }
  | { key: string; kind: 'fileEdited'; path: string }
  | { key: string; kind: 'usage'; input: number; output: number; isStart: boolean }
  | {
      key: string
      kind: 'turnDone'
      costUSD: number | null
      sessionId: string | null
      error: string | null
    }
  | { key: string; kind: 'exit'; code: number }
const onChatEvent = multiplexed<ChatEvent>('chat:event')

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
    setRoots: (roots: string[]): Promise<void> => ipcRenderer.invoke('workspace:setRoots', roots),
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
    inFiles: (opts: {
      root: string
      query: string
      caseSensitive?: boolean
      regex?: boolean
      wholeWord?: boolean
    }): Promise<{
      matches: Array<{
        file: string
        line: number
        column: number
        text: string
        matchStart: number
        matchLength: number
      }>
      truncated: boolean
    }> => ipcRenderer.invoke('search:inFiles', opts),
    replaceInFiles: (opts: {
      root: string
      query: string
      replacement: string
      caseSensitive?: boolean
      regex?: boolean
      wholeWord?: boolean
    }): Promise<{ files: number; replacements: number }> =>
      ipcRenderer.invoke('search:replaceInFiles', opts)
  },
  pty: {
    open: (opts: {
      sessionKey: string
      cwd: string
      initialCommand?: string
      cols?: number
      rows?: number
    }): Promise<{ id: string; existed: boolean; buffer: string; error?: string }> =>
      ipcRenderer.invoke('pty:open', opts),
    write: (id: string, data: string): void => ipcRenderer.send('pty:write', id, data),
    ack: (id: string, bytes: number): void => ipcRenderer.send('pty:ack', id, bytes),
    resume: (id: string): void => ipcRenderer.send('pty:resume', id),
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
    onStatus: (cb: (e: { key: string; busy: boolean }) => void): (() => void) => onPtyStatus(cb),
    onAgent: (cb: (e: { key: string; agent: boolean; name?: string | null }) => void): (() => void) =>
      onPtyAgent(cb),
    onBell: (cb: (e: { key: string }) => void): (() => void) => onPtyBell(cb),
    onDone: (cb: (e: { key: string; duration: number; summary?: string }) => void): (() => void) =>
      onPtyDone(cb)
  },
  chat: {
    start: (
      key: string,
      opts: {
        cwd: string
        resume?: string
        model?: string
        permissionMode?: string
        mcpDisabled?: string[]
        globalPrompt?: string
        agent?: string
      }
    ): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('chat:start', key, opts),
    send: (key: string, text: string): void => ipcRenderer.send('chat:send', key, text),
    interrupt: (key: string): void => ipcRenderer.send('chat:interrupt', key),
    setModel: (key: string, model: string): void => ipcRenderer.send('chat:setModel', key, model),
    setMode: (key: string, mode: string): void => ipcRenderer.send('chat:setMode', key, mode),
    stop: (key: string): void => ipcRenderer.send('chat:stop', key),
    title: (message: string): Promise<string> => ipcRenderer.invoke('chat:title', message),
    detectClis: (): Promise<
      Array<{ name: string; cmd: string; path: string; version: string | null }>
    > => ipcRenderer.invoke('chat:detectClis'),
    accounts: (): Promise<
      Array<{
        id: 'claude' | 'codex'
        name: string
        loggedIn: boolean | null
        plan?: string
        email?: string
        mode?: 'subscription' | 'apikey'
      }>
    > => ipcRenderer.invoke('accounts:list'),
    sessionInfo: (
      cwd: string
    ): Promise<{ slashCommands: string[]; mcpServers: Array<{ name: string; status: string }> }> =>
      ipcRenderer.invoke('chat:sessionInfo', cwd),
    sessions: (
      cwd: string
    ): Promise<Array<{ id: string; title: string; mtime: number; messages: number }>> =>
      ipcRenderer.invoke('chat:sessions', cwd),
    agents: (
      cwd: string
    ): Promise<Array<{ name: string; description: string; source: 'project' | 'user' }>> =>
      ipcRenderer.invoke('chat:agents', cwd),
    sessionTranscript: (
      cwd: string,
      id: string
    ): Promise<Array<{ role: 'user' | 'assistant'; text: string; tools: Array<{ name: string; detail: string }> }>> =>
      ipcRenderer.invoke('chat:sessionTranscript', cwd, id),
    mcpList: (
      cwd: string
    ): Promise<Array<{ name: string; url: string; status: 'connected' | 'needs-auth' | 'other' }>> =>
      ipcRenderer.invoke('chat:mcpList', cwd),
    mcpLogin: (cwd: string, name: string): Promise<{ ok: boolean; output: string }> =>
      ipcRenderer.invoke('chat:mcpLogin', cwd, name),
    mcpLogout: (cwd: string, name: string): Promise<{ ok: boolean; output: string }> =>
      ipcRenderer.invoke('chat:mcpLogout', cwd, name),
    onEvent: (cb: (e: ChatEvent) => void): (() => void) => onChatEvent(cb)
  },
  // Real Chromium browser: each tab is a main-process WebContentsView. The panel
  // draws chrome and reports the viewport rect; ops/results go over IPC.
  browser: {
    create: (id: string, url: string, partition?: string): Promise<void> =>
      ipcRenderer.invoke('browser:create', { id, url, partition }),
    navigate: (id: string, url: string): Promise<void> =>
      ipcRenderer.invoke('browser:navigate', { id, url }),
    go: (id: string, action: 'back' | 'forward' | 'reload' | 'stop'): Promise<void> =>
      ipcRenderer.invoke('browser:go', { id, action }),
    destroy: (id: string): Promise<void> => ipcRenderer.invoke('browser:destroy', { id }),
    sync: (
      activeId: string | null,
      rect: { x: number; y: number; width: number; height: number } | null,
      css?: { w: number; h: number }
    ): void => ipcRenderer.send('browser:sync', { activeId, rect, css }),
    hideAll: (hidden: boolean): void => ipcRenderer.send('browser:hideAll', hidden),
    execJs: (id: string, code: string): Promise<unknown> =>
      ipcRenderer.invoke('browser:execJs', { id, code }),
    capture: (id: string): Promise<string | null> => ipcRenderer.invoke('browser:capture', { id }),
    state: (
      id: string
    ): Promise<{
      url: string
      title: string
      loading: boolean
      canGoBack: boolean
      canGoForward: boolean
      zoom: number
    } | null> => ipcRenderer.invoke('browser:state', { id }),
    setZoom: (id: string, factor: number): Promise<void> =>
      ipcRenderer.invoke('browser:setZoom', { id, factor }),
    find: (id: string, text: string): void => ipcRenderer.send('browser:find', { id, text }),
    openDevtools: (id: string): Promise<void> => ipcRenderer.invoke('browser:openDevtools', { id }),
    setLang: (l: 'ko' | 'en'): void => ipcRenderer.send('browser:setLang', l),
    barMenu: (id: string): Promise<void> => ipcRenderer.invoke('browser:barMenu', { id }),
    pickElement: (
      id: string
    ): Promise<{ dataUrl: string | null; selector: string; html: string } | null> =>
      ipcRenderer.invoke('browser:pickElement', { id }),
    bookmarks: (): Promise<Array<{ url: string; title: string }>> =>
      ipcRenderer.invoke('browser:bookmarks'),
    history: (): Promise<Array<{ url: string; title: string; ts: number }>> =>
      ipcRenderer.invoke('browser:history'),
    addBookmark: (b: { url: string; title: string }): Promise<void> =>
      ipcRenderer.invoke('browser:addBookmark', b),
    removeBookmark: (url: string): Promise<void> =>
      ipcRenderer.invoke('browser:removeBookmark', url),
    clearHistory: (): Promise<void> => ipcRenderer.invoke('browser:clearHistory'),
    onEvent: (cb: (e: Record<string, unknown>) => void): (() => void) => {
      const listener = (_e: unknown, payload: Record<string, unknown>): void => cb(payload)
      ipcRenderer.on('browser:event', listener)
      return () => ipcRenderer.removeListener('browser:event', listener)
    },
    onKey: (
      cb: (e: {
        key: string
        code: string
        meta: boolean
        control: boolean
        alt: boolean
        shift: boolean
      }) => void
    ): (() => void) => {
      const listener = (_e: unknown, payload: Parameters<typeof cb>[0]): void => cb(payload)
      ipcRenderer.on('browser:key', listener)
      return () => ipcRenderer.removeListener('browser:key', listener)
    }
  },
  // HTTP client (API panel + riven_api_request).
  api: {
    request: (opts: {
      method: string
      url: string
      headers?: Record<string, string>
      body?: string
    }): Promise<{
      ok: boolean
      status: number
      statusText: string
      headers: Record<string, string>
      body: string
      timeMs: number
      contentType: string
      error?: string
    }> => ipcRenderer.invoke('api:request', opts)
  },
  // Scratch markdown notes (Notes panel + note_* MCP tools).
  notes: {
    list: (ws: string): Promise<Array<{ name: string; title: string; mtime: number }>> =>
      ipcRenderer.invoke('notes:list', ws),
    read: (ws: string, ref: string): Promise<string | null> =>
      ipcRenderer.invoke('notes:read', ws, ref),
    write: (ws: string, ref: string | null, title: string, body: string): Promise<string> =>
      ipcRenderer.invoke('notes:write', ws, ref, title, body),
    append: (ws: string, ref: string, body: string): Promise<string | null> =>
      ipcRenderer.invoke('notes:append', ws, ref, body),
    remove: (ws: string, ref: string): Promise<boolean> =>
      ipcRenderer.invoke('notes:delete', ws, ref),
    writeFile: (
      ws: string,
      relPath: string,
      body: string,
      overwrite: boolean
    ): Promise<{ ok: boolean; path?: string; error?: string }> =>
      ipcRenderer.invoke('notes:writeFile', ws, relPath, body, overwrite),
    saveToFile: (
      ws: string,
      ref: string,
      relPath: string,
      overwrite: boolean
    ): Promise<{ ok: boolean; path?: string; error?: string }> =>
      ipcRenderer.invoke('notes:saveToFile', ws, ref, relPath, overwrite)
  },
  // riven's own MCP tools: the main process forwards each agent tool call here;
  // the renderer performs it (open a file/panel, ask the user, …) and replies.
  mcp: {
    onInvoke: (
      cb: (e: {
        id: string
        tool: string
        args: Record<string, unknown>
        cwd: string | null
      }) => void
    ): (() => void) => {
      const listener = (
        _e: unknown,
        payload: { id: string; tool: string; args: Record<string, unknown>; cwd: string | null }
      ): void => cb(payload)
      ipcRenderer.on('mcp:invoke', listener)
      return () => ipcRenderer.removeListener('mcp:invoke', listener)
    },
    result: (id: string, result: string): void => ipcRenderer.send('mcp:result', { id, result })
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
    // opts.force shows even when a window is focused (the renderer already decided
    // the relevant pane isn't the one being looked at). opts.paneId lets a click
    // focus + navigate to that pane.
    show: (title: string, body: string, opts?: { force?: boolean; paneId?: string }): void =>
      ipcRenderer.send('notify:show', { title, body, ...opts }),
    onClick: (cb: (paneId: string) => void): (() => void) => {
      const listener = (_e: unknown, paneId: string): void => cb(paneId)
      ipcRenderer.on('notify:click', listener)
      return () => ipcRenderer.removeListener('notify:click', listener)
    }
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
    ): Promise<{ text: string } | { error: string }> =>
      ipcRenderer.invoke('ai:complete', prefix, suffix, opts)
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
  diagnostics: {
    run: (
      root: string,
      kind: 'eslint' | 'tsc'
    ): Promise<{
      ok: boolean
      diagnostics: Array<{
        path: string
        line: number
        column: number
        severity: 'error' | 'warning' | 'info'
        message: string
        source: string
        code?: string
      }>
      log: string
      error?: string
    }> => ipcRenderer.invoke('diagnostics:run', root, kind)
  },
  debug: {
    start: (cfg: { file: string; cwd?: string; args?: string[] }): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('debug:start', cfg),
    stop: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('debug:stop'),
    cont: (): Promise<unknown> => ipcRenderer.invoke('debug:continue'),
    stepOver: (): Promise<unknown> => ipcRenderer.invoke('debug:stepOver'),
    stepInto: (): Promise<unknown> => ipcRenderer.invoke('debug:stepInto'),
    stepOut: (): Promise<unknown> => ipcRenderer.invoke('debug:stepOut'),
    setBreakpoints: (file: string, lines: number[]): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('debug:setBreakpoints', file, lines),
    getProperties: (
      objectId: string
    ): Promise<Array<{ name: string; type: string; value: string; objectId: string | null }>> =>
      ipcRenderer.invoke('debug:getProperties', objectId),
    evaluate: (
      callFrameId: string,
      expression: string
    ): Promise<{ value: string; type: string; objectId: string | null }> =>
      ipcRenderer.invoke('debug:evaluate', callFrameId, expression),
    onEvent: (cb: (e: { type: string; payload?: unknown }) => void): (() => void) => {
      const listener = (_e: unknown, data: { type: string; payload?: unknown }): void => cb(data)
      ipcRenderer.on('debug:event', listener)
      return () => ipcRenderer.removeListener('debug:event', listener)
    }
  },
  git: {
    info: (folder: string): Promise<{ repoName: string; branch: string | null; isRepo: boolean }> =>
      ipcRenderer.invoke('git:info', folder),
    log: (
      folder: string,
      limit?: number
    ): Promise<
      Array<{
        hash: string
        parents: string[]
        author: string
        date: string
        refs: string
        subject: string
      }>
    > => ipcRenderer.invoke('git:log', folder, limit),
    branches: (folder: string): Promise<Array<{ name: string; current: boolean }>> =>
      ipcRenderer.invoke('git:branches', folder),
    checkout: (folder: string, branch: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('git:checkout', folder, branch),
    createBranch: (folder: string, name: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('git:createBranch', folder, name),
    fetch: (folder: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('git:fetch', folder),
    stash: (folder: string, message?: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('git:stash', folder, message),
    stashPop: (folder: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('git:stashPop', folder),
    stashList: (folder: string): Promise<Array<{ ref: string; subject: string }>> =>
      ipcRenderer.invoke('git:stashList', folder),
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
    stage: (folder: string, relPath: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('git:stage', folder, relPath),
    unstage: (folder: string, relPath: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('git:unstage', folder, relPath),
    stageAll: (folder: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('git:stageAll', folder),
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
    save: (data: unknown): Promise<void> => ipcRenderer.invoke('sessions:save', data),
    // Blocking write used only on beforeunload, so a reload/close can't drop the
    // pending debounced save.
    saveSync: (data: unknown): boolean => ipcRenderer.sendSync('sessions:save-sync', data) === true
  },
  // Whole-UI zoom (native UIScale). Scales the entire renderer.
  setZoom: (factor: number): void => {
    webFrame.setZoomFactor(factor) // immediate, for a snappy in-session change
    ipcRenderer.send('ui:setZoom', factor) // authoritative (survives load timing)
  },
  // Menu-driven zoom (⌘0/⌘+/⌘-): the renderer adjusts + persists uiScale.
  onUiZoom: (cb: (dir: 'in' | 'out' | 'reset') => void): (() => void) => {
    const listener = (_e: unknown, dir: 'in' | 'out' | 'reset'): void => cb(dir)
    ipcRenderer.on('ui:zoom', listener)
    return () => ipcRenderer.removeListener('ui:zoom', listener)
  },
  config: {
    load: (name: string): Promise<unknown> => ipcRenderer.invoke('config:load', name),
    save: (name: string, data: unknown): Promise<void> => ipcRenderer.invoke('config:save', name, data),
    reveal: (name: string): Promise<void> => ipcRenderer.invoke('config:reveal', name)
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
  },
  app: {
    version: (): Promise<string> => ipcRenderer.invoke('app:version')
  },
  update: {
    current: (): Promise<UpdateStatus> => ipcRenderer.invoke('update:current'),
    check: (): Promise<void> => ipcRenderer.invoke('update:check'),
    install: (): Promise<void> => ipcRenderer.invoke('update:install'),
    onStatus: (cb: (s: UpdateStatus) => void): (() => void) => {
      const listener = (_e: unknown, s: UpdateStatus): void => cb(s)
      ipcRenderer.on('update:status', listener)
      return () => ipcRenderer.removeListener('update:status', listener)
    }
  }
}

export type UpdateStatus =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'available'; version: string }
  | { state: 'downloading'; percent: number }
  | { state: 'downloaded'; version: string }
  | { state: 'upToDate' }
  | { state: 'error'; message: string }

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
