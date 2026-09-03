// Dev-only load/stress harness. NEVER runs in the normal app: it is gated on a
// `?stress=1` query param, which only a dedicated profiling instance passes (see
// scripts/stress/run.mjs). It opens every panel kind, floods terminals, spawns
// many chat panes, loads several editor buffers, then churns panels open/close to
// surface leaks. A frame/longtask/heap monitor records per-phase metrics into
// window.__STRESS_REPORT for the external profiler to read over CDP.
//
// Kept out of the production surface entirely: main.tsx only imports this when the
// query flag is present, so tree-shaking drops it from real builds.
import {
  getActiveApi,
  addTerminal,
  addChat,
  togglePanel,
  openEditorSplit,
  type NamedPanel
} from '../dock/registry'
import { useSession } from '../state/session'

const q = new URLSearchParams(location.search)
const num = (k: string, d: number): number => {
  const v = Number(q.get(k))
  return Number.isFinite(v) && v > 0 ? v : d
}

const WORKSPACE = q.get('ws') || '/Users/songhwaseob/hs-playground/riven-electron'
const N_CHAT = num('chats', 10)
const N_TERM = num('terms', 6)
const CHURN = num('churn', 40)
const FLOOD_MS = num('flood', 8000)

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const frame = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => r()))
async function waitFor(fn: () => boolean, timeout = 15000): Promise<boolean> {
  const t0 = performance.now()
  while (performance.now() - t0 < timeout) {
    if (fn()) return true
    await wait(100)
  }
  return fn()
}

// ---- metrics -------------------------------------------------------------
let frames = 0
let jank50 = 0
let jank100 = 0
let worst = 0
let ltCount = 0
let ltTotal = 0
let ltMax = 0
let heapPeak = 0
let lastT = 0

interface Mem {
  usedJSHeapSize: number
  totalJSHeapSize: number
}
const mem = (): Mem | null => (performance as unknown as { memory?: Mem }).memory ?? null

function startMonitor(): void {
  lastT = performance.now()
  const loop = (t: number): void => {
    const d = t - lastT
    lastT = t
    frames++
    if (d > 50) jank50++
    if (d > 100) jank100++
    if (d > worst) worst = d
    requestAnimationFrame(loop)
  }
  requestAnimationFrame(loop)
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        ltCount++
        ltTotal += e.duration
        if (e.duration > ltMax) ltMax = e.duration
      }
    }).observe({ entryTypes: ['longtask'] })
  } catch {
    /* longtask unsupported */
  }
  setInterval(() => {
    const m = mem()
    if (m && m.usedJSHeapSize > heapPeak) heapPeak = m.usedJSHeapSize
  }, 300)
}

function snap(): { frames: number; jank50: number; jank100: number; lt: number; t: number } {
  return { frames, jank50, jank100, lt: ltCount, t: performance.now() }
}

const report: Record<string, unknown>[] = []
;(window as unknown as { __STRESS_REPORT: unknown[] }).__STRESS_REPORT = report
const setStatus = (s: unknown): void => {
  ;(window as unknown as { __STRESS: unknown }).__STRESS = s
}

async function phase(name: string, fn: () => Promise<void>): Promise<void> {
  const before = snap()
  const m0 = mem()?.usedJSHeapSize ?? 0
  setStatus({ phase: name, running: true, heapMB: +(((mem()?.usedJSHeapSize ?? 0) / 1048576).toFixed(1)) })
  await fn()
  await frame()
  const after = snap()
  const dt = (after.t - before.t) / 1000
  const df = after.frames - before.frames
  const m1 = mem()?.usedJSHeapSize ?? 0
  const row = {
    phase: name,
    seconds: +dt.toFixed(2),
    fps: dt > 0 ? +(df / dt).toFixed(1) : 0,
    jank50: after.jank50 - before.jank50,
    jank100: after.jank100 - before.jank100,
    longtasks: after.lt - before.lt,
    heapStartMB: +(m0 / 1048576).toFixed(1),
    heapEndMB: +(m1 / 1048576).toFixed(1),
    panels: getActiveApi()?.panels.length ?? 0
  }
  report.push(row)
  setStatus({ running: false, ...row })
  // eslint-disable-next-line no-console
  console.log('[STRESS]', JSON.stringify(row))
}

function closeLastChat(): void {
  const api = getActiveApi()
  if (!api) return
  const chats = api.panels.filter((p) => p.id.startsWith('chat-'))
  const last = chats.at(-1)
  if (last) api.removePanel(last)
}

