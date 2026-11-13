// src/main/sessions.ts in the Tauri build. The group now lives in Rust
// (src-tauri/src/commands/sessions.rs); its channels never reach Node
// (tauri/shim/rust-owned.ts), so there is nothing to register.
export function registerSessionsHandlers(): void {}
