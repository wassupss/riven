import * as monaco from 'monaco-editor'
import { useSession, setOrphanModelDisposer } from '../state/session'

// Monaco models are global by URI, so the same folder opened as a second
// workspace shares ONE model per path. Revision/saved-version bookkeeping must
// therefore be shared too — if it were per-editor-pane, the second pane's mount
// would see an empty appliedRev, re-run model.setValue(disk) and destroy the
// first pane's unsaved edits (F1), and the two panes' dirty state would desync
// (F8). Keying these maps by model URI fixes both.
export const modelRev = new Map<string, number>()
export const modelSaved = new Map<string, number>()

function disposeNow(path: string): void {
  const uri = monaco.Uri.parse(`file://${path}`)
  const key = uri.toString()
  monaco.editor.getModel(uri)?.dispose()
  modelRev.delete(key)
  modelSaved.delete(key)
}

// Called when a tab is closed. Dispose the model only if NO workspace still has
// this path open — a sibling same-folder workspace shares the model by URI, so
// disposing it here would blank the other workspace's editor (the F1/F2 crash).
export function releaseModel(path: string): void {
  const stillOpen = Object.values(useSession.getState().sessions).some((s) =>
    s.openTabs.includes(path)
  )
  if (!stillOpen) disposeNow(path)
}

// Registered with the session store so closing a workspace disposes the models
// for files that were open ONLY in it (they'd otherwise leak for the process
// lifetime — F17). The store passes already-orphaned paths.
setOrphanModelDisposer((paths) => {
  for (const p of paths) disposeNow(p)
})
