// Measure where riven's CPU goes, per Chromium process type, with the frame and
// paint counts that explain it.
//
//   npm run dev -- -- --remote-debugging-port=9333   (or the packaged app with
//   the same flag), then:
//   node scripts/perf-cpu.mjs [seconds] [--label "idle, window blurred"]
//
// Why not Activity Monitor: it shows three processes called "riven Helper" and
// will not say which is the GPU process, which is the window's renderer and
// which is the pty worker. app.getAppMetrics() carries the type, so this can.
//
// Why frames as well as CPU: renderer and GPU CPU move together, because the
// renderer producing frames is what gives the GPU something to raster. A number
// on its own cannot tell "busy doing real work" from "repainting an idle window
// 60 times a second", which is the actual question here — so this counts the
// frames committed and the paint events during the same window.
//
// Everything is per ONE core, the same unit Activity Monitor uses.

const PORT = Number(process.env.RIVEN_CDP_PORT ?? 9333)
const args = process.argv.slice(2)
const SECONDS = Number(args.find((a) => /^\d+$/.test(a)) ?? 20)
const argOf = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const LABEL = argOf('--label') ?? ''
// --regime R-F|R-B|R-O declares which regime this run is SUPPOSED to be in.
// A reading taken in the wrong one is not a pass or a failure, it is INVALID —
// an occluded window reads ~0% however much is animating, so letting it count as
// a pass is how a regression gets shipped.
const WANT_REGIME = argOf('--regime')
// --expect "renderer<=3,frames<=1,gpu<=2,script<=5" — exits non-zero if exceeded.
const EXPECT = (argOf('--expect') ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map((clause) => {
    const m = /^(\w+)\s*<=\s*([\d.]+)$/.exec(clause)
    if (!m) throw new Error(`--expect clause must look like "renderer<=3", got "${clause}"`)
    return { key: m[1], max: Number(m[2]) }
  })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function findPage() {
  for (let i = 0; i < 60; i++) {
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
  throw new Error(`no page target on CDP port ${PORT} — start the app with --remote-debugging-port=${PORT}`)
}

class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url)
    this.seq = 0
    this.pending = new Map()
    this.events = []
    this.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(String(ev.data))
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)
        return
      }
      if (msg.method) this.events.push(msg)
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
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text)
    return r.result.value
  }
}

const page = await findPage()
const cdp = new Cdp(page.webSocketDebuggerUrl)
await cdp.open()
await cdp.send('Runtime.enable')

const metricsAvailable = await cdp.eval(`typeof window.api?.perf?.metrics === 'function'`)
if (!metricsAvailable) throw new Error('window.api.perf.metrics missing — this build predates the perf IPC')

// Frames are counted by TRACING, not by a requestAnimationFrame loop. A rAF loop
// keeps the renderer awake by definition — it would produce the very frames it
// claims to observe, and the first run of this script duly reported 100 frames a
// second in a window where nothing was happening. Tracing only listens.
await cdp.send('Tracing.start', {
  transferMode: 'ReportEvents',
  traceConfig: {
    includedCategories: ['devtools.timeline', 'disabled-by-default-devtools.timeline.frame']
  }
})

await cdp.send('Performance.enable')
const perfAt = async () => {
  const { metrics } = await cdp.send('Performance.getMetrics')
  return Object.fromEntries(metrics.map((m) => [m.name, m.value]))
}

const startPerf = await perfAt()
const t0 = Date.now()
const samples = []
while (Date.now() - t0 < SECONDS * 1000) {
  samples.push(await cdp.eval(`window.api.perf.metrics().then(JSON.stringify)`))
  await sleep(1000)
}
const endPerf = await perfAt()
const elapsed = (Date.now() - t0) / 1000

// Drain the trace and count what the renderer actually committed.
const traced = new Promise((resolve) => {
  const done = () => {
    const counts = {}
    for (const ev of cdp.events) {
      if (ev.method !== 'Tracing.dataCollected') continue
      for (const e of ev.params.value ?? []) counts[e.name] = (counts[e.name] ?? 0) + 1
    }
    resolve(counts)
  }
  const check = setInterval(() => {
    if (cdp.events.some((e) => e.method === 'Tracing.tracingComplete')) {
      clearInterval(check)
      done()
    }
  }, 100)
  setTimeout(() => {
    clearInterval(check)
    done()
  }, 15000)
})
await cdp.send('Tracing.end')
const trace = await traced
const frames = trace['DrawFrame'] ?? trace['Commit'] ?? 0
const paints = trace['Paint'] ?? 0

// Average each process over the run, then group: several renderers (main window,
// pop-outs) are all "renderer" for the purpose of this question.
const totals = new Map()
for (const raw of samples) {
  for (const p of JSON.parse(raw)) {
    const label =
      p.type === 'GPU'
        ? 'GPU process'
        : p.type === 'Browser'
          ? 'main'
          : p.type === 'Tab'
            ? 'renderer'
            : `${p.type}${p.serviceName ? ` (${p.serviceName})` : ''}`
    const cur = totals.get(label) ?? { cpu: 0, n: 0, pids: new Set() }
    cur.cpu += p.cpu
    cur.n++
    cur.pids.add(p.pid)
    totals.set(label, cur)
  }
}

