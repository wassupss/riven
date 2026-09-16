import { promises as fsp } from 'fs'
import * as path from 'path'
import { claudeStateFile } from './mcpRepair'

// Which MCP servers a project actually has, so riven can let its agents use them.
//
// The CLI checks every tool call against a permission layer BEFORE it leaves
// for the server. riven starts its chat panes non-interactively (stream-json),
// which means there is nobody to answer a permission prompt: a call that isn't
// pre-allowed is simply refused, and the agent reports it has no such tool.
// riven was passing `--allowedTools …,mcp__riven`, so every OTHER server the
// user had added — the whole reason they added it — was dead on arrival in a
// riven pane while working fine in a terminal, where a human can approve it.
//
// A server ends up in one of two places, and both count:
//   - the CLI's own state (`claude mcp add`), under projects[cwd].mcpServers
//   - `.mcp.json` in the repo, which teams check in
//
// This is deliberately a NAME list. `mcp__devhub` allows that server's tools;
// enumerating individual tools would silently drop any tool the server adds
// later, which is the same failure in a slower form.

const NAME_RE = /^[A-Za-z0-9_-]+$/

// Pure: server names from the two config shapes, de-duplicated, in a stable
// order. Names that could not be a tool prefix are dropped rather than passed
// to a command line.
export function serverNames(
  claudeState: { projects?: Record<string, { mcpServers?: Record<string, unknown> }> } | null,
  projectPaths: string[],
  dotMcp: { mcpServers?: Record<string, unknown> } | null
): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const take = (names: string[]): void => {
    for (const n of names) {
      if (seen.has(n) || !NAME_RE.test(n)) continue
      seen.add(n)
      out.push(n)
    }
  }
  for (const p of projectPaths) take(Object.keys(claudeState?.projects?.[p]?.mcpServers ?? {}))
  take(Object.keys(dotMcp?.mcpServers ?? {}))
  return out
}

async function readJson(file: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'))
  } catch {
    return null
  }
}

export async function configuredMcpServers(cwd: string, configDir?: string): Promise<string[]> {
  const state = (await readJson(claudeStateFile(configDir))) as Parameters<typeof serverNames>[0]
  const dot = (await readJson(path.join(cwd, '.mcp.json'))) as Parameters<typeof serverNames>[2]
  const paths = [cwd]
  try {
    const real = await fsp.realpath(cwd)
    if (real !== cwd) paths.push(real)
  } catch {
    /* cwd gone — the spelling we were given is all there is */
  }
  return serverNames(state, paths, dot)
}

// The --allowedTools value for a pane: riven's own tools plus every server the
// project has configured, minus any the user switched off.
export function allowedToolsValue(base: string, rivenPrefix: string, servers: string[], disabled: string[] = []): string {
  const off = new Set(disabled)
  const external = servers.filter((s) => !off.has(s)).map((s) => `mcp__${s}`)
  return [base, rivenPrefix, ...external].filter(Boolean).join(',')
}
