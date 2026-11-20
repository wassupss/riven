import * as monaco from 'monaco-editor'
import type { HighlighterCore, LanguageInput, ThemeInput } from 'shiki/core'
import { onShikiTheme } from '../state/themes'

// Monaco's built-in tokenizer doesn't understand JSX and mis-colors it. We swap
// in Shiki (the same TextMate grammars + themes VSCode uses) so .tsx/.jsx and
// everything else colorize exactly like VSCode.
//
// All of it is lazy. Shiki starts when the first editor asks for a theme
// (editorTheme), not at boot: building the highlighter with every grammar up
// front left ~130MB of startup garbage that JSC kept while the app sat idle.
// Grammars then load one language at a time, the first time Monaco tokenizes a
// model in that language.

// Fine-grained Shiki: only the grammars/themes we actually use are imported, so
// the bundler emits just these chunks instead of the whole ~200-language
// registry. import() specifiers must be string literals (a template literal
// would glob every language back in), and each sits behind a thunk so nothing
// is fetched until that language is needed.
const SHIKI_LANGS = {
  typescript: () => import('@shikijs/langs/typescript'),
  javascript: () => import('@shikijs/langs/javascript'),
  tsx: () => import('@shikijs/langs/tsx'),
  jsx: () => import('@shikijs/langs/jsx'),
  json: () => import('@shikijs/langs/json'),
  css: () => import('@shikijs/langs/css'),
  scss: () => import('@shikijs/langs/scss'),
  less: () => import('@shikijs/langs/less'),
  html: () => import('@shikijs/langs/html'),
  markdown: () => import('@shikijs/langs/markdown'),
  python: () => import('@shikijs/langs/python'),
  rust: () => import('@shikijs/langs/rust'),
  go: () => import('@shikijs/langs/go'),
  yaml: () => import('@shikijs/langs/yaml'),
  sql: () => import('@shikijs/langs/sql'),
  toml: () => import('@shikijs/langs/toml'),
  java: () => import('@shikijs/langs/java'),
  cpp: () => import('@shikijs/langs/cpp'),
  csharp: () => import('@shikijs/langs/csharp'),
  ruby: () => import('@shikijs/langs/ruby'),
  php: () => import('@shikijs/langs/php'),
  swift: () => import('@shikijs/langs/swift'),
  kotlin: () => import('@shikijs/langs/kotlin'),
  shellscript: () => import('@shikijs/langs/shellscript'),
  ini: () => import('@shikijs/langs/ini'),
  xml: () => import('@shikijs/langs/xml'),
  vue: () => import('@shikijs/langs/vue'),
  svelte: () => import('@shikijs/langs/svelte'),
  graphql: () => import('@shikijs/langs/graphql'),
  docker: () => import('@shikijs/langs/docker'),
  make: () => import('@shikijs/langs/make')
} satisfies Record<string, LanguageInput>
type Grammar = keyof typeof SHIKI_LANGS

// Monaco language id -> the grammar above that brings it. This is exactly the
// set Shiki used to take over when every grammar loaded at boot: each Monaco id
// that matched a loaded grammar's name or alias, embedded ones included (c
// comes with cpp, lua with ruby).
const GRAMMAR_FOR: Record<string, Grammar> = {
  c: 'cpp',
  cpp: 'cpp',
  csharp: 'csharp',
  css: 'css',
  dockerfile: 'docker',
  go: 'go',
  graphql: 'graphql',
  html: 'html',
  ini: 'ini',
  java: 'java',
  javascript: 'javascript',
  json: 'json',
  jsx: 'jsx',
  kotlin: 'kotlin',
  less: 'less',
  lua: 'ruby',
  make: 'make',
  markdown: 'markdown',
  php: 'php',
  python: 'python',
  ruby: 'ruby',
  rust: 'rust',
  scss: 'scss',
  shell: 'shellscript',
  sql: 'sql',
  svelte: 'svelte',
  swift: 'swift',
  toml: 'toml',
  tsx: 'tsx',
  typescript: 'typescript',
  vue: 'vue',
  xml: 'xml',
  yaml: 'yaml'
}

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
const SHIKI_THEMES: ThemeInput[] = [
  () => import('@shikijs/themes/vesper'),
  () => import('@shikijs/themes/night-owl'),
  () => import('@shikijs/themes/kanagawa-wave'),
  () => import('@shikijs/themes/houston'),
  () => import('@shikijs/themes/dark-plus'),
  () => import('@shikijs/themes/github-light'),
  () => import('@shikijs/themes/solarized-light')
]

