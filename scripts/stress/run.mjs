// Load-test driver. Launches a DEDICATED electron instance (separate user-data,
// remote debugging on) pointed at the running vite dev server with ?stress=1, so
// the renderer's stress harness (src/renderer/src/dev/stress.ts) drives the dock.
// We read per-phase metrics over CDP and sample the process tree's RSS, then force
// GC for a post-churn leak baseline. The user's real app is never touched.
//
// Usage: node scripts/stress/run.mjs   (vite dev must already be running on 5173)
import { spawn, execSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { setTimeout as sleep } from 'node:timers/promises'

const require = createRequire(import.meta.url)
const REPO = new URL('../../', import.meta.url).pathname
const PORT = 9333
const VITE = 'http://localhost:5173'
const PROFILE = '/tmp/riven-stress-profile'
const params = new URLSearchParams({ stress: '1', chats: '10', terms: '6', churn: '40', flood: '8000' })
const RENDERER_URL = `${VITE}/?${params}`

const electronBin = require('electron') // resolves to the electron binary path

function preflight() {
  try {
    execSync(`curl -s -o /dev/null -w '%{http_code}' ${VITE}`, { timeout: 3000 })
  } catch {
    console.error('vite dev server not reachable on 5173 — run `npm run dev` first.')
    process.exit(1)
  }
  execSync(`rm -rf ${PROFILE}`)
}

// ---- minimal CDP client over raw WebSocket ------------------------------
async function connectCDP() {
  let target
  for (let i = 0; i < 40; i++) {
    try {
      const list = await fetch(`http://127.0.0.1:${PORT}/json`).then((r) => r.json())
      target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (target) break
    } catch {
      /* not up yet */
    }
    await sleep(500)
  }
  if (!target) throw new Error('no CDP page target appeared')
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.onopen = res
    ws.onerror = rej
  })
  let id = 0
  const pending = new Map()
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)
      return
    }
    // Surface renderer console + uncaught exceptions to help diagnose boot stalls.
    if (msg.method === 'Runtime.consoleAPICalled') {
      const a = (msg.params.args || []).map((x) => x.value ?? x.description ?? '').join(' ')
      if (msg.params.type === 'error' || /STRESS|error|Error/.test(a)) console.log('  [console]', msg.params.type, a.slice(0, 300))
    } else if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails
      console.log('  [exception]', (d.exception?.description || d.text || '').slice(0, 400))
    }
  }
  const send = (method, p = {}) =>
    new Promise((resolve, reject) => {
      const mid = ++id
      pending.set(mid, { resolve, reject })
      ws.send(JSON.stringify({ id: mid, method, params: p }))
    })
  await send('Runtime.enable')
  await send('HeapProfiler.enable')
  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
    return r?.result?.value
  }
  return { send, evalJs, ws }
}

// ---- process memory (MB) -------------------------------------------------
// Report the LARGEST single process's RSS (summing a Chromium tree's RSS double-
// counts shared framework/GPU pages and vastly overstates real use). Also collect
// the pids so we can take a true phys_footprint reading at the end.
function treeStats(rootPid) {
  try {
    const out = execSync('ps -axo pid=,ppid=,rss=', { encoding: 'utf8' })
    const kids = new Map()
    const rss = new Map()
    for (const line of out.trim().split('\n')) {
      const [pid, ppid, r] = line.trim().split(/\s+/).map(Number)
      rss.set(pid, r)
      if (!kids.has(ppid)) kids.set(ppid, [])
      kids.get(ppid).push(pid)
    }
    let max = 0
    const pids = []
    const stack = [rootPid]
    while (stack.length) {
      const p = stack.pop()
      pids.push(p)
      max = Math.max(max, rss.get(p) ?? 0)
      for (const c of kids.get(p) ?? []) stack.push(c)
    }
    return { maxMB: +(max / 1024).toFixed(1), pids }
  } catch {
    return { maxMB: -1, pids: [] }
  }
}
// True, non-double-counted memory for a set of pids (macOS phys_footprint).
function footprintMB(pids) {
  let total = 0
  for (const p of pids) {
    try {
      const out = execSync(`footprint -p ${p} 2>/dev/null | grep -i 'phys_footprint'`, { encoding: 'utf8' })
      const m = out.match(/([\d.]+)\s*([MG])B/i)
      if (m) total += parseFloat(m[1]) * (m[2].toUpperCase() === 'G' ? 1024 : 1)
    } catch {
      /* process may have exited */
    }
  }
  return +total.toFixed(1)
}

