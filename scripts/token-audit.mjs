#!/usr/bin/env node
// npm run audit:tokens [-- --days 14 --min-calls 50 --dir ~/.claude/projects --json]
//
// Reads Claude Code's session transcripts and prints where the tokens went: per
// session (calls per turn, context size, cache reads) and per riven MCP tool
// (how often, how big in and out). Run it before and after a token change to
// see whether it did anything. Reads files only; starts no agent.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { auditTranscript, mergeTools } from './lib/tokenAudit.mjs'

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback
}

const days = Number(arg('days', '14'))
const minCalls = Number(arg('min-calls', '50'))
const dir = arg('dir', join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects'))
const asJson = process.argv.includes('--json')
const since = Date.now() - days * 86_400_000

const files = []
for (const project of readdirSync(dir)) {
  const pdir = join(dir, project)
  let entries
  try {
    entries = readdirSync(pdir)
  } catch {
    continue
  }
  for (const f of entries) {
    if (!f.endsWith('.jsonl')) continue
    const full = join(pdir, f)
    if (statSync(full).mtimeMs >= since) files.push({ project, id: f.replace(/\.jsonl$/, ''), full })
  }
}

const audits = files.map((f) => ({ ...f, a: auditTranscript(readFileSync(f.full, 'utf8').split('\n')) }))
const sessions = audits
  .filter((x) => x.a.apiCalls >= minCalls)
  .sort((x, y) => y.a.cacheRead - x.a.cacheRead)
const tools = mergeTools(audits.map((x) => x.a))
const totals = audits.reduce(
  (t, x) => ({
    calls: t.calls + x.a.apiCalls,
    cacheRead: t.cacheRead + x.a.cacheRead,
    cacheWrite: t.cacheWrite + x.a.cacheWrite,
    output: t.output + x.a.output,
    toolSearchForRiven: t.toolSearchForRiven + x.a.toolSearchForRiven
  }),
  { calls: 0, cacheRead: 0, cacheWrite: 0, output: 0, toolSearchForRiven: 0 }
)

if (asJson) {
  console.log(
    JSON.stringify(
      {
        days,
        files: files.length,
        totals,
        sessions: sessions.map((x) => ({ id: x.id, project: x.project, ...x.a, tools: undefined })),
        tools
      },
      null,
      2
    )
  )
  process.exit(0)
}

const k = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : String(n))

console.log(`\n${files.length} transcripts in the last ${days} days · ${k(totals.calls)} API calls`)
console.log(`cache read ${k(totals.cacheRead)} · cache write ${k(totals.cacheWrite)} · output ${k(totals.output)}`)
console.log(`ToolSearch loads for riven tools: ${totals.toolSearchForRiven}\n`)

console.log(`sessions with ≥${minCalls} calls, most cache-read first`)
console.table(
  sessions.slice(0, 15).map((x) => ({
    session: x.id.slice(0, 8),
    turns: x.a.userTurns,
    calls: x.a.apiCalls,
    'calls/turn': Math.round(x.a.callsPerTurn),
    'ctx p50': k(x.a.ctxP50),
    'ctx max': k(x.a.ctxMax),
    '>200K': `${Math.round(x.a.over200k * 100)}%`,
    'cache read': k(x.a.cacheRead),
    compacts: x.a.compactions
  }))
)

console.log('riven MCP tools (sizes in characters)')
console.table(
  tools.map((t) => ({
    tool: t.name,
    calls: t.calls,
    'in p50': t.inP50,
    'in p90': t.inP90,
    'out p50': t.outP50,
    'out p90': t.outP90,
    'out max': t.outMax
  }))
)
