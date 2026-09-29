// Small, pure translations from riven's settings to Claude CLI arguments.

/**
 * The --autocompact value to pass, or null to pass nothing.
 *
 * 'auto' is the CLI's default, so it is not passed at all. A number outside
 * 100K–1M makes the CLI refuse to start ("argument is invalid"), and a chat
 * pane that cannot start is far worse than one that compacts late — so an
 * out-of-range or unreadable value is dropped, not forwarded.
 */
export function autocompactArg(value: string | undefined | null): string | null {
  const v = (value ?? '').trim().toLowerCase()
  if (!v || v === 'auto') return null
  const m = /^(\d+(?:\.\d+)?)(k|m)?$/.exec(v)
  if (!m) return null
  const n = Math.round(parseFloat(m[1]) * (m[2] === 'm' ? 1_000_000 : m[2] === 'k' ? 1_000 : 1))
  if (n < 100_000 || n > 1_000_000) return null
  return String(n)
}
