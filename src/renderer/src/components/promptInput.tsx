import { createRoot } from 'react-dom/client'
import InputModal from './InputModal'

// Electron implements neither window.prompt nor a replacement, so every
// `const name = window.prompt(...)` in the app was dead: the button appeared to
// do nothing at all. This is the drop-in async replacement, rendering the same
// InputModal the rest of the app uses.
//
// It mounts its own React root because the callers are imperative (inside async
// handlers, not render), and nothing here needs React context: i18n and settings
// are zustand stores, which are shared across roots.
export function promptInput(opts: {
  title: string
  initial?: string
  placeholder?: string
}): Promise<string | null> {
  return new Promise((resolve) => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    let settled = false
    const close = (value: string | null): void => {
      if (settled) return
      settled = true
      resolve(value)
      // Unmount after the current commit, never during it.
      setTimeout(() => {
        root.unmount()
        host.remove()
      }, 0)
    }
    root.render(
      <InputModal
        title={opts.title}
        initial={opts.initial}
        placeholder={opts.placeholder}
        onSubmit={close}
        onCancel={() => close(null)}
      />
    )
  })
}
