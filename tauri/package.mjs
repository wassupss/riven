// Builds a bundled riven-tauri.app: one Rust binary with the page embedded
// (Tauri's frontendDist, out-tauri/renderer). No Node and no node_modules in
// the bundle: the app never starts Node (language servers and agents a person
// installed run from their own PATH).
//
//   node tauri/package.mjs              build out-tauri, then `tauri build`
//   node tauri/package.mjs --no-build   bundle the existing out-tauri
//   node tauri/package.mjs --release    the release identity (see below)
//   node tauri/package.mjs --target universal-apple-darwin
//                                       one Rust target (CI's release: both arches in one .app)
//   node tauri/package.mjs --dry-run    print the build step and the tauri command, run nothing
//
// Identity: tauri.bundle.json is the release one, riven.app with bundle id
// dev.riven.app, the id the Electron app shipped with (its data folder and keychain
// item are kept, so the move to Tauri reads them as they were). Run as that
// id the app uses Electron's data folder and keychain item
// (src-tauri/src/services/paths.rs, safe_storage.rs). A local package is
// therefore built WITHOUT it by default: tauri.local.json puts back
// riven-tauri.app / dev.riven.tauri, whose data stays in
// ~/Library/Application Support/riven-tauri. Only CI's release job passes
// --release.
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

const argv = process.argv.slice(2)
const dry = argv.includes('--dry-run')
const release = argv.includes('--release')
const ti = argv.indexOf('--target')
const target = ti >= 0 ? argv[ti + 1] : null
if (ti >= 0 && (!target || target.startsWith('--'))) throw new Error('--target needs a Rust target triple')

const args = ['-y', '@tauri-apps/cli@2', 'build', '--config', 'tauri.bundle.json']
if (!release) args.push('--config', 'tauri.local.json')
if (process.env.RIVEN_TAURI_BUNDLE_CONFIG) args.push('--config', path.resolve(process.env.RIVEN_TAURI_BUNDLE_CONFIG))
if (target) args.push('--target', target)
const bundle = `src-tauri/target/${target ? target + '/' : ''}release/bundle/macos/${release ? 'riven' : 'riven-tauri'}.app`

if (dry) {
  if (!argv.includes('--no-build')) console.log(`would run: node tauri/build.mjs`)
  console.log(`would run (in src-tauri): npx ${args.join(' ')}`)
  console.log(`bundle: ${bundle}`)
  process.exit(0)
}

if (!argv.includes('--no-build')) {
  execFileSync(process.execPath, [path.join(root, 'tauri/build.mjs')], { cwd: root, stdio: 'inherit' })
}
if (!fs.existsSync(path.join(root, 'out-tauri/renderer/__riven/preload.js'))) {
  throw new Error('out-tauri/renderer is not built (run without --no-build)')
}
// Left over from the Node-bundling packager.
fs.rmSync(path.join(root, 'src-tauri/target/stage'), { recursive: true, force: true })

execFileSync('npx', args, { cwd: path.join(root, 'src-tauri'), stdio: 'inherit' })
console.log(`bundle: ${bundle}`)
