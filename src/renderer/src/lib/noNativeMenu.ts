// The webview's own right-click menu (Reload, Inspect Element, Look Up...) is
// WebKit's, not ours: Electron never showed one, and in the Tauri build it
// leaks out wherever a component has no menu of its own (including Ctrl+click
// on macOS). This drops it everywhere in our pages. Components that want a
// menu still get the event first (React handles it at the root, before this
// window listener) and open ContextMenu as before. Pages inside the browser
// panel are separate webviews with their own handler (browser.rs).
export function installNoNativeMenu(): void {
  window.addEventListener('contextmenu', (e) => e.preventDefault())
}
