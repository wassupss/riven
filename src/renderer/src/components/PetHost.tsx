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
  const ready = useSettings((s) => s.ready)
  const set = useSettings((s) => s.set)

  useEffect(() => {
    // Wait for settings to load, or the defaults would close a window the user
    // had open before the file is even read.
    if (!ready) return
    if (show && detached) void window.api.pet.open()
    else void window.api.pet.close()
  }, [ready, show, detached])

  useEffect(() => {
    const offClosed = window.api.pet.onClosed(() => set({ petDetached: false }))
    // Putting the floating pet away is about SHOWING it, not about where it
    // lives: bringing it back should return it to its own window, where the user
    // last had it.
    const offHidden = window.api.pet.onHidden(() => set({ petShow: false }))
    return () => {
      offClosed()
      offHidden()
    }
  }, [set])

  if (detached) return null
  return <PetDevice />
}
