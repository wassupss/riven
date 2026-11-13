// src/main/pty.ts in the Tauri build. Terminals live in Rust now
// (src-tauri/src/services/pty: the PTYs, the libghostty-vt model, flow
// control, agent activity), and the terminal worker is gone from this build.
//
// What stays here is what still needs Node's MCP server and hook route, until
// those move too (docs/tauri-rust-main.md, stage 4):
//   - the shell environment that gives a typed `claude`/`codex` riven's tools
//     and hooks (the zsh shim dir, RIVEN_* variables). Rust asks for it on
//     every new terminal ('ptyEnv' on the control line) and spawns the shell.
//   - agent hooks: the loopback route receives them, Rust owns the session
//     they update ('pty.hook').
//   - how many terminal agents are working, for the quit confirmation (Rust
//     reports it as 'ptyAgents').
//   - pty:codexSessionTitle (reads Codex's rollouts, unrelated to the pty).
import { app, ipcMain } from 'electron'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  mcpConfigJson,
  mcpPaneUrl,
  mcpSystemPrompt,
  mcpAuthToken,
  mcpRequestTimeoutMs,
  implementedToolNames,
  agentMcpEnv,
  mcpReady
} from '../../../src/main/mcpServer'
import { codexConfigOverrides } from '../../../src/main/agents'
import { readCodexSessionTitle } from '../../../src/main/codexSessions'
import { resolveBin } from '../../../src/main/shellPath'
import { hookCommand, hookEnv, registerAgentHooks } from '../../../src/main/agentHooks'
import { call, fire, onEvent } from '../rust'

function defaultShell(): string {
  return process.env.SHELL || '/bin/zsh'
}

// A zsh startup dir riven owns, sourced INSTEAD of the user's (it sources
// theirs first). Its .zshrc defines `claude`/`codex` functions that inject
// riven's MCP server and agent hooks. Same files as src/main/pty.ts.
function shimDir(): string {
  return path.join(app.getPath('userData'), 'zdotdir')
}

let shimReady = false

function sq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

// 0700: everything here is SOURCED BY THE SHELL.
export function setupShellShim(): void {
  const dir = shimDir()
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    fs.chmodSync(dir, 0o700)
    const files: Record<string, string> = {
      '.zshenv': `ZDOTDIR="$HOME"
[ -r "$HOME/.zshenv" ] && source "$HOME/.zshenv"
export RIVEN_USER_ZDOTDIR="\${ZDOTDIR:-$HOME}"
ZDOTDIR=${sq(dir)}`,
      '.zprofile':
        '[ -r "$RIVEN_USER_ZDOTDIR/.zprofile" ] && source "$RIVEN_USER_ZDOTDIR/.zprofile"',
      '.zshrc': `[ -r "$RIVEN_USER_ZDOTDIR/.zshrc" ] && source "$RIVEN_USER_ZDOTDIR/.zshrc"
# riven: typing \`claude\` here gets riven's OWN tools (ask_user / open file /
# panels / browser / notes) and its lifecycle hooks, like the native chat pane.
if [ -n "$RIVEN_MCP_CONFIG" ]; then
  claude() {
    # Build flags in a zsh array, NOT via \${VAR:+--flag "$VAR"}: zsh does not
    # field-split parameter expansions, so that form passes '--flag value' to
    # claude as a single argv word and it rejects it.
    local -a rv
    rv+=(--mcp-config "$RIVEN_MCP_CONFIG")
    [ -n "$RIVEN_MCP_PROMPT" ] && rv+=(--append-system-prompt "$RIVEN_MCP_PROMPT")
    # Lifecycle hooks (deep-merged by the CLI, so the user's own hooks still fire).
    [ -n "$RIVEN_HOOKS_SETTINGS" ] && rv+=(--settings "$RIVEN_HOOKS_SETTINGS")
    command "\${RIVEN_REAL_CLAUDE:-claude}" "\${rv[@]}" "$@"
  }
fi
# The same for Codex: riven's MCP server and its hooks, as \`-c\` overrides (one
# per line of RIVEN_CODEX_ARGS), so the user's ~/.codex is never written to.
if [ -n "$RIVEN_CODEX_ARGS" ]; then
  codex() {
    local -a rv
    local line
    for line in "\${(@f)RIVEN_CODEX_ARGS}"; do rv+=(-c "$line"); done
    command "\${RIVEN_REAL_CODEX:-codex}" "\${rv[@]}" "$@"
  }
fi
# Restore so .zlogin and any nested shell use the user's own dir, not ours.
export ZDOTDIR="$RIVEN_USER_ZDOTDIR"`
    }
    for (const [name, body] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, name), body + '\n', { mode: 0o600 })
    }
    shimReady = true
  } catch (e) {
    console.error('[riven] shell shim setup failed', e)
    shimReady = false
  }
}

