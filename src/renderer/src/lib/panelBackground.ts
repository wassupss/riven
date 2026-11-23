import { useSettings, getSettings } from '../state/settings'
import { panelBgView, type PanelBgView } from '../state/panelBackground'
import '../styles/panel-background.css'

// Applies the panel background setting to the page: attributes and custom
// properties on <html>, read by styles/panel-background.css. The layers are
// static CSS, so nothing here runs per frame and no panel re-renders: the
// only JS work is this, once per change of the setting. (The terminal canvas
// and Monaco's theme follow the same setting on their own: TerminalPane and
// editor/highlight.)

/** The URL the page loads a stored background from. */
export function backgroundUrl(name: string): string {
  // The Tauri build serves it on the page's own origin (page.rs).
  const tauri = typeof window !== 'undefined' ? (window as { __RIVEN_BG__?: string }).__RIVEN_BG__ : undefined
  if (tauri) return tauri.replace('{}', encodeURIComponent(name))
  return `riven-media://bg/${encodeURIComponent(name)}`
}

function apply(v: PanelBgView): void {
  const root = document.documentElement
  if (!v.image) {
    root.removeAttribute('data-pbg')
    root.removeAttribute('data-pbg-app')
    for (const p of ['--pbg-image', '--pbg-tint', '--pbg-filter']) root.style.removeProperty(p)
    return
  }
  root.style.setProperty('--pbg-image', `url("${backgroundUrl(v.image)}")`)
  root.style.setProperty('--pbg-tint', String(v.tint))
  root.style.setProperty('--pbg-filter', v.filter)
  if (v.app) root.setAttribute('data-pbg-app', '')
  else root.removeAttribute('data-pbg-app')
  if (v.kinds.length) root.setAttribute('data-pbg', v.kinds.join(' '))
  else root.removeAttribute('data-pbg')
}

const key = (v: PanelBgView): string => `${v.image}|${v.app}|${v.kinds.join(',')}|${v.tint}|${v.filter}`

/** Start following the setting. Returns the unsubscribe. */
export function startPanelBackground(): () => void {
  let last = ''
  const sync = (): void => {
    const v = panelBgView(getSettings())
    const k = key(v)
    if (k === last) return
    last = k
    apply(v)
  }
  sync()
  return useSettings.subscribe(sync)
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
