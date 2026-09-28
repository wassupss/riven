// Which agent panes belong together.
//
// The rail lists every pane a workspace has, flat. That is fine for three and
// useless for twenty: a team of five reads as five unrelated rows sitting next
// to whatever else is open, and the one structure that explains them — the group
// they were created as — is visible only inside the group panel.

export interface PaneLike {
  id: string
}

export interface GroupLike {
  group: string
  members: Array<{ chatKey: string }>
}

export interface GroupedPanes<T extends PaneLike> {
  /** Groups that still have at least one pane open, in the panes' own order. */
  groups: Array<{ name: string; panes: T[] }>
  /** Everything that belongs to no group. */
  loose: T[]
}

/**
 * Split the roster into groups and the rest.
 *
 * Order follows the ROSTER, not the group roster: the rail is a list of what is
 * open, and a group that was created later but whose panes sit higher should
 * appear where its panes are. A pane claimed by two groups belongs to the first
 * that names it, so it is listed once.
 */
export function groupPanes<T extends PaneLike>(panes: T[], groups: GroupLike[]): GroupedPanes<T> {
  const owner = new Map<string, string>()
  for (const g of groups) {
    for (const m of g.members) {
      if (!owner.has(m.chatKey)) owner.set(m.chatKey, g.group)
    }
  }
  const byGroup = new Map<string, T[]>()
  const loose: T[] = []
  for (const pane of panes) {
    const name = owner.get(pane.id)
    if (!name) {
      loose.push(pane)
      continue
    }
    const list = byGroup.get(name)
    if (list) list.push(pane)
    else byGroup.set(name, [pane])
  }
  return {
    groups: [...byGroup.entries()].map(([name, ps]) => ({ name, panes: ps })),
    loose
  }
}

/**
 * The pane's title without the group's name in it.
 *
 * A member's tab reads "멤버1 · 팀 · 점심메뉴 추천" so it stands alone among
 * other tabs — but under a header that already says 팀, that middle segment is
 * the same word twice, on a rail with no room for it.
 */
export function stripGroup(title: string, group: string): string {
  const parts = title.split(' · ')
  if (parts.length < 2) return title
  const kept = parts.filter((p, i) => i === 0 || p !== group)
  return kept.join(' · ')
}
