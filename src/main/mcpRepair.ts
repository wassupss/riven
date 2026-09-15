import { promises as fsp } from 'fs'
import * as os from 'os'
import * as path from 'path'

// Repair MCP servers that were registered as their own `claude mcp add` line.
//
// Server setup pages hand out a ready-made `claude mcp add --transport http …`
// line. Pasted into a box that wraps non-URLs as a stdio command (riven's "Add
// MCP server" card did exactly that until it was fixed), it becomes
//
//   claude mcp add <name> -- claude mcp add --transport http <name> <url> --header …
//
// which stores {"type":"stdio","command":"claude","args":["mcp","add",…]}: a
// "server" whose command is the add line. It can never speak MCP, so its tools
// silently never load. Fixing the card stops new ones; this fixes the ones that
// already exist — including those an older riven wrote.
//
// It is safe to do unasked because it is unambiguous: an entry whose command is
// `claude mcp add` has exactly one possible meaning, and running those same
// arguments is what the user was trying to do in the first place.

export interface BrokenServer {
  name: string
  // The add invocation to replay, starting with 'mcp', 'add'. Passed to the CLI
  // as argv — never through a shell — so nothing in it is interpreted.
  args: string[]
}

type Servers = Record<string, { type?: string; command?: string; args?: unknown }>

function isPastedAdd(entry: Servers[string]): entry is { command: string; args: string[] } {
  if (!entry || typeof entry.command !== 'string' || !Array.isArray(entry.args)) return false
  const bin = entry.command.slice(entry.command.lastIndexOf('/') + 1)
  return (
    bin === 'claude' &&
    entry.args.length >= 2 &&
    entry.args[0] === 'mcp' &&
    entry.args[1] === 'add' &&
    entry.args.every((a) => typeof a === 'string')
  )
}

// Pure: which of this project's servers are broken add lines. The CLI keys a
// project by its path, which can be the symlink-resolved form (/tmp → /private/tmp),
// so both spellings are checked.
export function findPastedAddServers(
  config: { projects?: Record<string, { mcpServers?: Servers }> },
  projectPaths: string[]
): BrokenServer[] {
  const out: BrokenServer[] = []
  const seen = new Set<string>()
  for (const p of projectPaths) {
    const servers = config.projects?.[p]?.mcpServers ?? {}
    for (const [name, entry] of Object.entries(servers)) {
      if (seen.has(name) || !isPastedAdd(entry)) continue
      seen.add(name)
      out.push({ name, args: entry.args })
    }
  }
  return out
}

// Where the CLI keeps its state for this pane. With CLAUDE_CONFIG_DIR it is
// <dir>/.claude.json; without it, ~/.claude.json at the home ROOT — not
// ~/.claude/.claude.json.
//
// "No profile" is not the same as "no CLAUDE_CONFIG_DIR": every spawn here copies
// process.env and only ever SETS the variable, so a riven started from a shell
// that already exports it runs the CLI against that directory. Reading
// ~/.claude.json while the CLI we spawn reads somewhere else is how a repair
// looked at one file and then asked the CLI to remove a server it could not see.
// The file we read must be the file the CLI we run will read.
export function claudeStateFile(configDir?: string): string {
  const dir = configDir || process.env.CLAUDE_CONFIG_DIR
  return dir ? path.join(dir, '.claude.json') : path.join(os.homedir(), '.claude.json')
}

export type McpRunner = (args: string[]) => Promise<{ ok: boolean; output: string }>

export interface RepairResult {
  name: string
  ok: boolean
  output: string
}

export async function repairPastedAddServers(
  cwd: string,
  configDir: string | undefined,
  run: McpRunner
): Promise<RepairResult[]> {
  let config: Parameters<typeof findPastedAddServers>[0]
  try {
    config = JSON.parse(await fsp.readFile(claudeStateFile(configDir), 'utf8'))
  } catch {
    return []
  }
  const paths = [cwd]
  try {
    const real = await fsp.realpath(cwd)
    if (real !== cwd) paths.push(real)
  } catch {
    /* cwd gone — the cwd spelling is all there is */
  }
  const broken = findPastedAddServers(config, paths)
  const results: RepairResult[] = []
  for (const b of broken) {
    // The broken entry lives in local scope, which is where `claude mcp add`
    // puts things by default — so remove it there and replay the add as written.
    const removed = await run(['mcp', 'remove', b.name, '-s', 'local'])
    if (!removed.ok) {
      results.push({ name: b.name, ok: false, output: removed.output })
      continue
    }
    const added = await run(b.args)
    results.push({ name: b.name, ok: added.ok, output: added.output })
  }
  return results
}
