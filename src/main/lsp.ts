import { ipcMain, WebContents } from 'electron'
import { spawn, ChildProcess } from 'child_process'
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
  env?: Record<string, string> // extra env for ELECTRON_RUN_AS_NODE etc.
}

interface Spec {
  command: string
  args: string[]
  cwd: string
  initializationOptions?: unknown
  runAsNode?: boolean // spawn Electron in node mode (for JS-based servers we bundle)
}

const servers = new Map<string, Server>()

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

  // Server -> client notifications get forwarded to the renderer.
  conn.onNotification((method, params) => {
    if (!sender.isDestroyed()) sender.send('lsp:notify', { serverKey, method, params })
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
        workspace: { configuration: true, workspaceFolders: true, applyEdit: false }
      }
    })
    .then((caps) => {
      conn.sendNotification('initialized', {})
      return caps
    })

  const server: Server = { proc, conn, initialized, sender }
  servers.set(serverKey, server)
  proc.on('exit', () => servers.delete(serverKey))
  return server
}

export function registerLspHandlers(): void {
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
    let server = servers.get(serverKey)
    if (!server) server = await startServer(serverKey, rootPath, event.sender)
    const caps = await server.initialized
    return caps
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
    server.initialized.then(() => server!.conn.sendNotification(method, params))
  })
}
