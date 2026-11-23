import type { Hatch } from '../state/pet'

// ---------------------------------------------------------------------------
// "Raise this species now" from Settings. The pet may live in its own desktop
// window (detached, the default) with its own store, so Settings cannot adopt
// into the store it has: it asks whichever window shows the pet, over a
// BroadcastChannel (it reaches every other channel object of the same name,
// in this window too, so an attached pet hears it as well), and waits for the
// answer.
// ---------------------------------------------------------------------------

const NAME = 'riven-pet-raise'

type Msg =
  | { type: 'raise'; req: string; hatch: Hatch }
  | { type: 'result'; req: string; result: RaiseResult }

/** ok: an egg is out; full: the nest has no room; none: no pet is on screen to take it. */
export type RaiseResult = 'ok' | 'full' | 'none'

export function requestRaise(hatch: Hatch, timeoutMs = 1500): Promise<RaiseResult> {
  if (typeof BroadcastChannel === 'undefined') return Promise.resolve('none')
  const ch = new BroadcastChannel(NAME)
  const req = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  return new Promise<RaiseResult>((resolve) => {
    const done = (r: RaiseResult): void => {
      clearTimeout(timer)
      ch.close()
      resolve(r)
    }
    const timer = setTimeout(() => done('none'), timeoutMs)
    ch.onmessage = (e: MessageEvent<Msg>) => {
      if (e.data?.type === 'result' && e.data.req === req) done(e.data.result)
    }
    ch.postMessage({ type: 'raise', req, hatch } satisfies Msg)
  })
}

/** Where the pet is shown: answer raise requests. Returns the unsubscribe. */
export function listenRaise(handle: (hatch: Hatch) => RaiseResult): () => void {
  if (typeof BroadcastChannel === 'undefined') return () => {}
  const ch = new BroadcastChannel(NAME)
  ch.onmessage = (e: MessageEvent<Msg>) => {
    const m = e.data
    if (m?.type !== 'raise' || !m.hatch) return
    ch.postMessage({ type: 'result', req: m.req, result: handle(m.hatch) } satisfies Msg)
  }
  return () => ch.close()
}
