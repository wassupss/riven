// Renderer CPU profiler. Launches a dedicated electron instance against the dev
// vite server, opens two workspaces, then samples a V8 CPU profile while it
// repeatedly switches the active workspace — to find exactly what makes switching
// (and general interaction) slow. Prints the hottest functions by self time.
import { spawn, execSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { setTimeout as sleep } from 'node:timers/promises'

const require = createRequire(import.meta.url)
const REPO = new URL('../../', import.meta.url).pathname
const PORT = Number(process.env.PORT) || 9444
const PROFILE_DIR = '/tmp/riven-cpuprof'
const WS_A = '/Users/songhwaseob/hs-playground/portboard'
const WS_B = '/Users/songhwaseob/hs-playground/riven-electron'
const electronBin = require('electron')

function preflight() {
  try {
    execSync("curl -s -o /dev/null http://localhost:5173", { timeout: 3000 })
  } catch {
    console.error('vite not on 5173 — run `npm run dev` first.')
    process.exit(1)
  }
  execSync(`rm -rf ${PROFILE_DIR}`)
}

async function connectCDP() {
  let target
  for (let i = 0; i < 60; i++) {
    try {
      const list = await fetch(`http://127.0.0.1:${PORT}/json`).then((r) => r.json())
      target = list.find((t) => t.type === 'page' && !/devtools/.test(t.url))
      if (target) break
    } catch { /* not up */ }
    await sleep(500)
  }
  if (!target) throw new Error('no page target')
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  let id = 0
  const pending = new Map()
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result) }
  }
  const send = (method, params = {}) => new Promise((resolve, reject) => { const i = ++id; pending.set(i, { resolve, reject }); ws.send(JSON.stringify({ id: i, method, params })) })
  const evalJs = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }))?.result?.value
  return { send, evalJs }
}

