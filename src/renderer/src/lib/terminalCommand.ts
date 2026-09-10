// Whether an agent may run a command in a new terminal without asking first.
//
// riven_open_panel(kind:'terminal', command) hands the string to a login shell,
// so it is arbitrary code execution with the user's privileges — started by a
// model, on a machine with their SSH keys and repositories on it. The feature is
// worth having (an agent opening a second CLI beside itself is the point), but
// "run anything, silently" is not the same request.
//
// So: launching a known agent CLI is allowed outright, and everything else asks
// the user. That keeps the intended use frictionless and puts a human in front
// of the rest.

// Bare launchers only. Not a list of "trusted programs" — a list of things whose
// whole purpose is to start an interactive assistant in a terminal.
const AGENT_LAUNCHERS = new Set(['claude', 'codex', 'gemini', 'aider', 'cursor-agent', 'opencode'])

// Shell syntax that turns one command into several, or redirects it. An
// allowlisted launcher is only allowed if the command is JUST that launcher and
// its flags: `claude; rm -rf ~` must not ride in on `claude`.
const SHELL_METACHARACTERS = /[;&|<>`$(){}\n\r]/

export type CommandVerdict =
  | { allow: true; reason: 'agent-launcher' }
  | { allow: false; reason: 'not-an-agent-launcher' | 'shell-syntax' }

export function classifyTerminalCommand(command: string): CommandVerdict {
  const trimmed = command.trim()
  if (SHELL_METACHARACTERS.test(trimmed)) return { allow: false, reason: 'shell-syntax' }
  // The first word, minus any path: `/usr/local/bin/claude` is still claude, and
  // an env-var prefix (`FOO=1 claude`) is not a launcher invocation we recognise.
  const first = trimmed.split(/\s+/)[0] ?? ''
  const base = first.slice(first.lastIndexOf('/') + 1)
  if (AGENT_LAUNCHERS.has(base)) return { allow: true, reason: 'agent-launcher' }
  return { allow: false, reason: 'not-an-agent-launcher' }
}

export const KNOWN_AGENT_LAUNCHERS = [...AGENT_LAUNCHERS]
