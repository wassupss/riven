import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

// Codex keeps each conversation as a "rollout" under $CODEX_HOME/sessions, one
// JSON event per line, filed by date:
//   sessions/2026/08/07/rollout-2026-08-07T13-10-20-<session id>.jsonl
// The first line is session_meta; what the user typed arrives as
//   {"type":"event_msg","payload":{"type":"user_message","message":"…"}}

function codexHome(): string {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex')
}

const TITLE_MAX = 80

// A conversation's name: the first thing the user asked, on one line. Codex has
// no summarised title the way Claude Code does, and its opening message is
// what the user would recognise it by.
export function titleFromRollout(text: string): string | null {
  for (const line of text.split('\n')) {
    if (!line.includes('user_message')) continue
    let ev: { type?: string; payload?: { type?: string; message?: unknown } }
    try {
      ev = JSON.parse(line)
    } catch {
      continue
    }
    if (ev.type !== 'event_msg' || ev.payload?.type !== 'user_message') continue
    const msg = typeof ev.payload.message === 'string' ? ev.payload.message : ''
    const first = msg.split('\n').map((l) => l.trim()).find(Boolean)
    if (!first) continue
    return first.length > TITLE_MAX ? `${first.slice(0, TITLE_MAX - 1)}…` : first
  }
  return null
}

// Newest first, so a conversation from today is found without walking years.
function listDesc(dir: string): string[] {
  try {
    return fs.readdirSync(dir).sort().reverse()
  } catch {
    return []
  }
}

const found = new Map<string, string>()

export function findRollout(sessionId: string): string | null {
  const cached = found.get(sessionId)
  if (cached && fs.existsSync(cached)) return cached
  const root = path.join(codexHome(), 'sessions')
  const suffix = `-${sessionId}.jsonl`
  for (const y of listDesc(root)) {
    for (const m of listDesc(path.join(root, y))) {
      for (const d of listDesc(path.join(root, y, m))) {
        const dir = path.join(root, y, m, d)
        const hit = listDesc(dir).find((f) => f.endsWith(suffix))
        if (hit) {
          const p = path.join(dir, hit)
          found.set(sessionId, p)
          return p
        }
      }
    }
  }
  return null
}

// Only the head of the file is read: the opening message is near the top, and
// a long conversation's rollout runs to megabytes.
const HEAD_BYTES = 256 * 1024

export function readCodexSessionTitle(sessionId: string): string | null {
  const file = findRollout(sessionId)
  if (!file) return null
  let fd: number | null = null
  try {
    fd = fs.openSync(file, 'r')
    const buf = Buffer.alloc(HEAD_BYTES)
    const n = fs.readSync(fd, buf, 0, HEAD_BYTES, 0)
    return titleFromRollout(buf.subarray(0, n).toString('utf8'))
  } catch {
    return null
  } finally {
    if (fd !== null) fs.closeSync(fd)
  }
}
