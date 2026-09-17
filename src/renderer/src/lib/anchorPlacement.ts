export interface AnchorRect {
  left: number
  top: number
  right: number
  bottom: number
}

const GAP = 6
const MARGIN = 8

// Where a popover goes so it sits ON the thing that opened it: directly above
// an anchor in the lower half of the window (the status bar), directly below
// one in the upper half (the header), left edges aligned — and never off screen.
// Guessing a fixed offset instead left the port menu floating wherever its
// height happened not to match the guess.
export function anchorPlacement(
  anchor: AnchorRect,
  size: { width: number; height: number },
  viewport: { width: number; height: number }
): { left: number; top: number } {
  const below = anchor.top + (anchor.bottom - anchor.top) / 2 < viewport.height / 2
  let top = below ? anchor.bottom + GAP : anchor.top - GAP - size.height
  top = Math.max(MARGIN, Math.min(top, viewport.height - MARGIN - size.height))
  let left = anchor.left
  left = Math.max(MARGIN, Math.min(left, viewport.width - MARGIN - size.width))
  return { left, top }
}
