import { app, ipcMain, WebContents } from 'electron'
import { spawn, ChildProcess } from 'child_process'
import { createRequire } from 'module'
import { dirname, join } from 'path'
import {
  createMessageConnection,
  MessageConnection,
  StreamMessageReader,
  StreamMessageWriter
} from 'vscode-jsonrpc/node'
import { resolveBin } from './shellPath'

// One language server per serverKey, spawned lazily. A serverKey groups the
// languages one server owns (e.g. 'typescript' covers ts/tsx/js/jsx, 'clangd'
// covers c/cpp). Servers that aren't installed resolve to null and are skipped.
interface Server {
  proc: ChildProcess
  conn: MessageConnection
  initialized: Promise<unknown>
  sender: WebContents
  rootPath: string // the workspace root this server was initialized against
  env?: Record<string, string> // extra env for ELECTRON_RUN_AS_NODE etc.
  /** Documents the editor has open on this server (didOpen minus didClose). */
  openDocs: Set<string>
  /** Running once the last of them closed — see IDLE_STOP_MS. */
  idleTimer: ReturnType<typeof setTimeout> | null
}

// A language server is stopped once NO file of its language has been open in
// the editor for this long. Not "no requests for N minutes": while a file is
// open the server must stay warm — rust-analyzer or clangd can take minutes to
// re-index — so only a language nobody is looking at any more is let go.
const IDLE_STOP_MS = Number(process.env.RIVEN_LSP_IDLE_STOP_MS) || 10 * 60_000

interface Spec {
  command: string
  args: string[]
  cwd: string
  initializationOptions?: unknown
  runAsNode?: boolean // spawn Electron in node mode (for JS-based servers we bundle)
  // Tell the server the CLIENT owns file watching. Only set this for a server
  // that otherwise watches the workspace itself and cannot survive failing to —
  // we do not actually send workspace/didChangeWatchedFiles, so the server sees
  // edits to OPEN documents (didChange) but not changes made outside the editor.
  clientWatchesFiles?: boolean
}

const servers = new Map<string, Server>()
// In-flight starts, so two concurrent lsp:start for the same key await one spawn
// instead of racing and leaking a duplicate server process.
const starting = new Map<string, Promise<Server>>()

// A resolver returns the launch spec, or null when the server binary isn't found
// on the user's PATH. Add a language server by adding one entry here + a mapping
// in the renderer client (src/renderer/src/lsp/client.ts).
type Resolver = (rootPath: string) => Promise<Spec | null>

// Resolve a JS language server we bundle as an app dependency. Returns its entry
// file, or null if it isn't installed. Run these via Electron-as-Node so they
// work with zero setup (like VSCode extensions bundling their own server).
function bundled(moduleId: string): string | null {
  try {
    return require.resolve(moduleId)
  } catch {
    return null
  }
}

// Resolve a JS language server from the *workspace's* own node_modules (walking
// up parent dirs, so monorepo hoisting works). A project that pins its own
// server should win over the copy we bundle: the server has to agree with the
// framework version the project compiles with, and ours is frozen per release.
function fromWorkspace(rootPath: string, moduleId: string): string | null {
  try {
    // The path only anchors resolution — it doesn't have to exist.
    return createRequire(join(rootPath, 'package.json')).resolve(moduleId)
  } catch {
    return null
  }
}

