// Terminal smoke test against a running dev app (electron-vite dev started with
// `-- --remote-debugging-port=9333`). Drives the real renderer over CDP: opens a
// terminal, types a command, and asserts the echo lands in the xterm buffer —
// the whole path pty → main model → IPC → renderer scheduler → xterm. Also
// measures keystroke echo latency, the number the user actually feels.
//
//   npm run dev -- -- --remote-debugging-port=9333   (in one shell)
//   node scripts/e2e-terminal-smoke.mjs               (in another)
//
// No dependencies: Node 22's global WebSocket + fetch.

const PORT = Number(process.env.RIVEN_CDP_PORT ?? 9333)
const KEY_SAMPLES = 16
const MAX_MEDIAN_ECHO_MS = 75 // orca's regression ceiling for median key latency
const MAX_WORST_ECHO_MS = 300

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

async function findPage() {
  for (let i = 0; i < 60; i++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
      const page = targets.find((t) => t.type === 'page' && !/devtools/i.test(t.url))
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
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + JSON.stringify(r.exceptionDetails.exception))
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

// Buffer text of the newest dev-registered terminal.
const BUFFER_TEXT = `(() => {
  const terms = window.__rivenTerms || {}
  const keys = Object.keys(terms)
  if (!keys.length) return null
  const t = terms[keys[keys.length - 1]]
  const b = t.buffer.active
  const out = []
  for (let y = 0; y < b.length; y++) out.push(b.getLine(y)?.translateToString(true) ?? '')
  // Text left of the cursor on the cursor line: what the user typed, without
  // whatever the shell paints AFTER the cursor (zsh-autosuggestions' grey
  // history completion), which otherwise defeats an ends-with check.
  const cur = (b.getLine(b.cursorY + b.viewportY)?.translateToString(true) ?? '').slice(0, b.cursorX)
  return { key: keys[keys.length - 1], text: out.join('\\n'), cur, cols: t.cols, rows: t.rows }
})()`

async function waitFor(cdp, predicate, timeoutMs, label) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const v = await cdp.eval(BUFFER_TEXT)
    if (v && predicate(v.text, v)) return v
    // 5ms, not 50: at 50 a 15ms echo reads as 55 and the measurement is the
    // poll interval, not the pipeline.
    await sleep(5)
  }
  throw new Error(`timeout waiting for ${label}`)
}

async function main() {
  const page = await findPage()
  const cdp = new Cdp(page.webSocketDebuggerUrl)
  await cdp.open()
  await cdp.send('Runtime.enable')

  const hasHook = await cdp.eval('typeof window.__riven?.addTerminal === "function"')
  if (!hasHook) throw new Error('window.__riven.addTerminal missing — is this a dev build?')
  const before = await cdp.eval('Object.keys(window.__rivenTerms || {})')
  const added = await cdp.eval(
    '(() => { try { window.__riven.addTerminal(); return "ok" } catch (e) { return "ERR " + e.message } })()'
  )
  if (added !== 'ok') {
    console.warn(`addTerminal: ${added}; reusing an existing terminal`)
    if (!before.length) throw new Error('no terminal to test against')
  }

  // The shell prompt is the first thing that proves the pipeline end to end.
  // Prompts vary (p10k, oh-my-zsh, plain $), so "something arrived and then
  // went quiet" is the portable definition of "prompt is up".
  let stableSince = 0
  let lastText = ''
  const prompt = await waitFor(
    cdp,
    (t) => {
      if (!t.trim()) return false
      if (t !== lastText) {
        lastText = t
        stableSince = Date.now()
        return false
      }
      return Date.now() - stableSince > 400
    },
    20000,
    'shell prompt'
  )
  console.log(`terminal ${prompt.key} ready (${prompt.cols}x${prompt.rows})`)
  await cdp.eval(`window.__rivenTerms[${JSON.stringify(prompt.key)}].focus()`)
  await sleep(200)

  // Echo latency: one printable key at a time, measure until it appears.
  const latencies = []
  const marker = 'rvsmoke' + Date.now().toString(36)
  // The predicate is "the last non-empty line ends with everything typed so
  // far", not a length comparison: a prompt that redraws itself (p10k, transient
  // prompts) changes the buffer's length without changing what we typed.
  // This shell must not write the gibberish below into the user's real
  // ~/.zsh_history — earlier runs did, and their leftovers came back as
  // autosuggestions that broke the very check that typed them.
  await cdp.type('unset HISTFILE\r')
  await sleep(300)
  let typed = ''
  for (let i = 0; i < KEY_SAMPLES; i++) {
    const ch = String.fromCharCode(97 + (i % 26))
    typed += ch
    const t0 = performance.now()
    await cdp.type(ch)
    await waitFor(cdp, (_t, v) => v.cur.endsWith(typed), 3000, `echo of ${ch}`)
    latencies.push(performance.now() - t0)
  }
  // Kill the leftover letters with Ctrl+U rather than submitting them: with
  // oh-my-zsh's correction on, a submitted gibberish command parks the shell at
  // a `[nyae]?` prompt and swallows whatever is typed next.
  await cdp.send('Input.insertText', { text: '\u0015' })
  await sleep(100)
  await cdp.type(`echo ${marker}_$((6*7))\r`)
  await waitFor(cdp, (t) => t.includes(`${marker}_42`), 5000, 'command output')

  // A burst: 3000 lines must land without dropping the tail. The end marker is
  // split in the typed command (`EN""D`) so the shell's echo of the command line
  // cannot satisfy the wait — only the real output can. Matching the typed line
  // is how an earlier version of this test passed by accident, and `marker` is
  // unique per run so a reused terminal's old output cannot either.
  await cdp.type(`for i in $(seq 1 3000); do echo ${marker}_line_$i; done; echo ${marker}_EN""D\r`)
  const burst = await waitFor(cdp, (t) => t.includes(`${marker}_END`), 20000, 'burst end')
  const sawTail = burst.text.includes(`${marker}_line_3000`)

  latencies.sort((a, b) => a - b)
  const median = latencies[Math.floor(latencies.length / 2)]
  const worst = latencies[latencies.length - 1]
  console.log(`echo latency: median ${median.toFixed(1)}ms  p90 ${latencies[Math.floor(latencies.length * 0.9)].toFixed(1)}ms  worst ${worst.toFixed(1)}ms`)
  console.log(`burst: 3000 lines, tail ${sawTail ? 'present' : 'MISSING'}`)

  cdp.close()
  const failures = []
  if (median > MAX_MEDIAN_ECHO_MS) failures.push(`median echo ${median.toFixed(1)}ms > ${MAX_MEDIAN_ECHO_MS}ms`)
  if (worst > MAX_WORST_ECHO_MS) failures.push(`worst echo ${worst.toFixed(1)}ms > ${MAX_WORST_ECHO_MS}ms`)
  if (!sawTail) failures.push('burst tail missing')
  if (failures.length) {
    console.error('FAIL: ' + failures.join('; '))
    process.exit(1)
  }
  console.log('PASS')
}

main().catch((e) => {
  console.error('FAIL:', e.message)
  process.exit(1)
})
