import type { ComponentType } from 'react'

// The editor is intentionally hidden behind this interface. Today it's Monaco;
// swapping in a full LSP-backed editor (or anything else) later means providing
// a new component with this same contract — App never changes.
export interface OpenFile {
  path: string
  content: string
  // Bumped by the host when the on-disk content must overwrite the live buffer
  // (e.g. an agent edited the file). Switching tabs keeps the same revision so
  // in-editor edits are preserved.
  revision?: number
}

export interface AgentEditView {
  before: string
  after: string
}

export interface EditorPaneProps {
  file: OpenFile | null
  onSave: (path: string, content: string) => void
  onDirtyChange?: (dirty: boolean) => void
  // Agent edit under review (before/after): drives per-hunk highlight + revert.
  agentEdit?: AgentEditView | null
  // Called with the new full content when the user reverts one hunk.
  onAgentRevert?: (newAfter: string) => void
  // Dismiss the whole agent-edit review (accept everything as-is).
  onDismiss?: () => void
}

export type EditorPaneComponent = ComponentType<EditorPaneProps>

const EXT_TO_LANG: Record<string, string> = {
  ts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  jsx: 'jsx',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'html',
  md: 'markdown',
  py: 'python',
  rs: 'rust',
  go: 'go',
  java: 'java',
  c: 'cpp',
  cpp: 'cpp',
  h: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  rb: 'ruby',
  php: 'php',
  swift: 'swift',
  kt: 'kotlin',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  fish: 'shell',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  ini: 'ini',
  conf: 'ini',
  cfg: 'ini',
  properties: 'ini',
  env: 'ini',
  xml: 'xml',
  svg: 'xml',
  vue: 'vue',
  svelte: 'svelte',
  graphql: 'graphql',
  gql: 'graphql',
  dockerfile: 'dockerfile',
  sql: 'sql'
}

// Files identified by name rather than extension (Dockerfile, .env, …).
// Values are Monaco language ids (must match a registered language).
const NAME_TO_LANG: Array<[RegExp, string]> = [
  [/^dockerfile$/, 'dockerfile'],
  [/^dockerfile\./, 'dockerfile'],
  [/\.dockerfile$/, 'dockerfile'],
  [/^\.env($|\.)/, 'ini'], // .env, .env.local, .env.production…
  [/^\.?(bash|zsh)rc$/, 'shell'],
  [/^\.?(bash_profile|profile|zprofile|zshenv)$/, 'shell'],
  [/^makefile$/, 'make'],
  [/^(gemfile|rakefile)$/, 'ruby']
]

export function languageForPath(path: string): string {
  const base = (path.split('/').pop() ?? '').toLowerCase()
  for (const [re, lang] of NAME_TO_LANG) {
    if (re.test(base)) return lang
  }
  const ext = base.includes('.') ? base.split('.').pop()! : ''
  return EXT_TO_LANG[ext] ?? 'plaintext'
}
