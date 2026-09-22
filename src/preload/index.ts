import { contextBridge, ipcRenderer, webFrame, webUtils } from 'electron'

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

export type PtyAttention = 'finished' | 'needs_input' | null
const onPtyStatus = multiplexed<{ key: string; busy: boolean; attention: PtyAttention; hooked?: boolean }>(
  'pty:status'
)
const onPtyAgent = multiplexed<{ key: string; agent: boolean; name?: string | null }>('pty:agent')
// Which CLI conversation a terminal's agent is in, so the pane can resume it
// after a restart. Null when that session ended.
export type AgentKind = 'claude' | 'codex'
const onPtyAgentSession = multiplexed<{ key: string; sessionId: string | null; agent?: AgentKind | null }>(
  'pty:agentSession'
)
// The answer a terminal agent ended its turn with (from its Stop hook).
const onPtyReply = multiplexed<{ key: string; text: string }>('pty:reply')
const onPtyBell = multiplexed<{ key: string }>('pty:bell')
const onPtyTitle = multiplexed<{ key: string; title: string }>('pty:title')
const onPtyDone = multiplexed<{ key: string; reason: 'finished' | 'needs_input'; summary?: string }>(
  'pty:done'
)

// Terminal output carries the main-side model revision and flow-control epoch;
// a snapshot restores the model and starts a new epoch (see main/pty.ts).
export interface PtyChunk {
  data: string
  rev: number
  epoch: number
}
export interface PtySnapshot {
  data: string
  rev: number
  epoch: number
  cols: number
  rows: number
}