const SPECS: Record<string, Resolver> = {
  // Bundled with the app — always available.
  typescript: async (rootPath) => {
    const pkgJson = require.resolve('typescript-language-server/package.json')
    const pkg = require(pkgJson) as { bin: string | Record<string, string> }
    const binRel = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin['typescript-language-server']
    const cli = join(dirname(pkgJson), binRel)
    const tsserverPath = require.resolve('typescript/lib/tsserver.js')
    return {
      command: process.execPath,
      args: [cli, '--stdio'],
      cwd: rootPath,
      runAsNode: true,
      initializationOptions: { tsserver: { path: tsserverPath } }
    }
  },
  // The rest are optional — used only if the user has them installed on PATH.
  clangd: async (rootPath) => {
    const bin = await resolveBin('clangd')
    return bin ? { command: bin, args: ['--background-index'], cwd: rootPath } : null
  },
  // Bundled (python) — falls back to a system pyright-langserver if present.
  pyright: async (rootPath) => {
    const entry = bundled('pyright/langserver.index.js')
    if (entry)
      return { command: process.execPath, args: [entry, '--stdio'], cwd: rootPath, runAsNode: true }
    const bin = await resolveBin('pyright-langserver')
    return bin ? { command: bin, args: ['--stdio'], cwd: rootPath } : null
  },
  gopls: async (rootPath) => {
    const bin = await resolveBin('gopls')
    return bin ? { command: bin, args: [], cwd: rootPath } : null
  },
  rust: async (rootPath) => {
    const bin = await resolveBin('rust-analyzer')
    return bin ? { command: bin, args: [], cwd: rootPath } : null
  },
  // Bundled (shell) — falls back to a system bash-language-server if present.
  bash: async (rootPath) => {
    const entry = bundled('bash-language-server/out/cli.js')
    if (entry)
      return { command: process.execPath, args: [entry, 'start'], cwd: rootPath, runAsNode: true }
    const bin = await resolveBin('bash-language-server')
    return bin ? { command: bin, args: ['start'], cwd: rootPath } : null
  },
  // Bundled (yaml) — falls back to a system yaml-language-server if present.
  yaml: async (rootPath) => {
    const entry = bundled('yaml-language-server/bin/yaml-language-server')
    if (entry)
      return { command: process.execPath, args: [entry, '--stdio'], cwd: rootPath, runAsNode: true }
    const bin = await resolveBin('yaml-language-server')
    return bin ? { command: bin, args: ['--stdio'], cwd: rootPath } : null
  },
  // Workspace copy first, then the bundled one — a SvelteKit project pins the
  // server alongside its svelte version, and that pairing is what makes
  // svelte2tsx produce the right types. Falls back to a system `svelteserver`.
  svelte: async (rootPath) => {
    const entry =
      fromWorkspace(rootPath, 'svelte-language-server/bin/server.js') ??
      bundled('svelte-language-server/bin/server.js')
    if (entry)
      return {
        command: process.execPath,
        args: [entry, '--stdio'],
        cwd: rootPath,
        runAsNode: true,
        // Defaults for everything except completion filtering: the server
        // pre-filters incomplete lists against its own word heuristic, which
        // throws away items Monaco would have matched. Let Monaco filter.
        // Without this the server builds its OWN chokidar watcher over the whole
        // workspace root (server.js: the FallbackWatcher branch taken when the
        // client doesn't advertise didChangeWatchedFiles.dynamicRegistration).
        // On a large root that hits `EMFILE: too many open files, watch`, and
        // chokidar's unhandled 'error' event kills the process — so the server
        // died seconds after starting, every later request answered "server
        // svelte not started", and nothing ever reached the Output panel.
        clientWatchesFiles: true,
        initializationOptions: {
          configuration: { typescript: {}, javascript: {} },
          dontFilterIncompleteCompletions: true
        }
      }
    const bin = await resolveBin('svelteserver')
    return bin ? { command: bin, args: ['--stdio'], cwd: rootPath } : null
  }
}

