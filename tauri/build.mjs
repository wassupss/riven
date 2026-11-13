// Builds the Tauri flavour of riven into out-tauri/:
//   main/      src/main bundled for plain Node, 'electron' -> tauri/shim
//   preload/   src/preload as a page script, 'electron' -> the preload shim
//   renderer/  the unchanged renderer build (electron-vite), copied
//
//   node tauri/build.mjs            all three
//   node tauri/build.mjs --no-renderer
import * as esbuild from 'esbuild'
import { execFileSync } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const out = path.join(root, 'out-tauri')
const shim = (f) => path.join(root, 'tauri/shim', f)

function alias(map) {
  return {
    name: 'alias',
    setup(b) {
      const re = new RegExp(`^(${Object.keys(map).map((k) => k.replace(/[-/]/g, '\\$&')).join('|')})$`)
      b.onResolve({ filter: re }, (a) => ({ path: map[a.path] }))
    }
  }
}

// src/main modules whose group moved to Rust (src-tauri/src/commands): the
// Tauri build gets the stub in tauri/shim/moved instead, so the Node bundle
// no longer carries them. Add a name here when its group moves.
const MOVED = ['config', 'sessions', 'workspace', 'search', 'notes', 'pty', 'agentChat', 'mcpServer', 'agentHooks', 'git', 'githubPr', 'githubPrDetail', 'githubPrReview', 'watch', 'db/engine', 'lsp', 'debugger', 'cli', 'ports', 'modelCatalog', 'diagnostics', 'usage', 'apiclient', 'keepAwake', 'perf', 'notify']
const movedPlugin = {
  name: 'moved',
  setup(b) {
    const mainDir = path.join(root, 'src/main')
    b.onResolve({ filter: new RegExp(`^\\./(${MOVED.join('|')})$`) }, (a) =>
      a.resolveDir === mainDir ? { path: shim(`moved/${a.path.slice(2)}.ts`) } : undefined
    )
  }
}

// electron-vite's `?asset`: the file is emitted beside the bundle and the import
// is its absolute path at run time.
const assetPlugin = {
  name: 'asset',
  setup(b) {
    b.onResolve({ filter: /\?asset$/ }, (a) => ({
      path: path.resolve(a.resolveDir, a.path.replace(/\?asset$/, '')),
      namespace: 'asset'
    }))
    b.onLoad({ filter: /.*/, namespace: 'asset' }, (a) => {
      const name = path.basename(a.path)
      fs.mkdirSync(path.join(out, 'main'), { recursive: true })
      fs.copyFileSync(a.path, path.join(out, 'main', name))
      return { contents: `module.exports = require('path').join(__dirname, ${JSON.stringify(name)})`, loader: 'js' }
    })
  }
}

const mainOpts = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  packages: 'external',
  sourcemap: 'linked',
  logLevel: 'warning',
  plugins: [
    alias({ electron: shim('electron-main.ts'), 'electron-updater': shim('electron-updater.ts') }),
    movedPlugin,
    assetPlugin
  ]
}

// riven's MCP tool catalog and tool prompt, for the Rust MCP server
// (src-tauri/src/services/mcp). src/main/mcpServer.ts stays the one source:
// the Electron build serves it as is, and the Tauri build reads this JSON, so
// both offer agents the same tools, schemas, descriptions and prompt. Written
// only when it changed (cargo rebuilds on it); ASCII-escaped.
async function writeMcpCatalog() {
  const r = await esbuild.build({
    entryPoints: ['src/main/mcpServer.ts'],
    absWorkingDir: root,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    logLevel: 'warning',
    plugins: [
      {
        name: 'no-electron',
        setup(b) {
          b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'stub' }))
          b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'module.exports = { ipcMain: {} }', loader: 'js' }))
        }
      }
    ]
  })
  const mod = { exports: {} }
  new Function('module', 'exports', 'require', r.outputFiles[0].text)(mod, mod.exports, (await import('module')).createRequire(import.meta.url))
  const m = mod.exports
  const catalog = {
    tools: m.MCP_TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      implemented: t.implemented,
      advertised: t.advertised !== false
    })),
    promptHead: m.PROMPT_HEAD,
    promptLines: m.PROMPT_LINES
  }
  const text =
    JSON.stringify(catalog, null, 1).replace(/[\u007f-\uffff]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')) + '\n'
  const file = path.join(root, 'src-tauri/src/services/mcp/catalog.json')
  const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null
  if (old !== text) fs.writeFileSync(file, text)
}

fs.rmSync(path.join(out, 'main'), { recursive: true, force: true })
fs.rmSync(path.join(out, 'preload'), { recursive: true, force: true })

await Promise.all([
  writeMcpCatalog(),
  esbuild.build({
    ...mainOpts,
    // The DB feature (and its SQLite worker) runs in Rust since stage 6.
    entryPoints: { index: 'src/main/index.ts' },
    outdir: path.join(out, 'main'),
    absWorkingDir: root
  }),
  esbuild.build({
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'safari17',
    sourcemap: 'inline',
    logLevel: 'warning',
    entryPoints: { index: 'src/preload/index.ts' },
    outdir: path.join(out, 'preload'),
    absWorkingDir: root,
    plugins: [alias({ electron: shim('electron-preload.ts') })]
  })
])

if (!process.argv.includes('--no-renderer')) {
  execFileSync(path.join(root, 'node_modules/.bin/electron-vite'), ['build'], { cwd: root, stdio: 'inherit' })
  fs.rmSync(path.join(out, 'renderer'), { recursive: true, force: true })
  fs.cpSync(path.join(root, 'out/renderer'), path.join(out, 'renderer'), { recursive: true })
}
console.log('out-tauri ready')
