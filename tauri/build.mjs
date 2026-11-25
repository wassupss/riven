// Builds riven's page into out-tauri/renderer, which is Tauri's frontendDist
// (src-tauri/tauri.conf.json; embedded in a packaged binary, read from disk by
// a dev build):
//   renderer/                  the renderer (vite.config.ts), copied as built
//   renderer/__riven/preload.js  src/preload as a page script (the Tauri bridge)
// and writes src-tauri/src/services/mcp/catalog.json. Everything that used to be
// the Node main process runs in Rust (src-tauri).
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

// riven's MCP tool catalog and tool prompt, for the Rust MCP server
// (src-tauri/src/services/mcp). tauri/catalog/tools.ts is the one source.
// Written only when it changed (cargo rebuilds on it); ASCII-escaped.
async function writeMcpCatalog() {
  const r = await esbuild.build({
    entryPoints: ['tauri/catalog/tools.ts'],
    absWorkingDir: root,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    logLevel: 'warning'
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
    JSON.stringify(catalog, null, 1).replace(/[\u007f-￿]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')) + '\n'
  const file = path.join(root, 'src-tauri/src/services/mcp/catalog.json')
  const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null
  if (old !== text) fs.writeFileSync(file, text)
}

if (!process.argv.includes('--no-renderer')) {
  execFileSync(path.join(root, 'node_modules/.bin/vite'), ['build', '--config', 'vite.config.ts'], { cwd: root, stdio: 'inherit' })
} else if (!fs.existsSync(path.join(renderer, 'index.html'))) {
  throw new Error('out-tauri/renderer is missing: build once without --no-renderer')
}
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
    absWorkingDir: root
  })
])
console.log('out-tauri ready')