async function startServer(serverKey: string, rootPath: string, sender: WebContents): Promise<Server> {
  const resolver = SPECS[serverKey]
  if (!resolver) throw new Error(`no LSP spec for ${serverKey}`)
  const spec = await resolver(rootPath)
  if (!spec) throw new Error(`LSP server ${serverKey} is not installed`)

  const env = spec.runAsNode
    ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    : { ...process.env }
  const proc = spawn(spec.command, spec.args, {
    cwd: spec.cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe']
  })
  proc.stderr?.on('data', (d) => console.log(`[lsp:${serverKey}]`, d.toString().trim()))

  const conn = createMessageConnection(
    new StreamMessageReader(proc.stdout!),
    new StreamMessageWriter(proc.stdin!)
  )

  // Build the record up front with a MUTABLE sender; the forward reads
  // server.sender so after a ⌘R (which updates it in lsp:start) diagnostics keep
  // flowing instead of being dropped to the old, destroyed WebContents.
  const server: Server = { proc, conn, initialized: Promise.resolve(), sender, rootPath, openDocs: new Set(), idleTimer: null }
  // OS-level spawn failure (EMFILE/EACCES/…) → clean up so callers don't hang.
  proc.on('error', (e) => {
    console.error(`[lsp:${serverKey}] spawn error`, e)
    servers.delete(serverKey)
    starting.delete(serverKey)
  })

  // Server -> client notifications get forwarded to the current renderer.
  conn.onNotification((method, params) => {
    if (!server.sender.isDestroyed()) server.sender.send('lsp:notify', { serverKey, method, params })
  })
  // Answer the handful of server -> client requests with safe defaults.
  conn.onRequest((method, params) => {
    if (method === 'workspace/configuration') {
      return Array.isArray((params as { items?: unknown[] })?.items)
        ? (params as { items: unknown[] }).items.map(() => ({}))
        : []
    }
    if (method === 'workspace/applyEdit') return { applied: false }
    return null
  })

  conn.listen()

  const rootUri = `file://${rootPath}`
  const initialized = conn
    .sendRequest('initialize', {
      processId: process.pid,
      rootUri,
      workspaceFolders: [{ uri: rootUri, name: rootPath.split('/').pop() }],
      initializationOptions: spec.initializationOptions,
      capabilities: {
        textDocument: {
          synchronization: { dynamicRegistration: false, didSave: true },
          completion: {
            dynamicRegistration: false,
            contextSupport: true,
            completionItem: {
              snippetSupport: true,
              documentationFormat: ['markdown', 'plaintext'],
              resolveSupport: { properties: ['documentation', 'detail'] }
            }
          },
          hover: { dynamicRegistration: false, contentFormat: ['markdown', 'plaintext'] },
          signatureHelp: {
            dynamicRegistration: false,
            signatureInformation: { documentationFormat: ['markdown', 'plaintext'] }
          },
          definition: { dynamicRegistration: false, linkSupport: false },
          references: { dynamicRegistration: false },
          implementation: { dynamicRegistration: false, linkSupport: false },
          typeDefinition: { dynamicRegistration: false, linkSupport: false },
          publishDiagnostics: { relatedInformation: true }
        },
        workspace: {
          configuration: true,
          workspaceFolders: true,
          applyEdit: false,
          ...(spec.clientWatchesFiles
            ? { didChangeWatchedFiles: { dynamicRegistration: true } }
            : {})
        }
      }
    })
    .then((caps) => {
      conn.sendNotification('initialized', {})
      return caps
    })

  server.initialized = initialized
  servers.set(serverKey, server)
  // A server that dies leaves no trace otherwise: it drops out of the registry
  // and every later request answers "not started", which reads to the user as
  // the language simply not being supported. Say so out loud.
  proc.on('exit', (code, signal) => {
    if (code !== 0 || signal) console.error(`[lsp:${serverKey}] exited (code ${code}, signal ${signal})`)
    servers.delete(serverKey)
    starting.delete(serverKey)
  })
  return server
}

function stopServer(key: string, s: Server): void {
  if (s.idleTimer) clearTimeout(s.idleTimer)
  s.idleTimer = null
  try {
    s.conn.sendRequest('shutdown').catch(() => {})
    s.conn.sendNotification('exit')
  } catch {
    /* connection already gone */
  }
  try {
    s.proc.kill()
  } catch {
    /* already exited */
  }
  servers.delete(key)
  starting.delete(key)
}

