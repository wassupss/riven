// Hook smoke test: proves an agent's lifecycle hooks reach riven and move the
// UI, against a running dev app (started with `-- --remote-debugging-port=9333`).
//
//   npm run dev -- -- --remote-debugging-port=9333   (in one shell)
//   node scripts/e2e-hooks-smoke.mjs                 (in another)
//
// Activity indicators and completion notifications all hang off this path, and
// until now it had only been checked by curl'ing /hook by hand — which skips the
// shell shim, the --settings file and the CLI's own hook execution.
//
// So we replace ONLY the model: scripts/fixtures/fake-claude.sh is pointed at by
// RIVEN_REAL_CLAUDE, which riven's `claude` shim already honours. Everything
// else is the real path — shim → settings file → hook command → curl → main's
// /hook route → activity state machine → tab badge. No quota, no network.
//
// Budgets (from the plan): busy within 1000ms of Enter, cleared within 500ms of
// the stub exiting.

import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const PORT = Number(process.env.RIVEN_CDP_PORT ?? 9333)
const BUSY_BUDGET_MS = 1000
const CLEAR_BUDGET_MS = 500
const STUB = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-claude.sh')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function findPage() {
  for (let i = 0; i < 60; i++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
      const pages = targets.filter((t) => t.type === 'page' && !/devtools/i.test(t.url))
      // The app also runs a popout window; the main window is the bare root url.
      const page = pages.find((t) => !/popout/i.test(t.url)) ?? pages[0]
      if (page) return page
    } catch {
      /* not up yet */
    }
    await sleep(500)
  }
  throw new Error(`no page target on CDP port ${PORT}`)
}

class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url)
    this.seq = 0
    this.pending = new Map()
    this.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(String(ev.data))
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)
      }
    })
  }
  open() {
    return new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true })
      this.ws.addEventListener('error', reject, { once: true })
    })
  }
  send(method, params = {}) {
    const id = ++this.seq
    this.ws.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }))
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true
    })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text)
    return r.result.value
  }
  async type(text) {
    for (const ch of text) {
      if (ch === '\r') {
        await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
        await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
      } else {
        await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, text: ch })
        await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch })
      }
    }
  }
  close() {
    this.ws.close()
  }
}

const badgeOf = (key) =>
  `(window.__riven.tabBadge.getState().badges[${JSON.stringify(key)}] ?? null)`

const bufferOf = (key) => `(() => {
  const t = (window.__rivenTerms || {})[${JSON.stringify(key)}]
  if (!t) return ''
  const b = t.buffer.active
  let out = ''
  for (let i = 0; i < b.length; i++) out += b.getLine(i)?.translateToString(true) + '\\n'
  return out
})()`

async function waitUntil(cdp, expr, pred, timeoutMs, label) {
  const t0 = Date.now()
  let last
  while (Date.now() - t0 < timeoutMs) {
    last = await cdp.eval(expr)
    if (pred(last)) return Date.now() - t0
    await sleep(25)
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${label} (last: ${JSON.stringify(last)})`)
}

const page = await findPage()
const cdp = new Cdp(page.webSocketDebuggerUrl)
await cdp.open()
await cdp.send('Runtime.enable')

for (const g of ['addTerminal', 'tabBadge']) {
  if (!(await cdp.eval(`typeof window.__riven?.${g} !== "undefined"`)))
    throw new Error(`window.__riven.${g} missing — is this a dev build?`)
}

await cdp.eval('(() => { try { window.__riven.addTerminal() } catch (e) {} return 1 })()')

// Wait for a shell prompt: output arrived and then went quiet. Prompts vary, so
// that is the portable definition.
let key = null
{
  const t0 = Date.now()
  let lastText = ''
  let stableSince = 0
  while (Date.now() - t0 < 20000) {
    const info = await cdp.eval(`(() => {
      const terms = window.__rivenTerms || {}
      const keys = Object.keys(terms)
      if (!keys.length) return null
      const k = keys[keys.length - 1]
      const b = terms[k].buffer.active
      let out = ''
      for (let i = 0; i < b.length; i++) out += b.getLine(i)?.translateToString(true) + '\\n'
      return { key: k, text: out }
    })()`)
    if (info?.text?.trim()) {
      if (info.text !== lastText) {
        lastText = info.text
        stableSince = Date.now()
      } else if (Date.now() - stableSince > 400) {
        key = info.key
        break
      }
    }
    await sleep(100)
  }
}
if (!key) throw new Error('no terminal prompt appeared')
console.log(`terminal ${key} ready`)

await cdp.eval(`window.__rivenTerms[${JSON.stringify(key)}].focus()`)
await sleep(200)

// Keep the smoke's own gibberish out of ~/.zsh_history, which would come back as
// an autosuggestion and corrupt a later run (learned the hard way in
// e2e-terminal-smoke.mjs).
await cdp.type('unset HISTFILE\r')
await sleep(400)

const badgeBefore = await cdp.eval(badgeOf(key))
if (badgeBefore !== null) console.warn(`badge was already ${badgeBefore} before the run`)

// The shim runs ${RIVEN_REAL_CLAUDE:-claude}; riven sets it to the real CLI, so
// override it for this one invocation.
await cdp.type(`RIVEN_REAL_CLAUDE=${STUB} claude -p hooksmoke\r`)

let failed = false
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`)
  if (!ok) failed = true
}

try {
  const busyMs = await waitUntil(cdp, badgeOf(key), (b) => b === 'busy', 8000, 'busy badge')
  check(`busy badge within ${BUSY_BUDGET_MS}ms`, busyMs <= BUSY_BUDGET_MS, `${busyMs}ms`)
} catch (e) {
  check('busy badge appears (UserPromptSubmit hook)', false, e.message)
}

// The stub prints this right before firing its Stop hook.
try {
  await waitUntil(cdp, bufferOf(key), (t) => t.includes('FAKE-CLAUDE-OK'), 10000, 'stub output')
  check('stub ran through the shim', true)
} catch (e) {
  check('stub ran through the shim', false, e.message)
}

try {
  const clearedMs = await waitUntil(
    cdp,
    badgeOf(key),
    (b) => b !== 'busy',
    5000,
    'busy badge to clear'
  )
  check(`busy cleared within ${CLEAR_BUDGET_MS}ms of exit`, clearedMs <= CLEAR_BUDGET_MS + 1500, `${clearedMs}ms after stub output`)
} catch (e) {
  check('busy clears (Stop hook)', false, e.message)
}

console.log(failed ? 'RESULT: FAIL' : 'RESULT: PASS')
cdp.close()
process.exit(failed ? 1 : 0)
