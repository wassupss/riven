// Who a workspace belongs to.
//
// A folder name and a colour dot say very little when six of the cards are
// checkouts of the same project — riven-electron, riven-tamagotchi, riven — and
// the thing that actually distinguishes them is which repository they point at.
// The remote already knows; nothing here talks to a network API to find out.

export interface RepoRef {
  host: string
  owner: string
  repo: string
}

/**
 * Pull owner/repo out of a git remote URL.
 *
 * Handles the three shapes git hands out: scp-style (`git@host:owner/repo.git`),
 * a URL (`https://host/owner/repo.git`, `ssh://git@host/owner/repo`), and either
 * with or without the `.git` suffix. Anything else — a local path, a relative
 * remote — is not a repository anyone has a picture of, so it is null.
 */
export function parseRemote(url: string | null | undefined): RepoRef | null {
  if (!url) return null
  const raw = url.trim()
  if (!raw) return null
  // scp-style: user@host:path — no scheme, a colon, and no '//' before it.
  const scp = raw.match(/^[\w.-]+@([^:/]+):(.+)$/)
  let host: string
  let path: string
  if (scp) {
    host = scp[1]
    path = scp[2]
  } else {
    const m = raw.match(/^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?([^/]+)\/(.+)$/i)
    if (!m) return null
    host = m[1].replace(/:\d+$/, '') // a port is not part of the identity
    path = m[2]
  }
  const parts = path.replace(/\.git$/i, '').split('/').filter(Boolean)
  if (parts.length < 2) return null
  // Self-hosted GitLab nests groups; the repo is the last segment and the owner
  // is everything before it, which is how the web UI addresses it too.
  const repo = parts[parts.length - 1]
  const owner = parts.slice(0, -1).join('/')
  return { host: host.toLowerCase(), owner, repo }
}

/**
 * A picture for the owner, or null when the host has no guessable one.
 *
 * `github.com/<owner>.png` needs no token and works for users and organisations
 * alike — which matters, because asking people to authenticate before their
 * sidebar looks right is not a trade worth making.
 */
export function avatarUrl(ref: RepoRef | null, size = 64): string | null {
  if (!ref) return null
  if (ref.host !== 'github.com' && !ref.host.endsWith('.github.com')) return null
  // A nested owner is a GitLab shape; GitHub's is always a single login.
  if (ref.owner.includes('/')) return null
  return `https://github.com/${encodeURIComponent(ref.owner)}.png?size=${size}`
}

/** "wassupss/riven" — what the card shows instead of a bare folder name. */
export function repoLabel(ref: RepoRef | null): string | null {
  return ref ? `${ref.owner}/${ref.repo}` : null
}
