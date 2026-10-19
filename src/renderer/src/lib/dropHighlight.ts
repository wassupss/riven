import { useCallback, useEffect, useRef } from 'react'

// Every drop highlight in the app, cleared together when the drag is over.
//
// A highlight is turned on by `dragover` and off by `dragleave`, and there are
// ways to end a drag that fire NEITHER on the element that lit up: dropping on
// a child that stops the event before the container sees it, and pressing
// Escape. Both left the dashed outline on screen with no drag in progress, and
// nothing but another drag could clear it. `dragend`/`drop` on the window
// always fire, so that is what clears everything.
const dropClears = new Set<() => void>()
let dropClearsBound = false
export function useClearDropOnDragEnd(clear: () => void): void {
  useEffect(() => {
    dropClears.add(clear)
    if (!dropClearsBound) {
      dropClearsBound = true
      const all = (): void => dropClears.forEach((fn) => fn())
      window.addEventListener('dragend', all, true)
      window.addEventListener('drop', all, true)
    }
    return () => {
      dropClears.delete(clear)
    }
  }, [clear])
}

// The last resort. A drag from outside riven (Finder) that is cancelled with
// Escape while over the element fires no `dragend` here, and may fire no
// `dragleave` either. But `dragover` repeats every ~50ms for as long as the
// pointer is over a drop target, even standing still, so once it has been
// quiet for a moment the drag is gone. Call the returned function from
// `dragover`.
const DRAG_QUIET_MS = 350
export function useClearDropWhenDragQuiet(clear: () => void): () => void {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    []
  )
  return useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(clear, DRAG_QUIET_MS)
  }, [clear])
}

// `dragleave` fires for every child the pointer crosses, so `target` is usually
// a child, not the highlighted container. The drag has left the container only
// when where it went (`relatedTarget`) is outside it, or nowhere: out of the
// window, or Escape.
export function dragLeftElement(e: React.DragEvent): boolean {
  const to = e.relatedTarget as Node | null
  return !to || !e.currentTarget.contains(to)
}
