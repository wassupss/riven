// The AI <-> context bridge, renderer half. Claude panes register as "sinks";
// the editor / preview push context to the active sink of the *active workspace*
// by writing into its PTY. Scoping by workspace keeps context routing coherent
// when several projects are open at once.

export interface Sink {
  paneId: number
  ptyId: string
  label: string
  workspace: string
}

type Listener = () => void

class ContextBus {
  private sinks: Sink[] = []
  private activeByWs = new Map<string, number>()
  private listeners = new Set<Listener>()
  // Which panes currently have an LLM agent running (pty:agent), + text waiting
  // for an agent to appear (so we never dump code into a plain shell).
  private agentByPane = new Map<number, boolean>()
  private pending = new Map<string, string>()

  registerSink(sink: Sink): void {
    this.sinks = this.sinks.filter((s) => s.paneId !== sink.paneId).concat(sink)
    if (!this.activeByWs.has(sink.workspace)) this.activeByWs.set(sink.workspace, sink.paneId)
    this.emit()
  }

  // Called from TerminalPanel on pty:agent — an LLM appeared/left in this pane.
  setAgent(paneId: number, present: boolean): void {
    this.agentByPane.set(paneId, present)
    this.emit()
    if (present) {
      const sink = this.sinks.find((s) => s.paneId === paneId)
      if (sink) this.flushPending(sink.workspace)
    }
  }

  // A sink that has an agent running — prefer the active pane, else any.
  agentSink(workspace: string | null): Sink | null {
    if (!workspace) return null
    const active = this.getActive(workspace)
    if (active && this.agentByPane.get(active.paneId)) return active
    return this.sinks.find((s) => s.workspace === workspace && this.agentByPane.get(s.paneId)) ?? null
  }

  hasAgent(workspace: string | null): boolean {
    return !!this.agentSink(workspace)
  }

  clearPending(workspace: string | null): void {
    if (workspace) this.pending.delete(workspace)
  }

  private flushPending(workspace: string): void {
    const text = this.pending.get(workspace)
    const sink = this.agentSink(workspace)
    if (!text || !sink) return
    this.pending.delete(workspace)
    // Give the agent a beat to reach its input prompt before pasting.
    setTimeout(() => window.api.pty.write(sink.ptyId, text), 400)
  }

  unregisterSink(paneId: number): void {
    const gone = this.sinks.find((s) => s.paneId === paneId)
    this.sinks = this.sinks.filter((s) => s.paneId !== paneId)
    this.agentByPane.delete(paneId)
    if (gone && this.activeByWs.get(gone.workspace) === paneId) {
      const next = this.sinks.find((s) => s.workspace === gone.workspace)
      if (next) this.activeByWs.set(gone.workspace, next.paneId)
      else this.activeByWs.delete(gone.workspace)
    }
    this.emit()
  }

  setActive(workspace: string, paneId: number): void {
    if (this.sinks.some((s) => s.paneId === paneId && s.workspace === workspace)) {
      this.activeByWs.set(workspace, paneId)
      this.emit()
    }
  }

  getActive(workspace: string | null): Sink | null {
    if (!workspace) return null
    const id = this.activeByWs.get(workspace)
    return (
      this.sinks.find((s) => s.paneId === id) ??
      this.sinks.find((s) => s.workspace === workspace) ??
      null
    )
  }

  hasSink(workspace: string | null): boolean {
    return !!workspace && this.sinks.some((s) => s.workspace === workspace)
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private emit(): void {
    this.listeners.forEach((l) => l())
  }

  // Route to a terminal that actually has an LLM agent. If none, queue the text
  // and return false — the caller offers to launch an agent, and flushPending
  // delivers it once the agent appears.
  private write(workspace: string | null, text: string): boolean {
    const sink = this.agentSink(workspace)
    if (!sink) {
      if (workspace) this.pending.set(workspace, (this.pending.get(workspace) ?? '') + text)
      return false
    }
    window.api.pty.write(sink.ptyId, text)
    return true
  }

  sendCode(workspace: string | null, relPath: string, code: string, kind: 'selection' | 'file'): boolean {
    const header = kind === 'selection' ? `선택 영역 (${relPath})` : `파일 (${relPath})`
    return this.write(workspace, `\n[${header}]\n\`\`\`\n${code}\n\`\`\`\n`)
  }

  sendText(workspace: string | null, text: string): boolean {
    return this.write(workspace, text)
  }

  sendScreenshot(workspace: string | null, imgPath: string): boolean {
    return this.write(workspace, `\n[프리뷰 스크린샷 — 아래 파일을 확인해 주세요]\n${imgPath}\n`)
  }
}

export const contextBus = new ContextBus()
