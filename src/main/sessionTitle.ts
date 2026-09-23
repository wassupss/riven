// What a past conversation is called.
//
// A transcript can carry three answers and they are not equal:
//
//   custom-title  a human named it (the CLI's /rename writes this, and so does
//                 riven's rename — it is APPENDED, so the last one wins)
//   ai-title      the model's summary of the conversation
//   first user    whatever was said first, which is only a name by accident
//
// This rule lived in two places — the session picker and the terminal tab —
// and they drifted: neither knew about custom-title, so a renamed session kept
// showing its opening line in riven while the CLI showed the new name.

export interface TitleScan {
  /** The name a human gave it, newest first-to-last. */
  custom: string
  /** The model's own summary. */
  ai: string
  /** The opening message, first line only. */
  firstUser: string
  /** Turns in the conversation — a file with none is not worth listing. */
  messages: number
}

/** Read the title-bearing records out of a transcript's lines. */
export function scanTitles(lines: Iterable<string>): TitleScan {
  const out: TitleScan = { custom: '', ai: '', firstUser: '', messages: 0 }
  for (const line of lines) {
    if (!line) continue
    let j: Record<string, unknown>
    try {
      j = JSON.parse(line)
    } catch {
      continue // a partially written line is not a reason to lose the rest
    }
    if (j.type === 'custom-title' && typeof j.customTitle === 'string' && j.customTitle.trim())
      out.custom = j.customTitle.trim()
    if (!out.ai && j.type === 'ai-title' && typeof j.title === 'string' && j.title.trim())
      out.ai = j.title.trim()
    if (j.type === 'user' || j.type === 'assistant') out.messages++
    if (!out.firstUser && j.type === 'user') {
      const c = (j.message as Record<string, unknown> | undefined)?.content
      // A '<' opener is one of the CLI's own synthetic messages (command
      // output, system reminders), which nobody would recognise as a title.
      if (typeof c === 'string' && c && !c.startsWith('<')) out.firstUser = c.split('\n')[0].trim()
    }
  }
  return out
}

/** The name to show, truncated for a tab or a list row. */
export function titleOf(scan: TitleScan, max: number): string {
  const pick = scan.custom || scan.ai || scan.firstUser
  if (!pick) return ''
  return pick.length > max ? pick.slice(0, max) + '…' : pick
}
