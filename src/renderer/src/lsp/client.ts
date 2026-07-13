import * as monaco from 'monaco-editor'

// A small hand-rolled LSP client: bridges Monaco's provider APIs + document
// sync to a real language server running in the main process. Kept isolated in
// lsp/ so it can be replaced by monaco-languageclient later without touching UI.

const SUPPORTED_LANGS = ['typescript', 'javascript', 'tsx', 'jsx']

function serverKeyFor(languageId: string): string | null {
  return SUPPORTED_LANGS.includes(languageId) ? 'typescript' : null
}

// Monaco language id -> LSP languageId that tsserver expects.
function lspLanguageId(monacoLang: string): string {
  if (monacoLang === 'tsx') return 'typescriptreact'
  if (monacoLang === 'jsx') return 'javascriptreact'
  return monacoLang
}

let root: string | null = null
let initialized = false
const started = new Map<string, Promise<unknown>>()
const versions = new Map<string, number>()

function ensureStarted(serverKey: string): Promise<unknown> {
  let p = started.get(serverKey)
  if (!p) {
    p = window.api.lsp.start(serverKey, root!)
    started.set(serverKey, p)
  }
  return p
}

// ---- position / type conversions ------------------------------------------

interface LspPos {
  line: number
  character: number
}
interface LspRange {
  start: LspPos
  end: LspPos
}

function toLspPos(p: monaco.Position): LspPos {
  return { line: p.lineNumber - 1, character: p.column - 1 }
}
function toMonacoRange(r: LspRange): monaco.IRange {
  return {
    startLineNumber: r.start.line + 1,
    startColumn: r.start.character + 1,
    endLineNumber: r.end.line + 1,
    endColumn: r.end.character + 1
  }
}

const COMPLETION_KIND: Record<number, monaco.languages.CompletionItemKind> = {
  1: monaco.languages.CompletionItemKind.Text,
  2: monaco.languages.CompletionItemKind.Method,
  3: monaco.languages.CompletionItemKind.Function,
  4: monaco.languages.CompletionItemKind.Constructor,
  5: monaco.languages.CompletionItemKind.Field,
  6: monaco.languages.CompletionItemKind.Variable,
  7: monaco.languages.CompletionItemKind.Class,
  8: monaco.languages.CompletionItemKind.Interface,
  9: monaco.languages.CompletionItemKind.Module,
  10: monaco.languages.CompletionItemKind.Property,
  11: monaco.languages.CompletionItemKind.Unit,
  12: monaco.languages.CompletionItemKind.Value,
  13: monaco.languages.CompletionItemKind.Enum,
  14: monaco.languages.CompletionItemKind.Keyword,
  15: monaco.languages.CompletionItemKind.Snippet,
  16: monaco.languages.CompletionItemKind.Color,
  17: monaco.languages.CompletionItemKind.File,
  18: monaco.languages.CompletionItemKind.Reference,
  19: monaco.languages.CompletionItemKind.Folder,
  20: monaco.languages.CompletionItemKind.EnumMember,
  21: monaco.languages.CompletionItemKind.Constant,
  22: monaco.languages.CompletionItemKind.Struct,
  23: monaco.languages.CompletionItemKind.Event,
  24: monaco.languages.CompletionItemKind.Operator,
  25: monaco.languages.CompletionItemKind.TypeParameter
}

const MARKER_SEVERITY: Record<number, monaco.MarkerSeverity> = {
  1: monaco.MarkerSeverity.Error,
  2: monaco.MarkerSeverity.Warning,
  3: monaco.MarkerSeverity.Info,
  4: monaco.MarkerSeverity.Hint
}

function markdownFromContents(contents: unknown): string {
  if (contents == null) return ''
  if (typeof contents === 'string') return contents
  if (Array.isArray(contents)) return contents.map(markdownFromContents).join('\n\n')
  const c = contents as { kind?: string; value?: string; language?: string }
  if (c.value != null) {
    if (c.language) return '```' + c.language + '\n' + c.value + '\n```'
    return c.value
  }
  return ''
}

// ---- document synchronization ---------------------------------------------

