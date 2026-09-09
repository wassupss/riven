// Wire types between the main process and the terminal worker
// (`utilityProcess`). Modeled on paseo's terminal-worker-protocol.ts, trimmed to
// what riven actually needs.
//
// The split:
//   worker — pty spawn/write/resize/kill, the headless xterm MODEL, revision
//            assignment, the output coalescer, flow control (pty pause/resume),
//            snapshot generation, the hidden gate, bell/title parsing.
//   main   — session registry, renderer IPC, agent-hook routing, the activity
//            state machine, notifications, and building the pty env (which needs
//            the MCP server + hook config that only main has).
//
// Invariants that this boundary exists to protect:
//   * Coalescing happens in the WORKER, before IPC. One message per batch.
//   * A batch carries the LAST revision it contains.
//   * Non-output messages (snapshot / exit / title) flush the coalescer first,
//     so ordering on the wire stays truthful and revision dedup stays correct.
//   * A snapshot is generated immediately after a flush.
//   * Hidden panes: delivery is dropped, model ingest continues.

export interface WorkerSpawnOptions {
  key: string
  shell: string
  args: string[]
  cwd: string
  env: Record<string, string>
  cols: number
  rows: number
}

export type MainToWorker =
  | { type: 'spawn'; options: WorkerSpawnOptions }
  | { type: 'write'; key: string; data: string }
  | { type: 'resize'; key: string; cols: number; rows: number }
  | { type: 'kill'; key: string }
  // Renderer has (or no longer has) a live, sized xterm that wants bytes.
  // Turning visible off also arms needsSnapshot, so the next reveal restores
  // from the model — that is what makes a reattach after a reload exact.
  | { type: 'visible'; key: string; visible: boolean }
  // Cumulative chars the renderer has PARSED for this epoch (flow control).
  | { type: 'ack'; key: string; epoch: number; processed: number }
  // Last content lines of the model, for a notification preview. Main asks only
  // when it is actually about to notify, so this stays rare.
  | { type: 'tail'; key: string; requestId: string; lines: number }
  | { type: 'shutdown' }

export type WorkerToMain =
  | { type: 'spawned'; key: string; pid: number }
  | { type: 'spawnError'; key: string; error: string }
  // One message per coalesced batch, for a visible pane.
  | { type: 'output'; key: string; data: string; rev: number; epoch: number }
  // Hidden pane: the bytes were dropped (the model has them), but main's output
  // heuristic still needs to know something flowed. Data-less and throttled, so
  // a flooding background pane stays close to free.
  | { type: 'outputActivity'; key: string }
  | { type: 'snapshot'; key: string; data: string; rev: number; epoch: number; cols: number; rows: number }
  | { type: 'exit'; key: string; exitCode: number }
  | { type: 'bell'; key: string }
  | { type: 'title'; key: string; title: string }
  | { type: 'tailResult'; requestId: string; text: string }

// How often a hidden pane may report output activity. Main's heuristic resolves
// at ACTIVE_MS (800ms), so this is well inside its resolution.
export const HIDDEN_ACTIVITY_PING_MS = 250
