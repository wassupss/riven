// Is anyone able to see this window?
//
// document.visibilityState alone cannot answer it here: riven runs with
// backgroundThrottling off (so an occluded window keeps laying out its dock —
// see main/index.ts), and that also pins visibilityState at 'visible' while the
// window is minimised. Main reports minimise/hide, and this folds the two.
//
// When main's answer changes, a 'visibilitychange' event is dispatched, so every
// existing listener re-runs — they only need to ask isPageHidden() instead of
// reading document.visibilityState.

let hiddenByMain = false

export function isPageHidden(): boolean {
  return hiddenByMain || document.visibilityState === 'hidden'
}

if (typeof window !== 'undefined' && window.api?.win) {
  window.api.win.onVisibility(({ hidden }) => {
    if (hidden === hiddenByMain) return
    hiddenByMain = hidden
    document.dispatchEvent(new Event('visibilitychange'))
  })
}
