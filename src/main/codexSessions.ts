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
    return clip(first)
  }
  // A thread run through app-server logs no user_message events.
  const firstUser = transcriptFromRollout(text).find((m) => m.role === 'user')
  const line = firstUser?.text.split('\n').map((l) => l.trim()).find(Boolean)
  return line ? clip(line) : null
}

function clip(s: string): string {
  return s.length > TITLE_MAX ? `${s.slice(0, TITLE_MAX - 1)}…` : s
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

export interface RolloutMessage {
  role: 'user' | 'assistant'
  text: string
  tools: Array<{ name: string; detail: string }>
  images?: number
}

// Text of a response_item message, when it is something a person said or read:
// Codex also records injected context (environment, AGENTS.md, plugin lists)
// as "user" messages, all of which open with a tag or a heading.
function messageText(p: { role?: unknown; content?: unknown }): string | null {
  if (!Array.isArray(p.content)) return null
  const text = (p.content as Array<{ type?: string; text?: unknown }>)
    .filter((c) => (c.type === 'input_text' || c.type === 'output_text') && typeof c.text === 'string')
    .map((c) => c.text as string)
    .join('\n')
  if (!text.trim()) return null
  if (p.role === 'user' && /^\s*(<|# AGENTS\.md|# Context from my IDE)/.test(text)) return null
  return text
}

// A Codex conversation as the chat pane shows a restored one: what the user
// said and what Codex answered, in order.
//
// Read from the model-facing messages (response_item), which every rollout has.
// The TUI additionally logs user_message/agent_message events, but a thread run
// through app-server — a riven chat pane — writes none, so reading only those
// restored an empty conversation.
export function transcriptFromRollout(text: string): RolloutMessage[] {
  const out: RolloutMessage[] = []
  for (const line of text.split('\n')) {
    if (!line.includes('"response_item"')) continue
    let ev: { type?: string; payload?: { type?: string; role?: unknown; content?: unknown } }
    try {
      ev = JSON.parse(line)
    } catch {
      continue
    }
    const p = ev.payload
    if (ev.type !== 'response_item' || p?.type !== 'message') continue
    if (p.role !== 'user' && p.role !== 'assistant') continue
    const body = messageText(p)
    if (body === null) continue
    const images = Array.isArray(p.content)
      ? (p.content as Array<{ type?: string }>).filter((c) => c.type === 'input_image').length
      : 0
    const last = out[out.length - 1]
    // One turn can say several things; the pane shows it as one answer.
    if (p.role === 'assistant' && last && last.role === 'assistant') last.text += `\n\n${body}`
    else out.push({ role: p.role, text: body, tools: [], ...(images ? { images } : {}) })
  }
  return out
}

export function readCodexTranscript(sessionId: string): RolloutMessage[] {
  const file = findRollout(sessionId)
  if (!file) return []
  try {
    return transcriptFromRollout(fs.readFileSync(file, 'utf8'))
  } catch {
    return []
  }
}
