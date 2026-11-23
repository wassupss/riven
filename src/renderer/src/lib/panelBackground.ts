import { getSettings } from '../state/settings'
import { useSession } from '../state/session'
import { referencedBackgrounds } from '../state/panelBackground'

// Panel background images, the page side: where a stored image is loaded
// from, importing a picked file, and removing stored files nothing uses any
// more. Drawing is dock/PanelBgHost (per panel CSS variables, static CSS in
// styles/panel-background.css).

/** The URL the page loads a stored background from. */
export function backgroundUrl(name: string): string {
  const enc = encodeURIComponent(name)
  // The Tauri build serves it on the page's own origin (page.rs). Made
  // absolute so a popped-out panel's window resolves it the same way.
  const tauri = typeof window !== 'undefined' ? (window as { __RIVEN_BG__?: string }).__RIVEN_BG__ : undefined
  if (tauri) {
    const path = tauri.replace('{}', enc)
    try {
      return new URL(path, window.location.href).href
    } catch {
      return path
    }
  }
  return `riven-media://bg/${enc}`
}

/** Read a picked file and store a copy of it; resolves to the stored name. */
export function importBackground(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onerror = () => reject(r.error ?? new Error('read failed'))
    r.onload = () => {
      if (typeof r.result !== 'string') return reject(new Error('read failed'))
      window.api.background.import(r.result).then(resolve, reject)
    }
    r.readAsDataURL(file)
  })
}

/** Every stored background the settings or any workspace's saved panes still name. */
export function backgroundsInUse(): string[] {
  return referencedBackgrounds(getSettings().panelBgs, useSession.getState().sessions)
}

/**
 * Remove stored backgrounds nothing names. Main deletes only files of its own
 * name shape that are not in the list, so a file still referenced is never
 * touched; a file dropped here but still named on disk (a crash before the
 * debounced save) just shows no image.
 */
export function collectBackgrounds(): void {
  void window.api.background.gc(backgroundsInUse()).catch(() => {})
}

let gcTimer: ReturnType<typeof setTimeout> | null = null
/**
 * After an image was picked, replaced or removed: collect once things settle,
 * after settings and sessions had time to save, so the disk never names a
 * file that is already gone.
 */
export function scheduleBackgroundGc(): void {
  if (gcTimer) clearTimeout(gcTimer)
  gcTimer = setTimeout(() => {
    gcTimer = null
    collectBackgrounds()
  }, 2000)
}
