import * as monaco from 'monaco-editor'
import { createHighlighter } from 'shiki'
import { shikiToMonaco } from '@shikijs/monaco'

// Monaco's built-in tokenizer doesn't understand JSX and mis-colors it. We swap
// in Shiki (the same TextMate grammars + themes VSCode uses) so .tsx/.jsx and
// everything else colorize exactly like VSCode.

const LANGS = [
  'typescript',
  'javascript',
  'tsx',
  'jsx',
  'json',
  'css',
  'scss',
  'less',
  'html',
  'markdown',
  'python',
  'rust',
  'go',
  'yaml',
  'sql',
  'toml'
]

// JSX/TSX aren't first-class Monaco languages — register them so we can attach
// the JSX-aware grammar and a sensible editing config.
const TS_LANG_CONFIG: monaco.languages.LanguageConfiguration = {
  comments: { lineComment: '//', blockComment: ['/*', '*/'] },
  brackets: [
    ['{', '}'],
    ['[', ']'],
    ['(', ')']
  ],
  autoClosingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '(', close: ')' },
    { open: '"', close: '"' },
    { open: "'", close: "'" },
    { open: '`', close: '`' }
  ],
  surroundingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '(', close: ')' },
    { open: '"', close: '"' },
    { open: "'", close: "'" },
    { open: '`', close: '`' },
    { open: '<', close: '>' }
  ]
}

function registerLang(id: string, extensions: string[]): void {
  if (!monaco.languages.getLanguages().some((l) => l.id === id)) {
    monaco.languages.register({ id, extensions })
    monaco.languages.setLanguageConfiguration(id, TS_LANG_CONFIG)
  }
}

const SHIKI_THEMES = ['vesper', 'night-owl', 'kanagawa-wave', 'houston', 'dark-plus']

let started = false
let shikiReady = false
let currentTheme = 'vesper'

// After Shiki takes over Monaco's theme registry, the built-in 'vs-dark' no
// longer exists — creating an editor with it throws. Editors ask this for the
// currently-valid theme name.
export function editorTheme(): string {
  return shikiReady ? currentTheme : 'vs-dark'
}

// Called by the theme system; applies immediately if Shiki is ready.
export function setShikiTheme(name: string): void {
  currentTheme = name
  if (shikiReady) monaco.editor.setTheme(name)
}

export async function initHighlighting(): Promise<void> {
  if (started) return
  started = true
  registerLang('tsx', ['.tsx'])
  registerLang('jsx', ['.jsx'])
  try {
    const highlighter = await createHighlighter({
      themes: SHIKI_THEMES,
      langs: LANGS
    })
    shikiToMonaco(highlighter, monaco)
    shikiReady = true
    monaco.editor.setTheme(currentTheme)
  } catch (e) {
    console.error('[shiki] highlighting init failed', e)
  }
}
