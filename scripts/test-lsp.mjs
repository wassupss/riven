// Headless smoke test of the LSP pipeline: spawn typescript-language-server via
// Electron-as-Node exactly like main/lsp.ts, initialize, open a file with a type
// error, and assert we get diagnostics back.
import { createRequire } from 'module'
import { spawn } from 'child_process'
import { dirname, join } from 'path'
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter
} from 'vscode-jsonrpc/node'

const require = createRequire(import.meta.url)
const electronPath = require('electron') // string path when run under node

const pkgJson = require.resolve('typescript-language-server/package.json')
const pkg = require(pkgJson)
const binRel = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin['typescript-language-server']
const cli = join(dirname(pkgJson), binRel)
const tsserverPath = require.resolve('typescript/lib/tsserver.js')

console.log('electron:', electronPath)
console.log('cli:', cli)
console.log('tsserver:', tsserverPath)

const root = process.cwd()
const proc = spawn(electronPath, [cli, '--stdio'], {
  cwd: root,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  stdio: ['pipe', 'pipe', 'pipe']
})
proc.stderr.on('data', (d) => process.stderr.write('[lsp] ' + d))

const conn = createMessageConnection(
  new StreamMessageReader(proc.stdout),
  new StreamMessageWriter(proc.stdin)
)

let gotDiagnostics = false
conn.onNotification('textDocument/publishDiagnostics', (p) => {
  if (p.diagnostics && p.diagnostics.length) {
    console.log('DIAGNOSTICS:', JSON.stringify(p.diagnostics.map((d) => d.message)))
    gotDiagnostics = true
  }
})
conn.onRequest('workspace/configuration', (p) => (p.items || []).map(() => ({})))
conn.onRequest(() => null)
conn.listen()

const rootUri = 'file://' + root
const fileUri = 'file://' + join(root, '__lsp_probe__.ts')

const caps = await conn.sendRequest('initialize', {
  processId: process.pid,
  rootUri,
  workspaceFolders: [{ uri: rootUri, name: 'probe' }],
  initializationOptions: { tsserver: { path: tsserverPath } },
  capabilities: {
    textDocument: {
      synchronization: { didSave: true },
      completion: { completionItem: { snippetSupport: true } },
      publishDiagnostics: {}
    },
    workspace: { configuration: true, workspaceFolders: true }
  }
})
console.log('initialize OK. serverInfo:', JSON.stringify(caps.serverInfo || {}))
conn.sendNotification('initialized', {})

conn.sendNotification('textDocument/didOpen', {
  textDocument: {
    uri: fileUri,
    languageId: 'typescript',
    version: 1,
    text: 'const x: number = "hello";\nconsole.log(x)\n'
  }
})

// Also probe completion after a short delay.
setTimeout(async () => {
  const comp = await conn.sendRequest('textDocument/completion', {
    textDocument: { uri: fileUri },
    position: { line: 1, character: 8 } // after "console."
  })
  const items = Array.isArray(comp) ? comp : comp?.items || []
  console.log('COMPLETION items:', items.length, '→', items.slice(0, 5).map((i) => i.label))

  setTimeout(() => {
    console.log(gotDiagnostics ? 'RESULT: PASS (diagnostics received)' : 'RESULT: FAIL (no diagnostics)')
    proc.kill()
    process.exit(gotDiagnostics && items.length > 0 ? 0 : 1)
  }, 800)
}, 1500)
