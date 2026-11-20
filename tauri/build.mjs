// Builds the Tauri flavour of riven's page into out-tauri/renderer, which is
// Tauri's frontendDist (src-tauri/tauri.conf.json; embedded in a packaged
// binary, read from disk by a dev build):
//   renderer/                  the unchanged renderer build (electron-vite), copied
//   renderer/__riven/preload.js src/preload as a page script, 'electron' -> tauri/page
// and writes src-tauri/src/services/mcp/catalog.json. There is no Node main
// process any more: everything src/main did runs in Rust (src-tauri).
//
//   node tauri/build.mjs            both
//   node tauri/build.mjs --no-renderer   the preload and the catalog only
import * as esbuild from 'esbuild'
import { execFileSync } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const out = path.join(root, 'out-tauri')
const renderer = path.join(out, 'renderer')

function alias(map) {
  return {
    name: 'alias',
    setup(b) {
      const re = new RegExp(`^(${Object.keys(map).map((k) => k.replace(/[-/]/g, '\\$&')).join('|')})$`)
      b.onResolve({ filter: re }, (a) => ({ path: map[a.path] }))
    }
  }
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

if (!process.argv.includes('--no-renderer')) {
  execFileSync(path.join(root, 'node_modules/.bin/electron-vite'), ['build'], { cwd: root, stdio: 'inherit' })
  fs.rmSync(renderer, { recursive: true, force: true })
  fs.cpSync(path.join(root, 'out/renderer'), renderer, { recursive: true })
} else if (!fs.existsSync(path.join(renderer, 'index.html'))) {
  throw new Error('out-tauri/renderer is missing: build once without --no-renderer')
}
// Left over from the Node days (out-tauri/main, out-tauri/preload).
fs.rmSync(path.join(out, 'main'), { recursive: true, force: true })
fs.rmSync(path.join(out, 'preload'), { recursive: true, force: true })
fs.rmSync(path.join(renderer, '__riven'), { recursive: true, force: true })

await Promise.all([
  writeMcpCatalog(),
  esbuild.build({
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'safari17',
    sourcemap: 'inline',
    logLevel: 'warning',
    entryPoints: { preload: 'src/preload/index.ts' },
    outdir: path.join(renderer, '__riven'),
    absWorkingDir: root,
    plugins: [alias({ electron: path.join(root, 'tauri/page/electron.ts') })]
  })
])
console.log('out-tauri ready')