async function run(): Promise<void> {
  startMonitor()
  setStatus({ phase: 'boot', running: true })

  // Open the stress workspace and wait for its dock api to come up.
  useSession.getState().openWorkspace(WORKSPACE)
  const ready = await waitFor(() => !!getActiveApi())
  if (!ready) {
    setStatus({ phase: 'boot', error: 'no active dock api' })
    ;(window as unknown as { __STRESS_DONE: boolean }).__STRESS_DONE = true
    return
  }
  await wait(800)

  await phase('singletons', async () => {
    const kinds: NamedPanel[] = ['editor', 'search', 'git', 'changes', 'notes', 'api', 'preview', 'agentgroup']
    for (const k of kinds) {
      togglePanel(k as Parameters<typeof togglePanel>[0])
      await frame()
    }
  })

  await phase('editors', async () => {
    const files = [
      'src/renderer/src/dock/panels/ChatPanel.tsx',
      'src/renderer/src/i18n.ts',
      'src/renderer/src/dock/panels/AgentGroupPanel.tsx',
      'src/renderer/src/dock/registry.ts',
      'src/renderer/src/state/session.ts'
    ].map((f) => `${WORKSPACE}/${f}`)
    for (const f of files) {
      openEditorSplit(f)
      await wait(250)
    }
  })

  await phase('chats-open', async () => {
    for (let i = 0; i < N_CHAT; i++) {
      addChat()
      await frame()
    }
  })

  await phase('terminals-flood', async () => {
    for (let i = 0; i < N_TERM; i++) {
      // Unbounded flood: maxes PTY throughput + xterm render/scrollback churn.
      addTerminal(`yes "RIVEN-STRESS-${i}-XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"`)
      await frame()
    }
    await wait(FLOOD_MS) // sustained-load measurement window
  })

  await phase('steady-under-flood', async () => {
    // Interact (open/close a chat) while terminals keep flooding, to catch lag
    // that only appears under sustained background load.
    for (let i = 0; i < 10; i++) {
      addChat()
      await wait(150)
      closeLastChat()
      await wait(150)
    }
  })

  // Stop the floods so churn/leak measurement isn't dominated by PTY noise.
  await phase('stop-floods', async () => {
    const api = getActiveApi()
    if (api) for (const p of api.panels.filter((p) => p.id.startsWith('term-'))) api.removePanel(p)
    await wait(1500)
  })

  await phase('churn-leak', async () => {
    for (let i = 0; i < CHURN; i++) {
      addChat()
      await frame()
      closeLastChat()
      await frame()
    }
  })

  // Signal the external profiler to force GC now, then let it settle so it can
  // read a post-GC heap baseline for leak assessment.
  ;(window as unknown as { __STRESS_CHURN_DONE: boolean }).__STRESS_CHURN_DONE = true
  await wait(5000)

  const finalMem = mem()
  const final = {
    phase: 'final',
    heapNowMB: +(((finalMem?.usedJSHeapSize ?? 0) / 1048576).toFixed(1)),
    heapPeakMB: +((heapPeak / 1048576).toFixed(1)),
    heapTotalMB: +(((finalMem?.totalJSHeapSize ?? 0) / 1048576).toFixed(1)),
    worstFrameMs: +worst.toFixed(1),
    longtasksTotal: ltCount,
    longtaskMsTotal: +ltTotal.toFixed(0),
    longtaskMaxMs: +ltMax.toFixed(1),
    jank50Total: jank50,
    jank100Total: jank100,
    panels: getActiveApi()?.panels.length ?? 0
  }
  report.push(final)
  setStatus({ ...final, phase: 'done' })
  // eslint-disable-next-line no-console
  console.log('[STRESS]', JSON.stringify(final))
  ;(window as unknown as { __STRESS_DONE: boolean }).__STRESS_DONE = true
}

export function maybeRunStress(): void {
  if (!q.has('stress')) return
  // Live diagnostics the external driver can poll while the dock boots.
  setInterval(() => {
    const st = useSession.getState()
    ;(window as unknown as { __DIAG: unknown }).__DIAG = {
      href: location.href,
      hasApi: !!getActiveApi(),
      activeWorkspace: st.activeWorkspace,
      openWorkspaces: st.openWorkspaces.length,
      ready: st.ready,
      body: document.body?.innerText?.slice(0, 120) ?? ''
    }
  }, 500)
  // Give React/StrictMode the first mount before we start driving the dock.
  setTimeout(() => {
    void run().catch((e) => {
      ;(window as unknown as { __STRESS: unknown }).__STRESS = { phase: 'crash', error: String(e) }
      ;(window as unknown as { __STRESS_DONE: boolean }).__STRESS_DONE = true
      // eslint-disable-next-line no-console
      console.error('[STRESS] crash', e)
    })
  }, 1500)
}
