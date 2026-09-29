// Which models each CLI can be asked for.
//
// One list, because there were three: the chat pane's picker, the agent-group
// panel's member form, and the tool descriptions. They drifted — the group panel
// offered opus/sonnet/haiku and nothing else, so a team could not be given fable
// or any Codex model from the UI at all, even though a pane created by an agent
// could run them.
export type Cli = 'claude' | 'codex'

export const CLAUDE_MODELS = ['default', 'fable', 'opus', 'sonnet', 'haiku']
// Codex's own ids (from its app-server model/list). "default" is the account's.
export const CODEX_MODELS = ['default', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5']

export function modelsFor(cli: Cli | string | null | undefined): string[] {
  return cli === 'codex' ? CODEX_MODELS : CLAUDE_MODELS
}

/** A model picked for one CLI means nothing to the other: fall back to default. */
export function modelForCli(model: string | null | undefined, cli: Cli): string {
  const m = model ?? 'default'
  if (modelsFor(cli).includes(m)) return m
  // A version pinned from the catalog ("claude-opus-5") is a Claude model too.
  if (cli === 'claude' && isPinnedClaude(m)) return m
  return 'default'
}

// ---- what the aliases mean -------------------------------------------------
//
// The aliases above say nothing about versions; the CLI's own model list does
// (main/modelCatalog). Everything below turns that list into labels, and falls
// back to the bare alias when the list is not available — offline, logged out,
// or under e2e, where the CLI is withheld.

export interface ModelInfo {
  value: string
  resolvedModel?: string
  displayName: string
  description?: string
}

export function isPinnedClaude(m: string): boolean {
  return /^claude-[a-z]+-\d/.test(m)
}

/**
 * "claude-opus-5-5[1m]" → "Opus 5.5", "claude-haiku-4-5-20251001" → "Haiku 4.5".
 * For when the catalog has no entry: the old formatter turned every dash into a
 * space, which read as "opus 5 5".
 */
export function prettyModelId(raw: string): string {
  const id = raw.replace(/\[.*\]$/, '')
  const m = /^claude-([a-z]+)((?:-\d+)*)/.exec(id)
  if (!m) return id.replace(/^gpt-/, 'GPT-')
  const family = m[1].charAt(0).toUpperCase() + m[1].slice(1)
  // Version parts, minus a trailing 8-digit snapshot date.
  const parts = m[2].split('-').filter(Boolean).filter((p) => p.length < 8)
  return parts.length ? `${family} ${parts.join('.')}` : family
}

/** The catalog entry an alias or id stands for, if the catalog knows it. */
export function entryFor(value: string, catalog: ModelInfo[] | null): ModelInfo | null {
  if (!catalog?.length) return null
  const exact = catalog.find((e) => e.value === value)
  if (exact) return exact
  // "fable" is accepted by the CLI but listed only by its pinned id: take the
  // first (newest) entry of that family.
  if (/^[a-z]+$/.test(value)) {
    return catalog.find((e) => new RegExp(`^claude-${value}-`).test(e.resolvedModel ?? e.value)) ?? null
  }
  return catalog.find((e) => e.resolvedModel === value) ?? null
}

/** A human name for what `value` runs: "Opus 5.5", or the alias when unknown. */
export function modelLabel(value: string, catalog: ModelInfo[] | null): string {
  if (value === 'default') {
    const d = entryFor('default', catalog)
    if (!d?.resolvedModel) return 'default'
    // Name the model default resolves to by that model's own entry, so it reads
    // "default · Opus 5.5" rather than "Default (recommended)".
    const named = catalog?.find((e) => e.value !== 'default' && e.resolvedModel === d.resolvedModel)
    return `default · ${named?.displayName ?? prettyModelId(d.resolvedModel)}`
  }
  const e = entryFor(value, catalog)
  if (e) return e.displayName
  return isPinnedClaude(value) ? prettyModelId(value) : value
}

/**
 * Versions the user can pin on purpose: catalog entries that are not what one of
 * the aliases already resolves to (those are listed once, by alias).
 */
export function pinnedModels(catalog: ModelInfo[] | null): ModelInfo[] {
  if (!catalog?.length) return []
  const viaAlias = new Set(
    CLAUDE_MODELS.map((a) => entryFor(a, catalog)?.resolvedModel).filter((x): x is string => !!x)
  )
  return catalog.filter((e) => isPinnedClaude(e.value) && !viaAlias.has(e.resolvedModel ?? e.value))
}
