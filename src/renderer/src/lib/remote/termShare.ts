// Remote terminals, the computer's half that needs no app state: what a
// terminal's text looks like by the time it leaves this machine, and how often
// a phone may type. Desk only (the phone never sees raw text, so it has no
// use for these); state/remoteTerms.ts uses them.

const REDACTED = '[redacted]'

// Common credential shapes. Each is replaced whole; a false positive only
// hides a little text from the phone, a miss could show a key, so these lean
// wide.
const TOKENS: RegExp[] = [
  // OpenAI / Anthropic style (sk-..., sk-ant-..., sk-proj-...)
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  // Stripe
  /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/g,
  // GitHub
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  // GitLab
  /\bglpat-[A-Za-z0-9_-]{20,}/g,
  // Slack
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  // AWS access key ids
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  // Google API keys
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  // npm
  /\bnpm_[A-Za-z0-9]{30,}/g,
  // JWTs (and anything that starts like one: a cut-off one is still a secret)
  /\beyJ[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]+){0,2}/g
]

// `key=value`, `"token": "value"`, `PASSWORD: value` and the like: the name is
// kept, the value goes.
const ASSIGNED =
  /\b([A-Za-z0-9_.-]*(?:api[_-]?key|apikey|secret|token|passw(?:or)?d|passwd|pwd|access[_-]?key|private[_-]?key|credential|authorization)[A-Za-z0-9_.-]*)(["']?\s*[:=]\s*["']?)([^\s"',;]{6,})/gi
// `Authorization: Bearer xyz` once the header name itself is gone (or wrapped).
const BEARER = /\b(Bearer|Basic|Token)(\s+)[A-Za-z0-9._~+/-]{16,}=*/g
// user:password@ in a URL
const URL_CRED = /(\/\/[^\s:/@]+:)[^\s@/]+@/g
// PEM blocks: a whole one, one whose end is below the cut, and one whose
// beginning scrolled off the top.
const PEM_BLOCK = /-----BEGIN[ A-Z0-9]*KEY-----[\s\S]*?(?:-----END[ A-Z0-9]*KEY-----|$)/g
const PEM_TAIL = /^[\s\S]*-----END[ A-Z0-9]*KEY-----/

/** The text with credentials that look like credentials replaced by `[redacted]`. */
export function redactSecrets(text: string): string {
  // Whole blocks first, so any END marker still left has no BEGIN in view:
  // everything above it is (or may be) the key.
  let out = text.replace(PEM_BLOCK, REDACTED).replace(PEM_TAIL, REDACTED)
  for (const re of TOKENS) out = out.replace(re, REDACTED)
  // The scheme's token before the header: `Authorization: Bearer x` would
  // otherwise lose only the word "Bearer".
  out = out.replace(BEARER, (_m, word: string, sp: string) => `${word}${sp}${REDACTED}`)
  out = out.replace(ASSIGNED, (_m, name: string, sep: string) => `${name}${sep}${REDACTED}`)
  out = out.replace(URL_CRED, `$1${REDACTED}@`)
  return out
}

// What a phone may receive of a terminal. Last lines only, each clipped, and
// the whole well under one relay message (core.MAX_REPLY).
export const SCREEN_LINES = 200
const LINE_CHARS = 400
const SCREEN_BUDGET = 40_000

// Control characters (the model's plain text has none, but nothing here
// relies on that) and the invisible or direction-changing format characters
// that could make the phone show something other than what is there.
// eslint-disable-next-line no-control-regex
const UNSAFE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g

/** A terminal's text, ready to leave this machine: cleaned, redacted, bounded. */
export function screenForPhone(raw: string): string {
  const clean = redactSecrets(raw.replace(/\t/g, '  ').replace(UNSAFE, ''))
  const lines = clean
    .split('\n')
    .slice(-SCREEN_LINES)
    .map((l) => (l.length > LINE_CHARS ? l.slice(0, LINE_CHARS) + '…' : l))
  let size = lines.reduce((n, l) => n + l.length + 1, 0)
  while (lines.length > 1 && size > SCREEN_BUDGET) size -= lines.shift()!.length + 1
  return lines.join('\n')
}

/** A short label from the terminal (its title, say), safe to show on a phone. */
export function safeLabel(s: string, max = 100): string {
  const t = s.replace(UNSAFE, '').replace(/[\n\t]/g, ' ').trim()
  return t.length > max ? t.slice(0, max) + '…' : t
}

/** At most `max` events per `windowMs` for each key. */
export class RateLimiter {
  private hits = new Map<string, number[]>()
  constructor(
    private readonly max: number,
    private readonly windowMs: number
  ) {}

  take(key: string, now = Date.now()): boolean {
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs)
    if (recent.length >= this.max) {
      this.hits.set(key, recent)
      return false
    }
    recent.push(now)
    this.hits.set(key, recent)
    return true
  }

  clear(): void {
    this.hits.clear()
  }
}
