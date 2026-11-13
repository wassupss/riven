// src/main/notify.ts in the Tauri build: notify:show, notify:presence and
// notify:diag run in Rust (src-tauri/src/services/notify.rs), which plans,
// posts through UNUserNotificationCenter and routes a click back to the
// window and pane. The startup permission request (notify.ts's silent probe)
// is Rust's too, at launch, skipped in the background test mode.
export function registerNotifyHandlers(): void {}
export function ensureNotificationCenterRegistration(): void {}
