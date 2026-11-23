import { create } from 'zustand'
import type { DeskMsg, PhoneMsg, RemoteTerm, TermGone } from '../lib/remote/core'
import { RateLimiter, SCREEN_LINES, safeLabel, screenForPhone } from '../lib/remote/termShare'
import { getSettings, useSettings, type RemoteDevice, type RemoteTermAudit } from './settings'
import { setPaneState, useSession, workspaceName } from './session'
import { rosterFor, workspaceOfPane, type RosterEntry } from './roster'

// Remote control, terminals: a paired phone looking at a CLI agent running in
// one of this machine's terminals, and in a narrow way typing into it. The
// relay, keys and framing are state/remote.ts's; this decides what a phone may
// see and do here.
//
// Three locks, all on this machine, all off by default:
// - the device's "terminal view" (and, separately, "terminal input"),
//   switched on only in Settings › Remote. No phone message changes them.
// - the pane's "show on phone" (the tab's menu), saved with the session.
// - an agent must be the terminal's foreground program. A plain shell is
//   never listed, shown or typed into; main checks this again on input.
// Every one is re-checked on every screen sent and every key typed, so
// turning any of them off takes effect within one tick.
//
// What goes out is plain text from main's terminal model (never the raw byte
// stream), cleaned and with credential-shaped strings redacted, at most twice
// a second and only while a phone has that terminal open. With no phone
// watching there is no timer and no work at all.

type Send = (d: RemoteDevice, msg: DeskMsg) => void

const TICK_MS = 500 // at most 2 screens a second per phone
const AUDIT_MAX = 200
const PREVIEW_CHARS = 80
// Answering a prompt can take a few key presses in a row; a typed line is
// rarer. Per phone.
const keyLimit = new RateLimiter(10, 5_000)
const lineLimit = new RateLimiter(3, 10_000)

interface WatchedStore {
  /** Pane key → names of the phones that have it open right now. */
  watched: Record<string, string[]>
}
export const useRemoteTerms = create<WatchedStore>(() => ({ watched: {} }))

let send: Send | null = null
let present: () => RemoteDevice[] = () => []

/** Phone id → the terminal it has open, and the last text it was sent. */
const watching = new Map<string, { key: string; sent: string }>()
/** Pane key → main's revision and the text (already cleaned) it gave for it. */
const screens = new Map<string, { rev: string; text: string; agent: boolean }>()
/** Phones that asked for the list this session: they hear when it changes. */
const listeners = new Set<string>()
const lastList = new Map<string, string>()
let timer: ReturnType<typeof setInterval> | null = null
let ticking = false

/** The device as settings have it NOW: capabilities can change between messages. */
const deviceNow = (id: string): RemoteDevice | undefined => getSettings().remoteDevices.find((x) => x.id === id)

const isShared = (ws: string, key: string): boolean =>
  useSession.getState().sessions[ws]?.panes?.[key]?.remoteShare === true

/** The terminal, if it may be shown at all: opted in, and an agent in front. */
function sharedTerm(key: string): RosterEntry | null {
  if (!key.startsWith('term-')) return null
  const ws = workspaceOfPane(key)
  if (!ws || !isShared(ws, key)) return null
  // rosterFor lists a terminal only while a CLI agent is its foreground program.
  return rosterFor(ws).find((r) => r.id === key && r.kind === 'terminal') ?? null
}

function termsMsg(d: RemoteDevice): DeskMsg {
  if (!d.termView) return { t: 'terms', allowed: false, terms: [] }
  const { openWorkspaces, names } = useSession.getState()
  const terms: RemoteTerm[] = []
  for (const ws of openWorkspaces) {
    const label = safeLabel(workspaceName(ws, names))
    for (const r of rosterFor(ws)) {
      if (r.kind !== 'terminal' || !isShared(ws, r.id)) continue
      terms.push({
        id: r.id,
        workspace: label,
        title: safeLabel(r.title),
        agent: safeLabel(r.agent ?? 'agent', 30),
        status: r.status,
        canInput: !!d.termInput
      })
    }
  }
  return { t: 'terms', allowed: true, terms }
}

