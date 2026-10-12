/**
 * What a failed `result` should say. The subtype alone is not it: a turn the
 * account limit stopped arrives as is_error with subtype "success" and the
 * reason in `result` ("You've hit your session limit…"), which the pane showed
 * as a red "success"; execution errors carry theirs in `errors`.
 */
export function resultError(ev: Record<string, unknown>): string {
  const errs = Array.isArray(ev.errors) ? ev.errors.filter((e) => typeof e === 'string' && e.trim()) : []
  if (errs.length) return String(errs[0]).split('\n')[0].slice(0, 300)
  if (ev.subtype === 'success' && typeof ev.result === 'string' && ev.result.trim())
    return ev.result.trim().split('\n')[0].slice(0, 300)
  return String(ev.subtype ?? 'error')
}
