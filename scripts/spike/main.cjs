// Stage-1 spike host. Forks the spike worker as an Electron utilityProcess,
// collects its step reports, prints a verdict, exits non-zero on any failure.
const { app, utilityProcess } = require('electron')
const path = require('path')

const steps = []
let finished = false

const finish = (reason) => {
  if (finished) return
  finished = true
  console.log('\n===== SPIKE RESULT (%s) =====', reason)
  for (const s of steps) {
    console.log('%s  %s  %s', s.ok ? 'PASS' : 'FAIL', s.step.padEnd(28), s.detail ?? '')
  }
  const failed = steps.filter((s) => !s.ok)
  const required = ['require:node-pty', 'require:@xterm/headless', 'pty:spawn', 'pty:echo']
  const missing = required.filter((r) => !steps.some((s) => s.step === r && s.ok))
  console.log('failed=%d missing=%s', failed.length, missing.join(',') || 'none')
  const ok = failed.length === 0 && missing.length === 0
  console.log('VERDICT: %s', ok ? 'GO' : 'NO-GO')
  app.exit(ok ? 0 : 1)
}

app.whenReady().then(() => {
  const child = utilityProcess.fork(path.join(__dirname, 'worker.cjs'), [], {
    stdio: 'inherit',
    serviceName: 'riven-spike'
  })

  child.on('message', (msg) => {
    if (msg.kind === 'step') {
      steps.push(msg)
      console.log('[step] %s ok=%s %s', msg.step, msg.ok, msg.detail ?? '')
    } else if (msg.kind === 'done') {
      setTimeout(() => finish('worker done'), 150)
    }
  })

  child.on('exit', (code) => {
    console.log('[spike] worker exited code=%s', code)
    setTimeout(() => finish('worker exit'), 100)
  })

  // Hard deadline so a hang is a reported failure, not a stuck run.
  setTimeout(() => finish('timeout 15s'), 15000)
})
