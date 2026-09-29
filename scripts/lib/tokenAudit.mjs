// Where the tokens went, from Claude Code's own session transcripts.
//
// Pure: takes the lines of one .jsonl transcript and returns numbers, so the
// token work (autocompact, MCP diet, result caps) can be measured before and
// after from the same logs rather than argued about. Reads nothing, spends
// nothing — see scripts/token-audit.mjs for the command that walks the files.

const RIVEN_PREFIX = 'mcp__riven__'

/** Percentile of a sorted-or-not numeric array (nearest rank). 0 when empty. */
export function pct(values, p) {
  if (!values.length) return 0
  const s = [...values].sort((a, b) => a - b)
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))
  return s[i]
}

function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((b) => (typeof b?.text === 'string' ? b.text : '')).join('')
}

/**
 * One transcript → its calls, turns and riven tool traffic.
 *
 * An API call is counted once per message id: the transcript writes one entry
 * per content block, all carrying the same usage, so counting entries would
 * multiply every call by its block count.
 */
export function auditTranscript(lines) {
  const calls = new Map() // message id → context tokens for that call
  let cacheRead = 0
  let cacheWrite = 0
  let output = 0
  let userTurns = 0
  let compactions = 0
  const toolName = new Map() // tool_use id → name
  const tools = new Map() // name → { calls, inSizes[], outSizes[] }
  let toolSearchForRiven = 0

  const bucket = (name) => {
    let b = tools.get(name)
    if (!b) tools.set(name, (b = { calls: 0, inSizes: [], outSizes: [] }))
    return b
  }

  for (const line of lines) {
    if (!line || !line.trim()) continue
    let e
    try {
      e = JSON.parse(line)
    } catch {
      continue
    }
    if (e.isSidechain) continue // a subagent's own calls are its own session
    if (e.type === 'system' && e.subtype === 'compact_boundary') compactions++
    const m = e.message && typeof e.message === 'object' ? e.message : null
    if (!m) continue

    if (e.type === 'assistant') {
      const u = m.usage
      if (u && m.id && !calls.has(m.id)) {
        const ctx = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0)
        calls.set(m.id, ctx)
        cacheRead += u.cache_read_input_tokens ?? 0
        cacheWrite += u.cache_creation_input_tokens ?? 0
        output += u.output_tokens ?? 0
      }
      if (Array.isArray(m.content)) {
        for (const b of m.content) {
          if (b?.type !== 'tool_use') continue
          toolName.set(b.id, b.name)
          const size = JSON.stringify(b.input ?? {}).length
          if (typeof b.name === 'string' && b.name.startsWith(RIVEN_PREFIX)) {
            const t = bucket(b.name.slice(RIVEN_PREFIX.length))
            t.calls++
            t.inSizes.push(size)
          }
          if (b.name === 'ToolSearch' && /riven/i.test(JSON.stringify(b.input ?? {}))) toolSearchForRiven++
        }
      }
    } else if (e.type === 'user') {
      const c = m.content
      const results = Array.isArray(c) ? c.filter((b) => b?.type === 'tool_result') : []
      for (const r of results) {
        const name = toolName.get(r.tool_use_id)
        if (typeof name === 'string' && name.startsWith(RIVEN_PREFIX)) {
          bucket(name.slice(RIVEN_PREFIX.length)).outSizes.push(textOf(r.content).length)
        }
      }
      // A person's message: text, not a tool result, not an injected meta note.
      if (!results.length && !e.isMeta && textOf(c).trim()) userTurns++
    }
  }

  const ctx = [...calls.values()]
  return {
    apiCalls: ctx.length,
    userTurns,
    callsPerTurn: userTurns ? ctx.length / userTurns : 0,
    ctxP50: pct(ctx, 50),
    ctxMax: ctx.length ? Math.max(...ctx) : 0,
    over200k: ctx.length ? ctx.filter((n) => n > 200_000).length / ctx.length : 0,
    cacheRead,
    cacheWrite,
    output,
    compactions,
    toolSearchForRiven,
    tools
  }
}

/** Many transcripts' riven tool traffic, folded into one table. */
export function mergeTools(audits) {
  const out = new Map()
  for (const a of audits) {
    for (const [name, t] of a.tools) {
      const b = out.get(name) ?? { calls: 0, inSizes: [], outSizes: [] }
      b.calls += t.calls
      b.inSizes.push(...t.inSizes)
      b.outSizes.push(...t.outSizes)
      out.set(name, b)
    }
  }
  return [...out.entries()]
    .map(([name, t]) => ({
      name,
      calls: t.calls,
      inP50: pct(t.inSizes, 50),
      inP90: pct(t.inSizes, 90),
      outP50: pct(t.outSizes, 50),
      outP90: pct(t.outSizes, 90),
      outMax: t.outSizes.length ? Math.max(...t.outSizes) : 0
    }))
    .sort((a, b) => b.calls - a.calls)
}
