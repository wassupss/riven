import { app, ipcMain } from 'electron'

// Per-process CPU, straight from Chromium.
//
// Activity Monitor shows three processes called "riven Helper" and does not say
// which is which, so a CPU report from it cannot be acted on: the GPU process,
// the window's renderer and the pty worker are indistinguishable by name. Every
// process here carries its `type`, so a measurement can say WHICH one is hot —
// and that is the difference between "riven uses 40% CPU" and a fixable claim.
//
// This is diagnosis, not telemetry: nothing is collected or sent anywhere, it is
// read only when something asks (the perf script, or a future HUD).

export interface ProcSample {
  pid: number
  // 'Browser' (main), 'Tab' (a renderer), 'GPU', 'Utility', …
  type: string
  // Utility processes say what they are ("Node Service" for the pty worker).
  serviceName?: string
  name?: string
  cpu: number // percent of ONE core, averaged since the last sample Chromium took
}

export function sampleProcesses(): ProcSample[] {
  return app.getAppMetrics().map((m) => ({
    pid: m.pid,
    type: m.type,
    serviceName: m.serviceName,
    name: m.name,
    cpu: m.cpu?.percentCPUUsage ?? 0
  }))
}

export function registerPerfHandlers(): void {
  ipcMain.handle('perf:metrics', () => sampleProcesses())
}
