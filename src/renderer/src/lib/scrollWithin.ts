// scrollIntoView scrolls EVERY scrollable ancestor, overflow:hidden ones
// included. A dock panel whose tab is hidden still renders (defaultRenderer
// "always"), so its scrollIntoView reached past the panel and shifted the whole
// dock up, leaving the tab bar off-screen and an empty band at the bottom.
// This moves only the nearest scroller that is meant to scroll.

function scroller(el: Element): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const oy = getComputedStyle(p).overflowY
    if ((oy === 'auto' || oy === 'scroll') && p.scrollHeight > p.clientHeight) return p
  }
  return null
}

export function scrollWithin(
  el: Element | null | undefined,
  block: 'start' | 'center' | 'end' | 'nearest' = 'nearest',
  behavior: ScrollBehavior = 'auto'
): void {
  if (!el) return
  const box = scroller(el)
  if (!box) return
  const b = box.getBoundingClientRect()
  const r = el.getBoundingClientRect()
  // Hidden panels have no size; there is nothing to show yet.
  if (b.height === 0) return
  const top = r.top - b.top + box.scrollTop
  let to: number
  if (block === 'start') to = top
  else if (block === 'end') to = top + r.height - box.clientHeight
  else if (block === 'center') to = top + r.height / 2 - box.clientHeight / 2
  else if (r.top < b.top) to = top
  else if (r.bottom > b.top + box.clientHeight) to = top + r.height - box.clientHeight
  else return
  box.scrollTo({ top: Math.max(0, to), behavior })
}