// Native agent-chat events all share one channel; the payload's `key` scopes it
// to a pane. Renderer chat panels filter by their own key.
export type ChatEvent = { turn?: string | null } & (
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
)
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
    // Save a pasted image to a temp file and return its path (agents read paths).
    saveTempImage: (dataUrl: string): Promise<string | null> =>
      ipcRenderer.invoke('image:saveTemp', dataUrl),
    writeFile: (file: string, content: string): Promise<void> =>
      ipcRenderer.invoke('workspace:writeFile', file, content),
    createFile: (p: string): Promise<void> => ipcRenderer.invoke('workspace:createFile', p),
    createFolder: (p: string): Promise<void> => ipcRenderer.invoke('workspace:createFolder', p),
    rename: (oldPath: string, newPath: string): Promise<void> =>
      ipcRenderer.invoke('workspace:rename', oldPath, newPath),
    delete: (p: string): Promise<void> => ipcRenderer.invoke('workspace:delete', p),
    reveal: (p: string): Promise<void> => ipcRenderer.invoke('workspace:reveal', p),
    // Copy things dropped from Finder into a workspace directory.
    importPaths: (destDir: string, sources: string[]): Promise<{ copied: string[]; errors: string[] }> =>
      ipcRenderer.invoke('workspace:importPaths', destDir, sources),
    snapshotContents: (folder: string): Promise<Record<string, string>> =>
      ipcRenderer.invoke('workspace:snapshotContents', folder)
  },
  // The on-disk path of a dragged File. Electron removed the non-standard
  // `File.path` property in v32, so every `(file as {path}).path` read silently
  // yields undefined on the Electron we ship; webUtils is the replacement and
  // must be called here, in the preload, with the real File object.
  pathForFile: (file: File): string => {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return ''
    }
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
      configDir?: string
    }): Promise<{ id: string; existed: boolean; error?: string }> =>
      ipcRenderer.invoke('pty:open', opts),
    write: (id: string, data: string): void => ipcRenderer.send('pty:write', id, data),
    // Cumulative chars parsed in this epoch (TCP-style, so a lost ack never
    // becomes permanent in-flight debt).
    ack: (id: string, epoch: number, processed: number): void =>
      ipcRenderer.send('pty:ack', id, epoch, processed),
    // Whether a live, sized xterm wants bytes. Hidden panes receive nothing and
    // are restored from main's model on reveal.
    visible: (id: string, visible: boolean): void => ipcRenderer.send('pty:visible', id, visible),
    // The user looked at this terminal: clear its attention flag.
    seen: (id: string): void => ipcRenderer.send('pty:seen', id),
    onAgentSession: onPtyAgentSession,
    codexSessionTitle: (id: string): Promise<string | null> => ipcRenderer.invoke('pty:codexSessionTitle', id),
    resize: (id: string, cols: number, rows: number): void =>
      ipcRenderer.send('pty:resize', id, cols, rows),
    kill: (id: string): void => ipcRenderer.send('pty:kill', id),
    onData: (id: string, cb: (chunk: PtyChunk) => void): (() => void) => {
      const channel = `pty:data:${id}`
      const listener = (_e: unknown, chunk: PtyChunk): void => cb(chunk)
      ipcRenderer.on(channel, listener)
      return () => ipcRenderer.removeListener(channel, listener)
    },
    onSnapshot: (id: string, cb: (snap: PtySnapshot) => void): (() => void) => {
      const channel = `pty:snapshot:${id}`
      const listener = (_e: unknown, snap: PtySnapshot): void => cb(snap)
      ipcRenderer.on(channel, listener)
      return () => ipcRenderer.removeListener(channel, listener)
    },
    onExit: (id: string, cb: (code: number) => void): (() => void) => {
      const channel = `pty:exit:${id}`
      const listener = (_e: unknown, code: number): void => cb(code)
      ipcRenderer.on(channel, listener)
      return () => ipcRenderer.removeListener(channel, listener)
    },
    onStatus: (
      cb: (e: { key: string; busy: boolean; attention: PtyAttention; hooked?: boolean }) => void
    ): (() => void) => onPtyStatus(cb),
    onReply: (cb: (e: { key: string; text: string }) => void): (() => void) => onPtyReply(cb),
    onAgent: (cb: (e: { key: string; agent: boolean; name?: string | null }) => void): (() => void) =>
      onPtyAgent(cb),
    onBell: (cb: (e: { key: string }) => void): (() => void) => onPtyBell(cb),
    onTitle: (cb: (e: { key: string; title: string }) => void): (() => void) => onPtyTitle(cb),
    onDone: (
      cb: (e: { key: string; reason: 'finished' | 'needs_input'; summary?: string }) => void
    ): (() => void) => onPtyDone(cb)
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
        configDir?: string
        // Which agent backs the pane. Absent = Claude Code.
        cli?: 'claude' | 'codex'
      }
    ): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('chat:start', key, opts),
    // Images go as content blocks in the same message — the model sees them
    // in that turn, with no Read call on a pasted path.
    // `turn` identifies this message so its answer can be told apart from a
    // previous turn's late one (see lib/chatTurns.isStaleEvent).
    send: (
      key: string,
      text: string,
      images?: Array<{ mediaType: string; data: string; name?: string }>,
      turn?: string
    ): void => ipcRenderer.send('chat:send', key, text, images, turn),
    interrupt: (key: string): void => ipcRenderer.send('chat:interrupt', key),
    // Whether a pane still has an agent behind it (see chat:alive).
    alive: (key: string): Promise<{ alive: boolean; running: boolean }> =>
      ipcRenderer.invoke('chat:alive', key),
    // Replace the CLI behind a pane (or every pane) with a fresh process that
    // resumes the same conversation — how a CLI update reaches open panes.
    restart: (key?: string): Promise<{ restarted: number; busy: number }> =>
      ipcRenderer.invoke('chat:restart', key),
    setModel: (key: string, model: string): void => ipcRenderer.send('chat:setModel', key, model),
    setMode: (key: string, mode: string): void => ipcRenderer.send('chat:setMode', key, mode),
    stop: (key: string): void => ipcRenderer.send('chat:stop', key),
    title: (message: string): Promise<string> => ipcRenderer.invoke('chat:title', message),
    detectClis: (): Promise<
      Array<{ name: string; cmd: string; path: string; version: string | null }>
    > => ipcRenderer.invoke('chat:detectClis'),
    accounts: (
      configDir?: string
    ): Promise<
      Array<{
        id: 'claude' | 'codex'
        name: string
        loggedIn: boolean | null
        plan?: string
        email?: string
        org?: string
        mode?: 'subscription' | 'apikey'
        configDir?: string
      }>
    > => ipcRenderer.invoke('accounts:list', configDir),
    profileDir: (id: string): Promise<string> => ipcRenderer.invoke('accounts:profileDir', id),
    logout: (configDir?: string): Promise<{ ok: boolean; output: string }> =>
      ipcRenderer.invoke('accounts:logout', configDir),
    sessionInfo: (
      cwd: string,
      configDir?: string
    ): Promise<{ slashCommands: string[]; mcpServers: Array<{ name: string; status: string }> }> =>
      ipcRenderer.invoke('chat:sessionInfo', cwd, configDir),
    sessions: (
      cwd: string,
      configDir?: string
    ): Promise<Array<{ id: string; title: string; mtime: number; messages: number }>> =>
      ipcRenderer.invoke('chat:sessions', cwd, configDir),
    agents: (
      cwd: string
    ): Promise<Array<{ name: string; description: string; source: 'project' | 'user' }>> =>
      ipcRenderer.invoke('chat:agents', cwd),
    // The conversation's own title, for a terminal tab running that session.
    sessionTitle: (cwd: string, id: string, configDir?: string): Promise<string | null> =>
      ipcRenderer.invoke('chat:sessionTitle', cwd, id, configDir),
    sessionTranscript: (
      cwd: string,
      id: string,
      configDir?: string
    ): Promise<
      Array<{
        role: 'user' | 'assistant'
        text: string
        tools: Array<{ name: string; detail: string }>
        // How many images a user message carried (the pictures themselves are
        // not sent back — they are large, and the bubble only names them).
        images?: number
      }>
    > => ipcRenderer.invoke('chat:sessionTranscript', cwd, id, configDir),
    mcpList: (
      cwd: string,
      configDir?: string
    ): Promise<
      Array<{ name: string; url: string; status: 'connected' | 'needs-auth' | 'pending' | 'other' }>
    > => ipcRenderer.invoke('chat:mcpList', cwd, configDir),
    mcpSession: (
      cwd: string,
      configDir?: string,
      fresh?: boolean
    ): Promise<Array<{ name: string; status: string }>> =>
      ipcRenderer.invoke('chat:mcpSession', cwd, configDir, fresh),
    mcpApprove: (
      cwd: string,
      name: string,
      configDir?: string
    ): Promise<{ ok: boolean; output: string }> =>
      ipcRenderer.invoke('chat:mcpApprove', cwd, name, configDir),
    mcpLogout: (
      cwd: string,
      name: string,
      configDir?: string
    ): Promise<{ ok: boolean; output: string }> =>
      ipcRenderer.invoke('chat:mcpLogout', cwd, name, configDir),
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
      css?: { w: number; h: number },
      own?: string[]
    ): void => ipcRenderer.send('browser:sync', { activeId, rect, css, own }),
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
    // Omnibox suggestions live in their own non-focusable window (renderer DOM
    // cannot paint above a page's native view). rect=null closes it.
    suggest: (
      rect: { x: number; y: number; width: number; height: number } | null,
      items: Array<{ url: string; title: string }>,
      selected: number
    ): void => ipcRenderer.send('browser:suggest', { rect, items, selected }),
    onSuggestPick: (cb: (index: number) => void): (() => void) => {
      const l = (_e: unknown, i: number): void => cb(i)
      ipcRenderer.on('browser:suggestPick', l)
      return () => ipcRenderer.removeListener('browser:suggestPick', l)
    },
    // Take keyboard focus back from the page (see browser:focusApp).
    focusApp: (): void => ipcRenderer.send('browser:focusApp'),
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
        key: string | null // the chat pane that called, when riven spawned it
      }) => void
    ): (() => void) => {
      const listener = (
        _e: unknown,
        payload: {
          id: string
          tool: string
          args: Record<string, unknown>
          cwd: string | null
          key: string | null
        }
      ): void => cb(payload)
      ipcRenderer.on('mcp:invoke', listener)
      return () => ipcRenderer.removeListener('mcp:invoke', listener)
    },
    // The calling agent hung up before the user answered (its own tool timeout,
    // or it was killed). Whatever UI is blocking on this call must stop waiting.
    onCancel: (cb: (e: { id: string }) => void): (() => void) => {
      const listener = (_e: unknown, payload: { id: string }): void => cb(payload)
      ipcRenderer.on('mcp:cancel', listener)
      return () => ipcRenderer.removeListener('mcp:cancel', listener)
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
  // A file an agent actually wrote, with the content from either side of the
  // tool call. `pane` is the agent's pane, which the renderer maps to a
  // workspace — a pane belonging to another window is simply ignored there.
  onAgentFileEdit: (
    cb: (edit: { pane: string; path: string; before: string | null; after: string }) => void
  ): (() => void) => {
    const listener = (
      _e: unknown,
      edit: { pane: string; path: string; before: string | null; after: string }
    ): void => cb(edit)
    ipcRenderer.on('agent:fileEdit', listener)
    return () => ipcRenderer.removeListener('agent:fileEdit', listener)
  },
  // The machine woke from sleep / the screen unlocked. Main has already forced a
  // repaint; the renderer uses this to undo decisions it made because the GPU
  // context died (TerminalPane's permanent DOM-renderer fallback).
  onSystemResumed: (cb: (reason: string) => void): (() => void) => {
    const listener = (_e: unknown, reason: string): void => cb(reason)
    ipcRenderer.on('system:resumed', listener)
    return () => ipcRenderer.removeListener('system:resumed', listener)
  },
  // Per-process CPU by Chromium process TYPE — Activity Monitor shows three
  // identically-named "riven Helper" processes and cannot tell them apart.
  perf: {
    metrics: (): Promise<
      Array<{ pid: number; type: string; serviceName?: string; name?: string; cpu: number }>
    > => ipcRenderer.invoke('perf:metrics')
  },
  notify: {
    // Main decides whether and where to show it from every window's presence
    // (see main/notify.ts). opts.paneId names the pane it is about: a window
    // already looking at that pane suppresses it, and a click lands there.
    show: (title: string, body: string, opts?: { force?: boolean; paneId?: string }): void =>
      ipcRenderer.send('notify:show', { title, body, ...opts }),
    presence: (p: { visible: boolean; focused: boolean; activePane: string | null; at: number }): void =>
      ipcRenderer.send('notify:presence', p),
    diag: (): Promise<{
      requested: number
      suppressed: number
      cooled: number
      shown: number
      failed: number
      clicked: number
    }> => ipcRenderer.invoke('notify:diag'),
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
  usage: {
    today: (configDir?: string): Promise<{
      totalCost: number
      totalTokens: number
      perModel: Array<{ model: string; input: number; output: number; cacheWrite: number; cacheRead: number; cost: number }>
    }> => ipcRenderer.invoke('usage:today', configDir),
    codex: (): Promise<{
      installed: boolean
      totalTokens: number
      primary: { usedPct: number; resetsAt: string | null } | null
      primaryWindowMinutes: number | null
      secondary: { usedPct: number; resetsAt: string | null } | null
    }> => ipcRenderer.invoke('usage:codex'),
    limits: (configDir?: string): Promise<{
      session: { usedPct: number; resetsAt: string | null } | null
      weekly: { usedPct: number; resetsAt: string | null } | null
      stale?: boolean
      at?: number
    }> => ipcRenderer.invoke('usage:limits', configDir)
  },
  ports: {
    list: (folder: string): Promise<Array<{ port: number; pid: number; name: string }>> =>
      ipcRenderer.invoke('ports:list', folder),
    // Stop the process holding one of this workspace's ports. Main re-derives the
    // pid from its own scan, so this cannot be used to kill an arbitrary process.
    kill: (
      folder: string,
      port: number,
      pid: number
    ): Promise<{ ok: boolean; forced?: boolean; error?: string }> =>
      ipcRenderer.invoke('ports:kill', folder, port, pid)
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
  // Pull requests, through the `gh` CLI the user has already authenticated —
  // riven keeps no GitHub token of its own.
  gh: {
    prs: (
      repoDir: string,
      state?: 'open' | 'closed' | 'all'
    ): Promise<{
      ok: boolean
      login: string | null
      error?: 'no-gh' | 'not-authed' | 'no-remote' | 'failed'
      detail?: string
      prs: Array<{
        number: number
        title: string
        url: string
        state: string
        author: string
        isMine: boolean
        needsMyReview: boolean
        headRefName: string
        baseRefName: string
        isDraft: boolean
        review: 'approved' | 'changes_requested' | 'review_required' | 'none'
        checks: { total: number; passed: number; failed: number; pending: number }
        updatedAt: string
        parent: number | null
        depth: number
      }>
    }> => ipcRenderer.invoke('gh:prs', repoDir, state ?? 'open'),
    // What a new PR from this branch would start as: the base it lands on, the
    // title GitHub itself would choose, and the repo's PR template.
    newPrDraft: (
      repoDir: string
    ): Promise<{
      branch: string
      base: string
      title: string
      body: string
      commits: number
      hasTemplate: boolean
      pushed: boolean
      error?: string
    }> => ipcRenderer.invoke('gh:newPrDraft', repoDir),
    // Opens a pull request from inside riven. The body goes to `gh` on stdin.
    createPr: (
      repoDir: string,
      input: { title: string; body: string; base: string; draft: boolean }
    ): Promise<{ ok: boolean; url?: string; error?: string; needsPush?: boolean }> =>
      ipcRenderer.invoke('gh:createPr', repoDir, input),
    // Publishing the branch is its own step — it puts commits on a server.
    pushBranch: (repoDir: string, branch: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('gh:pushBranch', repoDir, branch),
    createWeb: (repoDir: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('gh:createWeb', repoDir),
    // One PR with everything needed to review it: status, changed files with
    // their patches, and the review threads on those lines.
    detail: (
      repoDir: string,
      number: number
    ): Promise<
      | {
          ok: true
          detail: {
            number: number
            title: string
            url: string
            body: string
            author: string
            state: string
            isDraft: boolean
            baseRefName: string
            headRefName: string
            headRefOid: string
            mergeable: string
            mergeStateStatus: string
            review: 'approved' | 'changes_requested' | 'review_required' | 'none'
            checks: { total: number; passed: number; failed: number; pending: number }
            checkRuns: Array<{ name: string; state: string; url: string | null }>
            additions: number
            deletions: number
            changedFiles: number
            files: Array<{
              filename: string
              previousFilename?: string
              status: string
              additions: number
              deletions: number
              changes: number
              patch: string | null
            }>
            threads: Array<{
              id: string
              path: string
              line: number | null
              originalLine: number | null
              startLine: number | null
              diffSide: 'LEFT' | 'RIGHT'
              isResolved: boolean
              isOutdated: boolean
              resolvedBy: string | null
              comments: Array<{
                id: string
                databaseId: number | null
                author: string
                body: string
                createdAt: string
                outdated: boolean
                diffHunk: string
              }>
            }>
            // Reviews (verdict + summary) and discussion not tied to a line.
            conversation: Array<{
              kind: 'review' | 'comment'
              author: string
              body: string
              at: string
              state?: string
            }>
          }
        }
      | { ok: false; error: string }
    > => ipcRenderer.invoke('gh:prDetail', repoDir, number),
    // Both sides of one file, for a diff editor: the patch alone only carries
    // the changed hunks with three lines of context.
    prFile: (
      repoDir: string,
      number: number,
      filePath: string
    ): Promise<{
      ok: boolean
      base: string
      head: string
      baseRefOid: string
      headRefOid: string
      error?: string
    }> => ipcRenderer.invoke('gh:prFile', repoDir, number, filePath),
    // Publishes under the user's GitHub account — only ever called from a
    // button that says so.
    submitReview: (
      repoDir: string,
      number: number,
      event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT',
      body: string,
      comments: Array<{ path: string; line: number; side: 'LEFT' | 'RIGHT'; startLine?: number; body: string }>,
      commitId: string
    ): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('gh:submitReview', repoDir, number, event, body, comments, commitId),
    replyThread: (repoDir: string, threadId: string, body: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('gh:replyThread', repoDir, threadId, body),
    resolveThread: (
      repoDir: string,
      threadId: string,
      resolved: boolean
    ): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('gh:resolveThread', repoDir, threadId, resolved)
  },
  git: {
    info: (folder: string): Promise<{ repoName: string; branch: string | null; isRepo: boolean }> =>
      ipcRenderer.invoke('git:info', folder),
    // Repos at/under the workspace folder (a workspace often holds many).
    repos: (folder: string): Promise<Array<{ path: string; name: string; branch: string | null }>> =>
      ipcRenderer.invoke('git:repos', folder),
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
  openExternal: (url: string): void => ipcRenderer.send('shell:openExternal', url),
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
  // 리븐펫's own always-on-top window (see src/main/pet.ts). The renderer
  // asks for it; main owns whether it exists.
  pet: {
    open: (): Promise<void> => ipcRenderer.invoke('pet:open'),
    close: (): Promise<void> => ipcRenderer.invoke('pet:close'),
    hide: (): Promise<void> => ipcRenderer.invoke('pet:hide'),
    isOpen: (): Promise<boolean> => ipcRenderer.invoke('pet:isOpen'),
    // The device measures itself; main resizes the window to match.
    resize: (height: number): Promise<void> => ipcRenderer.invoke('pet:resize', height),
    // A press of the pet's A / B / C, sent from wherever the shortcut fired and
    // delivered to whichever window is showing the device.
    press: (key: 'a' | 'b' | 'c'): Promise<void> => ipcRenderer.invoke('pet:press', key),
    onPress: (cb: (key: 'a' | 'b' | 'c') => void): (() => void) => {
      const l = (_e: unknown, key: 'a' | 'b' | 'c'): void => cb(key)
      ipcRenderer.on('pet:press', l)
      return () => ipcRenderer.removeListener('pet:press', l)
    },
    // Float the pet's window above other apps, or let it sit among them. The app
    // applies what it has persisted (setOnTop); the pet window asks for a change
    // (askOnTop) because it is not the window that may write settings.json.
    setOnTop: (on: boolean): Promise<void> => ipcRenderer.invoke('pet:setOnTop', on),
    askOnTop: (on: boolean): Promise<void> => ipcRenderer.invoke('pet:askOnTop', on),
    isOnTop: (): Promise<boolean> => ipcRenderer.invoke('pet:isOnTop'),
    onOnTop: (cb: (on: boolean) => void): (() => void) => {
      const l = (_e: unknown, on: boolean): void => cb(on)
      ipcRenderer.on('pet:onTop', l)
      return () => ipcRenderer.removeListener('pet:onTop', l)
    },
    // Fired for EVERY window: the floating pet was closed / put away, so the app
    // can put its own state back in step.
    onClosed: (cb: () => void): (() => void) => {
      const l = (): void => cb()
      ipcRenderer.on('pet:closed', l)
      return () => ipcRenderer.removeListener('pet:closed', l)
    },
    onHidden: (cb: () => void): (() => void) => {
      const l = (): void => cb()
      ipcRenderer.on('pet:hidden', l)
      return () => ipcRenderer.removeListener('pet:hidden', l)
    }
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