function isManaged(model: monaco.editor.ITextModel): boolean {
  return model.uri.scheme === 'file' && SUPPORTED_LANGS.includes(model.getLanguageId())
}

function didOpen(model: monaco.editor.ITextModel): void {
  const serverKey = serverKeyFor(model.getLanguageId())
  if (!serverKey) return
  const uri = model.uri.toString()
  versions.set(uri, 1)
  ensureStarted(serverKey).then(() => {
    window.api.lsp.notify(serverKey, 'textDocument/didOpen', {
      textDocument: {
        uri,
        languageId: lspLanguageId(model.getLanguageId()),
        version: 1,
        text: model.getValue()
      }
    })
  })
}

function didChange(model: monaco.editor.ITextModel): void {
  const serverKey = serverKeyFor(model.getLanguageId())
  if (!serverKey) return
  const uri = model.uri.toString()
  const version = (versions.get(uri) ?? 1) + 1
  versions.set(uri, version)
  window.api.lsp.notify(serverKey, 'textDocument/didChange', {
    textDocument: { uri, version },
    contentChanges: [{ text: model.getValue() }] // full-document sync
  })
}

function didClose(model: monaco.editor.ITextModel): void {
  const serverKey = serverKeyFor(model.getLanguageId())
  if (!serverKey) return
  const uri = model.uri.toString()
  versions.delete(uri)
  window.api.lsp.notify(serverKey, 'textDocument/didClose', { textDocument: { uri } })
}

// ---- provider registration -------------------------------------------------

function registerProviders(): void {
  monaco.languages.registerCompletionItemProvider(SUPPORTED_LANGS, {
    triggerCharacters: ['.', '"', "'", '/', '@', '<', ' '],
    async provideCompletionItems(model, position) {
      const serverKey = serverKeyFor(model.getLanguageId())
      if (!serverKey) return { suggestions: [] }
      await ensureStarted(serverKey)
      const res = (await window.api.lsp.request(serverKey, 'textDocument/completion', {
        textDocument: { uri: model.uri.toString() },
        position: toLspPos(position)
      })) as { items?: unknown[] } | unknown[] | null
      const items = (Array.isArray(res) ? res : res?.items) ?? []
      const word = model.getWordUntilPosition(position)
      const defaultRange = {
        startLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endLineNumber: position.lineNumber,
        endColumn: word.endColumn
      }
      const suggestions = (items as Array<Record<string, unknown>>).map((it) => {
        const textEdit = it.textEdit as { range?: LspRange; newText?: string } | undefined
        const isSnippet = it.insertTextFormat === 2
        return {
          label: it.label as string,
          kind: COMPLETION_KIND[(it.kind as number) ?? 1] ?? monaco.languages.CompletionItemKind.Text,
          insertText: (textEdit?.newText ?? (it.insertText as string) ?? (it.label as string)) as string,
          insertTextRules: isSnippet
            ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
            : undefined,
          range: textEdit?.range ? toMonacoRange(textEdit.range) : defaultRange,
          detail: it.detail as string | undefined,
          documentation: it.documentation
            ? { value: markdownFromContents(it.documentation) }
            : undefined,
          sortText: it.sortText as string | undefined,
          filterText: it.filterText as string | undefined
        } as monaco.languages.CompletionItem
      })
      return { suggestions }
    }
  })

  monaco.languages.registerHoverProvider(SUPPORTED_LANGS, {
    async provideHover(model, position) {
      const serverKey = serverKeyFor(model.getLanguageId())
      if (!serverKey) return null
      await ensureStarted(serverKey)
      const res = (await window.api.lsp.request(serverKey, 'textDocument/hover', {
        textDocument: { uri: model.uri.toString() },
        position: toLspPos(position)
      })) as { contents?: unknown; range?: LspRange } | null
      if (!res || !res.contents) return null
      const value = markdownFromContents(res.contents)
      if (!value) return null
      return {
        contents: [{ value }],
        range: res.range ? toMonacoRange(res.range) : undefined
      }
    }
  })

  monaco.languages.registerDefinitionProvider(SUPPORTED_LANGS, {
    async provideDefinition(model, position) {
      const serverKey = serverKeyFor(model.getLanguageId())
      if (!serverKey) return null
      await ensureStarted(serverKey)
      const res = (await window.api.lsp.request(serverKey, 'textDocument/definition', {
        textDocument: { uri: model.uri.toString() },
        position: toLspPos(position)
      })) as
        | { uri: string; range: LspRange }
        | Array<{ uri?: string; targetUri?: string; range?: LspRange; targetRange?: LspRange }>
        | null
      if (!res) return null
      const arr = Array.isArray(res) ? res : [res]
      return arr
        .map((loc) => {
          const uri = (loc.uri ?? loc.targetUri) as string | undefined
          const range = (loc.range ?? loc.targetRange) as LspRange | undefined
          if (!uri || !range) return null
          return { uri: monaco.Uri.parse(uri), range: toMonacoRange(range) }
        })
        .filter(Boolean) as monaco.languages.Definition
    }
  })

  monaco.languages.registerSignatureHelpProvider(SUPPORTED_LANGS, {
    signatureHelpTriggerCharacters: ['(', ','],
    async provideSignatureHelp(model, position) {
      const serverKey = serverKeyFor(model.getLanguageId())
      if (!serverKey) return null
      await ensureStarted(serverKey)
      const res = (await window.api.lsp.request(serverKey, 'textDocument/signatureHelp', {
        textDocument: { uri: model.uri.toString() },
        position: toLspPos(position)
      })) as {
        signatures?: Array<{ label: string; documentation?: unknown; parameters?: unknown[] }>
        activeSignature?: number
        activeParameter?: number
      } | null
      if (!res || !res.signatures || res.signatures.length === 0) return null
      return {
        value: {
          signatures: res.signatures.map((s) => ({
            label: s.label,
            documentation: s.documentation ? { value: markdownFromContents(s.documentation) } : undefined,
            parameters: (s.parameters ?? []).map((p) => {
              const param = p as { label: string | [number, number]; documentation?: unknown }
              return {
                label: param.label,
                documentation: param.documentation
                  ? { value: markdownFromContents(param.documentation) }
                  : undefined
              }
            })
          })),
          activeSignature: res.activeSignature ?? 0,
          activeParameter: res.activeParameter ?? 0
        },
        dispose: () => {}
      }
    }
  })
}

