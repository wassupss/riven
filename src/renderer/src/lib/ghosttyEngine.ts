import { instantiateVt, type Vt } from './ghostty/vt'
import wasmUrl from './ghostty/ghostty-vt.wasm?url'

// Experimental terminal engine (settings.terminalEngine === 'ghostty'): our own
// build of upstream libghostty-vt (scripts/build-ghostty-vt.sh) driven by our
// own bindings and renderer in ./ghostty.
//
// The wasm is loaded once per renderer and shared by every terminal. It is
// fetched from a served URL on purpose: our CSP (connect-src) refuses data:.
let loading: Promise<Vt> | null = null

export function loadGhostty(): Promise<Vt> {
  loading ??= fetch(wasmUrl)
    .then((r) => {
      if (!r.ok) throw new Error(`ghostty-vt.wasm: HTTP ${r.status}`)
      return r.arrayBuffer()
    })
    .then(instantiateVt)
    .catch((e) => {
      // Let the next terminal try again instead of caching the failure.
      loading = null
      throw e
    })
  return loading
}
