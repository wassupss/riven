// src/main/keepAwake.ts in the Tauri build: power:busy / power:remote run in
// Rust (src-tauri/src/services/power.rs), which holds and releases the sleep
// assertion and lets it go on quit.
export function registerKeepAwake(): void {}
export function releaseKeepAwake(): void {}
