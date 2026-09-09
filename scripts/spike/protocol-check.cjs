// Drives the BUILT terminal worker (out/main/terminal-worker.js) through the
// real protocol: spawn → visible → output → snapshot restore → tail → kill.
// This is the integration check that the electron-vite worker entry actually
// works when forked, not just that it compiles.
const { app, utilityProcess } = require('electron')
const path = require('path')

const KEY = 'check-1'
const MARKER = 'PROTOCOL_MARKER_77'
const checks = []
const record = (name, ok, detail) => {
  checks.push({ name, ok, detail })
  console.log('[check] %s ok=%s %s', name, ok, detail ?? '')
}

let finished = false
const finish = (reason) => {
  if (finished) return
  finished = true
  console.log('\n===== PROTOCOL CHECK (%s) =====', reason)
  for (const c of checks) {
    console.log('%s  %s  %s', c.ok ? 'PASS' : 'FAIL', c.name.padEnd(24), c.detail ?? '')
  }
  const want = ['spawned', 'output', 'visible-gate', 'snapshot', 'tail', 'exit']
  const missing = want.filter((w) => !checks.some((c) => c.name === w && c.ok))
  console.log('VERDICT: %s missing=%s', missing.length ? 'NO-GO' : 'GO', missing.join(',') || 'none')
  app.exit(missing.length ? 1 : 0)
}

app.whenReady().then(() => {
  const entry = path.join(__dirname, '../../out/main/terminal-worker.js')
  const child = utilityProcess.fork(entry, [], { stdio: 'inherit', serviceName: 'riven-check' })

  let sawOutput = false
  let hiddenBytes = 0
  let phase = 'boot'
  let snapRev = -1

  child.on('message', (m) => {
    if (m.type === 'spawned') {
      record('spawned', m.pid > 0, `pid=${m.pid}`)
      // Visible first, so we can see live output.
      child.postMessage({ type: 'visible', key: KEY, visible: true })
      child.postMessage({ type: 'write', key: KEY, data: 'echo live-ok\r' })
      return
    }
    if (m.type === 'spawnError') {
      record('spawned', false, m.error)
      finish('spawn error')
      return
    }
    if (m.type === 'output') {
      if (phase === 'boot' && m.data.includes('live-ok')) {
        sawOutput = true
        record('output', m.rev > 0 && m.epoch >= 0, `rev=${m.rev} epoch=${m.epoch}`)
        // Go hidden, emit the marker, and confirm nothing is delivered while
        // hidden — the model must still ingest it.
        phase = 'hidden'
        child.postMessage({ type: 'visible', key: KEY, visible: false })
        child.postMessage({ type: 'write', key: KEY, data: `echo ${MARKER}\r` })
        setTimeout(() => {
          record('visible-gate', hiddenBytes === 0, `bytes delivered while hidden=${hiddenBytes}`)
          phase = 'reveal'
          child.postMessage({ type: 'visible', key: KEY, visible: true })
        }, 700)
        return
      }
      if (phase === 'hidden') hiddenBytes += m.data.length
      return
    }
    if (m.type === 'snapshot') {
      if (phase === 'reveal') {
        snapRev = m.rev
        // The marker was written while hidden; it must be in the model snapshot.
        record('snapshot', m.data.includes(MARKER) && m.rev > 0, `rev=${m.rev} epoch=${m.epoch}`)
        child.postMessage({ type: 'tail', key: KEY, requestId: 'r1', lines: 8 })
      }
      return
    }
    if (m.type === 'tailResult') {
      record('tail', m.text.includes(MARKER), JSON.stringify(m.text.slice(-50)))
      child.postMessage({ type: 'kill', key: KEY })
      setTimeout(() => finish('done'), 400)
      return
    }
    if (m.type === 'exit') {
      record('exit', true, `code=${m.exitCode} afterSnapRev=${snapRev} sawOutput=${sawOutput}`)
      return
    }
  })

  child.on('exit', (c) => console.log('[check] worker exited code=%s', c))

  child.postMessage({
    type: 'spawn',
    options: {
      key: KEY,
      shell: '/bin/zsh',
      args: ['-i'],
      cwd: process.env.HOME,
      env: { ...process.env, TERM: 'xterm-256color', PS1: '$ ' },
      cols: 80,
      rows: 24
    }
  })

  setTimeout(() => finish('timeout 20s'), 20000)
})
