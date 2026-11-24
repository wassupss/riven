// Which workspace a pet assistant's riven tool call acts on, when the call
// itself names none (state/mcpTools resolveCtx). Kept in a module of its own
// so the tools can ask without importing the pet assistant host (which
// imports the session and settings stores).
//
// A pet assistant is no dock pane, so the usual attribution (the pane's
// workspace, else the CLI's folder) only works for one scoped to a single
// workspace (its CLI runs in that folder). For the others the host registers
// lib/petAssistant actingWorkspace: the one on screen if it is in scope, else
// the first open one in scope.

const scopes = new Map<string, () => string | null>()

export function setPetScope(key: string, resolve: (() => string | null) | null): void {
  if (resolve) scopes.set(key, resolve)
  else scopes.delete(key)
}

/** The workspace a pet assistant's call acts on, or null (not a pet, or none in scope is open). */
export function petActingWorkspace(key: string | null | undefined): string | null {
  if (!key) return null
  const fn = scopes.get(key)
  return fn ? fn() : null
}
