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
  c: 'c',
  cpp: 'cpp',
  h: 'cpp',
  sh: 'shell',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'ini',
  sql: 'sql'
}

export function languageForPath(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  return EXT_TO_LANG[ext] ?? 'plaintext'
}