let realClaude: string | null = null
let realCodex: string | null = null
export function primeShellShim(): void {
  setupShellShim()
  void resolveBin('claude').then((p) => {
    realClaude = p
  })
  void resolveBin('codex').then((p) => {
    realCodex = p
  })
}

function userHasCodexInstructions(): boolean {
  const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')
  try {
    return /^\s*developer_instructions\s*=/m.test(fs.readFileSync(path.join(home, 'config.toml'), 'utf8'))
  } catch {
    return false
  }
}

function codexArgs(key: string): string {
  const url = mcpPaneUrl(implementedToolNames(), key)
  return codexConfigOverrides({
    mcpUrl: url,
    hookCommand: (event) => hookCommand(event, 'codex'),
    instructions: url && !userHasCodexInstructions() ? mcpSystemPrompt() : null,
    toolTimeoutSec: Math.round(mcpRequestTimeoutMs() / 1000)
  }).join('\n')
}

// riven's part of a terminal's environment. Rust adds the rest (its own env
// with the login-shell PATH, TERM, CLAUDE_CONFIG_DIR, a UTF-8 locale).
async function rivenEnv(key: string): Promise<Record<string, string>> {
  // The hook env is built from the loopback server's base url, only known
  // once it listens. A terminal restored at startup can get here first.
  await mcpReady()
  const env: Record<string, string> = {}
  const mcpConfig =
    shimReady && /zsh$/.test(defaultShell()) ? mcpConfigJson(implementedToolNames(), key) : null
  if (mcpConfig) {
    env.ZDOTDIR = shimDir()
    env.RIVEN_MCP_CONFIG = mcpConfig
    env.RIVEN_MCP_PROMPT = mcpSystemPrompt()
    if (realClaude) env.RIVEN_REAL_CLAUDE = realClaude
    env.RIVEN_CODEX_ARGS = codexArgs(key)
    env.RIVEN_MCP_TOKEN = mcpAuthToken()
    if (realCodex) env.RIVEN_REAL_CODEX = realCodex
  }
  Object.assign(env, hookEnv(key), agentMcpEnv())
  return env
}

let workingAgents = 0

// Terminals whose CLI agent is working right now (Rust keeps the count).
export function runningTerminalAgentCount(): number {
  return workingAgents
}

export function registerPtyHandlers(): void {
  onEvent((m) => {
    if (m.ev === 'ptyAgents') {
      workingAgents = typeof m.n === 'number' ? m.n : 0
    } else if (m.ev === 'ptyEnv') {
      const id = m.id
      rivenEnv(String(m.key ?? ''))
        .catch((e) => {
          console.error('[riven] terminal env failed', e)
          return {}
        })
        .then((env) => call('pty.env', { id, env }))
        .catch(() => {})
    }
  })

  // Agent hooks arrive on the loopback server tagged with the pane they ran in.
  registerAgentHooks((e) => fire('pty.hook', { ...e }))

  ipcMain.handle('pty:codexSessionTitle', (_e, id: string) =>
    typeof id === 'string' ? readCodexSessionTitle(id) : null
  )
}