function trackOpenDocs(serverKey: string, server: Server, method: string, params: unknown): void {
  const uri = (params as { textDocument?: { uri?: string } } | null)?.textDocument?.uri
  if (!uri) return
  if (method === 'textDocument/didOpen') {
    server.openDocs.add(uri)
    if (server.idleTimer) clearTimeout(server.idleTimer)
    server.idleTimer = null
  } else if (method === 'textDocument/didClose') {
    server.openDocs.delete(uri)
    if (server.openDocs.size || server.idleTimer) return
    server.idleTimer = setTimeout(() => {
      server.idleTimer = null
      if (servers.get(serverKey) !== server || server.openDocs.size) return
      console.log(`[lsp:${serverKey}] no open files for ${IDLE_STOP_MS / 60_000}min — stopping`)
      stopServer(serverKey, server)
      // The renderer remembers it started this server; tell it, so the next
      // file of this language starts a fresh one instead of talking to nothing.
      if (!server.sender.isDestroyed()) server.sender.send('lsp:stopped', serverKey)
    }, IDLE_STOP_MS)
    server.idleTimer.unref?.()
  }
}

export function registerLspHandlers(): void {
  // A workspace was closed and no other open workspace uses its folder: its
  // language servers (tsserver, clangd, gopls, rust-analyzer — some of them
  // indexing gigabytes) have nobody left to answer, so they go with it.
  ipcMain.handle('lsp:stopRoot', (_e, rootPath: string) => {
    let stopped = 0
    for (const [key, s] of [...servers]) {
      if (s.rootPath !== rootPath) continue
      stopServer(key, s)
      if (!s.sender.isDestroyed()) s.sender.send('lsp:stopped', key)
      stopped++
    }
    return stopped
  })

  // Don't orphan heavy indexers (clangd/gopls/rust-analyzer) after quit.
  app.on('before-quit', () => {
    for (const [, s] of servers) {
      try {
        s.conn.sendRequest('shutdown').catch(() => {})
        s.conn.sendNotification('exit')
      } catch {
        /* connection already gone */
      }
      try {
        s.proc.kill()
      } catch {
        /* already exited */
      }
    }
    servers.clear()
    starting.clear()
  })

  // Report which servers are actually available (installed) for this workspace,
  // so the renderer only wires LSP features for languages it can serve.
  ipcMain.handle('lsp:servers', async (_event, rootPath: string) => {
    const keys = await Promise.all(
      Object.entries(SPECS).map(async ([key, resolve]) => {
        try {
          return (await resolve(rootPath)) ? key : null
        } catch {
          return null
        }
      })
    )
    return keys.filter(Boolean) as string[]
  })

  ipcMain.handle('lsp:start', async (event, serverKey: string, rootPath: string) => {
    const existing = servers.get(serverKey)
    if (existing) {
      if (existing.rootPath === rootPath) {
        existing.sender = event.sender // ⌘R: point the forward at the new renderer
        return existing.initialized
      }
      // Root changed (workspace switch): the running server is indexing the old
      // project, so its diagnostics/completions would be wrong. Shut it down and
      // fall through to spawn a fresh one rooted at the new path.
      try {
        existing.conn.sendNotification('exit')
      } catch {
        /* connection already gone */
      }
      try {
        existing.proc.kill()
      } catch {
        /* already exited */
      }
      servers.delete(serverKey)
      starting.delete(serverKey)
    }
    let pending = starting.get(serverKey)
    if (!pending) {
      pending = startServer(serverKey, rootPath, event.sender)
      starting.set(serverKey, pending)
      pending.then(
        () => starting.delete(serverKey),
        () => starting.delete(serverKey)
      )
    }
    const server = await pending
    server.sender = event.sender
    return server.initialized
  })

  ipcMain.handle('lsp:request', async (_event, serverKey: string, method: string, params: unknown) => {
    const server = servers.get(serverKey)
    if (!server) throw new Error(`server ${serverKey} not started`)
    await server.initialized
    return server.conn.sendRequest(method, params)
  })

  ipcMain.on('lsp:notify', (_event, serverKey: string, method: string, params: unknown) => {
    const server = servers.get(serverKey)
    if (!server) return
    trackOpenDocs(serverKey, server, method, params)
    server.initialized.then(() => server!.conn.sendNotification(method, params))
  })
}