async function main() {
  preflight()
  console.log('launching dedicated stress instance...')
  const child = spawn(
    electronBin,
    ['.', `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`],
    { cwd: REPO, env: { ...process.env, ELECTRON_RENDERER_URL: RENDERER_URL, NODE_ENV: 'development' }, stdio: 'ignore' }
  )
  const rootPid = child.pid
  const cleanup = () => {
    try {
      process.kill(-rootPid, 'SIGKILL')
    } catch {
      /* */
    }
    try {
      child.kill('SIGKILL')
    } catch {
      /* */
    }
  }
  process.on('exit', cleanup)

  const cdp = await connectCDP()
  console.log('CDP connected. running load test...\n')

  let gcDone = false
  let peakRss = 0
  let lastPids = []
  const t0 = Date.now()
  for (;;) {
    if (Date.now() - t0 > 120000) {
      console.log('timeout — aborting.')
      break
    }
    await sleep(2000)
    const st = treeStats(rootPid)
    const rss = st.maxMB
    lastPids = st.pids
    if (rss > peakRss) peakRss = rss
    const status = await cdp.evalJs('JSON.stringify(window.__STRESS||{})').catch(() => '{}')
    const s = JSON.parse(status || '{}')
    console.log(
      `[${((Date.now() - t0) / 1000).toFixed(0)}s] phase=${s.phase ?? '?'} ` +
        `maxProcRSS=${rss}MB heap=${s.heapEndMB ?? s.heapMB ?? s.heapNowMB ?? '?'}MB ` +
        `fps=${s.fps ?? '-'} lt=${s.longtasks ?? '-'} panels=${s.panels ?? '-'}` +
        (s.error ? ` ERROR=${s.error}` : '')
    )
    if ((s.phase ?? 'boot') === 'boot') {
      const diag = await cdp.evalJs('JSON.stringify(window.__DIAG||{})').catch(() => '{}')
      console.log('  diag:', diag)
    }

    const churnDone = await cdp.evalJs('!!window.__STRESS_CHURN_DONE').catch(() => false)
    if (churnDone && !gcDone) {
      gcDone = true
      await cdp.send('HeapProfiler.collectGarbage')
      await sleep(1500)
      const postGc = await cdp.evalJs('(performance.memory?.usedJSHeapSize/1048576)||0')
      console.log(`\n>>> post-churn GC: heap=${postGc.toFixed(1)}MB maxProcRSS=${treeStats(rootPid).maxMB}MB\n`)
    }

    const done = await cdp.evalJs('!!window.__STRESS_DONE').catch(() => false)
    if (done) break
  }

  await cdp.send('HeapProfiler.collectGarbage').catch(() => {})
  await sleep(1000)
  const finalHeap = await cdp.evalJs('(performance.memory?.usedJSHeapSize/1048576)||0').catch(() => 0)
  const reportJson = await cdp.evalJs('JSON.stringify(window.__STRESS_REPORT||[])').catch(() => '[]')
  const report = JSON.parse(reportJson)

  console.log('\n================ PER-PHASE ================')
  for (const r of report) {
    if (r.phase === 'final') continue
    console.log(
      `${r.phase.padEnd(18)} fps=${String(r.fps).padStart(5)} jank>50ms=${String(r.jank50).padStart(3)} ` +
        `jank>100ms=${String(r.jank100).padStart(3)} lt=${String(r.longtasks).padStart(3)} ` +
        `heap ${r.heapStartMB}->${r.heapEndMB}MB panels=${r.panels}`
    )
  }
  const fin = report.find((r) => r.phase === 'final')
  console.log('\n================ SUMMARY ================')
  if (fin) {
    console.log(`worst frame:      ${fin.worstFrameMs} ms`)
    console.log(`longtasks:        ${fin.longtasksTotal} (total ${fin.longtaskMsTotal}ms, max ${fin.longtaskMaxMs}ms)`)
    console.log(`jank frames:      >50ms=${fin.jank50Total}  >100ms=${fin.jank100Total}`)
    console.log(`heap peak:        ${fin.heapPeakMB} MB`)
    console.log(`heap at end:      ${fin.heapNowMB} MB`)
  }
  console.log(`heap post-GC:     ${finalHeap.toFixed(1)} MB   <- leak baseline (should be modest after churn)`)
  console.log(`max single-proc RSS peak: ${peakRss} MB`)
  const fp = footprintMB(lastPids)
  if (fp > 0) console.log(`true phys_footprint (all procs, no double-count): ${fp} MB`)
  console.log('==========================================')

  cleanup()
  process.exit(0)
}

main().catch((e) => {
  console.error('stress run failed:', e)
  process.exit(1)
})
