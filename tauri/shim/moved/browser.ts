// src/main/browser.ts in the Tauri build: the browser panel's 21 channels,
// its events, bookmarks and history, menus, the address bar's list and the
// element picker run in Rust (src-tauri/src/services/browser.rs over the
// native views in src-tauri/src/browser.rs).
export function registerBrowserHandlers(_windowGetter: unknown): void {}
