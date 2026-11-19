import type { Plugin } from 'vite'

// Keep dockview's tab overflow dropdown ("v 1") from showing when nothing overflows.
//
// In the Tauri build (WKWebView) a dock group with three tabs showed the
// overflow dropdown with a count of 1 although every tab was in view. Measured
// in that app: the tab strip (.dv-tabs-container, shrink-to-fit, fractional
// tab widths) was 192.63px wide, clientWidth 192, scrollWidth 193, and the last
// tab's right edge was past the strip's right edge by about 1.5e-6px. dockview
// decides overflow with two exact compares:
//
//   OverflowObserver:  scrollWidth > clientWidth             (193 > 192)
//   toggleDropdown:    isChildEntirelyVisibleWithinParent    (right > right by 1e-6)
//
// WebKit rounds scrollWidth up and clientWidth down for a fractional box (Chrome
// snaps them the same way, which is why Electron never showed it), so both
// compares trip on rounding alone. A tab clipped by less than one CSS pixel is
// not hidden from anyone, so both now allow 1px. A real overflow (a tab cut by
// more than that) is unchanged and keeps its exact count. Layout, the strip's
// empty area and its drop target are not touched.

const TOL = 1

const SCROLL =
  /const hasScrollX = entry\.target\.scrollWidth > entry\.target\.clientWidth;(\s*)const hasScrollY = entry\.target\.scrollHeight > entry\.target\.clientHeight;/

const SCROLL_TOL = (gap: string): string =>
  `const hasScrollX = entry.target.scrollWidth - entry.target.clientWidth > ${TOL};` +
  gap +
  `const hasScrollY = entry.target.scrollHeight - entry.target.clientHeight > ${TOL};`

const VISIBLE = /function isChildEntirelyVisibleWithinParent\(child, parent\) \{[\s\S]*?return true;\s*\}/

const VISIBLE_TOL =
  'function isChildEntirelyVisibleWithinParent(child, parent) {' +
  ' const c = getDomNodePagePosition(child); const p = getDomNodePagePosition(parent);' +
  ` const t = ${TOL};` +
  ' return !(c.left < p.left - t || c.left + c.width > p.left + p.width + t ||' +
  ' c.top < p.top - t || c.top + c.height > p.top + p.height + t); }'

export function dockviewSubpixelOverflow(): Plugin {
  let patched = false
  return {
    name: 'riven:dockview-subpixel-overflow',
    // Like dockviewFilePopout: the build (Electron package, and the Tauri
    // renderer, which is always a build) is where it matters. Dev pre-bundles
    // deps with esbuild and runs in Chromium, which snaps both sides alike.
    apply: 'build',
    enforce: 'pre',
    transform(code, id) {
      if (!id.includes('dockview-core') || !code.includes('class OverflowObserver')) return null
      if (!SCROLL.test(code) || !VISIBLE.test(code)) {
        // A dockview upgrade changed the checks. Fail the build rather than ship
        // the false "v 1" dropdown again without noticing.
        this.error('riven: dockview changed OverflowObserver / isChildEntirelyVisibleWithinParent, re-check vite/dockviewSubpixelOverflow.ts')
      }
      patched = true
      return {
        code: code.replace(SCROLL, (_m, gap: string) => SCROLL_TOL(gap)).replace(VISIBLE, VISIBLE_TOL),
        map: null
      }
    },
    buildEnd(err) {
      if (!err && !patched) {
        this.error('riven: dockview overflow checks not found in the bundle, vite/dockviewSubpixelOverflow.ts needs updating')
      }
    }
  }
}
