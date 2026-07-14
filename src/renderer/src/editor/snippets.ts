import * as monaco from 'monaco-editor'
import { getSettings } from '../state/settings'

// User-defined snippets: a Monaco completion provider that offers each snippet
// by its prefix. Bodies support ${1}/${2} tab stops (InsertAsSnippet). Reads
// live from settings, so edits in the Settings editor take effect immediately.

const SNIPPET_LANGS = [
  'typescript', 'javascript', 'tsx', 'jsx', 'python', 'rust', 'go', 'java',
  'cpp', 'csharp', 'ruby', 'php', 'html', 'css', 'scss', 'less', 'json',
  'yaml', 'markdown', 'shellscript', 'sql', 'toml', 'vue', 'svelte'
]

let registered = false

export function registerSnippets(): void {
  if (registered) return
  registered = true
  monaco.languages.registerCompletionItemProvider(SNIPPET_LANGS, {
    provideCompletionItems(model, position) {
      const snippets = getSettings().snippets
      if (!snippets.length) return { suggestions: [] }
      const word = model.getWordUntilPosition(position)
      const range = {
        startLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endLineNumber: position.lineNumber,
        endColumn: word.endColumn
      }
      return {
        suggestions: snippets
          .filter((s) => s.prefix)
          .map((s) => ({
            label: s.prefix,
            kind: monaco.languages.CompletionItemKind.Snippet,
            insertText: s.body,
            insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
            range,
            detail: 'snippet'
          }))
      }
    }
  })
}
