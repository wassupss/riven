import { app, BrowserWindow, ipcMain, Notification, WebContents } from 'electron'

// Desktop notifications, decided in ONE place.
//
// Each window reports its presence (visible, focused, which pane is active, when
// the user last touched it). When something wants to notify, the plan is:
//   1. a present, visible, focused window already showing that pane → nobody is
//      told; the user is looking at it.
//   2. otherwise the most recently active present window is the recipient — one
//      notification, and clicking it lands on that window's pane.
//   3. nobody present (all windows idle for a while / hidden) → still shown; a
//      desktop app has no other channel.
// This is paseo's computeNotificationPlan with "push" replaced by "show anyway",
// and it replaces the per-component `looking` guesses and the per-instance
// "any window focused → drop" rule that together produced both missed and
// duplicate notifications.
//
// Delivery details are orca's: retain the Notification (Electron GCs an
// unreferenced one and its click handler with it), release on close/failed/5min,
// a 5s per-target cooldown so a bell and a done in the same chunk are one
// notification, and a startup probe so macOS lists the app in System Settings.

export interface Presence {
  visible: boolean
  focused: boolean
  activePane: string | null
  at: number
}

export interface NotifyRequest {
  title: string
  body: string
  paneId?: string
  // Kept for old callers; the plan decides now.
  force?: boolean
}

export const PRESENCE_THRESHOLD_MS = 180_000
const COOLDOWN_MS = 5_000
const RELEASE_FALLBACK_MS = 5 * 60 * 1000

interface Plan {
  recipient: number | null // index into the candidate list
  suppressed: boolean
}

// Pure, so it is testable: given every window's presence, who (if anyone) hears
// about `paneId`.
export function computePlan(states: Presence[], paneId: string | null, now: number): Plan {
  let best: number | null = null
  let bestAt = -Infinity
  for (const [i, s] of states.entries()) {
    const at = Math.min(s.at, now)
    const present = now - at <= PRESENCE_THRESHOLD_MS
    if (!present) continue
    if (s.visible && s.focused && paneId !== null && s.activePane === paneId) {
      return { recipient: null, suppressed: true }
    }
    if (at > bestAt) {
      best = i
      bestAt = at
    }
  }
  return { recipient: best, suppressed: false }
}

// Cooldown per key, pruned so the map cannot grow with pane churn.
export function reserveCooldown(recent: Map<string, number>, key: string, now: number): boolean {
  const last = recent.get(key) ?? 0
  if (now - last < COOLDOWN_MS) return false
  recent.delete(key)
  recent.set(key, now)
  if (recent.size > 64) {
    for (const [k, t] of recent) {
      if (now - t >= COOLDOWN_MS) recent.delete(k)
      if (recent.size <= 64) break
    }
  }
  return true
}

const presenceByWc = new Map<number, Presence>()
const recent = new Map<string, number>()
const active = new Set<Notification>()

function retain(n: Notification): () => void {
  active.add(n)
  let released = false
  const release = (): void => {
    if (released) return
    released = true
    active.delete(n)
    clearTimeout(timer)
  }
  const timer = setTimeout(release, RELEASE_FALLBACK_MS)
  timer.unref?.()
  n.on('close', release)
  n.on('failed', (_e, err) => {
    console.warn('[notify] failed to show', err)
    release()
  })
  return release
}

function windowFor(wcId: number): BrowserWindow | null {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed() && w.webContents.id === wcId) return w
  }
  return null
}

// macOS only lists an app under System Settings > Notifications after it has
// tried to post one; do it silently at startup so the toggle exists before the
// first real notification is needed.
export function ensureNotificationCenterRegistration(): void {
  if (process.platform !== 'darwin' || !Notification.isSupported()) return
  const probe = new Notification({ title: app.name, silent: true })
  probe.on('show', () => probe.close())
  setTimeout(() => probe.close(), 2_000).unref?.()
  probe.show()
}

function show(sender: WebContents, req: NotifyRequest): void {
  if (!Notification.isSupported()) return
  const now = Date.now()
  const ids = [...presenceByWc.keys()]
  const states = ids.map((id) => presenceByWc.get(id) as Presence)
  const plan = computePlan(states, req.paneId ?? null, now)
  if (plan.suppressed) return
  if (!reserveCooldown(recent, req.paneId ?? req.title, now)) return
  // Land the click on the window the plan picked, else the sender, else any.
  const target =
    (plan.recipient !== null ? windowFor(ids[plan.recipient]) : null) ??
    BrowserWindow.fromWebContents(sender) ??
    BrowserWindow.getAllWindows().find((w) => !w.isDestroyed()) ??
    null
  const n = new Notification({ title: req.title, body: req.body, silent: false })
  const release = retain(n)
  n.on('click', () => {
    release()
    if (target && !target.isDestroyed()) {
      if (target.isMinimized()) target.restore()
      target.show()
      target.focus()
      if (req.paneId) target.webContents.send('notify:click', req.paneId)
    }
  })
  n.show()
}

export function registerNotifyHandlers(): void {
  ipcMain.on('notify:presence', (e, p: Presence) => {
    presenceByWc.set(e.sender.id, { ...p, at: Math.min(p.at, Date.now()) })
    e.sender.once('destroyed', () => presenceByWc.delete(e.sender.id))
  })
  ipcMain.on('notify:show', (e, req: NotifyRequest) => show(e.sender, req))
}
