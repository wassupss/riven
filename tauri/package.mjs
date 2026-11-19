// Builds a bundled riven-tauri.app: one Rust binary with the page embedded
// (Tauri's frontendDist, out-tauri/renderer). No Node and no node_modules in
// the bundle: the app never starts Node (language servers and agents a person
// installed run from their own PATH).
//
//   node tauri/package.mjs              build out-tauri, then `tauri build`
//   node tauri/package.mjs --no-build   bundle the existing out-tauri
//
// Signing here is ad-hoc ("-", tauri.bundle.json): runs on this Mac only.
// Release builds in CI pass their own config on top (Developer ID identity,
// notarization, updater artifacts); see docs/tauri-rust-main.md (8단계 배포).
//   RIVEN_TAURI_BUNDLE_CONFIG=<json file>  an extra --config merged after tauri.bundle.json
import { execFileSync } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

if (!process.argv.includes('--no-build')) {
  execFileSync(process.execPath, [path.join(root, 'tauri/build.mjs')], { cwd: root, stdio: 'inherit' })
}
if (!fs.existsSync(path.join(root, 'out-tauri/renderer/__riven/preload.js'))) {
  throw new Error('out-tauri/renderer is not built (run without --no-build)')
}
// Left over from the Node-bundling packager.
fs.rmSync(path.join(root, 'src-tauri/target/stage'), { recursive: true, force: true })

const args = ['-y', '@tauri-apps/cli@2', 'build', '--config', 'tauri.bundle.json']
if (process.env.RIVEN_TAURI_BUNDLE_CONFIG) args.push('--config', path.resolve(process.env.RIVEN_TAURI_BUNDLE_CONFIG))
execFileSync('npx', args, { cwd: path.join(root, 'src-tauri'), stdio: 'inherit' })
console.log('bundle: src-tauri/target/release/bundle/macos/riven-tauri.app')
