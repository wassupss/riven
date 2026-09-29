// Keeping another agent's answer from swallowing the caller's context.
//
// A delegated reply went back to the lead whole — measured up to 12.9K
// characters for one answer — and from then on it rides along in every API call
// the lead makes for the rest of the conversation. Past a cap, the head of the
// answer goes back and the full text is kept somewhere the lead can read it
// if it turns out to need it.

/** How much of a delegated answer goes back inline, in characters. */
export const REPLY_CAP = 8000

/**
 * The first ~`cap` characters of `text`, cut at a paragraph or line break when
 * one is close, so the lead does not get half a sentence. `clipped` says
 * whether anything was left out.
 */
export function clipText(text: string, cap: number): { head: string; clipped: boolean } {
  if (cap <= 0 || text.length <= cap) return { head: text, clipped: false }
  const window = text.slice(0, cap)
  // Prefer a paragraph break in the last fifth, then a line break, then a space.
  const floor = Math.floor(cap * 0.8)
  for (const sep of ['\n\n', '\n', ' ']) {
    const at = window.lastIndexOf(sep)
    if (at >= floor) return { head: window.slice(0, at).trimEnd(), clipped: true }
  }
  return { head: window, clipped: true }
}

/** The line that tells the lead what was left out and where the rest is. */
export function clipNotice(total: number, shown: number, note: string | null): string {
  const where = note
    ? `전문은 riven_note_read(note="${note}")로 읽을 수 있습니다`
    : '전문은 저장하지 못했습니다'
  return `…(전체 ${total.toLocaleString()}자 중 앞 ${shown.toLocaleString()}자만 전달 — ${where})`
}