// ---- diagnostics -----------------------------------------------------------

function wireDiagnostics(): void {
  window.api.lsp.onNotify(({ method, params }) => {
    if (method !== 'textDocument/publishDiagnostics') return
    const p = params as {
      uri: string
      diagnostics: Array<{ range: LspRange; message: string; severity?: number; source?: string }>
    }
    const target = monaco.editor.getModels().find((m) => m.uri.toString() === p.uri)
    if (!target) return
    monaco.editor.setModelMarkers(
      target,
      'lsp',
      p.diagnostics.map((d) => ({
        message: d.message,
        severity: MARKER_SEVERITY[d.severity ?? 1] ?? monaco.MarkerSeverity.Error,
        source: d.source,
        ...toMonacoRange(d.range)
      }))
    )
  })
}

// ---- public entry ----------------------------------------------------------

// Dispose the model for a path (e.g. when a tab is closed) → triggers didClose.
export function closeDocument(path: string): void {
  const uri = monaco.Uri.parse(`file://${path}`)
  monaco.editor.getModel(uri)?.dispose()
}

export function ensureLspInitialized(workspaceRoot: string): void {
  root = workspaceRoot
  if (initialized) return
  initialized = true

  registerProviders()
  wireDiagnostics()

  monaco.editor.getModels().forEach((m) => {
    if (isManaged(m)) didOpen(m)
  })
  monaco.editor.onDidCreateModel((m) => {
    if (isManaged(m)) {
      didOpen(m)
      m.onDidChangeContent(() => {
        if (isManaged(m)) didChange(m)
      })
    }
  })
  monaco.editor.onWillDisposeModel((m) => {
    if (isManaged(m)) didClose(m)
  })
}