function publishWatched(): void {
  const watched: Record<string, string[]> = {}
  for (const [id, w] of watching) {
    const name = deviceNow(id)?.name ?? 'phone'
    ;(watched[w.key] ??= []).push(name)
  }
  const prev = useRemoteTerms.getState().watched
  if (JSON.stringify(prev) !== JSON.stringify(watched)) useRemoteTerms.setState({ watched })
}

function unwatch(id: string, reason?: TermGone): void {
  const w = watching.get(id)
  if (!w) return
  watching.delete(id)
  if (reason) {
    const d = deviceNow(id)
    if (d) send?.(d, { t: 'termGone', termKey: w.key, reason })
  }
  if (![...watching.values()].some((x) => x.key === w.key)) screens.delete(w.key)
  publishWatched()
  if (!watching.size && timer) {
    clearInterval(timer)
    timer = null
  }
}

/** Why this phone may not see this terminal now, or null if it may. */
function refusal(d: RemoteDevice | undefined, key: string): TermGone | null {
  if (!d?.termView) return 'no-access'
  return sharedTerm(key) ? null : 'not-shared'
}

async function tick(): Promise<void> {
  if (ticking || !send) return
  ticking = true
  try {
    const keys = new Set([...watching.values()].map((w) => w.key))
    for (const key of keys) {
      // Panes nobody may see any more are not even read.
      if (!sharedTerm(key)) {
        for (const [id, w] of [...watching]) if (w.key === key) unwatch(id, 'not-shared')
        continue
      }
      const prev = screens.get(key)
      let got: { rev: string; text: string | null; agent: boolean } | null = null
      try {
        got = await window.api.pty.remoteText(key, SCREEN_LINES, prev?.rev ?? '')
      } catch {
        got = null // an older main without the command: nothing to show
      }
      if (!got) {
        for (const [id, w] of [...watching]) if (w.key === key) unwatch(id, 'closed')
        continue
      }
      const cur = got.text === null && prev ? { ...prev, agent: got.agent } : { rev: got.rev, text: screenForPhone(got.text ?? ''), agent: got.agent }
      screens.set(key, cur)
      for (const [id, w] of [...watching]) {
        if (w.key !== key) continue
        const d = deviceNow(id)
        const no = refusal(d, key)
        if (no || !d) {
          unwatch(id, no ?? 'no-access')
          continue
        }
        const canInput = !!d.termInput && cur.agent
        const sig = `${canInput ? 1 : 0}${cur.text}`
        if (w.sent === sig) continue
        w.sent = sig
        // Optional: the channel may have closed while main was answering.
        send?.(d, { t: 'termScreen', termKey: key, text: cur.text, now: Date.now(), canInput })
      }
    }
  } finally {
    ticking = false
  }
}

function watch(d: RemoteDevice, key: string | null): void {
  // One terminal per phone: whatever it had open before is let go first.
  unwatch(d.id)
  if (!key) return
  const no = refusal(deviceNow(d.id), key)
  if (no) {
    send?.(d, { t: 'termGone', termKey: key, reason: no })
    return
  }
  watching.set(d.id, { key, sent: '' })
  publishWatched()
  timer ??= setInterval(() => void tick(), TICK_MS)
  void tick()
}

function audit(entry: RemoteTermAudit): void {
  const list = [...getSettings().remoteTermAudit, entry].slice(-AUDIT_MAX)
  useSettings.getState().set({ remoteTermAudit: list })
}

async function input(d: RemoteDevice, m: Extract<PhoneMsg, { t: 'termInput' }>): Promise<void> {
  const ack = (ok: boolean, error?: string): void =>
    send?.(d, { t: 'ack', reqId: m.reqId, ok, ...(error ? { error } : {}) })
  const dev = deviceNow(d.id)
  const term = sharedTerm(m.termKey)
  const what = m.input.kind === 'line' ? 'line' : m.input.key
  const record = (ok: boolean, error?: string): void =>
    audit({
      at: Date.now(),
      device: dev?.name ?? d.name,
      deviceId: d.id,
      pane: safeLabel(term?.title ?? m.termKey),
      paneKey: m.termKey,
      what,
      ...(m.input.kind === 'line' ? { preview: m.input.text.slice(0, PREVIEW_CHARS) } : {}),
      ok,
      ...(error ? { error } : {})
    })
  // Refused before anything is typed, and each refusal is on the record too.
  if (!dev?.termView || !dev.termInput) {
    record(false, 'no-access')
    return ack(false, 'no-access')
  }
  if (!term) {
    record(false, 'not-shared')
    return ack(false, 'not-shared')
  }
  const limiter = m.input.kind === 'line' ? lineLimit : keyLimit
  if (!limiter.take(d.id)) {
    // Not recorded: a phone hammering the limit should not flush the log.
    return ack(false, 'rate-limited')
  }
  let ok = false
  try {
    ok = await window.api.pty.remoteInput(
      m.termKey,
      m.input.kind === 'line' ? { text: m.input.text } : { key: m.input.key }
    )
  } catch {
    ok = false
  }
  record(ok, ok ? undefined : 'refused')
  ack(ok, ok ? undefined : 'refused')
}

