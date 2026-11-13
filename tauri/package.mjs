// Builds a bundled riven-tauri.app. Stages what it needs at run time:
//   src-tauri/target/stage/app/   out-tauri + package.json + production node_modules
//   src-tauri/target/stage/node   the Node binary that runs the main process
// main.rs prefers <Resources>/app and <Resources>/node when they exist.
//
//   node tauri/package.mjs            build out-tauri, then stage
//   node tauri/package.mjs --no-build stage the existing out-tauri
//   node tauri/package.mjs --stage-only  stage, skip `tauri build`
import { execFileSync } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const stage = path.join(root, 'src-tauri/target/stage')
const app = path.join(stage, 'app')

if (!process.argv.includes('--no-build')) {
  execFileSync(process.execPath, [path.join(root, 'tauri/build.mjs')], { cwd: root, stdio: 'inherit' })
}

fs.rmSync(stage, { recursive: true, force: true })
fs.mkdirSync(app, { recursive: true })
fs.cpSync(path.join(root, 'out-tauri'), path.join(app, 'out-tauri'), { recursive: true })
for (const f of ['package.json', 'package-lock.json']) fs.copyFileSync(path.join(root, f), path.join(app, f))

// Production dependencies only, with npm 10 like CI (newer npm rejects this
// lockfile). Scripts are skipped: the root postinstall is electron-builder's.
execFileSync('npx', ['-y', 'npm@10', 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], {
  cwd: app,
  stdio: 'inherit'
})
fs.rmSync(path.join(app, 'package-lock.json'))
// Terminals run in Rust now (src-tauri/src/services/pty); nothing in the Node
// bundle loads node-pty any more.
fs.rmSync(path.join(app, 'node_modules/node-pty'), { recursive: true, force: true })

// The Node that runs this script runs the app: same ABI the dev build was tested on.
fs.copyFileSync(process.execPath, path.join(stage, 'node'))
fs.chmodSync(path.join(stage, 'node'), 0o755)
console.log(`staged ${path.relative(root, stage)} (node ${process.version})`)

// Bundle: the overlay config adds the staged resources (kept out of the dev
// build, which would otherwise copy them into target/debug and run them).
if (!process.argv.includes('--stage-only')) {
  execFileSync('npx', ['-y', '@tauri-apps/cli@2', 'build', '--config', 'tauri.bundle.json'], {
    cwd: path.join(root, 'src-tauri'),
    stdio: 'inherit'
  })
}