// JSX/TSX and the languages Monaco has no built-in for are registered as soon
// as this module loads (cheap, Monaco only), so a model created before Shiki is
// up still gets the right language id and is colorized once its grammar lands.
// (dockerfile/shell/cpp/ini/xml/graphql/csharp/ruby/php/swift/kotlin are
// Monaco built-ins already; Shiki matches them via id/alias.)
registerLang('tsx', ['.tsx'])
registerLang('jsx', ['.jsx'])
registerLang('toml', ['.toml'])
registerLang('vue', ['.vue'])
registerLang('svelte', ['.svelte'])
registerLang('make', [])

let started: Promise<void> | null = null
let shikiReady = false
let currentTheme = 'vesper'

// After Shiki takes over Monaco's theme registry, the built-in 'vs-dark' no
// longer exists — creating an editor with it throws. Editors ask this for the
// currently-valid theme name. Every editor asks before it is created, so this
// is also what starts Shiki: an app that never opens an editor never pays for it.
export function editorTheme(): string {
  void initHighlighting()
  return shikiReady ? currentTheme : 'vs-dark'
}

// Called by the theme system; applies immediately if Shiki is ready.
export function setShikiTheme(name: string): void {
  currentTheme = name
  if (shikiReady) monaco.editor.setTheme(name)
}
// The theme system calls in through this hook rather than importing this module
// (see onShikiTheme), so windows without an editor never load Monaco.
onShikiTheme(setShikiTheme)

// Starts Shiki once (later calls get the same promise). Colors swap in on every
// open editor when it resolves; until then they show Monaco's plain vs-dark.
export function initHighlighting(): Promise<void> {
  started ??= start()
  return started
}

async function start(): Promise<void> {
  try {
    const [{ createHighlighterCore }, { createOnigurumaEngine }, { shikiToMonaco }] = await Promise.all([
      import('shiki/core'),
      import('shiki/engine/oniguruma'),
      import('@shikijs/monaco')
    ])
    const highlighter = await createHighlighterCore({
      engine: createOnigurumaEngine(import('shiki/wasm')),
      themes: SHIKI_THEMES,
      langs: []
    })
    attach(highlighter, shikiToMonaco)
    shikiReady = true
    monaco.editor.setTheme(currentTheme)
  } catch (e) {
    console.error('[shiki] highlighting init failed', e)
  }
}

// A grammar that colors nothing, standing in until the real one has loaded.
const PLAIN = {
  tokenizeLine2: (_line: string, ruleStack: unknown) => ({
    tokens: new Uint32Array([0, 0]),
    ruleStack,
    stoppedEarly: false
  })
}

// shikiToMonaco gives a tokens provider to every Monaco language the
// highlighter reports as loaded, and each provider looks its grammar up on
// every line. So it is handed a view that reports every language we have a
// grammar for, and answers a lookup for one not loaded yet with PLAIN while
// that grammar loads. When it lands, the language's provider is registered
// again, which makes Monaco re-tokenize that language's models with it.
function attach(
  highlighter: HighlighterCore,
  shikiToMonaco: (h: HighlighterCore, m: typeof monaco) => void
): void {
  const loaded = new Set<string>()
  const waiting = new Set<string>()
  const loading = new Map<Grammar, Promise<void>>()
  const providers = new Map<string, Parameters<typeof setTokensProvider>[1]>()
  const setTokensProvider = monaco.languages.setTokensProvider

  const load = (id: string): void => {
    const grammar = GRAMMAR_FOR[id]
    waiting.add(id)
    if (!grammar || loading.has(grammar)) return
    loading.set(
      grammar,
      highlighter
        .loadLanguage(SHIKI_LANGS[grammar])
        .then(() => {
          for (const l of highlighter.getLoadedLanguages()) loaded.add(l)
          for (const w of [...waiting]) {
            const p = providers.get(w)
            if (!loaded.has(w) || !p) continue
            waiting.delete(w)
            setTokensProvider(w, p)
          }
        })
        .catch((e) => console.error(`[shiki] grammar ${grammar} failed to load`, e))
    )
  }

  const view = new Proxy(highlighter, {
    get(target, prop, receiver) {
      if (prop === 'getLoadedLanguages') return () => Object.keys(GRAMMAR_FOR)
      if (prop === 'getLanguage')
        return (id: string) => {
          if (loaded.has(id)) return target.getLanguage(id)
          if (!waiting.has(id)) load(id)
          return PLAIN
        }
      return Reflect.get(target, prop, receiver)
    }
  })

  // Keep each provider shikiToMonaco registers, to register it again later.
  monaco.languages.setTokensProvider = (id, p) => {
    providers.set(id, p)
    return setTokensProvider(id, p)
  }
  try {
    shikiToMonaco(view, monaco)
  } finally {
    monaco.languages.setTokensProvider = setTokensProvider
  }
}
