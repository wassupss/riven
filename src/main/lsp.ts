import { ipcMain, WebContents } from 'electron'
import { spawn, ChildProcess } from 'child_process'
import { dirname, join } from 'path'
import {
  createMessageConnection,
  MessageConnection,
  StreamMessageReader,
  StreamMessageWriter
} from 'vscode-jsonrpc/node'

// One language server, spawned lazily. Keyed by serverKey ('typescript' covers ts/tsx/js/jsx).
interface Server {
  proc: ChildProcess
  conn: MessageConnection
  initialized: Promise<unknown>
  sender: WebContents
}

const servers = new Map<string, Server>()

interface ServerSpec {
  // resolves the CLI entry + args for a server
  resolve: () => { command: string; args: string[]; cwd: string; initializationOptions?: unknown }
}

function tsServerSpec(rootPath: string): ReturnType<ServerSpec['resolve']> {
  // Run typescript-language-server through Electron-as-Node.
  const pkgJson = require.resolve('typescript-language-server/package.json')
  const pkg = require(pkgJson) as { bin: string | Record<string, string> }
  const binRel = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin['typescript-language-server']
  const cli = join(dirname(pkgJson), binRel)
  const tsserverPath = require.resolve('typescript/lib/tsserver.js')
  return {
    command: process.execPath,
    args: [cli, '--stdio'],
    cwd: rootPath,
    initializationOptions: { tsserver: { path: tsserverPath } }
  }
}

const SPECS: Record<string, (rootPath: string) => ReturnType<ServerSpec['resolve']>> = {
  typescript: tsServerSpec
}

function startServer(serverKey: string, rootPath: string, sender: WebContents): Server {
  const specFn = SPECS[serverKey]
  if (!specFn) throw new Error(`no LSP spec for ${serverKey}`)
  const spec = specFn(rootPath)

  const proc = spawn(spec.command, spec.args, {
    cwd: spec.cwd,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
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
  ipcMain.handle('lsp:start', async (event, serverKey: string, rootPath: string) => {
    let server = servers.get(serverKey)
    if (!server) server = startServer(serverKey, rootPath, event.sender)
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
