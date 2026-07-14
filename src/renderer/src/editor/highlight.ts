import * as monaco from 'monaco-editor'
import { createHighlighterCore } from 'shiki/core'
import { createOnigurumaEngine } from 'shiki/engine/oniguruma'
import { shikiToMonaco } from '@shikijs/monaco'

// Monaco's built-in tokenizer doesn't understand JSX and mis-colors it. We swap
// in Shiki (the same TextMate grammars + themes VSCode uses) so .tsx/.jsx and
// everything else colorize exactly like VSCode.

// Fine-grained Shiki: only the grammars/themes we actually use are imported, so
// the bundler emits just these chunks instead of the whole ~200-language
// registry. import() specifiers must be string literals (a template literal
// would glob every language back in).
const SHIKI_LANGS = [
  import('@shikijs/langs/typescript'),
  import('@shikijs/langs/javascript'),
  import('@shikijs/langs/tsx'),
  import('@shikijs/langs/jsx'),
  import('@shikijs/langs/json'),
  import('@shikijs/langs/css'),
  import('@shikijs/langs/scss'),
  import('@shikijs/langs/less'),
  import('@shikijs/langs/html'),
  import('@shikijs/langs/markdown'),
  import('@shikijs/langs/python'),
  import('@shikijs/langs/rust'),
  import('@shikijs/langs/go'),
  import('@shikijs/langs/yaml'),
  import('@shikijs/langs/sql'),
  import('@shikijs/langs/toml'),
  import('@shikijs/langs/java'),
  import('@shikijs/langs/cpp'),
  import('@shikijs/langs/csharp'),
  import('@shikijs/langs/ruby'),
  import('@shikijs/langs/php'),
  import('@shikijs/langs/swift'),
  import('@shikijs/langs/kotlin'),
  import('@shikijs/langs/shellscript'),
  import('@shikijs/langs/ini'),
  import('@shikijs/langs/xml'),
  import('@shikijs/langs/vue'),
  import('@shikijs/langs/svelte'),
  import('@shikijs/langs/graphql'),
  import('@shikijs/langs/docker'),
  import('@shikijs/langs/make')
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

// Dark themes plus the light themes the light app-themes map to. Shiki theme
// JSON is lazy-loaded per theme, so adding light entries costs nothing until
// a light app-theme is activated.
const SHIKI_THEMES = [
  import('@shikijs/themes/vesper'),
  import('@shikijs/themes/night-owl'),
  import('@shikijs/themes/kanagawa-wave'),
  import('@shikijs/themes/houston'),
  import('@shikijs/themes/dark-plus'),
  import('@shikijs/themes/github-light'),
  import('@shikijs/themes/solarized-light')
]

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
  // Languages Monaco has no built-in for — register so Shiki's grammar attaches.
  // (dockerfile/shell/cpp/ini/xml/graphql/csharp/ruby/php/swift/kotlin are
  // Monaco built-ins already; Shiki matches them via id/alias.)
  registerLang('toml', ['.toml'])
  registerLang('vue', ['.vue'])
  registerLang('svelte', ['.svelte'])
  registerLang('make', [])
  try {
    const highlighter = await createHighlighterCore({
      engine: createOnigurumaEngine(import('shiki/wasm')),
      themes: SHIKI_THEMES,
      langs: SHIKI_LANGS
    })
    shikiToMonaco(highlighter, monaco)
    shikiReady = true
    monaco.editor.setTheme(currentTheme)
  } catch (e) {
    console.error('[shiki] highlighting init failed', e)
  }
}
