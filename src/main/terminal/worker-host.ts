// Main-side owner of the terminal worker process.
//
// Forks lazily (nothing is paid until the first terminal opens), re-forks after
// a crash, and guarantees the child is dead on quit. A crash must never take the
// app with it: the host reports it, main cleans up the sessions that died, and
// the next `pty:open` gets a fresh worker.

import { utilityProcess, type UtilityProcess } from 'electron'
import * as path from 'path'
import type { MainToWorker, WorkerToMain } from './worker-protocol'

export interface TerminalWorkerHostOptions {
  onMessage: (msg: WorkerToMain) => void
  // The worker died without being asked to. Argument is the exit code.
  onCrash: (code: number) => void
}

export class TerminalWorkerHost {
  private child: UtilityProcess | null = null
  private stopped = false

  constructor(private readonly opts: TerminalWorkerHostOptions) {}

  // Emitted next to the main bundle by electron-vite (see its rollup input), so
  // this resolves identically in dev and in a packaged app.
  private entryPath(): string {
    return path.join(__dirname, 'terminal-worker.js')
  }

  private fork(): UtilityProcess | null {
    if (this.stopped) return null
    let child: UtilityProcess
    try {
      child = utilityProcess.fork(this.entryPath(), [], {
        serviceName: 'riven-terminal',
        // Let the worker's console.error reach the same place main's does.
        stdio: 'inherit'
      })
    } catch (e) {
      console.error('[riven] terminal worker fork failed', e)
      return null
    }

    child.on('message', (msg: WorkerToMain) => {
      try {
        this.opts.onMessage(msg)
      } catch (e) {
        console.error('[riven] terminal worker message handling failed', e)
      }
    })

    child.on('exit', (code) => {
      // Only the CURRENT child's death is news; a stale handle exiting after a
      // re-fork must not clear the new one.
      if (this.child !== child) return
      this.child = null
      if (this.stopped) return
      console.error('[riven] terminal worker exited unexpectedly, code=', code)
      this.opts.onCrash(code)
    })

    this.child = child
    return child
  }

  private ensure(): UtilityProcess | null {
    if (this.child) return this.child
    return this.fork()
  }

  // Starting a terminal is the only thing allowed to bring the worker up; every
  // other message is meaningless without a session and is dropped if it is down.
  post(msg: MainToWorker): void {
    const child = msg.type === 'spawn' ? this.ensure() : this.child
    if (!child) return
    try {
      child.postMessage(msg)
    } catch (e) {
      console.error('[riven] terminal worker post failed', e)
    }
  }

  // Quit path. Ask the worker to kill its shells, then kill the worker itself —
  // main is about to SIGKILL itself (index.ts), which would otherwise orphan it.
  shutdown(): void {
    this.stopped = true
    const child = this.child
    if (!child) return
    this.child = null
    try {
      child.postMessage({ type: 'shutdown' } satisfies MainToWorker)
    } catch {
      /* already gone */
    }
    try {
      child.kill()
    } catch {
      /* already gone */
    }
  }
}
