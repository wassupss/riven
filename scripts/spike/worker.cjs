// Stage-1 spike worker: does node-pty + @xterm/headless load inside an
// Electron utilityProcess, and does a real pty round-trip reach the parent?
// Raw CJS on purpose — this isolates the native-ABI question from the
// electron-vite build pipeline.

const report = (step, ok, detail) => {
  process.parentPort.postMessage({ kind: 'step', step, ok, detail: detail ?? null })
}

let pty, HeadlessTerminal, SerializeAddon

try {
  pty = require('node-pty')
  report('require:node-pty', true, typeof pty.spawn)
} catch (e) {
  report('require:node-pty', false, `${e.name}: ${e.message}`)
}

try {
  HeadlessTerminal = require('@xterm/headless').Terminal
  report('require:@xterm/headless', true, typeof HeadlessTerminal)
} catch (e) {
  report('require:@xterm/headless', false, `${e.name}: ${e.message}`)
}

try {
  SerializeAddon = require('@xterm/addon-serialize').SerializeAddon
  report('require:@xterm/addon-serialize', true, typeof SerializeAddon)
} catch (e) {
  report('require:@xterm/addon-serialize', false, `${e.name}: ${e.message}`)
}

// Headless model must actually parse and serialize, not just load.
try {
  const term = new HeadlessTerminal({ cols: 80, rows: 24, allowProposedApi: true })
  const ser = new SerializeAddon()
  term.loadAddon(ser)
  term.write('model-ok', () => {
    let out = ''
    try {
      out = ser.serialize({ scrollback: 10 })
    } catch (e) {
      report('model:serialize', false, `${e.name}: ${e.message}`)
      return
    }
    report('model:serialize', out.includes('model-ok'), JSON.stringify(out.slice(0, 40)))
  })
} catch (e) {
  report('model:construct', false, `${e.name}: ${e.message}`)
}

// Real pty round-trip: spawn a shell, run `echo hi`, wait for the echo.
try {
  const proc = pty.spawn('/bin/zsh', ['-c', 'echo hi'], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: process.env.HOME,
    env: { ...process.env, TERM: 'xterm-256color' }
  })
  report('pty:spawn', true, `pid=${proc.pid}`)

  let seen = ''
  proc.onData((d) => {
    seen += d
    if (seen.includes('hi')) {
      report('pty:echo', true, JSON.stringify(seen.slice(0, 40)))
    }
  })
  proc.onExit(({ exitCode }) => {
    report('pty:exit', true, `code=${exitCode}`)
    process.parentPort.postMessage({ kind: 'done' })
  })
} catch (e) {
  report('pty:spawn', false, `${e.name}: ${e.message}`)
  process.parentPort.postMessage({ kind: 'done' })
}
