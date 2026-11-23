// Which panels with a Monaco editor in them show a background image.
//
// Monaco themes are global in the standalone editor: defineTheme/setTheme (and
// even a per-instance `theme` option) restyle every editor on the page, so a
// see-through theme cannot be given to one editor alone. Most of the editor is
// cleared per panel in CSS instead (styles/panel-background.css, scoped to a
// .pbg-host that has a background): the text area, gutter and margins. What
// CSS cannot reach is what Monaco paints on canvas, the minimap, which reads
// minimap.background from the theme. So editor/highlight switches the global
// theme to transparent minimap/editor backgrounds while at least one panel
// with a background is mounted; the global rule in styles.css still paints
// every other editor solid --bg, so those look the same either way.
//
// This module has no Monaco import, so the dock can report into it without
// loading the editor in windows that have none.

const holders = new Set<symbol>()
let listener: ((on: boolean) => void) | null = null

export function seeThroughActive(): boolean {
  return holders.size > 0
}

/** editor/highlight listens here; called only when the answer flips. */
export function onSeeThroughChange(fn: (on: boolean) => void): void {
  listener = fn
}

/** A panel with a background is mounted; returns the release. */
export function holdSeeThrough(): () => void {
  const id = Symbol('pbg')
  const was = holders.size > 0
  holders.add(id)
  if (!was) listener?.(true)
  return () => {
    if (!holders.delete(id)) return
    if (holders.size === 0) listener?.(false)
  }
}
