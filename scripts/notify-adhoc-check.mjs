// Does macOS actually DISPLAY riven's notifications?
//
// It cannot be answered on a dev build: an unsigned app is refused at the OS
// layer with UNErrorDomain 1, asynchronously, long after Notification.show()
// returns. Measured on `npm run dev`: 3 requested, 0 shown, 3 failed.
//
// It turns out an AD-HOC signature is enough — no Developer ID, no notarization,
// no CI round trip. So this is runnable locally before a release:
//
//   npm run pack          # electron-builder --dir (a few minutes)
//   npm run check:notify  # this script
//
// It ad-hoc signs the packed app under its real bundle id, launches it against a
// throwaway user-data dir (so your real workspaces/sessions are untouched),
// fires ten notifications with distinct pane ids to dodge the 5s per-pane
// cooldown, and reads main's counters back over notify:diag.
//
// Budget, from the plan's signed-build checklist: 10 requested, 10 shown, 0 failed.

import { execFileSync, spawn } from 'child_process'
import { existsSync, rmSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const APP = join(repo, 'release', 'mac-arm64', 'riven.app')
const BIN = join(APP, 'Contents', 'MacOS', 'riven')
const PROFILE = '/tmp/riven-notify-check-profile'
const PORT = Number(process.env.RIVEN_CDP_PORT ?? 9335)
const COUNT = 10

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

if (process.platform !== 'darwin') {
  console.log('SKIP: macOS only')
  process.exit(0)
}
if (!existsSync(BIN)) {
  console.error(`no packed app at ${APP} — run \`npm run pack\` first`)
  process.exit(2)
}

// electron-builder leaves the Electron linker signature in place when it finds
// no identity, which carries Identifier=Electron. Re-sign so the bundle id is
// riven's own — notification delivery is keyed on it.
console.log('ad-hoc signing…')
execFileSync('codesign', ['--force', '--deep', '--sign', '-', '--identifier', 'dev.riven.app', APP], {
  stdio: 'inherit'
})

rmSync(PROFILE, { recursive: true, force: true })
const child = spawn(BIN, [`--user-data-dir=${PROFILE}`, `--remote-debugging-port=${PORT}`], {
  env: { ...process.env, RIVEN_NOTIFY_DEBUG: '1' },
  stdio: ['ignore', 'pipe', 'pipe']
})
const appLog = []
child.stdout.on('data', (d) => appLog.push(String(d)))
child.stderr.on('data', (d) => appLog.push(String(d)))

const cleanup = () => {
  try {
    child.kill()
  } catch {
    /* already gone */
  }
  rmSync(PROFILE, { recursive: true, force: true })
}
process.on('exit', cleanup)

async function findPage() {
  for (let i = 0; i < 90; i++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
      const pages = targets.filter((t) => t.type === 'page' && !/devtools/i.test(t.url))
      const p = pages.find((t) => !/popout/i.test(t.url)) ?? pages[0]
      if (p) return p
    } catch {
      /* not up yet */
    }
    await sleep(500)
  }
  throw new Error('the packed app never exposed a debuggable page')
}

const page = await findPage()
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => ws.addEventListener('open', r, { once: true }))
let id = 0
const pending = new Map()
ws.addEventListener('message', (e) => {
  const m = JSON.parse(String(e.data))
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m.result)
    pending.delete(m.id)
  }
})
const ev = async (expression) => {
  const i = ++id
  ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }))
  const r = await new Promise((res) => pending.set(i, res))
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text)
  return r.result.value
}

for (let i = 0; i < 60; i++) {
  if (await ev(`typeof window.api?.notify?.diag === 'function'`)) break
  await sleep(500)
}

const before = JSON.parse(await ev(`window.api.notify.diag().then(JSON.stringify)`))
for (let i = 0; i < COUNT; i++) {
  await ev(`(() => { window.api.notify.show('riven notify check', 'n=${i}', { paneId: 'term-chk-${i}' }); return 1 })()`)
  await sleep(250)
}
await sleep(2000)
const after = JSON.parse(await ev(`window.api.notify.diag().then(JSON.stringify)`))
const d = (k) => after[k] - before[k]

console.log(
  `requested +${d('requested')}  shown +${d('shown')}  failed +${d('failed')}  ` +
    `cooled +${d('cooled')}  suppressed +${d('suppressed')}`
)
const ok = d('requested') === COUNT && d('shown') === COUNT && d('failed') === 0
if (!ok) {
  console.log('--- app log ---')
  console.log(appLog.join('').split('\n').filter((l) => l.includes('[notify]')).slice(-12).join('\n'))
}
console.log(ok ? `RESULT: PASS (${COUNT}/${COUNT} displayed, 0 failed)` : 'RESULT: FAIL')
ws.close()
process.exit(ok ? 0 : 1)
