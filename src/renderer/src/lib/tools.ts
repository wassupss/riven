// The built-in tools a Claude Code pane pre-approves.
//
// The same list main passes as `--allowedTools` (see main/agentChat's
// DEFAULT_ALLOWED). Kept here as well, rather than imported across the process
// boundary, because the settings screen has to offer exactly the names the CLI
// accepts — and a renderer cannot import from main.
export const BUILTIN_TOOLS = [
  'Task',
  'Read',
  'Grep',
  'Glob',
  'LS',
  'Edit',
  'Write',
  'MultiEdit',
  'NotebookEdit',
  'Bash',
  'BashOutput',
  'WebFetch',
  'WebSearch',
  'TodoWrite'
] as const
