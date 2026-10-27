import { createContext, useCallback, useContext, useState, type ReactNode } from 'react'

// Which window a popup belongs in.
//
// A popped-out dock group is a separate window that dockview MOVES the panel's
// live DOM into, while React keeps running in the main window. So inside a
// popped-out panel `document` and `window` still mean MAIN: a menu portalled to
// `document.body` opened in the parent window, Escape/click-outside listeners on
// `window` never heard the pop-out, and `window.confirm` raised its dialog over
// the parent too.
//
// Two sources, in order:
//  1. the panel the component renders in (HostScope, set per dock panel), which
//     is exact for anything a panel renders;
//  2. the window the user last pressed a key or pointer in, for imperative
//     callers that have no React context (promptInput, confirm, lightbox).

const Scope = createContext<{ current: HTMLElement | null } | null>(null)

let lastDoc: Document | null = null

const live = (d: Document | null): d is Document => !!d && !!d.defaultView && !d.defaultView.closed

/** The document the user last interacted with (main unless a pop-out was used). */
export function activeDoc(): Document {
  return live(lastDoc) ? lastDoc : document
}

export function activeWin(): Window {
  return activeDoc().defaultView ?? window
}

const mark = (e: Event): void => {
  const d = (e.currentTarget as Node | null)?.ownerDocument
  if (d) lastDoc = d
}

// Main is the default; a click back in main after using a pop-out moves it back.
document.addEventListener('pointerdown', () => (lastDoc = document), true)
document.addEventListener('keydown', () => (lastDoc = document), true)

/** Wraps a dock panel so popups opened from it land in the window it is drawn in. */
export function HostScope({ children }: { children: ReactNode }): JSX.Element {
  const [ref] = useState<{ current: HTMLElement | null }>(() => ({ current: null }))
  const attach = useCallback(
    (el: HTMLDivElement | null) => {
      ref.current?.removeEventListener('pointerdown', mark, true)
      ref.current?.removeEventListener('keydown', mark, true)
      ref.current = el
      el?.addEventListener('pointerdown', mark, true)
      el?.addEventListener('keydown', mark, true)
    },
    [ref]
  )
  return (
    <Scope.Provider value={ref}>
      <div ref={attach} style={{ display: 'contents' }}>
        {children}
      </div>
    </Scope.Provider>
  )
}

export interface Host {
  doc: Document
  win: Window
}

const hostOf = (doc: Document): Host => ({ doc, win: doc.defaultView ?? window })

/**
 * The window a popup should render in, fixed when it mounts: a dialog must not
 * jump between windows when the user clicks elsewhere while it is open.
 */
export function useHost(): Host {
  const scope = useContext(Scope)
  const [host] = useState(() => {
    const d = scope?.current?.ownerDocument
    return hostOf(live(d ?? null) ? d! : activeDoc())
  })
  return host
}

/** Same as useHost, for code that has an element in hand (tab headers). */
export function hostFor(el: Element | null | undefined): Host {
  return hostOf(el?.ownerDocument ?? activeDoc())
}

/**
 * `window.confirm` / `window.alert` raise their dialog over the window whose
 * function is called, and every caller in the app calls main's. Route them to
 * the window the user is actually in. Installed once from main.tsx.
 */
export function installDialogRouting(): void {
  const confirm = window.confirm.bind(window)
  const alert = window.alert.bind(window)
  window.confirm = (msg?: string): boolean => {
    const w = activeWin()
    return w === window ? confirm(msg) : w.confirm(msg)
  }
  window.alert = (msg?: string): void => {
    const w = activeWin()
    if (w === window) alert(msg)
    else w.alert(msg)
  }
}
