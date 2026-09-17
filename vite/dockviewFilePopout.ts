import type { Plugin } from 'vite'

// Let dockview pop a panel out of a packaged riven.
//
// ⌘⇧O (pop the active panel into its own window) worked in development and did
// nothing at all in the shipped app. dockview 7 refuses any pop-out URL that is
// not same-origin http(s):
//
//   dockview: popout URL must be same-origin http(s); got: file:///…/popout.html
//
// and a packaged Electron app loads its renderer from file://, so the check
// throws before window.open is even called. In development the renderer is
// served from http://localhost, which is why every test there passed.
//
// The check exists to fail loudly where a pop-out could not work — a window
// whose document the opener cannot reach. That is not the case here: measured
// in the packaged build, a file:// window opened from the app's own renderer
// directory is fully reachable (document readable, nodes adopted and moved),
// which is all dockview needs. So the check is widened to exactly that case — a
// file: URL in the SAME directory as the running document — and nothing else.
// It cannot be pointed at arbitrary files elsewhere on disk.

const CHECK =
  /const protocolOk = resolved\.protocol === 'http:' \|\| resolved\.protocol === 'https:';(\s*)if \(!protocolOk \|\| resolved\.origin !== window\.location\.origin\) \{/

const WIDENED = (gap: string): string =>
  "const __rivenDir = (p) => p.slice(0, p.lastIndexOf('/') + 1);" +
  "const sameDirFile = resolved.protocol === 'file:' && window.location.protocol === 'file:' && " +
  '__rivenDir(resolved.pathname) === __rivenDir(window.location.pathname);' +
  "const protocolOk = sameDirFile || resolved.protocol === 'http:' || resolved.protocol === 'https:';" +
  gap +
  'if (!protocolOk || (!sameDirFile && resolved.origin !== window.location.origin)) {'

export function dockviewFilePopout(): Plugin {
  let patched = false
  return {
    name: 'riven:dockview-file-popout',
    // Only the production build loads from file://. (Dev pre-bundles deps with
    // esbuild, where this hook would not run anyway — and does not need to.)
    apply: 'build',
    enforce: 'pre',
    transform(code, id) {
      if (!id.includes('dockview-core') || !code.includes('function assertSameOriginPopoutUrl')) return null
      if (!CHECK.test(code)) {
        // A dockview upgrade changed the check. Fail the build rather than ship
        // an app whose pop-out silently stopped working again.
        this.error(
          'riven: dockview changed assertSameOriginPopoutUrl — re-check vite/dockviewFilePopout.ts, or ⌘⇧O breaks in the packaged app'
        )
      }
      patched = true
      return { code: code.replace(CHECK, (_m, gap: string) => WIDENED(gap)), map: null }
    },
    buildEnd(err) {
      if (!err && !patched) {
        this.error(
          'riven: dockview popout check not found in the bundle — vite/dockviewFilePopout.ts needs updating, or ⌘⇧O breaks in the packaged app'
        )
      }
    }
  }
}
