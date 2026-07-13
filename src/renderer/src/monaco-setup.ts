// Wire Monaco's web workers through Vite so intellisense runs locally (no CDN).
import * as monaco from 'monaco-editor'
import { loader } from '@monaco-editor/react'
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker'
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker'
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker'
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker'

self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string): Worker {
    switch (label) {
      case 'json':
        return new jsonWorker()
      case 'css':
      case 'scss':
      case 'less':
        return new cssWorker()
      case 'html':
      case 'handlebars':
      case 'razor':
        return new htmlWorker()
      case 'typescript':
      case 'javascript':
        return new tsWorker()
      default:
        return new editorWorker()
    }
  }
}

// Turn off Monaco's built-in TS/JS language service for the features our LSP
// client owns, so we don't get duplicate completions/diagnostics. Colorization,
// bracket matching, formatting and rename stay on (they're a free bonus).
const offForLsp = {
  completionItems: false,
  hovers: false,
  definitions: false,
  signatureHelp: false,
  diagnostics: false
}
monaco.languages.typescript.typescriptDefaults.setModeConfiguration({
  ...monaco.languages.typescript.typescriptDefaults.modeConfiguration,
  ...offForLsp
})
monaco.languages.typescript.javascriptDefaults.setModeConfiguration({
  ...monaco.languages.typescript.javascriptDefaults.modeConfiguration,
  ...offForLsp
})

// Use the bundled monaco instead of fetching from a CDN.
loader.config({ monaco })
