// The message that brings a background delegation's answer back to the pane
// that handed the work off (riven_ask_agent wait=false -> returnToCaller).
//
// The headless chat opens that turn with notices. The CLI chat cannot: what
// is sent is a message the CLI stores in its transcript like anything typed.
// So the text carries a head line the chat view recognises, and draws the
// turn as "delegated work done" notices instead of a bubble the person never
// typed. Several answers landing together are one message (joined by a blank
// line), one head each.

const HEAD = '[백그라운드 위임 결과 · '

/** The text a returned delegation is sent as. */
export function wakeText(title: string, asked: string, body: string): string {
  return `${HEAD}${title}]\n맡긴 일: ${asked}\n\n${body}`
}

/**
 * The delegations a message reports back, by the title of the agent each
 * went to, or null when the message is not one (it does not start with a
 * head line). Only a head at the start of a line counts.
 */
export function wakeTitles(text: string): string[] | null {
  if (!text.trimStart().startsWith(HEAD)) return null
  const out: string[] = []
  for (const line of text.split('\n')) {
    if (!line.startsWith(HEAD)) continue
    const end = line.lastIndexOf(']')
    if (end > HEAD.length) out.push(line.slice(HEAD.length, end))
  }
  return out.length ? out : null
}
