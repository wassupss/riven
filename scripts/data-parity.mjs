// Electron and Tauri share one data folder (src-tauri/src/services/paths.rs).
// This checks, file by file, that the Rust main reads what Electron's src/main
// writes and writes it back byte for byte:
//
//   1. Electron's own main-process code (bundled here with 'electron' stubbed,
//      app.getPath('userData') = a temp folder) writes settings, keybindings,
//      sessions, notes, DB connections, browser.json and the file store.
//   2. The folder is copied, and the Rust test services::parity (cargo test,
//      RIVEN_TAURI_DATA_DIR = the copy) loads every file and saves it again.
//   3. The copy must equal the original, and what Rust read must match.
//
// Only temp folders are used: never the real ~/Library/Application Support.
//   node scripts/data-parity.mjs
import * as esbuild from 'esbuild'
import { execFileSync } from 'child_process'
import { createHash } from 'crypto'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'riven-parity-'))
const electronDir = path.join(tmp, 'electron')
const tauriDir = path.join(tmp, 'tauri')
fs.mkdirSync(electronDir)

// ---- 1. Electron's main code, 'electron' stubbed ---------------------------------
const handlers = new Map()
globalThis.__parityElectron = {
  app: { getPath: (k) => (k === 'userData' ? electronDir : tmp), isPackaged: false, getName: () => 'riven' },
  ipcMain: { handle: (ch, fn) => handlers.set(ch, fn), on: (ch, fn) => handlers.set(ch, fn) },
  shell: { showItemInFolder() {} },
  safeStorage: { isEncryptionAvailable: () => false, getSelectedStorageBackend: () => 'keychain' }
}
const entry = `
  export { registerConfigHandlers } from './src/main/config'
  export { registerSessionsHandlers } from './src/main/sessions'
  export { registerNotesHandlers } from './src/main/notes'
  export * as db from './src/main/db/store'
  ${fs.existsSync(path.join(root, 'src/main/store.ts')) ? "export { registerStoreHandlers } from './src/main/store'" : ''}
`
const r = await esbuild.build({
  stdin: { contents: entry, resolveDir: root, loader: 'ts' },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
  logLevel: 'warning',
  plugins: [
    {
      name: 'electron-stub',
      setup(b) {
        b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'stub' }))
        b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'module.exports = globalThis.__parityElectron', loader: 'js' }))
      }
    }
  ]
})
const mod = { exports: {} }
new Function('module', 'exports', 'require', r.outputFiles[0].text)(mod, mod.exports, createRequire(import.meta.url))
const m = mod.exports
m.registerConfigHandlers()
m.registerSessionsHandlers()
m.registerNotesHandlers()
m.registerStoreHandlers?.()
const call = (ch, ...a) => handlers.get(ch)({ sender: {} }, ...a)

const ws = '/Users/someone/프로젝트/riven demo'
const tricky = {
  text: 'quote " backslash \\ tab \t newline \n U+2028 \u2028 emoji 🙂 한글 nul-ish \u0001',
  nums: [0, 1, -1, 1.5, 0.1, 0.30000000000000004, 1 / 3, 1763600000000, 123456789012345, 1e-7, 2.5e-5],
  empty: { a: [], o: {}, n: null, t: true, f: false }
}
await call('config:save', 'settings.json', { theme: 'dark', language: 'ko', uiScale: 1.1, fontSize: 13, tricky })
await call('config:save', 'keybindings.json', { 'workbench.action.quickOpen': 'mod+p', 'chat.new': 'mod+shift+a' })
const sessions = {
  [ws]: {
    openTabs: [`${ws}/README.md`, `${ws}/src/한글.ts`],
    activePath: `${ws}/README.md`,
    previewUrl: '',
    dockLayout: { grid: { root: { type: 'branch', data: [], size: 1000 }, width: 1600, height: 1000, orientation: 'HORIZONTAL' }, panels: { 'chat-1': { id: 'chat-1' } }, activeGroup: '1' },
    panes: { 'chat-1': { model: 'opus', session: 'abc', log: [{ role: 'user', text: tricky.text }], fresh: true } },
    groups: [{ group: 'team', members: [{ name: 'lead', persona: null, model: 'default', parent: null, chatKey: 'chat-1' }] }],
    runs: [],
    jobs: [],
    goals: []
  },
  '/tmp/empty': { openTabs: [], activePath: null, previewUrl: '', dockLayout: null, panes: {} }
}
await call('sessions:save', sessions)
await call('notes:write', ws, null, 'Plan 계획', '# Plan 계획\n\n- one\n- two\n')
await call('notes:write', ws, null, 'Second', 'no heading line\nsecond line')
m.db.saveConnection({ name: 'local pg', engine: 'postgres', host: 'localhost', port: 5432, user: 'me', database: 'app', ssl: false })
m.db.saveConnection({ name: 'sqlite 파일', engine: 'sqlite', file: '~/data/app.db' })
// The renderer's data files (src/main/store.ts), as lib/fileStore saves them.
if (m.registerStoreHandlers) {
  await call('store:save', 'pipelines', { [ws]: [{ id: 'pl_1', name: '리뷰', stages: [{ name: 's', model: 'opus', role: 'r', agent: '' }] }] })
  await call('store:save', 'db-console-history', [{ id: 't1', sql: "select '한글', 1.5", connId: 'c', at: 1763600000000, ms: 3, rows: 1 }])
  await call('store:save', 'db-erd-positions', { 'c1//public': { users: { x: 10, y: -20 } } })
  await call('store:save', 'auth', { 'sb-abc-auth-token': JSON.stringify({ access_token: 'x', expires_at: 1 }) })
  await call('store:save', 'removed-by-tauri', [1])
}
// browser.ts writes JSON.stringify(store) (compact), 300ms after a change.
fs.writeFileSync(
  path.join(electronDir, 'browser.json'),
  JSON.stringify({ bookmarks: [{ url: 'https://example.com/', title: 'Example 예제' }], history: [{ url: 'https://example.com/', title: 'Example 예제', ts: 1763600000123 }] })
)

