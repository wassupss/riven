import './monaco-setup'
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { initHighlighting } from './editor/highlight'
import { initOutputCapture } from './state/outputLog'
import './styles.css'
import '@xterm/xterm/css/xterm.css'

// VSCode-grade syntax highlighting (async; colors swap in once ready).
initHighlighting()
// Start capturing language-server logs into the Output panel from launch.
initOutputCapture()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)

// Dev load/stress harness — only when a dedicated profiling instance passes
// ?stress=1 (never in normal use). Dynamic import so it stays out of the app path.
if (new URLSearchParams(location.search).has('stress')) {
  void import('./dev/stress').then((m) => m.maybeRunStress())
}

// DEV-only: expose stores/registry on window so an external CDP profiler can drive
// real code paths (workspace switch etc.). Never present in production builds.
if (import.meta.env.DEV) {
  void import('./state/session').then((m) => ((window as unknown as { __session: unknown }).__session = m.useSession))
  void import('./dock/registry').then((m) => ((window as unknown as { __registry: unknown }).__registry = m))
}
