import * as monaco from 'monaco-editor'
import { getSettings } from '../state/settings'
import { getProvider } from '../state/aiProviders'

// Copilot-style ghost-text completions. The provider is always registered but is
// a no-op (zero network) unless the user turns it on in Settings → AI, so the
// IDE stays lightweight by default. When on, it debounces and asks the configured
// model (default: local Ollama) to fill in at the cursor.
let registered = false

// Notify once per distinct failure reason so a down backend (e.g. Ollama not
// running) is visible without spamming a notification on every keystroke.
const notifiedReasons = new Set<string>()
function surfaceAiError(reason: string): void {
  if (notifiedReasons.has(reason)) return
  notifiedReasons.add(reason)
  window.api.notify.show('AI 자동완성 / autocomplete', reason)
}

export function registerInlineComplete(): void {
  if (registered) return
  registered = true

  monaco.languages.registerInlineCompletionsProvider('*', {
    async provideInlineCompletions(model, position, _ctx, token) {
      const s = getSettings()
      if (!s.aiComplete) return { items: [] }

      // Debounce: if the user keeps typing, the token cancels and we bail before
      // spending a request.
      await new Promise((r) => setTimeout(r, 300))
      if (token.isCancellationRequested) return { items: [] }

      const lastLine = model.getLineCount()
      const prefix = model
        .getValueInRange({
          startLineNumber: 1,
          startColumn: 1,
          endLineNumber: position.lineNumber,
          endColumn: position.column
        })
        .slice(-4000)
      const suffix = model
        .getValueInRange({
          startLineNumber: position.lineNumber,
          startColumn: position.column,
          endLineNumber: lastLine,
          endColumn: model.getLineMaxColumn(lastLine)
        })
        .slice(0, 2000)
      if (!prefix.trim()) return { items: [] }

      let res: { text: string } | { error: string }
      try {
        res = await window.api.ai.complete(prefix, suffix, {
          mode: getProvider(s.aiProvider).mode,
          endpoint: s.aiCompleteEndpoint,
          model: s.aiCompleteModel,
          apiKey: s.aiApiKey
        })
      } catch {
        return { items: [] }
      }
      // Surface a backend failure (once per distinct reason) instead of silently
      // showing nothing, so the user can tell "no suggestion" from "misconfigured".
      if ('error' in res) {
        surfaceAiError(res.error)
        return { items: [] }
      }
      const text = res.text
      if (token.isCancellationRequested || !text) return { items: [] }

      return {
        items: [
          {
            insertText: text,
            range: new monaco.Range(
              position.lineNumber,
              position.column,
              position.lineNumber,
              position.column
            )
          }
        ]
      }
    },
    freeInlineCompletions() {
      /* nothing to dispose */
    }
  })
}