/** What remote.ts hands over from a phone. True if it was a terminal message. */
export function handleTermMsg(d: RemoteDevice, m: PhoneMsg): boolean {
  switch (m.t) {
    case 'terms':
      listeners.add(d.id)
      sendList(d, true)
      return true
    case 'termWatch':
      watch(d, m.termKey)
      return true
    case 'termInput':
      void input(d, m)
      return true
    default:
      return false
  }
}

function sendList(d: RemoteDevice, force = false): void {
  const dev = deviceNow(d.id)
  if (!dev) return
  const msg = termsMsg(dev)
  const json = JSON.stringify(msg)
  if (!force && lastList.get(d.id) === json) return
  lastList.set(d.id, json)
  send?.(dev, msg)
}

let listTimer: ReturnType<typeof setTimeout> | null = null
/** The list changed, maybe (roster, layout, settings): tell the phones that asked. */
export function pushTerms(): void {
  if (!listeners.size || !send) return
  if (listTimer) clearTimeout(listTimer)
  listTimer = setTimeout(() => {
    listTimer = null
    for (const d of present()) if (listeners.has(d.id)) sendList(d)
  }, 500)
}

/** A phone left the channel: it watches nothing and hears nothing. */
export function dropTermDevice(id: string): void {
  listeners.delete(id)
  lastList.delete(id)
  unwatch(id)
}

/** remote.ts connected (or disconnected, with null): where messages go. */
export function attachTerms(s: Send | null, presentDevices: () => RemoteDevice[]): void {
  send = s
  present = presentDevices
  if (!s) {
    for (const id of [...watching.keys()]) unwatch(id)
    listeners.clear()
    lastList.clear()
    screens.clear()
    keyLimit.clear()
    lineLimit.clear()
    if (listTimer) clearTimeout(listTimer)
    listTimer = null
  }
}

/**
 * One click from the computer: every phone loses terminal view and input, and
 * whatever terminal one has open closes on it now. Turning them back on is a
 * deliberate act in Settings › Remote.
 */
export function stopAllRemoteTerminals(): void {
  for (const id of [...watching.keys()]) unwatch(id, 'stopped')
  const devices = getSettings().remoteDevices
  if (devices.some((d) => d.termView || d.termInput))
    useSettings.getState().set({ remoteDevices: devices.map((d) => ({ ...d, termView: false, termInput: false })) })
  for (const d of present()) if (listeners.has(d.id)) sendList(d)
}

/** Settings › Remote: what one phone may do with terminals. Input needs view. */
export function setTermAccess(id: string, p: { termView?: boolean; termInput?: boolean }): void {
  useSettings.getState().set({
    remoteDevices: getSettings().remoteDevices.map((d) => {
      if (d.id !== id) return d
      const termView = p.termView ?? !!d.termView
      return { ...d, termView, termInput: termView && (p.termInput ?? !!d.termInput) }
    })
  })
  // Taken away: whatever that phone has open closes on the next tick; the
  // list goes out again either way.
  pushTerms()
}

/** The tab menu's "show on phone". Turning it off closes the pane on every phone. */
export function setTermShared(ws: string, key: string, on: boolean): void {
  setPaneState(ws, key, { remoteShare: on })
  if (!on) for (const [id, w] of [...watching]) if (w.key === key) unwatch(id, 'not-shared')
  pushTerms()
}

export function clearTermAudit(): void {
  useSettings.getState().set({ remoteTermAudit: [] })
}
