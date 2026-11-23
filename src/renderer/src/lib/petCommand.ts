import type { NestBrief, PetCommand, PetResult } from '../state/pet'

// ---------------------------------------------------------------------------
// Looking after the pet from a window that is not showing it. The pet may live
// in its own desktop window (detached, the default) with its own store, so
// Settings cannot change the store it has: it asks whichever window shows the
// pet, over a BroadcastChannel (it reaches every other channel object of the
// same name, in this window too, so a pet inside the app hears it as well),
// and waits for the answer.
//
// The window showing the pet also announces a summary of the nest whenever it
// changes, so a list of the pets elsewhere (Settings) follows along.
// ---------------------------------------------------------------------------

const NAME = 'riven-pet'

type Msg =
  | { type: 'cmd'; req: string; cmd: PetCommand | null }
  | { type: 'answer'; req: string; result: PetResult; nest: NestBrief | null }
  | { type: 'nest'; nest: NestBrief }

export interface PetAnswer {
  result: PetResult
  /** The nest after the command, when the pet answered. */
  nest: NestBrief | null
}

const has = (): boolean => typeof BroadcastChannel !== 'undefined'

/**
 * Send a command to the window showing the pet (null just asks for the nest).
 * Resolves 'none' when nothing answers in time: nothing is showing the pet.
 */
export function requestPet(cmd: PetCommand | null, timeoutMs = 1500): Promise<PetAnswer> {
  if (!has()) return Promise.resolve({ result: 'none', nest: null })
  const ch = new BroadcastChannel(NAME)
  const req = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  return new Promise<PetAnswer>((resolve) => {
    const done = (a: PetAnswer): void => {
      clearTimeout(timer)
      ch.close()
      resolve(a)
    }
    const timer = setTimeout(() => done({ result: 'none', nest: null }), timeoutMs)
    ch.onmessage = (e: MessageEvent<Msg>) => {
      const m = e.data
      if (m?.type === 'answer' && m.req === req) done({ result: m.result, nest: m.nest ?? null })
    }
    ch.postMessage({ type: 'cmd', req, cmd } satisfies Msg)
  })
}

/** Where the pet is shown: answer commands. Returns the unsubscribe. */
export function servePet(handle: (cmd: PetCommand | null) => PetAnswer): () => void {
  if (!has()) return () => {}
  const ch = new BroadcastChannel(NAME)
  ch.onmessage = (e: MessageEvent<Msg>) => {
    const m = e.data
    if (m?.type !== 'cmd' || typeof m.req !== 'string') return
    const a = handle(m.cmd ?? null)
    ch.postMessage({ type: 'answer', req: m.req, result: a.result, nest: a.nest } satisfies Msg)
  }
  return () => ch.close()
}

let out: BroadcastChannel | null = null
/** Where the pet is shown: tell every listener what the nest looks like now. */
export function announceNest(nest: NestBrief): void {
  if (!has()) return
  out ??= new BroadcastChannel(NAME)
  out.postMessage({ type: 'nest', nest } satisfies Msg)
}

/** Follow the nest as the window showing the pet announces it. Returns the unsubscribe. */
export function onNest(cb: (nest: NestBrief) => void): () => void {
  if (!has()) return () => {}
  const ch = new BroadcastChannel(NAME)
  ch.onmessage = (e: MessageEvent<Msg>) => {
    const m = e.data
    if (m?.type === 'nest' && m.nest) cb(m.nest)
    else if (m?.type === 'answer' && m.nest) cb(m.nest)
  }
  return () => ch.close()
}

/** Stop announcing (tests, and a window going away). */
export function closeAnnouncer(): void {
  out?.close()
  out = null
}
