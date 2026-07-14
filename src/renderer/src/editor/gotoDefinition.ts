// @ts-expect-error - monaco internal ESM module ships no type declarations
import { StandaloneServices } from 'monaco-editor/esm/vs/editor/standalone/browser/standaloneServices'
// @ts-expect-error - monaco internal ESM module ships no type declarations
import { ICodeEditorService } from 'monaco-editor/esm/vs/editor/browser/services/codeEditorService'
import { useSession } from '../state/session'
import { useNav } from '../state/nav'

let installed = false

// Monaco's standalone editor service can only navigate within models that
// already exist in the active editor. Go-to-definition / Cmd+click into a file
// that isn't currently open silently does nothing. We override openCodeEditor
// so cross-file (and cross-tab) targets open in riven's editor and reveal the
// definition's line. Same-file jumps still go through monaco's default path.
export function installCrossFileNavigation(): void {
  if (installed) return
  installed = true
  const svc = StandaloneServices.get(ICodeEditorService) as {
    openCodeEditor?: (input: unknown, source: unknown, sideBySide?: boolean) => Promise<unknown>
  }
  const orig = svc.openCodeEditor?.bind(svc)
  svc.openCodeEditor = async (input: unknown, source: unknown, sideBySide?: boolean) => {
    // Let monaco handle the target if it's the model already showing.
    try {
      const existing = orig ? await orig(input, source, sideBySide) : null
      if (existing) return existing
    } catch {
      /* fall through to riven's own opener */
    }
    const i = input as { resource?: { fsPath?: string }; options?: { selection?: { startLineNumber?: number; startColumn?: number } } }
    const path = i?.resource?.fsPath
    if (path) {
      useSession.getState().openFile(path)
      const sel = i?.options?.selection
      if (sel) {
        useNav.getState().requestReveal(path, sel.startLineNumber ?? 1, sel.startColumn ?? 1)
      }
    }
    return source ?? null
  }
}