// Aggregate a V8 CPU profile by self time (hitCount) per function.
function analyze(profile) {
  const byFn = new Map()
  const total = profile.nodes.reduce((s, n) => s + (n.hitCount || 0), 0)
  for (const n of profile.nodes) {
    if (!n.hitCount) continue
    const cf = n.callFrame
    const name = (cf.functionName || '(anonymous)') + '  ' + (cf.url || '').replace(/.*\/(src|node_modules)\//, '$1/').replace(/\?.*/, '') + (cf.lineNumber >= 0 ? ':' + (cf.lineNumber + 1) : '')
    byFn.set(name, (byFn.get(name) || 0) + n.hitCount)
  }
  const rows = [...byFn.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)
  return { total, rows }
}

async function main() {
  const ATTACH = !!process.env.ATTACH
  let child = null
  if (!ATTACH) {
    preflight()
    console.log('launching profiler instance...')
    child = spawn(electronBin, ['.', `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE_DIR}`],
      { cwd: REPO, env: { ...process.env, ELECTRON_RENDERER_URL: 'http://localhost:5173', NODE_ENV: 'development' }, stdio: 'ignore' })
  } else {
    console.log(`ATTACH mode — connecting to existing app on :${PORT} (real session)`)
  }
  const cleanup = () => { if (child) try { child.kill('SIGKILL') } catch {} }
  process.on('exit', cleanup)

  const cdp = await connectCDP()
  console.log('CDP connected. waiting for stores...')
  for (let i = 0; i < 40; i++) { if (await cdp.evalJs('!!window.__session').catch(() => false)) break; await sleep(500) }

  if (!ATTACH) {
    await cdp.evalJs(`window.__session.getState().openWorkspace(${JSON.stringify(WS_A)})`)
    await sleep(1500)
    await cdp.evalJs(`window.__session.getState().openWorkspace(${JSON.stringify(WS_B)})`)
    await sleep(2500)
  }
  const wsList = await cdp.evalJs('JSON.stringify(window.__session.getState().openWorkspaces)')
  console.log('open workspaces:', wsList)
  const panels = await cdp.evalJs('(window.__registry.getActiveApi && window.__registry.getActiveApi()?.panels.length) || 0')
  console.log('active workspace panels:', panels)

  // Count mounted heavy components across ALL (hidden) workspaces — the real cost.
  const mounted = await cdp.evalJs(`JSON.stringify({
    domNodes: document.querySelectorAll('*').length,
    xterm: document.querySelectorAll('.xterm').length,
    monaco: document.querySelectorAll('.monaco-editor').length,
    dockviews: document.querySelectorAll('.dv-dockview').length,
    canvases: document.querySelectorAll('canvas').length,
    backdropEls: [...document.querySelectorAll('*')].filter(function(e){var s=getComputedStyle(e);return (s.backdropFilter&&s.backdropFilter!=='none')||(s.webkitBackdropFilter&&s.webkitBackdropFilter!=='none')}).length
  })`)
  console.log('mounted heavy components:', mounted)

  void analyze
  // Measure switch latency = time from setActiveWorkspace() until the frame is
  // actually painted (2x rAF). This captures style+layout+paint+composite, which a
  // JS-only CPU profile misses. We run the same test under 4 conditions to isolate
  // the cost: baseline, no backdrop-filter, no animations, and both off.
  const measure = async (label) => {
    const expr = `(async function(){
      const st=window.__session.getState();
      const ws=st.openWorkspaces.slice(0,2);
      const raf=()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r())));
      const t=[];
      for(let i=0;i<12;i++){
        const target=ws[i%ws.length];
        const a=performance.now();
        st.setActiveWorkspace(target);
        await raf();
        t.push(performance.now()-a);
        await new Promise(r=>setTimeout(r,120));
      }
      t.sort((x,y)=>x-y);
      return {median:+t[t.length>>1].toFixed(1),p90:+t[Math.floor(t.length*0.9)].toFixed(1),max:+Math.max.apply(null,t).toFixed(1)};
    })()`
    const r = await cdp.evalJs(expr)
    console.log(`  ${label.padEnd(28)} median=${r.median}ms  p90=${r.p90}ms  max=${r.max}ms`)
    return r
  }
  const inject = async (id, css) => { await cdp.evalJs(`(function(){var s=document.getElementById(${JSON.stringify(id)})||document.createElement('style');s.id=${JSON.stringify(id)};s.textContent=${JSON.stringify(css)};document.head.appendChild(s);})()`) }
  const remove = async (id) => { await cdp.evalJs(`(function(){var s=document.getElementById(${JSON.stringify(id)});if(s)s.remove();})()`) }

  console.log('\n=== workspace-switch latency (paint-inclusive) under conditions ===')
  await measure('baseline')
  await inject('kill-bd', '*{backdrop-filter:none!important;-webkit-backdrop-filter:none!important}')
  await measure('no backdrop-filter')
  await remove('kill-bd')
  await inject('kill-anim', '*,*::before,*::after{animation:none!important;transition:none!important}')
  await measure('no animations/transitions')
  await inject('kill-bd', '*{backdrop-filter:none!important;-webkit-backdrop-filter:none!important}')
  await measure('no backdrop + no anim')
  await remove('kill-bd'); await remove('kill-anim')
  // Also: how many DOM nodes + how many backdrop-filter elements are live?
  const stats = await cdp.evalJs(`JSON.stringify({nodes:document.querySelectorAll('*').length, bd:[...document.querySelectorAll('*')].filter(function(e){var s=getComputedStyle(e);return (s.backdropFilter&&s.backdropFilter!=='none')||(s.webkitBackdropFilter&&s.webkitBackdropFilter!=='none')}).length, blurs:[...document.querySelectorAll('*')].filter(function(e){return getComputedStyle(e).filter.indexOf('blur')>=0}).length})`)
  console.log('\nDOM stats:', stats)
  console.log('='.repeat(70))
  cleanup()
  process.exit(0)
}

main().catch((e) => { console.error('profile failed:', e); process.exit(1) })
