// "@teammate message" in a chat composer: the message goes to that agent
// pane instead of this conversation. Shared by the chat panes (pure, tested).

/**
 * A teammate's @mention handle: the name only, dropping the " · group"
 * suffix that group-member panes carry in their title.
 */
export function mentionHandle(title: string): string {
  return (title.split(' · ')[0] || title).trim()
}

/** The "@query" being typed at the end of the input (lower case), else null. */
export function mentionQuery(input: string): string | null {
  const m = /(?:^|\s)@([^@]*)$/.exec(input)
  return m ? m[1].toLowerCase().trimStart() : null
}

/** The input with the trailing "@query" replaced by "@handle ". */
export function insertMention(input: string, handle: string): string {
  return input.replace(/(?:^|\s)@[^@]*$/, (m) => (m.startsWith(' ') ? ' ' : '') + '@' + handle + ' ')
}

/** The input with the trailing "@query" taken out (Esc on the menu). */
export function dropMentionQuery(input: string): string {
  return input.replace(/(?:^|\s)@[^@]*$/, '')
}

/** Peers whose handle contains the query, for the menu. */
export function mentionMatches<T extends { title: string }>(peers: T[], query: string | null, max = 20): T[] {
  if (query === null) return []
  return peers.filter((p) => mentionHandle(p.title).toLowerCase().includes(query)).slice(0, max)
}

/**
 * Leading @mentions and the rest of the message. Titles can contain spaces
 * ("Claude Code", "리드 · 팀"), so each "@..." is matched against the known
 * handles, longest first, instead of cutting at whitespace. Null when the
 * message names nobody it knows or has nothing left to send.
 */
export function parseMentions<T extends { id: string; title: string }>(
  text: string,
  peers: T[]
): { targets: T[]; body: string } | null {
  const handles = peers
    .map((p) => ({ entry: p, handle: mentionHandle(p.title) }))
    .filter((p) => p.handle)
    .sort((a, b) => b.handle.length - a.handle.length)
  let rest = text.replace(/^\s+/, '')
  const targets: T[] = []
  for (;;) {
    if (!rest.startsWith('@')) break
    const after = rest.slice(1)
    const lc = after.toLowerCase()
    const hit = handles.find((p) => lc.startsWith(p.handle.toLowerCase()))
    if (!hit) break
    if (!targets.some((t) => t.id === hit.entry.id)) targets.push(hit.entry)
    rest = after.slice(hit.handle.length).replace(/^\s+/, '')
  }
  const body = rest.trim()
  if (targets.length === 0 || !body) return null
  return { targets, body }
}
