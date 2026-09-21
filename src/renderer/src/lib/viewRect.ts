export interface Rect {
  left: number
  top: number
  width: number
  height: number
}

// Is this a box riven can put a native view (or the address-bar dropdown) at?
//
// A page and the suggestion list are OS-level views placed from a rectangle the
// renderer measures. That measurement is only trustworthy while the panel is
// actually laid out: a window that is occluded stops getting animation frames,
// and the dock's panel positions then go stale or read as zero — which put the
// page view somewhere off in the corner, at a few pixels tall. A box that is not
// inside the window is never a real panel, so it is ignored rather than obeyed.
export function placeable(r: Rect, win: { width: number; height: number }, min = 2): boolean {
  if (!(r.width > min && r.height > min)) return false
  if (!(win.width > 0 && win.height > 0)) return false
  const slack = 1
  return (
    r.left >= -slack &&
    r.top >= -slack &&
    r.left + r.width <= win.width + slack &&
    r.top + r.height <= win.height + slack
  )
}
