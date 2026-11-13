// src/main/search.ts in the Tauri build. The group now lives in Rust
// (src-tauri/src/commands/search.rs); its channels never reach Node
// (tauri/shim/rust-owned.ts), so there is nothing to register.
export function registerSearchHandlers(): void {}