const perSample = [...totals.entries()]
  .map(([label, v]) => ({ label, cpu: v.cpu / samples.length, pids: v.pids.size }))
  .sort((a, b) => b.cpu - a.cpu)

// Say which regime this was taken in. Chromium stops committing frames entirely
// for an OCCLUDED window, so a measurement taken with riven behind another
// window reads ~0% no matter what is animating — and concluding "it's fine" from
// that is wrong. The expensive case is visible-but-unfocused, where
// visibilityState is still 'visible' and animations run at full rate.
const where = await cdp.eval(`JSON.stringify({
  visibility: document.visibilityState,
  focused: document.hasFocus(),
  blurClass: document.body.classList.contains('win-blurred'),
  animations: document.getAnimations().length,
  chatPanels: document.querySelectorAll('.chat-panel').length,
  terminals: Object.keys(window.__rivenTerms || {}).length
})`)
const w = JSON.parse(where)
// Decide the regime from the window's own state, NOT from the frame rate. The
// first version inferred "occluded" from "no frames + animations running", which
// mislabels a genuinely still visible window and, worse, would call an occluded
// window "idle and still" whenever nothing happened to be animating.
const code = w.visibility !== 'visible' ? 'R-O' : w.focused ? 'R-F' : 'R-B'
const regime =
  code === 'R-O'
    ? 'R-O  OCCLUDED (or minimised) — Chromium is not painting at all; this is NOT the costly case'
    : code === 'R-F'
      ? 'R-F  visible + focused'
      : 'R-B  visible but UNFOCUSED — the case this plan is about'

console.log(`\n=== riven CPU over ${elapsed.toFixed(0)}s${LABEL ? ` — ${LABEL}` : ''} ===`)
console.log(`  state: ${regime}`)
console.log(
  `         visibility=${w.visibility} focused=${w.focused} win-blurred=${w.blurClass} ` +
    `· ${w.animations} animations, ${w.chatPanels} chat panes, ${w.terminals} terminals\n`
)
for (const r of perSample) {
  console.log(`  ${r.label.padEnd(26)} ${r.cpu.toFixed(1).padStart(6)}%  (${r.pids} process${r.pids > 1 ? 'es' : ''})`)
}
console.log(`  ${'TOTAL'.padEnd(26)} ${perSample.reduce((s, r) => s + r.cpu, 0).toFixed(1).padStart(6)}%`)

const d = (k) => (endPerf[k] ?? 0) - (startPerf[k] ?? 0)
console.log('\n  renderer activity in the same window:')
console.log(`    frames committed   ${(frames / elapsed).toFixed(1)}/s   ← ~0 means the window is genuinely still`)
console.log(`    paints             ${(paints / elapsed).toFixed(1)}/s`)
console.log(`    layout count       ${d('LayoutCount')}`)
console.log(`    recalc styles      ${d('RecalcStyleCount')}`)
console.log(`    script duration    ${d('ScriptDuration').toFixed(2)}s  (${((d('ScriptDuration') / elapsed) * 100).toFixed(1)}% of wall)`)
console.log(`    layout duration    ${d('LayoutDuration').toFixed(2)}s`)
console.log(`    recalc duration    ${d('RecalcStyleDuration').toFixed(2)}s`)

// A still window that still runs frames is the signature this plan is chasing.
if (frames / elapsed > 5) {
  console.log('\n  NOTE: frames are being produced continuously. If nothing is animating on')
  console.log('        purpose, that is the cost — not the GPU process, which only rasters')
  console.log('        what the renderer commits.')
}

const cpuOf = (label) => perSample.find((r) => r.label === label)?.cpu ?? 0
const measured = {
  renderer: cpuOf('renderer'),
  gpu: cpuOf('GPU process'),
  main: cpuOf('main'),
  frames: frames / elapsed,
  paints: paints / elapsed,
  script: (d('ScriptDuration') / elapsed) * 100
}

let exitCode = 0
if (WANT_REGIME && WANT_REGIME !== code) {
  console.log(`\n  INVALID: asked for ${WANT_REGIME}, measured in ${code}.`)
  console.log('           Numbers from the wrong regime mean nothing — fix the window state and')
  console.log('           run it again. This is not a pass and not a failure.')
  exitCode = 2
} else if (EXPECT.length) {
  console.log('\n  expectations:')
  for (const { key, max } of EXPECT) {
    const got = measured[key]
    if (got === undefined) {
      console.log(`    ${key.padEnd(10)} UNKNOWN key (use ${Object.keys(measured).join('/')})`)
      exitCode = Math.max(exitCode, 1)
      continue
    }
    const pass = got <= max
    console.log(`    ${key.padEnd(10)} ${got.toFixed(1).padStart(6)} <= ${String(max).padStart(5)}   ${pass ? 'ok' : 'EXCEEDED'}`)
    if (!pass) exitCode = Math.max(exitCode, 1)
  }
}
console.log()
cdp.ws.close()
process.exit(exitCode)
