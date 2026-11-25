#!/usr/bin/env node
// Release assets for a signed, notarized Tauri riven.app (CI's
// .github/workflows/release-tauri.yml; docs/tauri-rust-main.md, 9-7).
//
// The Tauri updater (tauri-plugin-updater, src-tauri/src/services/update.rs)
// reads them. Electron is gone, so there is no Electron feed any more:
//     riven-<version>-universal.app.tar.gz (+ .sig)   tauri build's updater bundle, renamed
//     latest.json   {version, notes, pub_date, platforms: {darwin-aarch64, darwin-x86_64, ...: {url, signature}}}
//     One universal tarball serves both arches. The plugin looks up
//     "{os}-{arch}-{bundle type}" then "{os}-{arch}", so both spellings are listed.
//
//   node scripts/tauri-release-assets.mjs --app <riven.app> --updater <riven.app.tar.gz>
//     --sig <riven.app.tar.gz.sig> --version 0.4.0 --tag tauri-v0.4.0 --repo owner/name --out <dir>
//     [--notes "text"] [--date 2026-11-20T00:00:00.000Z]
//
// Needs macOS (ditto). Never signs anything: the .sig comes from tauri build.
import { execFileSync } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'

function opts(argv) {
  const o = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) throw new Error(`unexpected argument: ${a}`)
    const v = argv[i + 1]
    if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`)
    o[a.slice(2)] = v
    i++
  }
  for (const k of ['app', 'updater', 'sig', 'version', 'tag', 'repo', 'out']) {
    if (!o[k]) throw new Error(`missing --${k}`)
  }
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(o.version)) throw new Error(`not a semver version: ${o.version}`)
  if (!/^[\w.-]+\/[\w.-]+$/.test(o.repo)) throw new Error(`not owner/name: ${o.repo}`)
  return o
}


export function latestJson({ version, notes, date, url, signature }) {
  const entry = { signature, url }
  const platforms = {}
  for (const arch of ['aarch64', 'x86_64']) {
    platforms[`darwin-${arch}`] = entry
    platforms[`darwin-${arch}-app`] = entry
  }
  return JSON.stringify({ version, notes, pub_date: date, platforms }, null, 2) + '\n'
}

function main() {
  const o = opts(process.argv.slice(2))
  const date = o.date || new Date().toISOString()
  if (Number.isNaN(Date.parse(date))) throw new Error(`bad --date: ${date}`)
  const app = path.resolve(o.app)
  if (!fs.existsSync(path.join(app, 'Contents/Info.plist'))) throw new Error(`not an .app bundle: ${app}`)
  const signature = fs.readFileSync(o.sig, 'utf8').trim()
  if (!signature) throw new Error(`empty signature: ${o.sig}`)
  // The updater tarball must hold the bundle at its top level.
  const first = execFileSync('tar', ['-tzf', o.updater], { encoding: 'utf8', maxBuffer: 1 << 30 }).split('\n')[0]
  if (!first.startsWith(path.basename(app) + '/')) throw new Error(`${o.updater} does not start with ${path.basename(app)}/ (got ${first})`)

  fs.mkdirSync(o.out, { recursive: true })
  const tarName = `riven-${o.version}-universal.app.tar.gz`
  fs.copyFileSync(o.updater, path.join(o.out, tarName))
  fs.writeFileSync(path.join(o.out, tarName + '.sig'), signature + '\n')
  const url = `https://github.com/${o.repo}/releases/download/${encodeURIComponent(o.tag)}/${tarName}`
  const notes = o.notes ?? `riven ${o.version}`
  fs.writeFileSync(path.join(o.out, 'latest.json'), latestJson({ version: o.version, notes, date, url, signature }))

  for (const f of fs.readdirSync(o.out).sort()) console.log(`${f}\t${fs.statSync(path.join(o.out, f)).size}`)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main()
  } catch (e) {
    console.error(String(e.message || e))
    process.exit(1)
  }
}
