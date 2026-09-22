import { useEffect } from 'react'
import { useSettings } from '../state/settings'
import PetDevice from './PetDevice'

// ---------------------------------------------------------------------------
// Decides WHERE 리븐펫 lives, so only one of the two ever runs.
//
//  · attached  → the device is rendered inside riven's window.
//  · detached  → main opens its own desktop window (src/main/pet.ts), which
//                mounts the same device; nothing is rendered here. The default:
//                a desk pet belongs on the desk.
//
// Main owns the window's existence and tells every renderer when it goes away,
// so the setting can never claim a pet that is not on screen — including after a
// crash, or when the user closed the floating pet from its own ✕.
// ---------------------------------------------------------------------------
export default function PetHost(): JSX.Element | null {
  const show = useSettings((s) => s.settings.petShow)
  const detached = useSettings((s) => s.settings.petDetached)
  const onTop = useSettings((s) => s.settings.petOnTop)
  const ready = useSettings((s) => s.ready)
  const set = useSettings((s) => s.set)

  useEffect(() => {
    // Wait for settings to load, or the defaults would close a window the user
    // had open before the file is even read.
    if (!ready) return
    if (show && detached) {
      // Open first, then lift: main can only raise a window that exists, and
      // the same call re-applies the choice whenever it is toggled.
      void window.api.pet.open().then(() => window.api.pet.setOnTop(onTop))
    } else void window.api.pet.close()
  }, [ready, show, detached, onTop])

  useEffect(() => {
    // The floating pet's own setup row asked to be lifted (or let down). Main has
    // already done it; persisting is this window's job, because two windows
    // writing settings.json means the later snapshot wins and the other's edits
    // are lost.
    const offOnTop = window.api.pet.onOnTop((v) => set({ petOnTop: v }))
    const offClosed = window.api.pet.onClosed(() => set({ petDetached: false }))
    // Putting the floating pet away is about SHOWING it, not about where it
    // lives: bringing it back should return it to its own window, where the user
    // last had it.
    const offHidden = window.api.pet.onHidden(() => set({ petShow: false }))
    return () => {
      offOnTop()
      offClosed()
      offHidden()
    }
  }, [set])

  if (detached) return null
  return <PetDevice />
}