// ---- 2. Rust, on a copy ----------------------------------------------------------------
fs.cpSync(electronDir, tauriDir, { recursive: true })
const fixture = {
  workspace: ws,
  captureFolders: [ws, '/a//b', '---', '', 'C:\\Users\\x y', '한글 폴더'],
  profileIds: ['work', 'a b/c', 'x_y-z', '한글', '..']
}
const outFile = path.join(tmp, 'rust-out.json')
execFileSync('cargo', ['test', '--quiet', 'services::parity::tests::electron_files_round_trip', '--', '--exact', '--nocapture'], {
  cwd: path.join(root, 'src-tauri'),
  stdio: ['ignore', 'inherit', 'inherit'],
  env: { ...process.env, RIVEN_TAURI_DATA_DIR: tauriDir, RIVEN_PARITY_OUT: outFile, RIVEN_PARITY_FIXTURE: JSON.stringify(fixture) }
})
const rust = JSON.parse(fs.readFileSync(outFile, 'utf8'))

// ---- 3. compare ------------------------------------------------------------------------
let failed = 0
const check = (what, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? `  ${detail}` : ''}`)
  if (!ok) failed++
}
const same = (rel) => {
  const a = fs.readFileSync(path.join(electronDir, rel))
  const b = fs.readFileSync(path.join(tauriDir, rel))
  check(`${rel} written back byte for byte`, a.equals(b), a.equals(b) ? `${a.length} bytes` : `electron ${a.length} / rust ${b.length}`)
}
check('Rust used the temp folder', rust.userData === tauriDir)
same('settings.json')
same('keybindings.json')
same('sessions.json')
check('sessions: both workspaces read', rust.sessionsWorkspaces === 2)
same('db/connections.json')
check(
  'db: connections listed the same',
  JSON.stringify(rust.connections) === JSON.stringify(m.db.listConnections()),
  `${rust.connections.length} entries`
)
const elNotes = await call('notes:list', ws)
check(
  'notes: same folder (sha1 of workspace), names and titles',
  JSON.stringify(rust.notes.filter((n) => n.name !== rust.tauriNote).map((n) => [n.name, n.title]).sort()) ===
    JSON.stringify(elNotes.map((n) => [n.name, n.title]).sort())
)
for (const n of elNotes) check(`notes: body of ${n.name}`, rust.noteBodies[n.name] === (await call('notes:read', ws, n.name)))
// What Rust wrote, Electron reads.
fs.cpSync(path.join(tauriDir, 'notes'), path.join(electronDir, 'notes'), { recursive: true })
const after = await call('notes:list', ws)
check('notes: Electron lists the note Rust wrote', after.some((n) => n.name === rust.tauriNote && n.title === 'Tauri note 한글'))
check('browser.json: Rust writes back what browser.ts wrote', rust.browserText === fs.readFileSync(path.join(electronDir, 'browser.json'), 'utf8'))
const capture = (f) => f.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'workspace'
check('captures/<folder> names', JSON.stringify(rust.captureDirs) === JSON.stringify(fixture.captureFolders.map(capture)), JSON.stringify(rust.captureDirs))
const profile = (id) => path.join(tauriDir, 'claude-profiles', id.replace(/[^\w-]/g, ''))
// An id with nothing left after cleaning ends in '/' in Rust: the same folder.
const norm = (p) => p.replace(/\/+$/, '')
check('claude-profiles/<id> paths', JSON.stringify(rust.profileDirs.map(norm)) === JSON.stringify(fixture.profileIds.map(profile)))
const key = createHash('sha1').update(ws).digest('hex').slice(0, 16)
check('notes folder key', fs.existsSync(path.join(tauriDir, 'notes', key)))

if (m.registerStoreHandlers) {
  for (const f of fs.readdirSync(path.join(electronDir, 'store'))) {
    if (f !== 'removed-by-tauri.json') same(`store/${f}`)
  }
  check('store: Rust read every file', JSON.stringify(rust.store) === JSON.stringify(await call('store:loadAll')))
  check('store: Rust removes a file on null', !fs.existsSync(path.join(tauriDir, 'store/removed-by-tauri.json')))
  fs.cpSync(path.join(tauriDir, 'store/from-tauri.json'), path.join(electronDir, 'store/from-tauri.json'))
  const el = await call('store:loadAll')
  check('store: Electron reads the file Rust wrote', JSON.stringify(el['from-tauri']) === JSON.stringify({ by: 'rust', n: [1, 2.5] }))
}

if (globalThis.__parityExtra) failed += await globalThis.__parityExtra({ call, m, electronDir, tauriDir, rust, check })
fs.rmSync(tmp, { recursive: true, force: true })
console.log(failed ? `${failed} failed` : 'all same')
process.exit(failed ? 1 : 0)
