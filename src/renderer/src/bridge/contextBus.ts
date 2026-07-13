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

  registerSink(sink: Sink): void {
    this.sinks = this.sinks.filter((s) => s.paneId !== sink.paneId).concat(sink)
    if (!this.activeByWs.has(sink.workspace)) this.activeByWs.set(sink.workspace, sink.paneId)
    this.emit()
  }

  unregisterSink(paneId: number): void {
    const gone = this.sinks.find((s) => s.paneId === paneId)
    this.sinks = this.sinks.filter((s) => s.paneId !== paneId)
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

  private write(workspace: string | null, text: string): boolean {
    const sink = this.getActive(workspace)
    if (!sink) return false
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
    return this.write(workspace, `\n[프리뷰 스크린샷 — 아래 파일을 확인해줘]\n${imgPath}\n`)
  }
}

export const contextBus = new ContextBus()
